/**
 * Multi-Channel Bot Push & Scheduled Daily Digest Engine (Zero external dependencies)
 *
 * Official, compliant webhook/message adapters:
 *  - wecom          : 企业微信内部群机器人 Webhook (markdown, auto UTF-8 4096-byte chunking)
 *  - feishu         : 飞书群机器人 Webhook (interactive card + optional HMAC-SHA256 signing)
 *  - dingtalk       : 钉钉群机器人 Webhook (markdown + optional HMAC-SHA256 signing)
 *  - wxpusher       : WxPusher 个人微信官方模板直推 (markdown -> personal WeChat)
 *  - custom_webhook : 通用 JSON Webhook (n8n / Zapier / Bark / Telegram relay / 自建服务)
 *
 * Plus built-in plain-text WeChat group copy formatter ("wechatGroupText") for safe manual paste.
 * All secrets & webhook URLs are stored strictly locally in gitignored `data/push-config.json`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ArticleIndexStore } from "./dedup.mjs";
import { DATA_DIR } from "./weread-cdp.mjs";
import { DEFAULT_OUTPUT_DIR } from "./pipeline.mjs";

export const PUSH_CONFIG_PATH = path.join(DATA_DIR, "push-config.json");

export const CHANNEL_TYPES = {
  wecom: { label: "企业微信群机器人", short: "企微群" },
  feishu: { label: "飞书群机器人", short: "飞书群" },
  dingtalk: { label: "钉钉群机器人", short: "钉钉群" },
  wxpusher: { label: "WxPusher（个人微信直推）", short: "个人微信" },
  custom_webhook: { label: "通用自定义 Webhook", short: "Webhook" },
};

function getShanghaiNowParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const hhmm = `${get("hour")}:${get("minute")}`;
  const iso = `${date}T${hhmm}:${get("second")}+08:00`;
  return { date, hhmm, iso };
}

function defaultPushConfig() {
  return {
    version: "1.0",
    updated_at: "",
    settings: {
      pushOnNewArticles: false,
      dailyDigestEnabled: false,
      syncBeforeDigest: true,
      dailyDigestTime: "21:00",
      lookbackHours: 24,
      maxArticlesPerDigest: 20,
      excerptChars: 160,
      includeSummary: true,
      onlyAccounts: [],
      lastDigestDate: "",
      lastDigestAt: "",
    },
    channels: [],
    history: [],
  };
}

function normalizeChannel(raw) {
  const type = CHANNEL_TYPES[raw?.type] ? raw.type : "wecom";
  const topicIds = Array.isArray(raw?.topicIds)
    ? raw.topicIds.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n > 0)
    : String(raw?.topicIds || "")
        .split(/[\s,，;；]+/)
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n > 0);
  const uids = Array.isArray(raw?.uids)
    ? raw.uids.map((x) => String(x).trim()).filter(Boolean)
    : String(raw?.uids || "")
        .split(/[\s,，;；]+/)
        .map((x) => x.trim())
        .filter(Boolean);

  return {
    id: String(raw?.id || `ch_${crypto.randomBytes(4).toString("hex")}`).trim(),
    name: String(raw?.name || CHANNEL_TYPES[type].label).trim(),
    type,
    enabled: raw?.enabled !== false,
    webhookUrl: String(raw?.webhookUrl || "").trim(),
    secret: String(raw?.secret || "").trim(),
    appToken: String(raw?.appToken || "").trim(),
    topicIds,
    uids,
    createdAt: raw?.createdAt || getShanghaiNowParts().iso,
    lastSentAt: raw?.lastSentAt || "",
    lastStatus: raw?.lastStatus || "idle",
    lastError: raw?.lastError || "",
  };
}

export function maskTargetHint(ch) {
  if (!ch) return "";
  if (ch.type === "wxpusher") {
    const tok = ch.appToken ? `${ch.appToken.slice(0, 6)}...${ch.appToken.slice(-4)}` : "未填 appToken";
    const dest = [];
    if (ch.topicIds?.length) dest.push(`主题 ${ch.topicIds.join(",")}`);
    if (ch.uids?.length) dest.push(`${ch.uids.length} 个 UID`);
    return `${tok}${dest.length ? ` · ${dest.join(" / ")}` : ""}`;
  }
  const url = String(ch.webhookUrl || "").trim();
  if (!url) return "未配置 Webhook URL";
  try {
    const u = new URL(url);
    const keyParam = u.searchParams.get("key") || u.searchParams.get("access_token") || "";
    if (keyParam && keyParam.length > 10) {
      return `${u.host}${u.pathname}?...${keyParam.slice(-6)}`;
    }
    const seg = u.pathname.split("/").filter(Boolean);
    const tail = seg[seg.length - 1] || "";
    if (tail.length > 12) {
      return `${u.host}/.../${tail.slice(0, 4)}***${tail.slice(-4)}`;
    }
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 28) + (url.length > 28 ? "..." : "");
  }
}

export async function loadPushConfig() {
  const def = defaultPushConfig();
  try {
    const raw = await fs.readFile(PUSH_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const s = parsed.settings || {};
    const timeMatch = String(s.dailyDigestTime || "21:00").match(/^(\d{2}):(\d{2})$/);
    return {
      version: "1.0",
      updated_at: parsed.updated_at || "",
      settings: {
        pushOnNewArticles: Boolean(s.pushOnNewArticles),
        dailyDigestEnabled: Boolean(s.dailyDigestEnabled),
        syncBeforeDigest: s.syncBeforeDigest !== false,
        dailyDigestTime: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : "21:00",
        lookbackHours: Math.max(1, Math.min(168, Number(s.lookbackHours) || 24)),
        maxArticlesPerDigest: Math.max(1, Math.min(50, Number(s.maxArticlesPerDigest) || 20)),
        excerptChars: Math.max(0, Math.min(600, Number(s.excerptChars ?? 160))),
        includeSummary: s.includeSummary !== false,
        onlyAccounts: Array.isArray(s.onlyAccounts) ? s.onlyAccounts.map((x) => String(x).trim()).filter(Boolean) : [],
        lastDigestDate: String(s.lastDigestDate || ""),
        lastDigestAt: String(s.lastDigestAt || ""),
      },
      channels: Array.isArray(parsed.channels) ? parsed.channels.map(normalizeChannel) : [],
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 30) : [],
    };
  } catch {
    return def;
  }
}

export async function savePushConfig(cfg) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  cfg.updated_at = getShanghaiNowParts().iso;
  await fs.writeFile(PUSH_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

export async function updatePushSettings(patch = {}) {
  const cfg = await loadPushConfig();
  const s = cfg.settings;
  if (typeof patch.pushOnNewArticles === "boolean") s.pushOnNewArticles = patch.pushOnNewArticles;
  if (typeof patch.dailyDigestEnabled === "boolean") s.dailyDigestEnabled = patch.dailyDigestEnabled;
  if (typeof patch.syncBeforeDigest === "boolean") s.syncBeforeDigest = patch.syncBeforeDigest;
  if (typeof patch.dailyDigestTime === "string" && /^\d{2}:\d{2}$/.test(patch.dailyDigestTime.trim())) {
    s.dailyDigestTime = patch.dailyDigestTime.trim();
  }
  if (patch.lookbackHours !== undefined) {
    s.lookbackHours = Math.max(1, Math.min(168, Number(patch.lookbackHours) || 24));
  }
  if (patch.maxArticlesPerDigest !== undefined) {
    s.maxArticlesPerDigest = Math.max(1, Math.min(50, Number(patch.maxArticlesPerDigest) || 20));
  }
  if (patch.excerptChars !== undefined) {
    s.excerptChars = Math.max(0, Math.min(600, Number(patch.excerptChars)));
  }
  if (typeof patch.includeSummary === "boolean") s.includeSummary = patch.includeSummary;
  if (Array.isArray(patch.onlyAccounts)) {
    s.onlyAccounts = patch.onlyAccounts.map((x) => String(x).trim()).filter(Boolean);
  }
  return await savePushConfig(cfg);
}

export async function upsertPushChannel(input) {
  const cfg = await loadPushConfig();
  const ch = normalizeChannel(input);

  if (ch.type === "wxpusher") {
    if (!ch.appToken) throw new Error("WxPusher 通道必须填写 AppToken（AT_...）");
    if (ch.topicIds.length === 0 && ch.uids.length === 0) {
      throw new Error("WxPusher 通道请至少填写一个 TopicID（主题 ID）或 UID（用户 ID）");
    }
  } else {
    if (!/^https?:\/\//i.test(ch.webhookUrl)) {
      throw new Error("请填写以 http:// 或 https:// 开头的有效 Webhook URL");
    }
  }

  const idx = cfg.channels.findIndex((c) => c.id === ch.id);
  if (idx >= 0) {
    cfg.channels[idx] = {
      ...cfg.channels[idx],
      ...ch,
      createdAt: cfg.channels[idx].createdAt,
    };
  } else {
    cfg.channels.push(ch);
  }
  await savePushConfig(cfg);
  return { channel: idx >= 0 ? cfg.channels[idx] : ch, config: cfg };
}

export async function togglePushChannel(id, enabled) {
  const cfg = await loadPushConfig();
  const target = cfg.channels.find((c) => c.id === id);
  if (!target) throw new Error(`未找到推送通道：${id}`);
  target.enabled = typeof enabled === "boolean" ? enabled : !target.enabled;
  await savePushConfig(cfg);
  return { channel: target, config: cfg };
}

export async function removePushChannel(id) {
  const cfg = await loadPushConfig();
  const before = cfg.channels.length;
  cfg.channels = cfg.channels.filter((c) => c.id !== id);
  await savePushConfig(cfg);
  return { removed: before - cfg.channels.length, config: cfg };
}

export async function getPushSummary() {
  const cfg = await loadPushConfig();
  const enabledCount = cfg.channels.filter((c) => c.enabled).length;
  return {
    totalChannels: cfg.channels.length,
    enabledChannels: enabledCount,
    pushOnNewArticles: cfg.settings.pushOnNewArticles,
    dailyDigestEnabled: cfg.settings.dailyDigestEnabled,
    dailyDigestTime: cfg.settings.dailyDigestTime,
    lastDigestDate: cfg.settings.lastDigestDate,
    lastDigestAt: cfg.settings.lastDigestAt,
  };
}

/**
 * Split long markdown text into clean UTF-8 byte-safe chunks (critical for WeCom's 4096-byte limit).
 */
export function chunkTextByUtf8Bytes(text, maxBytes = 3800) {
  const full = String(text || "").trim();
  if (!full) return [];
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return [full];

  const blocks = full.split(/\n{2,}/);
  const chunks = [];
  let current = "";

  const flush = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
  };

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    // If a single block exceeds maxBytes, split by lines
    if (Buffer.byteLength(block, "utf8") > maxBytes) {
      flush();
      const lines = block.split("\n");
      let sub = "";
      for (const line of lines) {
        const candidate = sub ? `${sub}\n${line}` : line;
        if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
          if (sub) chunks.push(sub.trim());
          // Hard slice if single line is gigantic
          let rem = line;
          while (Buffer.byteLength(rem, "utf8") > maxBytes) {
            let cut = Math.floor(maxBytes / 3);
            while (cut < rem.length && Buffer.byteLength(rem.slice(0, cut + 1), "utf8") <= maxBytes) {
              cut++;
            }
            chunks.push(rem.slice(0, Math.max(1, cut)));
            rem = rem.slice(Math.max(1, cut));
          }
          sub = rem;
        } else {
          sub = candidate;
        }
      }
      if (sub.trim()) chunks.push(sub.trim());
      continue;
    }

    const candidate = current ? `${current}\n\n${block}` : block;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) {
      flush();
      current = block;
    } else {
      current = candidate;
    }
  }
  flush();

  if (chunks.length > 1) {
    return chunks.map((c, idx) => `${c}\n\n> (${idx + 1}/${chunks.length})`);
  }
  return chunks;
}

/**
 * Extract a clean plain-text excerpt from a saved cleaned Markdown file.
 */
async function readMarkdownExcerpt(fullPath, maxChars = 160) {
  if (!fullPath || maxChars <= 0) return "";
  try {
    let text = await fs.readFile(fullPath, "utf8");
    // Strip YAML frontmatter
    if (text.startsWith("---")) {
      const end = text.indexOf("\n---", 3);
      if (end > 0) text = text.slice(end + 4);
    }
    // Remove leading H1 title & metadata blockquote lines
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => {
        if (!l) return false;
        if (/^#\s+/.test(l)) return false;
        if (/^>\s*(?:公众号|作者|发布时间|来源|阅读)/.test(l)) return false;
        if (/^!\[[^\]]*\]\([^)]+\)$/.test(l)) return false;
        if (/^[-*_]{3,}$/.test(l)) return false;
        return true;
      });
    let plain = lines
      .join(" ")
      .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_~#>]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length > maxChars) {
      plain = `${plain.slice(0, maxChars).trim()}…`;
    }
    return plain;
  } catch {
    return "";
  }
}

function parseArticleTimestampMs(art) {
  const raw = String(art?.published_at || art?.publishedAt || art?.date || "").trim();
  if (!raw) return 0;
  // Normalize "YYYY-MM-DD HH:mm" or "YYYY-MM-DD" as Asia/Shanghai (+08:00)
  const mFull = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (mFull) {
    const dt = new Date(`${mFull[1]}T${mFull[2]}:${mFull[3] || "00"}+08:00`);
    return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
  }
  const mDate = raw.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (mDate) {
    const dt = new Date(`${mDate[1]}T12:00:00+08:00`);
    return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
  }
  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? 0 : fallback.getTime();
}

/**
 * Build a multi-format digest (Markdown for bots + plain text for personal WeChat groups)
 * either from an explicit `explicitArticles` list (realtime new-article push) or from recent archived articles.
 */
export async function buildArticlesDigest({
  outputDir = DEFAULT_OUTPUT_DIR,
  hours = 24,
  accounts = [],
  maxArticles = 20,
  excerptChars = 160,
  includeSummary = true,
  explicitArticles = null,
  titlePrefix = "",
} = {}) {
  const { date: todayStr, hhmm } = getShanghaiNowParts();
  const store = new ArticleIndexStore(outputDir);
  await store.load();

  let selected = [];
  if (Array.isArray(explicitArticles) && explicitArticles.length > 0) {
    // Hydrate from index store when possible so we have word_count, read_num, relative_path, source_url
    for (const item of explicitArticles) {
      const hit = store.data.articles.find(
        (a) =>
          (item.relativePath && a.relative_path === item.relativePath) ||
          (item.relative_path && a.relative_path === item.relative_path) ||
          (item.title && a.title === item.title && (!item.account || a.account === item.account))
      );
      selected.push(
        hit || {
          title: item.title || "未命名文章",
          account: item.account || "未知公众号",
          date: item.date || todayStr,
          published_at: item.published_at || item.date || todayStr,
          relative_path: item.relativePath || item.relative_path || "",
          source_url: item.url || item.source_url || "",
          read_num: item.read_num ?? item.readNum ?? null,
          like_num: item.like_num ?? item.likeNum ?? null,
          word_count: item.word_count ?? 0,
        }
      );
    }
  } else {
    const cutoffMs = Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000;
    const accFilter = new Set((accounts || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    const sorted = [...(store.data.articles || [])].sort((a, b) => {
      const ta = parseArticleTimestampMs(a);
      const tb = parseArticleTimestampMs(b);
      if (tb !== ta) return tb - ta;
      return String(b.fetched_at || "").localeCompare(String(a.fetched_at || ""));
    });

    for (const a of sorted) {
      if (accFilter.size > 0 && !accFilter.has(String(a.account || "").toLowerCase())) continue;
      const pubMs = parseArticleTimestampMs(a);
      const fetchedMs = a.fetched_at ? new Date(a.fetched_at).getTime() : 0;
      const effectiveMs = Math.max(pubMs, Number.isNaN(fetchedMs) ? 0 : fetchedMs);
      if (effectiveMs >= cutoffMs) {
        selected.push(a);
      }
      if (selected.length >= maxArticles) break;
    }

    // If strict lookback window matched 0 (e.g. user clicked preview on a quiet day), keep selected empty
    // so caller can decide whether to show "no new articles" or fallback preview
  }

  selected = selected.slice(0, Math.max(1, Number(maxArticles) || 20));

  const enriched = [];
  for (const a of selected) {
    const fullPath = a.relative_path ? path.resolve(store.outputDir, a.relative_path) : "";
    const excerpt = includeSummary && excerptChars > 0 ? await readMarkdownExcerpt(fullPath, excerptChars) : "";
    enriched.push({
      account: a.account || "未知公众号",
      title: a.title || "未命名文章",
      date: a.date || todayStr,
      publishedAt: a.published_at || a.date || todayStr,
      wordCount: Number(a.word_count || 0),
      readNum: typeof a.read_num === "number" ? a.read_num : null,
      likeNum: typeof a.like_num === "number" ? a.like_num : null,
      sourceUrl: a.source_url || "",
      relativePath: a.relative_path || "",
      excerpt,
    });
  }

  // Group by account while preserving order of appearance
  const byAccount = new Map();
  for (const art of enriched) {
    if (!byAccount.has(art.account)) byAccount.set(art.account, []);
    byAccount.get(art.account).push(art);
  }

  const headerTitle =
    titlePrefix ||
    (explicitArticles
      ? `公众号订阅新文速递（${todayStr} ${hhmm}）`
      : `公众号订阅日报（${todayStr}）`);

  const mdLines = [
    `## ${headerTitle}`,
    `> 共收录 **${enriched.length}** 篇（涉及 **${byAccount.size}** 个公众号 · 窗口：${
      explicitArticles ? "实时新增" : `近 ${hours} 小时`
    }）`,
    "",
  ];

  const wxLines = [
    `【${headerTitle}】`,
    `共 ${enriched.length} 篇 · ${byAccount.size} 个公众号（${explicitArticles ? "最新推送" : `近 ${hours} 小时`}）`,
    "————————————",
  ];

  let seq = 1;
  for (const [accName, list] of byAccount.entries()) {
    mdLines.push(`### ${accName}（${list.length} 篇）`);
    wxLines.push(`\n▸ ${accName}（${list.length} 篇）`);
    for (const art of list) {
      const stats = [];
      if (art.publishedAt) stats.push(art.publishedAt);
      if (art.wordCount > 0) stats.push(`${art.wordCount}字`);
      if (typeof art.readNum === "number" && art.readNum > 0) stats.push(`阅读 ${art.readNum}`);
      const metaLine = stats.length ? ` (${stats.join(" · ")})` : "";

      // Only hyperlink real mp.weixin.qq.com URLs (WeRead synthetic /s/WR... URLs don't open directly in WeChat)
      const isDirectLink = art.sourceUrl && !/\/s\/WR[A-Za-z0-9_-]{12,}/.test(art.sourceUrl);
      const mdTitle = isDirectLink ? `[${art.title}](${art.sourceUrl})` : `**${art.title}**`;

      mdLines.push(`${seq}. ${mdTitle}${metaLine}`);
      if (art.excerpt) {
        mdLines.push(`   > ${art.excerpt}`);
      }

      wxLines.push(`${seq}. 《${art.title}》${metaLine}`);
      if (art.excerpt) {
        wxLines.push(`   摘要：${art.excerpt}`);
      }
      if (isDirectLink) {
        wxLines.push(`   链接：${art.sourceUrl}`);
      }
      seq++;
    }
    mdLines.push("");
  }

  if (enriched.length === 0) {
    mdLines.push(`近 ${hours} 小时暂无新入库文章。`);
    wxLines.push(`近 ${hours} 小时暂无新入库文章。`);
  }

  return {
    title: headerTitle,
    generatedAt: getShanghaiNowParts().iso,
    date: todayStr,
    hours,
    articleCount: enriched.length,
    accountCount: byAccount.size,
    articles: enriched,
    markdown: mdLines.join("\n").trim(),
    wechatGroupText: wxLines.join("\n").trim(),
    outputDir: store.outputDir,
  };
}

/**
 * Low-level official channel dispatchers
 */
async function postJson(url, body, timeoutMs = 15000) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function sendToWeCom(ch, markdown) {
  const chunks = chunkTextByUtf8Bytes(markdown, 3800);
  for (const part of chunks) {
    const r = await postJson(ch.webhookUrl, {
      msgtype: "markdown",
      markdown: { content: part },
    });
    if (!r.ok || (r.json && Number(r.json.errcode) !== 0)) {
      throw new Error(`企业微信返回错误 (${r.json?.errcode ?? r.status}): ${r.json?.errmsg || r.text.slice(0, 120)}`);
    }
  }
  return { chunks: chunks.length, message: `已推送 ${chunks.length} 条企微 Markdown 消息` };
}

/**
 * Convert standard Markdown into Feishu Interactive Card v1 Markdown subset
 * (Feishu cards do NOT render `##` headings or `>` blockquotes — they show them literally!).
 */
export function toFeishuCardMarkdown(markdown, cardTitle = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const out = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    // Skip redundant top H2 if it duplicates the card header title
    if (cardTitle && /^##\s+/.test(trimmed) && trimmed.replace(/^##\s+/, "").trim() === cardTitle.trim()) {
      continue;
    }
    if (/^###\s+(.+)/.test(trimmed)) {
      const text = trimmed.replace(/^###\s+/, "").trim();
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(`**📌 ${text}**`);
      continue;
    }
    if (/^##\s+(.+)/.test(trimmed)) {
      const text = trimmed.replace(/^##\s+/, "").trim();
      out.push(`**${text}**`);
      continue;
    }
    if (/^>\s*(.+)/.test(trimmed)) {
      const text = trimmed.replace(/^>\s*/, "").trim();
      out.push(`<font color='grey'>${text}</font>`);
      continue;
    }
    out.push(raw);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function sendToFeishu(ch, title, markdown) {
  const feishuMd = toFeishuCardMarkdown(markdown, title);
  const chunks = chunkTextByUtf8Bytes(feishuMd, 15000);
  for (let i = 0; i < chunks.length; i++) {
    const cardTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title;
    const payload = {
      msg_type: "interactive",
      card: {
        header: {
          template: "turquoise",
          title: { tag: "plain_text", content: cardTitle },
        },
        elements: [{ tag: "markdown", content: chunks[i] }],
      },
    };
    if (ch.secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      const sign = crypto.createHmac("sha256", `${ts}\n${ch.secret}`).update("").digest("base64");
      payload.timestamp = ts;
      payload.sign = sign;
    }
    const r = await postJson(ch.webhookUrl, payload);
    const code = r.json?.code ?? r.json?.StatusCode;
    if (!r.ok || (code !== undefined && Number(code) !== 0)) {
      throw new Error(`飞书返回错误 (${code ?? r.status}): ${r.json?.msg || r.json?.StatusMessage || r.text.slice(0, 120)}`);
    }
  }
  return { chunks: chunks.length, message: `已推送 ${chunks.length} 张飞书卡片消息` };
}

async function sendToDingTalk(ch, title, markdown) {
  const chunks = chunkTextByUtf8Bytes(markdown, 12000);
  for (let i = 0; i < chunks.length; i++) {
    let targetUrl = ch.webhookUrl;
    if (ch.secret) {
      const ts = String(Date.now());
      const sign = encodeURIComponent(
        crypto.createHmac("sha256", ch.secret).update(`${ts}\n${ch.secret}`).digest("base64")
      );
      targetUrl += (targetUrl.includes("?") ? "&" : "?") + `timestamp=${ts}&sign=${sign}`;
    }
    const r = await postJson(targetUrl, {
      msgtype: "markdown",
      markdown: {
        title: chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title,
        text: chunks[i],
      },
    });
    if (!r.ok || (r.json && Number(r.json.errcode) !== 0)) {
      throw new Error(`钉钉返回错误 (${r.json?.errcode ?? r.status}): ${r.json?.errmsg || r.text.slice(0, 120)}`);
    }
  }
  return { chunks: chunks.length, message: `已推送 ${chunks.length} 条钉钉 Markdown 消息` };
}

async function sendToWxPusher(ch, title, markdown) {
  const payload = {
    appToken: ch.appToken,
    content: markdown,
    summary: title.slice(0, 96),
    contentType: 3, // Markdown
    topicIds: ch.topicIds || [],
    uids: ch.uids || [],
    verifyPayType: 0,
  };
  const r = await postJson("https://wxpusher.zjiecode.com/api/send/message", payload);
  if (!r.ok || (r.json && Number(r.json.code) !== 1000 && r.json.success !== true)) {
    throw new Error(`WxPusher 返回错误 (${r.json?.code ?? r.status}): ${r.json?.msg || r.text.slice(0, 120)}`);
  }
  return { chunks: 1, message: "已推送至个人微信（WxPusher）" };
}

async function sendToCustomWebhook(ch, payloadObj) {
  const r = await postJson(ch.webhookUrl, payloadObj);
  if (!r.ok) {
    throw new Error(`自定义 Webhook 返回 HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  }
  return { chunks: 1, message: `已推送至自定义 Webhook (HTTP ${r.status})` };
}

export async function dispatchToSingleChannel(ch, { title, markdown, plainText, articles = [], event = "digest" }) {
  if (ch.type === "wecom") return await sendToWeCom(ch, markdown);
  if (ch.type === "feishu") return await sendToFeishu(ch, title, markdown);
  if (ch.type === "dingtalk") return await sendToDingTalk(ch, title, markdown);
  if (ch.type === "wxpusher") return await sendToWxPusher(ch, title, markdown);
  return await sendToCustomWebhook(ch, {
    event,
    title,
    generatedAt: getShanghaiNowParts().iso,
    articleCount: articles.length,
    markdown,
    plainText,
    articles,
  });
}

/**
 * Send a test notification to a saved channel (by id) or an unsaved channel config object.
 */
export async function sendTestPush(channelIdOrObj) {
  const cfg = await loadPushConfig();
  let ch = null;
  let persistIdx = -1;
  if (typeof channelIdOrObj === "string") {
    persistIdx = cfg.channels.findIndex((c) => c.id === channelIdOrObj);
    if (persistIdx < 0) throw new Error(`未找到推送通道：${channelIdOrObj}`);
    ch = cfg.channels[persistIdx];
  } else {
    ch = normalizeChannel(channelIdOrObj);
  }

  const { date, hhmm } = getShanghaiNowParts();
  const title = `微信文章工作台 · 推送连通测试 (${date} ${hhmm})`;
  const markdown = [
    `## ${title}`,
    `> 通道：**${ch.name}**（${CHANNEL_TYPES[ch.type]?.label || ch.type}）`,
    "",
    "- 状态：**连通成功**",
    "- 后续当订阅公众号有新文章，或到达每日定时日报时间时，系统会自动将清洗后的精选摘要推送到这里。",
  ].join("\n");
  const plainText = `【${title}】\n通道：${ch.name}\n状态：连通成功！后续将按设定自动推送订阅日报。`;

  try {
    const res = await dispatchToSingleChannel(ch, { title, markdown, plainText, articles: [], event: "test" });
    if (persistIdx >= 0) {
      cfg.channels[persistIdx].lastSentAt = getShanghaiNowParts().iso;
      cfg.channels[persistIdx].lastStatus = "ok";
      cfg.channels[persistIdx].lastError = "";
      await savePushConfig(cfg);
    }
    return { ok: true, channelId: ch.id, name: ch.name, type: ch.type, ...res };
  } catch (err) {
    const msg = String(err?.message || err);
    if (persistIdx >= 0) {
      cfg.channels[persistIdx].lastSentAt = getShanghaiNowParts().iso;
      cfg.channels[persistIdx].lastStatus = "error";
      cfg.channels[persistIdx].lastError = msg;
      await savePushConfig(cfg);
    }
    return { ok: false, channelId: ch.id, name: ch.name, type: ch.type, error: msg };
  }
}

/**
 * Push a prepared digest or realtime article list to enabled channels and record history.
 */
export async function sendDigestToChannels(digest, { channelIds = [], trigger = "manual", kind = "daily_digest" } = {}) {
  const cfg = await loadPushConfig();
  const targets =
    Array.isArray(channelIds) && channelIds.length > 0
      ? cfg.channels.filter((c) => channelIds.includes(c.id))
      : cfg.channels.filter((c) => c.enabled);

  if (targets.length === 0) {
    return {
      ok: false,
      sent: 0,
      failed: 0,
      results: [],
      error: "尚未配置或启用任何推送通道（请先添加企业微信/飞书/钉钉/WxPusher/自定义 Webhook）",
    };
  }

  const nowIso = getShanghaiNowParts().iso;
  const results = [];
  let sent = 0;
  let failed = 0;

  for (const ch of targets) {
    try {
      const res = await dispatchToSingleChannel(ch, {
        title: digest.title,
        markdown: digest.markdown,
        plainText: digest.wechatGroupText,
        articles: digest.articles || [],
        event: kind,
      });
      ch.lastSentAt = nowIso;
      ch.lastStatus = "ok";
      ch.lastError = "";
      sent++;
      results.push({ channelId: ch.id, name: ch.name, type: ch.type, ok: true, message: res.message });
    } catch (err) {
      const msg = String(err?.message || err);
      ch.lastSentAt = nowIso;
      ch.lastStatus = "error";
      ch.lastError = msg;
      failed++;
      results.push({ channelId: ch.id, name: ch.name, type: ch.type, ok: false, error: msg });
    }
  }

  cfg.history.unshift({
    at: nowIso,
    trigger,
    kind,
    title: digest.title,
    articleCount: digest.articleCount || 0,
    sent,
    failed,
    results,
  });
  cfg.history = cfg.history.slice(0, 30);

  if (kind === "daily_digest" && sent > 0) {
    cfg.settings.lastDigestDate = getShanghaiNowParts().date;
    cfg.settings.lastDigestAt = nowIso;
  }

  await savePushConfig(cfg);
  return { ok: failed === 0 && sent > 0, sent, failed, results };
}

/**
 * Full daily digest pipeline: generate digest, save local `00_每日订阅日报.md`, and optionally push to channels.
 */
export async function runDailyDigestPush({
  outputDir = DEFAULT_OUTPUT_DIR,
  trigger = "manual",
  hours = null,
  accounts = null,
  maxArticles = null,
  channelIds = [],
  previewOnly = false,
  skipIfEmpty = false,
  syncFirst = null,
  onSyncFirst = null,
} = {}) {
  const cfg = await loadPushConfig();
  const s = cfg.settings;

  // Optionally sync subscriptions first so the digest includes today's freshly published articles
  let syncResult = null;
  const shouldSyncFirst = !previewOnly && (syncFirst !== null ? Boolean(syncFirst) : Boolean(s.syncBeforeDigest));
  if (shouldSyncFirst && typeof onSyncFirst === "function") {
    try {
      syncResult = await onSyncFirst();
    } catch {}
  }

  const digest = await buildArticlesDigest({
    outputDir,
    hours: hours ?? s.lookbackHours,
    accounts: accounts ?? s.onlyAccounts,
    maxArticles: maxArticles ?? s.maxArticlesPerDigest,
    excerptChars: s.excerptChars,
    includeSummary: s.includeSummary,
  });

  // Always persist the latest local digest file when there are articles
  let digestFile = "";
  if (digest.articleCount > 0 && !previewOnly) {
    digestFile = path.join(digest.outputDir, "00_每日订阅日报.md");
    await fs.mkdir(digest.outputDir, { recursive: true });
    await fs.writeFile(digestFile, `${digest.markdown}\n`, "utf8").catch(() => {});
  }

  if (previewOnly) {
    return { ok: true, previewOnly: true, digest, digestFile };
  }

  if (skipIfEmpty && digest.articleCount === 0) {
    // Still mark today as checked on scheduled trigger so we don't re-fire every minute
    if (trigger === "scheduled") {
      cfg.settings.lastDigestDate = getShanghaiNowParts().date;
      cfg.settings.lastDigestAt = getShanghaiNowParts().iso;
      await savePushConfig(cfg);
    }
    return {
      ok: true,
      skipped: true,
      reason: "no_new_articles",
      digest,
      digestFile,
      syncResult,
      sent: 0,
      failed: 0,
      results: [],
    };
  }

  const pushRes = await sendDigestToChannels(digest, {
    channelIds,
    trigger,
    kind: "daily_digest",
  });
  return { ...pushRes, digest, digestFile, syncResult };
}

/**
 * Called automatically after `runSubscriptionsCheck` saves new articles when `pushOnNewArticles` is enabled.
 */
export async function triggerNewArticlesPush(newArticles, { outputDir = DEFAULT_OUTPUT_DIR, trigger = "subscription" } = {}) {
  if (!Array.isArray(newArticles) || newArticles.length === 0) return null;
  const cfg = await loadPushConfig();
  if (!cfg.settings.pushOnNewArticles) return null;
  const enabled = cfg.channels.filter((c) => c.enabled);
  if (enabled.length === 0) return null;

  const digest = await buildArticlesDigest({
    outputDir,
    explicitArticles: newArticles,
    maxArticles: cfg.settings.maxArticlesPerDigest,
    excerptChars: cfg.settings.excerptChars,
    includeSummary: cfg.settings.includeSummary,
  });
  return await sendDigestToChannels(digest, { trigger, kind: "realtime_new" });
}

/**
 * Check if the scheduled daily digest should fire right now (called every 60s by web-server.mjs).
 */
export async function checkAndRunScheduledDailyDigest({ outputDir = DEFAULT_OUTPUT_DIR, logger = null, onSyncFirst = null } = {}) {
  const cfg = await loadPushConfig();
  if (!cfg.settings.dailyDigestEnabled) return null;
  const enabled = cfg.channels.filter((c) => c.enabled);
  if (enabled.length === 0) return null;

  const { date: today, hhmm } = getShanghaiNowParts();
  if (cfg.settings.lastDigestDate === today) return null;
  if (hhmm < cfg.settings.dailyDigestTime) return null;

  if (logger) {
    logger(`[每日日报调度] ${hhmm} 触发定时日报推送（近 ${cfg.settings.lookbackHours} 小时）...`);
  }
  const res = await runDailyDigestPush({
    outputDir,
    trigger: "scheduled",
    skipIfEmpty: true,
    onSyncFirst,
  });
  if (logger) {
    if (res.skipped) {
      logger(`[每日日报调度] 近 ${cfg.settings.lookbackHours} 小时暂无新文章，今日跳过群推送。`);
    } else {
      logger(
        `[每日日报调度] 推送完成（收录 ${res.digest?.articleCount || 0} 篇｜成功 ${res.sent || 0} 个通道｜失败 ${res.failed || 0} 个）`
      );
    }
  }
  return res;
}
