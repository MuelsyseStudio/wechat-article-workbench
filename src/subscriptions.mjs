/**
 * Multi-Account WeChat Official Account Subscription Store & Incremental Auto-Sync Engine
 *
 * Persists subscribed accounts & scheduler config under data/subscriptions.json.
 * Performs fast, low-traffic incremental checks via WeRead (/web/mp/articles -> /web/mp/content),
 * stopping early as soon as already-archived articles are reached, with built-in rate-limit circuit breaking.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ArticleIndexStore, formatLocalIsoNow } from "./dedup.mjs";
import {
  DEFAULT_OUTPUT_DIR,
  resolveWeReadAccountsFromInputs,
  syncWeReadAccounts,
} from "./pipeline.mjs";
import {
  DATA_DIR,
  WeReadSession,
  bizToWeReadBookId,
  parseWeReadArticlesResponse,
  politeDelayAbortable,
  saveWeReadAccount,
} from "./weread-cdp.mjs";
import { parseWechatUrlIdentity } from "./html-to-md.mjs";
import { triggerNewArticlesPush } from "./notifier.mjs";

export const SUBSCRIPTIONS_PATH = path.join(DATA_DIR, "subscriptions.json");

const DEFAULT_SCHEDULER = {
  enabled: true,
  intervalMinutes: 60,
  delaySec: 4,
  lookbackPages: 2,
  maxPerCheck: 25,
  downloadImages: false,
  saveJsonl: false,
  lastGlobalCheckAt: "",
  nextGlobalCheckAt: "",
};

function normalizeSubscriptionData(raw) {
  const scheduler = {
    ...DEFAULT_SCHEDULER,
    ...(raw?.scheduler || {}),
  };
  scheduler.intervalMinutes = Math.max(5, Math.min(1440, Number(scheduler.intervalMinutes) || 60));
  scheduler.delaySec = Math.max(1, Math.min(60, Number(scheduler.delaySec) || 4));
  scheduler.lookbackPages = Math.max(1, Math.min(20, Number(scheduler.lookbackPages) || 2));
  scheduler.maxPerCheck = Math.max(1, Math.min(200, Number(scheduler.maxPerCheck) || 25));
  scheduler.enabled = Boolean(scheduler.enabled);

  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const recentRuns = Array.isArray(raw?.recentRuns) ? raw.recentRuns.slice(0, 30) : [];
  return {
    version: "1.0",
    updated_at: raw?.updated_at || "",
    scheduler,
    accounts,
    recentRuns,
  };
}

/**
 * Load subscriptions from disk. On first initialization, auto-seeds any accounts already
 * archived in index.json so the user can monitor them immediately.
 */
export async function loadSubscriptions({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let data = null;
  let existed = false;

  try {
    const raw = await fs.readFile(SUBSCRIPTIONS_PATH, "utf8");
    data = normalizeSubscriptionData(JSON.parse(raw));
    existed = true;
  } catch {
    data = normalizeSubscriptionData({});
  }

  // Reconcile local archived counts & latest article date/title from index.json
  const store = new ArticleIndexStore(outputDir);
  await store.load();

  const statsByBookId = new Map();
  for (const art of store.data.articles) {
    const bookId = art.weread_book_id || (art.biz ? bizToWeReadBookId(art.biz).bookId : "");
    if (!bookId) continue;
    const prev = statsByBookId.get(bookId) || {
      bookId,
      biz: art.biz || bizToWeReadBookId(bookId).biz,
      name: art.account || "未知公众号",
      sampleUrl: art.source_url || "",
      count: 0,
      latestDate: "",
      latestTitle: "",
    };
    prev.count++;
    if (art.account && art.account !== "未知公众号" && prev.name === "未知公众号") {
      prev.name = art.account;
    }
    const artDate = art.published_at || art.date || "";
    if (!prev.latestDate || artDate > prev.latestDate) {
      prev.latestDate = art.date || "";
      prev.latestTitle = art.title || "";
    }
    statsByBookId.set(bookId, prev);
  }

  // First-time bootstrap: seed known archived accounts as initial subscriptions
  if (!existed && statsByBookId.size > 0) {
    const now = formatLocalIsoNow();
    for (const st of statsByBookId.values()) {
      data.accounts.push({
        id: st.bookId,
        bookId: st.bookId,
        biz: st.biz,
        name: st.name,
        category: "默认订阅",
        sampleUrl: st.sampleUrl,
        enabled: true,
        since: "",
        tags: [],
        createdAt: now,
        lastCheckedAt: "",
        lastArticleDate: st.latestDate,
        lastArticleTitle: st.latestTitle,
        totalSynced: st.count,
        lastRunAdded: 0,
        lastStatus: "idle",
        lastError: "",
      });
    }
    await saveSubscriptions(data);
  } else {
    // Keep totalSynced / latestArticle fresh from index.json
    let dirty = false;
    for (const acc of data.accounts) {
      const st = statsByBookId.get(acc.bookId);
      if (st) {
        if (acc.totalSynced !== st.count) {
          acc.totalSynced = st.count;
          dirty = true;
        }
        if (st.latestDate && (!acc.lastArticleDate || st.latestDate >= acc.lastArticleDate)) {
          if (acc.lastArticleDate !== st.latestDate || acc.lastArticleTitle !== st.latestTitle) {
            acc.lastArticleDate = st.latestDate;
            acc.lastArticleTitle = st.latestTitle;
            dirty = true;
          }
        }
        if ((!acc.name || acc.name === "未知公众号") && st.name && st.name !== "未知公众号") {
          acc.name = st.name;
          dirty = true;
        }
      }
    }
    if (dirty && existed) {
      await saveSubscriptions(data);
    }
  }

  return data;
}

export async function saveSubscriptions(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const normalized = normalizeSubscriptionData(data);
  normalized.updated_at = formatLocalIsoNow();
  await fs.writeFile(SUBSCRIPTIONS_PATH, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export async function updateSubscriptionConfig(patch = {}, { outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const data = await loadSubscriptions({ outputDir });
  data.scheduler = {
    ...data.scheduler,
    ...patch,
  };
  return await saveSubscriptions(data);
}

/**
 * Add one or multiple WeChat Official Accounts to the subscription list.
 * Accepts single/multi-line article URLs, album URLs, __biz strings, or MP_WXS_<digits>.
 */
export async function addSubscriptions(
  inputs,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    nameHint = "",
    category = "默认订阅",
    since = "",
    tags = [],
    onProgress = null,
  } = {}
) {
  const data = await loadSubscriptions({ outputDir });
  const rawList = Array.isArray(inputs) ? inputs : [inputs];

  // Try connecting to existing WeRead browser session (without forcing launch) to help resolve short URLs/names
  let session = null;
  try {
    const s = new WeReadSession();
    const conn = await s.connect({ autoLaunch: false, bringToFront: false });
    if (conn.connected) session = s;
    else s.close();
  } catch {}

  try {
    const { accounts: resolved, warnings } = await resolveWeReadAccountsFromInputs(rawList, {
      outputDir,
      session,
      onProgress,
    });

    if (resolved.length === 0) {
      return {
        added: [],
        existing: [],
        warnings,
        error:
          warnings[0] ||
          "未能从输入中解析出任何公众号 ID（请粘贴文章链接、含 __biz 的合集链接，或直接输入 MP_WXS_<数字>）",
        data,
      };
    }

    const added = [];
    const existing = [];
    const now = formatLocalIsoNow();

    for (const r of resolved) {
      let resolvedName = r.accountName || (resolved.length === 1 ? nameHint : "") || "";

      // If account name is still unknown and we have a logged-in WeRead session, peek 1 article to get mp_name
      if ((!resolvedName || resolvedName === "未知公众号") && session) {
        try {
          const login = await session.checkLogin({ probeApi: false });
          if (login.loggedIn) {
            const pageRes = await session.fetchArticlesPage(r.bookId, 0);
            if (pageRes.ok) {
              const parsed = parseWeReadArticlesResponse(pageRes.data, { bookId: r.bookId });
              if (parsed.items[0]?.account && parsed.items[0].account !== "未知公众号") {
                resolvedName = parsed.items[0].account;
              }
            }
          }
        } catch {}
      }

      if (!resolvedName) resolvedName = r.bookId;

      await saveWeReadAccount({
        bookId: r.bookId,
        biz: r.biz,
        numericId: r.numericId,
        accountName: resolvedName,
        sampleUrl: r.sampleUrl || "",
      });

      const found = data.accounts.find((a) => a.bookId === r.bookId);
      if (found) {
        if (nameHint && resolved.length === 1) found.name = nameHint;
        else if ((found.name === found.bookId || found.name === "未知公众号") && resolvedName !== found.bookId) {
          found.name = resolvedName;
        }
        if (category && category !== "默认订阅") found.category = category;
        if (since) found.since = since;
        found.enabled = true;
        existing.push(found);
      } else {
        const entry = {
          id: r.bookId,
          bookId: r.bookId,
          biz: r.biz || "",
          name: resolvedName,
          category: category || "默认订阅",
          sampleUrl: r.sampleUrl || "",
          enabled: true,
          since: since || "",
          tags: Array.isArray(tags) ? tags : [],
          createdAt: now,
          lastCheckedAt: "",
          lastArticleDate: "",
          lastArticleTitle: "",
          totalSynced: 0,
          lastRunAdded: 0,
          lastStatus: "idle",
          lastError: "",
        };
        data.accounts.push(entry);
        added.push(entry);
      }
    }

    const saved = await saveSubscriptions(data);
    return { added, existing, warnings, data: saved };
  } finally {
    if (session) session.close();
  }
}

export async function updateSubscriptionAccount(bookId, patch = {}, { outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const data = await loadSubscriptions({ outputDir });
  const target = data.accounts.find((a) => a.bookId === bookId || a.id === bookId);
  if (!target) {
    throw new Error(`未找到订阅公众号：${bookId}`);
  }
  if (typeof patch.enabled === "boolean") target.enabled = patch.enabled;
  if (typeof patch.name === "string" && patch.name.trim()) target.name = patch.name.trim();
  if (typeof patch.category === "string") target.category = patch.category.trim() || "默认订阅";
  if (typeof patch.since === "string") target.since = patch.since.trim();
  if (Array.isArray(patch.tags)) target.tags = patch.tags;
  const saved = await saveSubscriptions(data);
  return { account: target, data: saved };
}

export async function removeSubscriptionAccount(bookId, { outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const data = await loadSubscriptions({ outputDir });
  const before = data.accounts.length;
  data.accounts = data.accounts.filter((a) => a.bookId !== bookId && a.id !== bookId);
  const removed = before - data.accounts.length;
  const saved = await saveSubscriptions(data);
  return { removed, data: saved };
}

/**
 * Run incremental update check across all enabled subscriptions (or one specific bookId).
 * Optimized for minimal traffic: inspects only the top `lookbackPages` per account and stops paging
 * as soon as an entire page is already archived locally.
 */
export async function runSubscriptionsCheck({
  outputDir = DEFAULT_OUTPUT_DIR,
  bookId = "",
  trigger = "manual", // "manual" | "scheduled" | "cli" | "mcp"
  delayMs = null,
  lookbackPages = null,
  maxPerAccount = null,
  downloadImages = null,
  saveJsonl = null,
  signal = null,
  onProgress = null,
} = {}) {
  const data = await loadSubscriptions({ outputDir });
  const cfg = data.scheduler;
  const effDelayMs = Math.max(1000, Number(delayMs ?? cfg.delaySec * 1000));
  const effLookbackPages = Math.max(1, Number(lookbackPages ?? cfg.lookbackPages));
  const effMaxPerAccount = Math.max(1, Number(maxPerAccount ?? cfg.maxPerCheck));
  const effDownloadImages = downloadImages !== null ? Boolean(downloadImages) : Boolean(cfg.downloadImages);
  const effSaveJsonl = saveJsonl !== null ? Boolean(saveJsonl) : Boolean(cfg.saveJsonl);

  const targets = bookId
    ? data.accounts.filter((a) => a.bookId === bookId || a.id === bookId)
    : data.accounts.filter((a) => a.enabled);

  const runSummary = {
    kind: "subscription_sync",
    trigger,
    startedAt: formatLocalIsoNow(),
    finishedAt: "",
    accountsChecked: 0,
    totalNewArticles: 0,
    saved: 0,
    updated: 0,
    skipped: 0,
    filteredOut: 0,
    errors: 0,
    needsLogin: false,
    stoppedEarly: false,
    stopReason: "",
    accountResults: [],
    newArticles: [],
    outputDir: path.resolve(outputDir),
    indexFile: path.join(path.resolve(outputDir), "00_文章索引.md"),
  };

  if (targets.length === 0) {
    runSummary.finishedAt = formatLocalIsoNow();
    runSummary.stopReason = bookId ? `未找到订阅公众号 ${bookId}` : "当前没有已启用的订阅公众号";
    return runSummary;
  }

  const store = new ArticleIndexStore(outputDir);
  await store.load();

  const session = new WeReadSession();
  try {
    if (onProgress) {
      onProgress({
        phase: "sub",
        message: `开始执行订阅更新检查（${trigger === "scheduled" ? "定时自动" : "手动触发"}，共 ${targets.length} 个公众号）...`,
      });
    }

    await session.connect({ autoLaunch: true, bringToFront: false });
    const login = await session.checkLogin({ probeApi: true });
    if (!login.loggedIn) {
      runSummary.needsLogin = true;
      runSummary.stoppedEarly = true;
      runSummary.stopReason = login.expired
        ? login.errMsg || "微信读书登录已过期，请点击「登录微信读书」重新扫码"
        : "尚未登录微信读书，请先点击「登录微信读书」微信扫码";
      for (const acc of targets) {
        acc.lastStatus = "needs_login";
        acc.lastError = runSummary.stopReason;
      }
      await saveSubscriptions(data);
      runSummary.finishedAt = formatLocalIsoNow();
      return runSummary;
    }

    let globalApiCalls = 0;

    for (let idx = 0; idx < targets.length; idx++) {
      if (signal?.aborted) {
        runSummary.stoppedEarly = true;
        runSummary.stopReason = "用户手动中止订阅检查";
        break;
      }

      const acc = targets[idx];
      if (idx > 0) {
        await politeDelayAbortable(effDelayMs, signal);
        if (signal?.aborted) {
          runSummary.stoppedEarly = true;
          runSummary.stopReason = "用户手动中止订阅检查";
          break;
        }
      }

      if (onProgress) {
        onProgress({
          phase: "sub",
          message: `[订阅 ${idx + 1}/${targets.length}] 正在检查「${acc.name}」(${acc.bookId}) 是否有新文章...`,
        });
      }

      const newItems = [];
      let offset = 0;
      let accStopped = false;
      let accErr = "";
      let newestSeenDate = acc.lastArticleDate || "";
      let newestSeenTitle = acc.lastArticleTitle || "";

      for (let page = 1; page <= effLookbackPages; page++) {
        if (signal?.aborted) break;
        if (page > 1) {
          await politeDelayAbortable(effDelayMs, signal);
          if (signal?.aborted) break;
        }

        globalApiCalls++;
        const pageRes = await session.fetchArticlesPage(acc.bookId, offset);
        if (!pageRes.ok) {
          accStopped = true;
          accErr = pageRes.errMsg || "拉取目录失败";
          const code = Number(pageRes.errCode || 0);
          if (code === -2012 || code === -2010) {
            runSummary.needsLogin = true;
            runSummary.stoppedEarly = true;
            runSummary.stopReason = accErr;
          } else if (
            code === -2041 ||
            code === -2013 ||
            code === 429 ||
            pageRes.status === 0 ||
            /限速|频控|安全校验|ErrorNeedVerify|断开|ERR_CONNECTION_CLOSED/.test(accErr)
          ) {
            runSummary.stoppedEarly = true;
            runSummary.stopReason = accErr;
            // On -2041 during scheduled runs, pause auto-scheduler so it does not keep poking WeRead and extending cooldown
            if (code === -2041 && trigger === "scheduled") {
              data.scheduler.enabled = false;
              runSummary.stopReason = `${accErr}（已自动暂停后台定时检查，避免反复触碰延长冷却；在微信读书解除验证后可重新开启定时）`;
            }
          }
          break;
        }

        const parsed = parseWeReadArticlesResponse(pageRes.data, {
          bookId: acc.bookId,
          accountHint: acc.name,
        });

        if (parsed.rawGroupCount === 0) break;
        offset += parsed.rawGroupCount;

        // Backfill real account name
        if (parsed.items[0]?.account && parsed.items[0].account !== "未知公众号") {
          if (!acc.name || acc.name === acc.bookId || acc.name === "未知公众号") {
            acc.name = parsed.items[0].account;
          }
        }
        if (parsed.items[0]?.date && (!newestSeenDate || parsed.items[0].date >= newestSeenDate)) {
          newestSeenDate = parsed.items[0].date;
          newestSeenTitle = parsed.items[0].title || newestSeenTitle;
        }

        let unseenOnThisPage = 0;
        let allOlderThanSince = Boolean(acc.since) && parsed.items.length > 0;

        for (const item of parsed.items) {
          if (acc.since && item.date && item.date >= acc.since) {
            allOlderThanSince = false;
          } else if (acc.since && !item.date) {
            allOlderThanSince = false;
          }
          if (acc.since && item.date && item.date < acc.since) continue;

          const uid = parseWechatUrlIdentity(item.url || "");
          const probe = {
            reviewId: item.reviewId,
            sourceUrl: uid.canonicalUrl || item.url || "",
            articleKey: uid.articleKey || "",
            account: item.account,
            date: item.date,
            publishedAt: item.publishedAt || "",
            title: item.title,
          };
          const dup = store.findDuplicate({
            meta: probe,
            contentHash: "",
          });
          const knownEmpty = store.findKnownEmpty(probe);

          if (!dup.duplicate && !knownEmpty.knownEmpty) {
            unseenOnThisPage++;
            newItems.push({ ...item, biz: acc.biz || "" });
            if (newItems.length >= effMaxPerAccount) break;
          }
        }

        // Fast early stop: if this entire page is already archived locally, no need to check older pages!
        if (unseenOnThisPage === 0 || allOlderThanSince || newItems.length >= effMaxPerAccount) {
          break;
        }
      }

      const nowIso = formatLocalIsoNow();
      acc.lastCheckedAt = nowIso;
      if (newestSeenDate) acc.lastArticleDate = newestSeenDate;
      if (newestSeenTitle) acc.lastArticleTitle = newestSeenTitle;

      if (accStopped) {
        acc.lastStatus = runSummary.needsLogin ? "needs_login" : "rate_limited";
        acc.lastError = accErr;
        acc.lastRunAdded = 0;
        runSummary.errors++;
        runSummary.accountResults.push({
          bookId: acc.bookId,
          name: acc.name,
          status: acc.lastStatus,
          added: 0,
          error: accErr,
        });
        if (onProgress) {
          onProgress({ phase: "weread_warn", message: `⚠️ 「${acc.name}」检查中断：${accErr}` });
        }
        if (runSummary.stoppedEarly) break;
        continue;
      }

      runSummary.accountsChecked++;

      if (newItems.length === 0) {
        acc.lastStatus = "up_to_date";
        acc.lastError = "";
        acc.lastRunAdded = 0;
        runSummary.accountResults.push({
          bookId: acc.bookId,
          name: acc.name,
          status: "up_to_date",
          added: 0,
        });
        if (onProgress) {
          onProgress({
            phase: "sub",
            message: `✓ 「${acc.name}」已是最新（暂无新文章，跳过正文拉取）`,
          });
        }
        continue;
      }

      if (onProgress) {
        onProgress({
          phase: "sub_new",
          message: `发现「${acc.name}」有 ${newItems.length} 篇新文章！开始自动下载并清洗入库...`,
        });
      }

      // Close outer session temporarily or run syncWeReadAccounts with prefetchedItems
      session.close();
      const syncRes = await syncWeReadAccounts([], {
        outputDir: store.outputDir,
        delayMs: effDelayMs,
        maxArticles: effMaxPerAccount,
        downloadImages: effDownloadImages,
        saveJsonl: effSaveJsonl,
        extraTags: acc.tags || [],
        prefetchedItems: newItems,
        signal,
        onProgress,
      });

      // Reload store after syncWeReadAccounts flushed
      await store.load();

      acc.lastRunAdded = (syncRes.saved || 0) + (syncRes.updated || 0);
      acc.totalSynced = store.data.articles.filter(
        (a) => a.weread_book_id === acc.bookId || (acc.biz && a.biz === acc.biz)
      ).length;

      runSummary.saved += syncRes.saved || 0;
      runSummary.updated += syncRes.updated || 0;
      runSummary.skipped += syncRes.skipped || 0;
      runSummary.filteredOut += syncRes.filteredOut || 0;
      runSummary.errors += syncRes.errors || 0;
      runSummary.totalNewArticles += acc.lastRunAdded;

      for (const it of syncRes.items || []) {
        if (it.status === "saved" || it.status === "updated") {
          runSummary.newArticles.push({
            account: acc.name,
            bookId: acc.bookId,
            title: it.title,
            date: it.date,
            relativePath: it.relativePath,
          });
        }
      }

      if (syncRes.stoppedEarly) {
        acc.lastStatus = syncRes.needsLogin ? "needs_login" : "rate_limited";
        acc.lastError = syncRes.stopReason || "";
        runSummary.stoppedEarly = true;
        runSummary.stopReason = syncRes.stopReason || "";
        runSummary.accountResults.push({
          bookId: acc.bookId,
          name: acc.name,
          status: acc.lastStatus,
          added: acc.lastRunAdded,
          error: acc.lastError,
        });
        break;
      } else {
        acc.lastStatus = acc.lastRunAdded > 0 ? "updated" : "up_to_date";
        acc.lastError = "";
        runSummary.accountResults.push({
          bookId: acc.bookId,
          name: acc.name,
          status: acc.lastStatus,
          added: acc.lastRunAdded,
        });
      }

      // Reconnect session if there are more accounts to check
      if (idx + 1 < targets.length) {
        await session.connect({ autoLaunch: false, bringToFront: false });
      }
    }

    runSummary.finishedAt = formatLocalIsoNow();
    if (!bookId) {
      data.scheduler.lastGlobalCheckAt = runSummary.finishedAt;
    }
    data.recentRuns.unshift({
      trigger,
      at: runSummary.finishedAt,
      accountsChecked: runSummary.accountsChecked,
      newArticles: runSummary.totalNewArticles,
      errors: runSummary.errors,
      stoppedEarly: runSummary.stoppedEarly,
      stopReason: runSummary.stopReason,
      titles: runSummary.newArticles.slice(0, 8).map((a) => `${a.account}: ${a.title}`),
    });
    data.recentRuns = data.recentRuns.slice(0, 30);

    await saveSubscriptions(data);

    // Optional realtime bot push when new subscribed articles arrive
    if (runSummary.newArticles.length > 0) {
      try {
        const pushRes = await triggerNewArticlesPush(runSummary.newArticles, {
          outputDir: store.outputDir,
          trigger,
        });
        if (pushRes) {
          runSummary.pushResult = pushRes;
          if (onProgress) {
            onProgress({
              phase: pushRes.failed > 0 ? "weread_warn" : "sub_new",
              message: `📣 已触发新文实时推送（${runSummary.newArticles.length} 篇｜成功 ${pushRes.sent} 个通道｜失败 ${pushRes.failed} 个）`,
            });
          }
        }
      } catch (err) {
        if (onProgress) {
          onProgress({ phase: "weread_warn", message: `⚠️ 实时推送异常：${err?.message || err}` });
        }
      }
    }

    return runSummary;
  } finally {
    session.close();
  }
}
