/**
 * Shared Pipeline Engine used by CLI, local MCP server, and Web UI server.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectWechatBlockOrUnavailable,
  extractImageUrlsFromHtml,
  extractOutboundLinksFromHtml,
  extractRelatedLinksAndAlbums,
  extractWeReadBodyHtml,
  extractWechatBodyHtml,
  extractWechatMetadata,
  htmlFragmentToMarkdown,
  parseDirtyMarkdownFile,
  parseWechatUrlIdentity,
} from "./html-to-md.mjs";
import { ArticleIndexStore, sanitizeFilename } from "./dedup.mjs";
import {
  downloadImagesLocally,
  extractUrlsFromInput,
  fetchPublicAlbumArticles,
  fetchTextWithRetry,
  politeDelay,
} from "./fetcher.mjs";
import {
  WeReadSession,
  bizToWeReadBookId,
  extractWeReadIdentifiersFromText,
  loadSavedWeReadAccounts,
  parseWeReadArticlesResponse,
  politeDelayAbortable,
  saveWeReadAccount,
} from "./weread-cdp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, "..", "公众号清洗归档");

async function processHtmlString(
  html,
  {
    sourceUrl = "",
    fileName = "",
    accountHint = "",
    store,
    outputDir,
    downloadImages = false,
    force = false,
    extraTags = [],
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    onlyOriginal = false,
    minWords = 0,
    dateFrom = "",
    dateTo = "",
  }
) {
  const check = detectWechatBlockOrUnavailable(html);
  if (check.blocked) {
    return {
      status: "blocked",
      reason: check.reason,
      message: check.message,
      sourceUrl,
    };
  }

  const meta = extractWechatMetadata(html, { sourceUrl, fileName });
  if (!meta.account && accountHint) meta.account = accountHint;

  if (dateFrom && meta.date && meta.date < dateFrom) {
    return { status: "filtered_out", reason: `date_before_${dateFrom}`, meta, sourceUrl: meta.sourceUrl || sourceUrl };
  }
  if (dateTo && meta.date && meta.date > dateTo) {
    return { status: "filtered_out", reason: `date_after_${dateTo}`, meta, sourceUrl: meta.sourceUrl || sourceUrl };
  }
  if (onlyOriginal && !meta.isOriginal) {
    return { status: "filtered_out", reason: "not_original", meta, sourceUrl: meta.sourceUrl || sourceUrl };
  }

  const bodyHtml = extractWechatBodyHtml(html);

  let imageUrlMap = null;
  if (downloadImages) {
    const imgUrls = extractImageUrlsFromHtml(bodyHtml);
    if (imgUrls.length > 0) {
      const accountDir = path.join(outputDir, sanitizeFilename(meta.account || "未知公众号", 50));
      const slug = `${meta.date || "0000-00-00"}_${sanitizeFilename(meta.title || "article", 50)}`;
      const assetsDir = path.join(accountDir, "assets", slug);
      imageUrlMap = await downloadImagesLocally(imgUrls, {
        assetsDir,
        relativeBaseDir: accountDir,
      });
    }
  }

  const body = htmlFragmentToMarkdown(bodyHtml, { imageUrlMap });
  if (!body || body.trim().length === 0) {
    return {
      status: "error",
      reason: "empty_body",
      message: "正文提取为空",
      sourceUrl: meta.sourceUrl || sourceUrl,
    };
  }

  const wordCount = body.replace(/\s+/g, "").length;
  if (minWords > 0 && wordCount < minWords) {
    return {
      status: "filtered_out",
      reason: `word_count_${wordCount}_lt_${minWords}`,
      meta,
      wordCount,
      sourceUrl: meta.sourceUrl || sourceUrl,
    };
  }

  const saved = await store.saveArticle({
    meta,
    body,
    bodyHtml,
    force,
    extraTags,
    includeDatePrefix,
    includeYaml,
    saveMd,
    saveHtml,
    saveJson,
  });
  return {
    ...saved,
    meta,
    wordCount,
  };
}

export async function fetchSingleArticle(
  url,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    downloadImages = false,
    force = false,
    extraTags = [],
    dateFrom = "",
    dateTo = "",
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    onlyOriginal = false,
    minWords = 0,
    store = null,
    autoFlush = true,
  } = {}
) {
  const activeStore = store || new ArticleIndexStore(outputDir);
  if (!store) await activeStore.load();

  const { status, finalUrl, text } = await fetchTextWithRetry(url);
  if (status !== 200) {
    return { status: "error", reason: `http_${status}`, message: `HTTP 状态码 ${status}`, sourceUrl: url };
  }

  const result = await processHtmlString(text, {
    sourceUrl: finalUrl || url,
    store: activeStore,
    outputDir: activeStore.outputDir,
    downloadImages,
    force,
    extraTags,
    includeDatePrefix,
    includeYaml,
    saveMd,
    saveHtml,
    saveJson,
    onlyOriginal,
    minWords,
    dateFrom,
    dateTo,
  });

  if (autoFlush && (result.status === "saved" || result.status === "updated")) {
    await activeStore.flush();
  }
  return result;
}

export async function fetchAlbum(
  albumUrl,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    maxArticles = 200,
    delayMs = 1500,
    dateFrom = "",
    dateTo = "",
    downloadImages = false,
    force = false,
    extraTags = [],
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    onlyOriginal = false,
    minWords = 0,
    signal = null,
    onProgress = null,
  } = {}
) {
  const album = await fetchPublicAlbumArticles(albumUrl, {
    maxArticles,
    delayMs: Math.min(delayMs, 1500),
    dateFrom,
    dateTo,
  });

  const urls = album.articles.map((a) => a.url);
  const batchResult = await batchFetchInputs(urls, {
    outputDir,
    delayMs,
    dateFrom,
    dateTo,
    maxArticles,
    downloadImages,
    force,
    extraTags,
    includeDatePrefix,
    includeYaml,
    saveMd,
    saveHtml,
    saveJson,
    onlyOriginal,
    minWords,
    signal,
    onProgress,
  });

  return {
    albumId: album.albumId,
    biz: album.biz,
    discovered: album.articles.length,
    ...batchResult,
  };
}

export async function inspectInputs(
  inputs,
  {
    maxArticles = 200,
    dateFrom = "",
    dateTo = "",
    delayMs = 2000,
    discoverRelated = true,
    signal = null,
    onProgress = null,
  } = {}
) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const seedArticleUrls = [];
  const albumQueue = [];
  const seenArticleKeys = new Set();
  const seenAlbumIds = new Set();

  const discoveredItems = [];
  const discoveredAlbums = [];
  const discoveredRelatedLinks = [];
  let stoppedEarly = false;
  let stopReason = "";

  const addArticleItem = (rawUrl, { title = "", date = "", source = "input" } = {}) => {
    const id = parseWechatUrlIdentity(rawUrl);
    if (!id.fetchUrl) return false;
    const key = id.articleKey || id.fetchUrl;
    if (seenArticleKeys.has(key) || seenArticleKeys.has(id.fetchUrl)) return false;
    seenArticleKeys.add(key);
    seenArticleKeys.add(id.fetchUrl);
    discoveredItems.push({ url: id.fetchUrl, title, date, source });
    return true;
  };

  const addAlbumUrl = (rawUrl, title = "") => {
    try {
      const u = new URL(String(rawUrl).replace(/&amp;/g, "&"));
      const aid = u.searchParams.get("album_id");
      if (aid && seenAlbumIds.has(aid)) return false;
      if (aid) seenAlbumIds.add(aid);
    } catch {}
    albumQueue.push({ url: rawUrl, title });
    return true;
  };

  for (const item of list) {
    const extracted = await extractUrlsFromInput(item);
    for (const u of extracted.articleUrls) {
      if (addArticleItem(u, { source: "input" })) {
        seedArticleUrls.push(u);
      }
    }
    for (const au of extracted.albumUrls) {
      addAlbumUrl(au);
    }
  }

  // Auto-discover public album tags & in-article recommended links from seed single articles
  if (discoverRelated && seedArticleUrls.length > 0 && seedArticleUrls.length <= 20) {
    for (let i = 0; i < seedArticleUrls.length; i++) {
      if (signal?.aborted) {
        stoppedEarly = true;
        stopReason = "用户手动中止解析";
        break;
      }
      if (i > 0) await politeDelay(delayMs);
      const url = seedArticleUrls[i];
      if (onProgress) {
        onProgress({ phase: "discover", message: `正在检测单篇文章的公开合集标签与文内推荐链接 (${i + 1}/${seedArticleUrls.length})...` });
      }
      try {
        const { status, finalUrl, text } = await fetchTextWithRetry(url);
        if (status !== 200) continue;
        const check = detectWechatBlockOrUnavailable(text);
        if (check.blocked) {
          if (check.reason === "verification_required") {
            stoppedEarly = true;
            stopReason = check.message;
            break;
          }
          continue;
        }
        const meta = extractWechatMetadata(text, { sourceUrl: finalUrl || url });
        // Backfill title/date on the seed item
        const seedItem = discoveredItems.find((x) => x.url === parseWechatUrlIdentity(url).fetchUrl);
        if (seedItem) {
          if (meta.title) seedItem.title = meta.title;
          if (meta.date) seedItem.date = meta.date;
        }

        const rel = extractRelatedLinksAndAlbums(text, { currentUrl: finalUrl || url, biz: meta.biz });
        for (const alb of rel.albums) {
          if (addAlbumUrl(alb.url, alb.title)) {
            if (onProgress) {
              onProgress({ phase: "discover", message: `发现公开合集标签：#${alb.title} (${alb.albumId})` });
            }
          }
        }
        for (const link of rel.relatedArticles) {
          if (addArticleItem(link.url, { title: link.title, source: "in_article_related" })) {
            discoveredRelatedLinks.push(link);
          }
        }
        if (onProgress && (rel.albums.length > 0 || rel.relatedArticles.length > 0)) {
          onProgress({
            phase: "discover",
            message: `《${meta.title || "当前文章"}》探测到 ${rel.albums.length} 个公开合集、${rel.relatedArticles.length} 条文内关联推荐链接`,
          });
        }
      } catch (err) {
        if (onProgress) onProgress({ phase: "discover", message: `探测单篇链接失败：${err?.message || err}` });
      }
    }
  }

  // Expand all direct + auto-discovered public albums respecting user's delayMs
  for (let i = 0; i < albumQueue.length; i++) {
    if (signal?.aborted || stoppedEarly) break;
    if (i > 0 || (discoverRelated && seedArticleUrls.length > 0)) {
      await politeDelay(delayMs);
    }
    const { url: au, title: hintTitle } = albumQueue[i];
    if (onProgress) onProgress({ phase: "album", message: `正在按 ${Math.round(delayMs / 1000)} 秒间隔解析公开合集：${hintTitle || au}` });
    const album = await fetchPublicAlbumArticles(au, {
      maxArticles,
      delayMs,
      dateFrom,
      dateTo,
      signal,
      onPage: ({ page, discovered, albumTitle }) => {
        if (onProgress) {
          onProgress({
            phase: "album",
            message: `合集${albumTitle ? `「${albumTitle}」` : ""}第 ${page} 页解析完成，累计发现 ${discovered} 篇`,
          });
        }
      },
    });
    discoveredAlbums.push({
      albumUrl: au,
      albumId: album.albumId,
      biz: album.biz,
      title: album.albumTitle || hintTitle || `合集 ${album.albumId}`,
      count: album.articles.length,
    });
    for (const a of album.articles) {
      addArticleItem(a.url, { title: a.title, date: a.date, source: `album:${album.albumId}` });
    }
  }

  const sliced = discoveredItems.slice(0, Math.max(1, maxArticles));
  return {
    articleCount: sliced.length,
    albumCount: discoveredAlbums.length,
    relatedLinkCount: discoveredRelatedLinks.length,
    albums: discoveredAlbums,
    relatedLinks: discoveredRelatedLinks,
    articles: sliced,
    urls: sliced.map((x) => x.url),
    stoppedEarly,
    stopReason,
  };
}

export async function batchFetchInputs(
  inputs,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    delayMs = 2000,
    dateFrom = "",
    dateTo = "",
    maxArticles = 200,
    downloadImages = false,
    force = false,
    extraTags = [],
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    onlyOriginal = false,
    minWords = 0,
    discoverRelated = false,
    signal = null,
    onProgress = null,
  } = {}
) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const queue = [];
  const albumUrls = [];
  const seenKeys = new Set();
  const seenAlbums = new Set();

  const enqueueArticle = (rawUrl, { isSeed = false } = {}) => {
    const id = parseWechatUrlIdentity(rawUrl);
    if (!id.fetchUrl) return false;
    const key = id.articleKey || id.fetchUrl;
    if (seenKeys.has(key) || seenKeys.has(id.fetchUrl)) return false;
    if (queue.length >= Math.max(1, maxArticles)) return false;
    seenKeys.add(key);
    seenKeys.add(id.fetchUrl);
    queue.push({ url: id.fetchUrl, isSeed });
    return true;
  };

  const enqueueAlbum = (rawUrl) => {
    try {
      const u = new URL(String(rawUrl).replace(/&amp;/g, "&"));
      const aid = u.searchParams.get("album_id");
      if (aid && seenAlbums.has(aid)) return false;
      if (aid) seenAlbums.add(aid);
    } catch {}
    albumUrls.push(rawUrl);
    return true;
  };

  for (const item of list) {
    const extracted = await extractUrlsFromInput(item);
    for (const u of extracted.articleUrls) enqueueArticle(u, { isSeed: true });
    for (const au of extracted.albumUrls) enqueueAlbum(au);
  }

  let didAlbumFetch = false;
  for (const au of albumUrls) {
    if (signal?.aborted) break;
    didAlbumFetch = true;
    if (onProgress) onProgress({ phase: "album", message: `正在按 ${Math.max(0, delayMs / 1000)} 秒间隔解析公开合集：${au}` });
    const album = await fetchPublicAlbumArticles(au, {
      maxArticles,
      delayMs,
      dateFrom,
      dateTo,
      signal,
      onPage: ({ page, discovered, albumTitle }) => {
        if (onProgress) {
          onProgress({
            phase: "album",
            message: `合集${albumTitle ? `「${albumTitle}」` : ""}第 ${page} 页，已发现 ${discovered} 篇`,
          });
        }
      },
    });
    if (onProgress) onProgress({ phase: "album", message: `合集解析完成，发现 ${album.articles.length} 篇公开文章` });
    for (const a of album.articles) {
      enqueueArticle(a.url, { isSeed: false });
    }
  }

  const store = new ArticleIndexStore(outputDir);
  await store.load();

  const summary = {
    outputDir: store.outputDir,
    indexFile: store.indexMdPath,
    totalInputs: queue.length,
    discoveredAlbums: [],
    discoveredRelatedCount: 0,
    saved: 0,
    updated: 0,
    skipped: 0,
    filteredOut: 0,
    errors: 0,
    stoppedEarly: false,
    stopReason: "",
    items: [],
  };

  let fetchedNetworkCount = 0;

  for (let i = 0; i < queue.length; i++) {
    if (signal?.aborted) {
      summary.stoppedEarly = true;
      summary.stopReason = "用户手动中止任务";
      break;
    }

    const { url, isSeed } = queue[i];
    if (!force && !(discoverRelated && isSeed)) {
      const uid = parseWechatUrlIdentity(url);
      const preDup = store.findDuplicate({
        meta: {
          sourceUrl: uid.fetchUrl || url,
          articleKey: uid.articleKey || "",
          account: "",
          date: "",
          title: "",
        },
        contentHash: "",
      });
      if (preDup.duplicate) {
        summary.skipped++;
        summary.items.push({
          url,
          status: "skipped",
          title: preDup.existing.title,
          date: preDup.existing.date,
          reason: `duplicate:${preDup.reason}`,
          relativePath: preDup.existing.relative_path,
        });
        if (onProgress) {
          onProgress({
            index: i + 1,
            total: queue.length,
            url,
            status: "skipped",
            title: preDup.existing.title,
            reason: `duplicate:${preDup.reason}`,
          });
        }
        continue;
      }

      const knownEmpty = store.findKnownEmpty({
        sourceUrl: uid.fetchUrl || url,
        articleKey: uid.articleKey || "",
      });
      if (knownEmpty.knownEmpty) {
        summary.skipped++;
        summary.items.push({
          url,
          status: "skipped",
          title: knownEmpty.entry?.title || "",
          date: knownEmpty.entry?.date || "",
          reason: `known_empty:${knownEmpty.reason}`,
        });
        if (onProgress) {
          onProgress({
            index: i + 1,
            total: queue.length,
            url,
            status: "skipped",
            title: knownEmpty.entry?.title || url,
            reason: `known_empty:${knownEmpty.reason}`,
          });
        }
        continue;
      }
    }

    // Always wait full polite delay after album pagination OR between network fetches
    if (fetchedNetworkCount > 0 || didAlbumFetch) {
      await politeDelay(delayMs);
    }
    if (signal?.aborted) {
      summary.stoppedEarly = true;
      summary.stopReason = "用户手动中止任务";
      break;
    }

    fetchedNetworkCount++;
    try {
      const { status, finalUrl, text } = await fetchTextWithRetry(url);
      if (status !== 200) {
        summary.errors++;
        summary.items.push({ url, status: "error", reason: `http_${status}` });
        if (onProgress) onProgress({ index: i + 1, total: queue.length, url, status: "error", reason: `http_${status}` });
        continue;
      }

      const res = await processHtmlString(text, {
        sourceUrl: finalUrl || url,
        store,
        outputDir: store.outputDir,
        downloadImages,
        force,
        extraTags,
        includeDatePrefix,
        includeYaml,
        saveMd,
        saveHtml,
        saveJson,
        onlyOriginal,
        minWords,
        dateFrom,
        dateTo,
      });

      if (res.status === "blocked" && res.reason === "verification_required") {
        summary.stoppedEarly = true;
        summary.stopReason = res.message;
        summary.errors++;
        summary.items.push({ url, status: "blocked", reason: res.reason, message: res.message });
        if (onProgress) onProgress({ index: i + 1, total: queue.length, url, status: "blocked", message: res.message });
        break;
      }

      if (
        (res.status === "blocked" && res.reason === "article_deleted") ||
        (res.status === "error" && res.reason === "empty_body")
      ) {
        const uid = parseWechatUrlIdentity(url);
        store.recordKnownEmpty({
          sourceUrl: uid.fetchUrl || url,
          articleKey: uid.articleKey || "",
          account: res.meta?.account || "",
          date: res.meta?.date || "",
          title: res.meta?.title || "",
          reason: res.reason,
          message: res.message || "",
        });
      }

      if (res.status === "saved") summary.saved++;
      else if (res.status === "updated") summary.updated++;
      else if (res.status === "skipped") summary.skipped++;
      else if (res.status === "filtered_out") summary.filteredOut++;
      else summary.errors++;

      summary.items.push({
        url,
        status: res.status,
        title: res.meta?.title || "",
        account: res.meta?.account || "",
        date: res.meta?.date || "",
        relativePath: res.relativePath || "",
        reason: res.reason || "",
        message: res.message || "",
      });
      if (onProgress) {
        onProgress({
          index: i + 1,
          total: queue.length,
          url,
          status: res.status,
          title: res.meta?.title || "",
          date: res.meta?.date || "",
          reason: res.reason || "",
          message: res.message || "",
        });
      }

      // If discoverRelated is enabled on a seed article, auto-extract its public albums & in-article links!
      if (discoverRelated && isSeed && res.status !== "blocked" && res.status !== "error") {
        const rel = extractRelatedLinksAndAlbums(text, {
          currentUrl: finalUrl || url,
          biz: res.meta?.biz || "",
        });

        let newlyQueued = 0;
        for (const link of rel.relatedArticles) {
          if (enqueueArticle(link.url, { isSeed: false })) {
            newlyQueued++;
            summary.discoveredRelatedCount++;
          }
        }
        if (newlyQueued > 0 && onProgress) {
          onProgress({
            phase: "discover",
            message: `从《${res.meta?.title || "当前文章"}》文内提取到 ${newlyQueued} 条「往期推荐/关联文章」链接，已自动加入队列`,
          });
        }

        for (const alb of rel.albums) {
          if (!enqueueAlbum(alb.url)) continue;
          summary.discoveredAlbums.push(alb);
          if (onProgress) {
            onProgress({
              phase: "discover",
              message: `发现公开合集标签「#${alb.title}」，正在按间隔展开合集文章...`,
            });
          }
          await politeDelay(delayMs);
          if (signal?.aborted) break;
          const expanded = await fetchPublicAlbumArticles(alb.url, {
            maxArticles: Math.max(1, maxArticles - queue.length),
            delayMs,
            dateFrom,
            dateTo,
            signal,
          });
          let addedFromAlbum = 0;
          for (const a of expanded.articles) {
            if (enqueueArticle(a.url, { isSeed: false })) addedFromAlbum++;
          }
          if (onProgress) {
            onProgress({
              phase: "discover",
              message: `合集「#${alb.title}」展开完成，新增 ${addedFromAlbum} 篇待抓取文章（当前总队列 ${queue.length} 篇）`,
            });
          }
        }
        summary.totalInputs = queue.length;
      }
    } catch (err) {
      summary.errors++;
      const msg = String(err?.message || err);
      summary.items.push({ url, status: "error", message: msg });
      if (onProgress) onProgress({ index: i + 1, total: queue.length, url, status: "error", message: msg });
    }
  }

  summary.totalInputs = queue.length;
  await store.flush();
  return summary;
}

async function walkFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "assets" || e.name === "图片" || e.name === "封面" || e.name === "node_modules") continue;
      out.push(...(await walkFiles(full)));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function cleanLocalDirectory(
  inputDir,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    dateFrom = "",
    dateTo = "",
    force = false,
    extraTags = [],
    accountHint = "",
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    onlyOriginal = false,
    minWords = 0,
    signal = null,
    onProgress = null,
  } = {}
) {
  const absInput = path.resolve(inputDir);
  const allFiles = await walkFiles(absInput);

  const stemMap = new Map();
  for (const f of allFiles) {
    const ext = path.extname(f).toLowerCase();
    if (![".html", ".htm", ".md"].includes(ext)) continue;
    if (path.basename(f) === "00_文章索引.md") continue;
    const key = path.join(path.dirname(f), path.basename(f, ext));
    const existing = stemMap.get(key);
    if (!existing) {
      stemMap.set(key, { file: f, kind: ext === ".md" ? "md" : "html" });
    } else if (existing.kind === "md" && ext !== ".md") {
      stemMap.set(key, { file: f, kind: "html" });
    }
  }

  const store = new ArticleIndexStore(outputDir);
  await store.load();

  const entries = [...stemMap.values()];
  const summary = {
    inputDir: absInput,
    outputDir: store.outputDir,
    indexFile: store.indexMdPath,
    scanned: entries.length,
    saved: 0,
    updated: 0,
    skipped: 0,
    filteredOut: 0,
    errors: 0,
    stoppedEarly: false,
    stopReason: "",
    items: [],
  };

  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) {
      summary.stoppedEarly = true;
      summary.stopReason = "用户手动中止任务";
      break;
    }

    const { file, kind } = entries[i];
    const parentName = path.basename(path.dirname(file));
    const genericNames = new Set(["下载", "download", "downloads", "export", "exports", "html", "md"]);
    const inferredAccount = accountHint || (genericNames.has(parentName.toLowerCase()) ? "" : parentName);
    const fileName = path.basename(file);

    try {
      const raw = await fs.readFile(file, "utf8");
      let meta;
      let body;
      let bodyHtml = "";

      if (kind === "html") {
        meta = extractWechatMetadata(raw, { fileName });
        if (!meta.account && inferredAccount) meta.account = inferredAccount;
        bodyHtml = extractWechatBodyHtml(raw);
        body = htmlFragmentToMarkdown(bodyHtml);
      } else {
        const parsed = parseDirtyMarkdownFile(raw, { fileName, accountHint: inferredAccount });
        meta = parsed.meta;
        body = parsed.body;
      }

      if ((dateFrom && meta.date && meta.date < dateFrom) || (dateTo && meta.date && meta.date > dateTo)) {
        summary.filteredOut++;
        if (onProgress) onProgress({ index: i + 1, total: entries.length, status: "filtered_out", title: meta.title, reason: "date_filter" });
        continue;
      }
      if (onlyOriginal && !meta.isOriginal) {
        summary.filteredOut++;
        if (onProgress) onProgress({ index: i + 1, total: entries.length, status: "filtered_out", title: meta.title, reason: "not_original" });
        continue;
      }

      if (!body || body.trim().length === 0) {
        summary.errors++;
        summary.items.push({ sourceFile: file, status: "error", reason: "empty_body" });
        continue;
      }

      const wordCount = body.replace(/\s+/g, "").length;
      if (minWords > 0 && wordCount < minWords) {
        summary.filteredOut++;
        if (onProgress) onProgress({ index: i + 1, total: entries.length, status: "filtered_out", title: meta.title, reason: `min_words` });
        continue;
      }

      const res = await store.saveArticle({
        meta,
        body,
        bodyHtml,
        force,
        extraTags,
        includeDatePrefix,
        includeYaml,
        saveMd,
        saveHtml,
        saveJson,
      });

      if (res.status === "saved") summary.saved++;
      else if (res.status === "updated") summary.updated++;
      else if (res.status === "skipped") summary.skipped++;

      summary.items.push({
        sourceFile: file,
        sourceKind: kind,
        status: res.status,
        title: meta.title,
        account: meta.account,
        date: meta.date,
        relativePath: res.relativePath,
        reason: res.reason || "",
      });
      if (onProgress) {
        onProgress({
          index: i + 1,
          total: entries.length,
          status: res.status,
          title: meta.title,
          date: meta.date,
          reason: res.reason || "",
        });
      }
    } catch (err) {
      summary.errors++;
      const msg = String(err?.message || err);
      summary.items.push({ sourceFile: file, status: "error", message: msg });
      if (onProgress) onProgress({ index: i + 1, total: entries.length, status: "error", title: fileName, message: msg });
    }
  }

  await store.flush();
  return summary;
}

export async function exportArticlesCsv({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const store = new ArticleIndexStore(outputDir);
  await store.load();
  await store.flush();
  return await store.exportCsv();
}

export async function exportArticlesJsonl({ outputDir = DEFAULT_OUTPUT_DIR } = {}) {
  const store = new ArticleIndexStore(outputDir);
  await store.load();
  return await store.exportJsonl();
}

export async function searchCleanedIndex({
  outputDir = DEFAULT_OUTPUT_DIR,
  account = "",
  keyword = "",
  dateFrom = "",
  dateTo = "",
  limit = 100,
} = {}) {
  const store = new ArticleIndexStore(outputDir);
  await store.load();
  const res = store.query({ account, keyword, dateFrom, dateTo, limit });
  return {
    outputDir: store.outputDir,
    indexFile: store.indexMdPath,
    ...res,
  };
}

/**
 * Resolve one or more WeRead bookIds (MP_WXS_<digits>) from user inputs:
 * - Direct MP_WXS_<digits>
 * - Any URL containing __biz=... (album, long article link, profile_ext)
 * - Short article link https://mp.weixin.qq.com/s/xxx (checks local index cache -> HTTP fetch -> temp browser tab)
 */
export async function resolveWeReadAccountsFromInputs(
  inputs,
  { outputDir = DEFAULT_OUTPUT_DIR, session = null, store = null, onProgress = null } = {}
) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const combinedParts = [];
  for (const item of list) {
    const s = String(item || "").trim();
    if (!s) continue;
    if (!/^https?:\/\//i.test(s) && !/^MP_WXS_/i.test(s)) {
      try {
        const st = await fs.stat(s);
        if (st.isFile()) {
          combinedParts.push(await fs.readFile(s, "utf8"));
          continue;
        }
      } catch {}
    }
    combinedParts.push(s);
  }
  const combinedText = combinedParts.join("\n");
  const { bookIds, shortArticleUrls } = extractWeReadIdentifiersFromText(combinedText);

  const activeStore = store || new ArticleIndexStore(outputDir);
  if (!store) await activeStore.load();
  const savedAccounts = await loadSavedWeReadAccounts(activeStore.outputDir);

  const resolvedMap = new Map();
  const warnings = [];

  for (const b of bookIds) {
    const known = savedAccounts.find((a) => a.bookId === b.bookId);
    resolvedMap.set(b.bookId, {
      bookId: b.bookId,
      biz: b.biz,
      numericId: b.numericId,
      accountName: known?.accountName || "",
      sampleUrl: b.sampleUrl || known?.sampleUrl || "",
      source: b.source,
    });
  }

  for (const shortUrl of shortArticleUrls) {
    const uid = parseWechatUrlIdentity(shortUrl);
    // 1. Check archived index.json cache first (0 network requests!)
    const cachedArt = activeStore.data.articles.find(
      (a) =>
        a.biz &&
        ((uid.articleKey && a.article_key === uid.articleKey) ||
          (uid.canonicalUrl && a.source_url === uid.canonicalUrl) ||
          a.source_url === shortUrl)
    );
    if (cachedArt) {
      const conv = bizToWeReadBookId(cachedArt.biz);
      if (conv.bookId) {
        if (!resolvedMap.has(conv.bookId)) {
          resolvedMap.set(conv.bookId, {
            ...conv,
            accountName: cachedArt.account || "",
            sampleUrl: shortUrl,
            source: "local_index_cache",
          });
          if (onProgress) {
            onProgress({
              phase: "weread_resolve",
              message: `从本地知识库缓存秒解公众号 ID：${cachedArt.account || ""} -> ${conv.bookId}`,
            });
          }
        }
        continue;
      }
    }

    // 2. Check saved weread-accounts.json sampleUrl match
    const savedMatch = savedAccounts.find((a) => a.sampleUrl === shortUrl);
    if (savedMatch) {
      if (!resolvedMap.has(savedMatch.bookId)) {
        resolvedMap.set(savedMatch.bookId, { ...savedMatch, source: "saved_accounts_cache" });
      }
      continue;
    }

    // 3. Try lightweight HTTP fetch for single article to extract window.biz
    if (onProgress) {
      onProgress({ phase: "weread_resolve", message: `正在从短链解析公众号 __biz：${shortUrl}` });
    }
    let found = false;
    try {
      const { status, text } = await fetchTextWithRetry(shortUrl, { retries: 1 });
      if (status === 200) {
        const meta = extractWechatMetadata(text, { sourceUrl: shortUrl });
        if (meta.biz) {
          const conv = bizToWeReadBookId(meta.biz);
          if (conv.bookId) {
            resolvedMap.set(conv.bookId, {
              ...conv,
              accountName: meta.account || "",
              sampleUrl: shortUrl,
              source: "http_biz_extract",
            });
            found = true;
            if (onProgress) {
              onProgress({
                phase: "weread_resolve",
                message: `成功解析公众号：${meta.account || "未知公众号"} -> ${conv.bookId} (__biz=${conv.biz})`,
              });
            }
          }
        }
      }
    } catch {}

    // 4. Fallback: try reading window.biz via temporary tab in the running Edge browser
    if (!found && session) {
      if (onProgress) {
        onProgress({ phase: "weread_resolve", message: `尝试在本地浏览器临时标签页提取 window.biz...` });
      }
      const tabRes = await session.resolveBizInTempTab(shortUrl).catch(() => null);
      if (tabRes?.ok && tabRes.bookId) {
        resolvedMap.set(tabRes.bookId, {
          bookId: tabRes.bookId,
          biz: tabRes.biz,
          numericId: tabRes.numericId,
          accountName: tabRes.accountName || "",
          sampleUrl: shortUrl,
          source: "browser_tab_biz",
        });
        found = true;
        if (onProgress) {
          onProgress({
            phase: "weread_resolve",
            message: `浏览器解析成功：${tabRes.accountName || "未知公众号"} -> ${tabRes.bookId}`,
          });
        }
      } else if (tabRes?.message) {
        warnings.push(`${shortUrl}: ${tabRes.message}`);
      }
    }

    if (!found && warnings.length === 0) {
      warnings.push(
        `无法从短链 ${shortUrl} 提取 __biz，请改贴含 __biz= 的合集/历史链接，或直接输入 MP_WXS_<纯数字>`
      );
    }
  }

  const accounts = [...resolvedMap.values()];
  for (const acc of accounts) {
    await saveWeReadAccount(acc);
  }
  return { accounts, warnings };
}

/**
 * Paginate full historical article catalog from WeRead (/web/mp/articles)
 */
export async function inspectWeReadAccounts(
  inputs,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    dateFrom = "",
    dateTo = "",
    minReads = 0,
    onlyOriginal = false,
    maxArticles = 200,
    maxPages = 50,
    startPage = 1,
    delayMs = 2000,
    session = null,
    store = null,
    signal = null,
    onProgress = null,
  } = {}
) {
  const activeStore = store || new ArticleIndexStore(outputDir);
  if (!store) await activeStore.load();

  const ownSession = !session;
  const activeSession = session || new WeReadSession();

  try {
    if (ownSession) {
      if (onProgress) onProgress({ phase: "weread_list", message: "正在连接本地微信读书浏览器会话..." });
      await activeSession.connect({ autoLaunch: true, bringToFront: false });
    }

    const login = await activeSession.checkLogin({ probeApi: true });
    if (!login.loggedIn) {
      const reason = login.expired
        ? login.errMsg || "微信读书登录已过期，请点击「登录微信读书」重新微信扫码"
        : "尚未登录微信读书，请先点击「登录微信读书」在弹出的 Edge 窗口中微信扫码登录";
      return {
        kind: "weread_inspect",
        needsLogin: true,
        accounts: [],
        articleCount: 0,
        newCount: 0,
        archivedCount: 0,
        articles: [],
        urls: [],
        warnings: [],
        stoppedEarly: true,
        stopReason: reason,
      };
    }

    const { accounts, warnings } = await resolveWeReadAccountsFromInputs(inputs, {
      outputDir: activeStore.outputDir,
      session: activeSession,
      store: activeStore,
      onProgress,
    });

    if (accounts.length === 0) {
      return {
        kind: "weread_inspect",
        needsLogin: false,
        accounts: [],
        articleCount: 0,
        newCount: 0,
        archivedCount: 0,
        articles: [],
        urls: [],
        warnings,
        stoppedEarly: true,
        stopReason: warnings[0] || "未从输入中识别出公众号 bookId（请粘贴文章链接、含 __biz 的合集链接，或直接输入 MP_WXS_<数字>）",
      };
    }

    const effectiveStartPage = Math.max(1, Number(startPage) || 1);
    const effectiveMaxPages = Math.max(effectiveStartPage, Math.min(200, Number(maxPages) || 50));
    const effectiveMaxArticles = Math.max(1, Number(maxArticles) || 200);
    const pageDelayMs = Math.max(800, Number(delayMs) || 1500);

    const allMatched = [];
    const seenReviewIds = new Set();
    let stoppedEarly = false;
    let stopReason = "";
    let pagesFetched = 0;

    for (const acc of accounts) {
      if (signal?.aborted || stoppedEarly || allMatched.length >= effectiveMaxArticles) break;

      if (onProgress) {
        onProgress({
          phase: "weread_list",
          message: `开始拉取微信读书目录：${acc.accountName || acc.bookId} (${acc.bookId})`,
        });
      }

      let offset = 0;
      let accCount = 0;

      for (let page = 1; page <= effectiveMaxPages; page++) {
        if (signal?.aborted) {
          stoppedEarly = true;
          stopReason = "用户手动中止任务";
          break;
        }
        if (pagesFetched > 0) {
          await politeDelayAbortable(pageDelayMs, signal);
          if (signal?.aborted) {
            stoppedEarly = true;
            stopReason = "用户手动中止任务";
            break;
          }
        }

        pagesFetched++;
        const res = await activeSession.fetchArticlesPage(acc.bookId, offset);
        if (!res.ok) {
          stoppedEarly = true;
          stopReason = res.errMsg || "微信读书目录接口请求失败";
          if (onProgress) {
            onProgress({ phase: "weread_warn", message: `⚠️ ${stopReason}` });
          }
          break;
        }

        const parsed = parseWeReadArticlesResponse(res.data, {
          bookId: acc.bookId,
          accountHint: acc.accountName,
        });

        if (parsed.rawGroupCount === 0) {
          if (onProgress) {
            onProgress({
              phase: "weread_list",
              message: `${acc.accountName || acc.bookId} 已到达历史末尾（共翻 ${page - 1} 页，命中 ${accCount} 篇）`,
            });
          }
          break;
        }

        offset += parsed.rawGroupCount;

        // Backfill real account name from WeRead response
        if (parsed.items[0]?.account && parsed.items[0].account !== "未知公众号" && !acc.accountName) {
          acc.accountName = parsed.items[0].account;
          await saveWeReadAccount(acc);
        }

        if (page < effectiveStartPage) {
          if (onProgress) {
            onProgress({
              phase: "weread_list",
              message: `跳过第 ${page} 页（当前设置从第 ${effectiveStartPage} 页开始，offset=${offset}）`,
            });
          }
          continue;
        }

        let oldestDateInPage = "";
        let allOlderThanFrom = Boolean(dateFrom) && parsed.items.length > 0;
        let addedThisPage = 0;

        for (const item of parsed.items) {
          if (item.date && (!oldestDateInPage || item.date < oldestDateInPage)) {
            oldestDateInPage = item.date;
          }
          if (dateFrom && item.date && item.date >= dateFrom) {
            allOlderThanFrom = false;
          } else if (dateFrom && !item.date) {
            allOlderThanFrom = false;
          }

          if (seenReviewIds.has(item.reviewId)) continue;
          seenReviewIds.add(item.reviewId);

          if (dateFrom && item.date && item.date < dateFrom) continue;
          if (dateTo && item.date && item.date > dateTo) continue;
          if (minReads > 0 && item.readNum < minReads) continue;
          if (onlyOriginal && !item.isOriginal) continue;

          const uid = parseWechatUrlIdentity(item.url);
          const itemMetaProbe = {
            reviewId: item.reviewId,
            sourceUrl: uid.canonicalUrl || item.url,
            articleKey: uid.articleKey || "",
            account: item.account,
            date: item.date,
            title: item.title,
          };
          const dup = activeStore.findDuplicate({
            meta: itemMetaProbe,
            contentHash: "",
          });
          const emptyHit = activeStore.findKnownEmpty(itemMetaProbe);

          allMatched.push({
            ...item,
            biz: acc.biz || "",
            alreadyArchived: Boolean(dup.duplicate),
            alreadyEmpty: Boolean(emptyHit.knownEmpty),
          });
          addedThisPage++;
          accCount++;

          if (allMatched.length >= effectiveMaxArticles) break;
        }

        if (onProgress) {
          onProgress({
            phase: "weread_list",
            message: `${acc.accountName || acc.bookId} 第 ${page} 页完成（本页命中 ${addedThisPage} 篇，累计 ${allMatched.length} 篇${oldestDateInPage ? `，已回溯至 ${oldestDateInPage}` : ""}）`,
          });
        }

        if (allMatched.length >= effectiveMaxArticles) {
          if (onProgress) {
            onProgress({
              phase: "weread_list",
              message: `已达到单次最大篇数上限 (${effectiveMaxArticles} 篇)，停止继续翻页`,
            });
          }
          break;
        }

        if (allOlderThanFrom) {
          if (onProgress) {
            onProgress({
              phase: "weread_list",
              message: `本页文章已全部早于起始日期 ${dateFrom}，提前结束翻页`,
            });
          }
          break;
        }
      }

      acc.articleCount = accCount;
    }

    const archivedCount = allMatched.filter((x) => x.alreadyArchived).length;
    const emptyCount = allMatched.filter((x) => !x.alreadyArchived && x.alreadyEmpty).length;
    const newCount = allMatched.length - archivedCount - emptyCount;

    return {
      kind: "weread_inspect",
      needsLogin: false,
      accounts,
      articleCount: allMatched.length,
      newCount,
      archivedCount,
      emptyCount,
      articles: allMatched,
      urls: allMatched.map((x) => x.url).filter(Boolean),
      warnings,
      stoppedEarly,
      stopReason,
    };
  } finally {
    if (ownSession) activeSession.close();
  }
}

/**
 * Full WeRead sync: catalog pagination (or prefetched list) -> /web/mp/content HTML -> clean Markdown + dedup + index
 */
export async function syncWeReadAccounts(
  inputs,
  {
    outputDir = DEFAULT_OUTPUT_DIR,
    dateFrom = "",
    dateTo = "",
    minReads = 0,
    minWords = 0,
    onlyOriginal = false,
    maxArticles = 200,
    maxPages = 50,
    startPage = 1,
    delayMs = 2500,
    downloadImages = false,
    force = false,
    extraTags = [],
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
    saveJsonl = false,
    prefetchedItems = null,
    signal = null,
    onProgress = null,
  } = {}
) {
  const store = new ArticleIndexStore(outputDir);
  await store.load();

  const session = new WeReadSession();
  try {
    if (onProgress) onProgress({ phase: "weread_list", message: "正在连接本地微信读书浏览器会话..." });
    await session.connect({ autoLaunch: true, bringToFront: false });

    const login = await session.checkLogin({ probeApi: true });
    if (!login.loggedIn) {
      const stopReason = login.expired
        ? login.errMsg || "微信读书登录已过期，请点击「登录微信读书」重新微信扫码"
        : "尚未登录微信读书，请先点击「登录微信读书」在弹出的 Edge 窗口中微信扫码登录";
      return {
        channel: "weread",
        needsLogin: true,
        outputDir: store.outputDir,
        indexFile: store.indexMdPath,
        totalInputs: 0,
        saved: 0,
        updated: 0,
        skipped: 0,
        filteredOut: 0,
        errors: 0,
        stoppedEarly: true,
        stopReason,
        items: [],
      };
    }

    let candidates = [];
    let accounts = [];
    let catalogStoppedEarly = false;
    let catalogStopReason = "";
    let didCatalogFetch = false;

    if (Array.isArray(prefetchedItems) && prefetchedItems.length > 0) {
      candidates = prefetchedItems.slice(0, Math.max(1, Number(maxArticles) || 200));
      if (onProgress) {
        onProgress({
          phase: "weread_list",
          message: `复用已解析的微信读书目录（共 ${candidates.length} 篇），直接开始拉取正文清洗...`,
        });
      }
    } else {
      didCatalogFetch = true;
      const inspected = await inspectWeReadAccounts(inputs, {
        outputDir: store.outputDir,
        dateFrom,
        dateTo,
        minReads,
        onlyOriginal,
        maxArticles,
        maxPages,
        startPage,
        delayMs,
        session,
        store,
        signal,
        onProgress,
      });
      candidates = inspected.articles || [];
      accounts = inspected.accounts || [];
      catalogStoppedEarly = Boolean(inspected.stoppedEarly);
      catalogStopReason = inspected.stopReason || "";
      if (candidates.length === 0) {
        return {
          channel: "weread",
          needsLogin: Boolean(inspected.needsLogin),
          accounts,
          outputDir: store.outputDir,
          indexFile: store.indexMdPath,
          totalInputs: 0,
          saved: 0,
          updated: 0,
          skipped: 0,
          filteredOut: 0,
          errors: 0,
          stoppedEarly: catalogStoppedEarly,
          stopReason: catalogStopReason || "未在指定筛选条件下找到可下载的文章",
          items: [],
        };
      }
    }

    const summary = {
      channel: "weread",
      accounts,
      outputDir: store.outputDir,
      indexFile: store.indexMdPath,
      totalInputs: candidates.length,
      saved: 0,
      updated: 0,
      skipped: 0,
      filteredOut: 0,
      errors: 0,
      stoppedEarly: catalogStoppedEarly,
      stopReason: catalogStopReason,
      items: [],
    };

    let fetchedContentCount = 0;
    let metadataEnrichedCount = 0;
    let emptyRecordedCount = 0;
    let consecutiveNetErrors = 0;

    for (let i = 0; i < candidates.length; i++) {
      if (signal?.aborted) {
        summary.stoppedEarly = true;
        summary.stopReason = "用户手动中止任务";
        break;
      }

      const item = candidates[i];
      const uid = parseWechatUrlIdentity(item.url || "");
      const probeMeta = {
        reviewId: item.reviewId || "",
        sourceUrl: uid.canonicalUrl || item.url || "",
        articleKey: uid.articleKey || "",
        account: item.account || "",
        date: item.date || "",
        title: item.title || "",
      };

      // Instant local dedup & known-empty skip check BEFORE calling /web/mp/content
      if (!force) {
        const preDup = store.findDuplicate({
          meta: probeMeta,
          contentHash: "",
        });
        if (preDup.duplicate) {
          if (
            store.enrichExistingMetadata(preDup.existing, {
              reviewId: item.reviewId,
              wereadBookId: item.bookId,
              readNum: item.readNum,
              likeNum: item.likeNum,
              summary: item.summary,
            })
          ) {
            metadataEnrichedCount++;
          }
          summary.skipped++;
          summary.items.push({
            reviewId: item.reviewId,
            url: item.url,
            status: "skipped",
            title: preDup.existing.title || item.title,
            date: preDup.existing.date || item.date,
            reason: `duplicate:${preDup.reason}`,
            relativePath: preDup.existing.relative_path,
          });
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              url: item.url,
              status: "skipped",
              title: preDup.existing.title || item.title,
              date: preDup.existing.date || item.date,
              reason: `duplicate:${preDup.reason}`,
            });
          }
          continue;
        }

        const knownEmpty = store.findKnownEmpty(probeMeta);
        if (knownEmpty.knownEmpty) {
          summary.skipped++;
          summary.items.push({
            reviewId: item.reviewId,
            url: item.url,
            status: "skipped",
            title: item.title || knownEmpty.entry?.title || "",
            date: item.date || knownEmpty.entry?.date || "",
            reason: `known_empty:${knownEmpty.reason}`,
          });
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              url: item.url,
              status: "skipped",
              title: item.title || knownEmpty.entry?.title || "",
              date: item.date || knownEmpty.entry?.date || "",
              reason: `known_empty:${knownEmpty.reason}`,
            });
          }
          continue;
        }
      }

      if (fetchedContentCount > 0 || didCatalogFetch) {
        // Every 35 actual network downloads, add a gentle 15s cooldown to reduce WeRead rate-limit resets
        if (fetchedContentCount > 0 && fetchedContentCount % 35 === 0) {
          if (onProgress) {
            onProgress({
              phase: "weread_list",
              message: `已连续拉取 ${fetchedContentCount} 篇正文，主动休息 15 秒以防触发微信读书连接限速...`,
            });
          }
          await politeDelayAbortable(15000, signal);
        } else {
          await politeDelayAbortable(delayMs, signal);
        }
        if (signal?.aborted) {
          summary.stoppedEarly = true;
          summary.stopReason = "用户手动中止任务";
          break;
        }
      }

      fetchedContentCount++;
      try {
        let contentRes = await session.fetchContentHtml(item.reviewId);
        // Single gentle retry on transient network disconnect before counting as failure
        if (!contentRes.ok && contentRes.status === 0 && /Failed to fetch|network|closed/i.test(contentRes.errMsg || "")) {
          await politeDelayAbortable(Math.max(delayMs * 2, 6000), signal);
          if (!signal?.aborted) {
            contentRes = await session.fetchContentHtml(item.reviewId);
          }
        }

        if (!contentRes.ok) {
          const code = Number(contentRes.errCode || 0);
          const isNetDrop =
            contentRes.status === 0 && /Failed to fetch|network|closed|timeout|断开/i.test(contentRes.errMsg || "");
          const isAuthOrRateLimit =
            code === -2012 ||
            code === -2010 ||
            code === -2013 ||
            code === 401 ||
            code === 403 ||
            code === 429 ||
            /限速|频繁|过期|登录/.test(contentRes.errMsg || "");

          if (isNetDrop) {
            consecutiveNetErrors++;
          } else {
            consecutiveNetErrors = 0;
          }

          if (isAuthOrRateLimit || consecutiveNetErrors >= 3) {
            summary.stoppedEarly = true;
            summary.stopReason = isAuthOrRateLimit
              ? contentRes.errMsg || "微信读书接口返回异常，已安全停止"
              : "连续 3 次网络断连（ERR_CONNECTION_CLOSED），判定触发微信读书频控限速，已自动熔断并保存已完成归档。请稍候 5~15 分钟后再次点击「2.批量下载清洗」，已归档篇目会自动去重跳过。";
            summary.errors++;
            summary.items.push({
              reviewId: item.reviewId,
              url: item.url,
              status: "blocked",
              title: item.title,
              reason: isNetDrop ? "weread_connection_closed" : `weread_err_${code}`,
              message: summary.stopReason,
            });
            if (onProgress) {
              onProgress({
                index: i + 1,
                total: candidates.length,
                url: item.url,
                status: "blocked",
                title: item.title,
                message: summary.stopReason,
              });
            }
            break;
          }

          // Record confirmed WeRead empty content (HTTP 200 with empty payload, errCode === -2) so future runs skip it
          if (code === -2 && contentRes.status === 200) {
            store.recordKnownEmpty({
              ...probeMeta,
              reason: "empty_body",
              message: contentRes.errMsg || "微信读书返回的正文为空",
            });
            emptyRecordedCount++;
          }

          summary.errors++;
          summary.items.push({
            reviewId: item.reviewId,
            url: item.url,
            status: "error",
            title: item.title,
            reason: code === -2 ? "empty_body" : `weread_err_${code}`,
            message: contentRes.errMsg || "正文获取失败",
          });
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              url: item.url,
              status: "error",
              title: item.title,
              reason: code === -2 ? "empty_body" : "",
              message:
                code === -2
                  ? `${contentRes.errMsg || "正文为空"}（已记入空文跳过名单，下次自动跳过）`
                  : contentRes.errMsg || "正文获取失败",
            });
          }
          continue;
        }

        consecutiveNetErrors = 0;

        const html = contentRes.html;
        const htmlMeta = extractWechatMetadata(html, { sourceUrl: item.url || "" });
        const bodyHtml = extractWeReadBodyHtml(html);

        const mergedMeta = {
          title: item.title || htmlMeta.title || "未命名文章",
          account: item.account || htmlMeta.account || "未知公众号",
          author: htmlMeta.author || item.account || "",
          publishedAt: item.publishedAt || htmlMeta.publishedAt || item.date || "",
          date: item.date || htmlMeta.date || "",
          ipRegion: htmlMeta.ipRegion || "",
          sourceUrl: uid.canonicalUrl || item.url || htmlMeta.sourceUrl || "",
          sourceChannel: "weread",
          digest: item.summary || htmlMeta.digest || "",
          summary: item.summary || htmlMeta.digest || "",
          isOriginal: Boolean(item.isOriginal || htmlMeta.isOriginal),
          biz: item.biz || htmlMeta.biz || bizToWeReadBookId(item.bookId).biz || "",
          wereadBookId: item.bookId || "",
          reviewId: item.reviewId || "",
          readNum: typeof item.readNum === "number" ? item.readNum : 0,
          likeNum: typeof item.likeNum === "number" ? item.likeNum : 0,
          articleKey: uid.articleKey || htmlMeta.articleKey || `weread:${item.reviewId}`,
          outboundLinks: extractOutboundLinksFromHtml(bodyHtml),
        };

        if (onlyOriginal && !mergedMeta.isOriginal) {
          summary.filteredOut++;
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              status: "filtered_out",
              title: mergedMeta.title,
              date: mergedMeta.date,
              reason: "not_original",
            });
          }
          continue;
        }

        let imageUrlMap = null;
        if (downloadImages && bodyHtml) {
          const imgUrls = extractImageUrlsFromHtml(bodyHtml);
          if (imgUrls.length > 0) {
            const accountDir = path.join(store.outputDir, sanitizeFilename(mergedMeta.account || "未知公众号", 50));
            const slug = `${mergedMeta.date || "0000-00-00"}_${sanitizeFilename(mergedMeta.title || "article", 50)}`;
            const assetsDir = path.join(accountDir, "assets", slug);
            imageUrlMap = await downloadImagesLocally(imgUrls, {
              assetsDir,
              relativeBaseDir: accountDir,
            });
          }
        }

        const body = htmlFragmentToMarkdown(bodyHtml, { imageUrlMap });
        if (!body || body.trim().length === 0) {
          store.recordKnownEmpty({
            ...probeMeta,
            account: mergedMeta.account,
            date: mergedMeta.date,
            title: mergedMeta.title,
            reason: "empty_body",
            message: "正文提取为空",
          });
          emptyRecordedCount++;
          summary.errors++;
          summary.items.push({
            reviewId: item.reviewId,
            url: item.url,
            status: "error",
            title: mergedMeta.title,
            reason: "empty_body",
            message: "正文提取为空（已记入空文跳过名单，下次自动跳过）",
          });
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              status: "error",
              title: mergedMeta.title,
              reason: "empty_body",
              message: "正文提取为空（已记入空文跳过名单，下次自动跳过）",
            });
          }
          continue;
        }

        const wordCount = body.replace(/\s+/g, "").length;
        if (minWords > 0 && wordCount < minWords) {
          summary.filteredOut++;
          if (onProgress) {
            onProgress({
              index: i + 1,
              total: candidates.length,
              status: "filtered_out",
              title: mergedMeta.title,
              date: mergedMeta.date,
              reason: `word_count_${wordCount}_lt_${minWords}`,
            });
          }
          continue;
        }

        const saved = await store.saveArticle({
          meta: mergedMeta,
          body,
          bodyHtml,
          force,
          extraTags,
          includeDatePrefix,
          includeYaml,
          saveMd,
          saveHtml,
          saveJson,
        });

        if (saved.status === "saved") summary.saved++;
        else if (saved.status === "updated") summary.updated++;
        else if (saved.status === "skipped") summary.skipped++;

        summary.items.push({
          reviewId: item.reviewId,
          url: mergedMeta.sourceUrl,
          status: saved.status,
          title: mergedMeta.title,
          account: mergedMeta.account,
          date: mergedMeta.date,
          readNum: mergedMeta.readNum,
          likeNum: mergedMeta.likeNum,
          relativePath: saved.relativePath || "",
          reason: saved.reason || "",
        });

        if (onProgress) {
          onProgress({
            index: i + 1,
            total: candidates.length,
            url: mergedMeta.sourceUrl,
            status: saved.status,
            title: mergedMeta.title,
            date: mergedMeta.date,
            readNum: mergedMeta.readNum,
            likeNum: mergedMeta.likeNum,
            reason: saved.reason || "",
          });
        }

        // Periodic checkpoint flush every 10 saved/updated articles for crash/rate-limit safety
        if ((summary.saved + summary.updated) > 0 && (summary.saved + summary.updated) % 10 === 0) {
          await store.flush();
        }
      } catch (err) {
        summary.errors++;
        const msg = String(err?.message || err);
        summary.items.push({
          reviewId: item.reviewId,
          url: item.url,
          status: "error",
          title: item.title,
          message: msg,
        });
        if (onProgress) {
          onProgress({
            index: i + 1,
            total: candidates.length,
            url: item.url,
            status: "error",
            title: item.title,
            message: msg,
          });
        }
      }
    }

    if (summary.saved > 0 || summary.updated > 0 || metadataEnrichedCount > 0 || emptyRecordedCount > 0) {
      await store.flush();
    }
    if (saveJsonl) {
      const jsonl = await store.exportJsonl();
      summary.jsonlFile = jsonl.jsonlPath;
    }

    return summary;
  } finally {
    session.close();
  }
}
