/**
 * Polite Public Fetcher, Public Album Enumerator, and Multi-Format Input Extractor
 * Uses ONLY publicly accessible endpoints with rate limiting; never bypasses anti-bot/CAPTCHA gates.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  decodeHtmlEntities,
  formatShanghaiDateTime,
  parseWechatUrlIdentity,
} from "./html-to-md.mjs";
import { sanitizeFilename } from "./dedup.mjs";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function politeDelay(delayMs = 1500) {
  const base = Math.max(0, Number(delayMs) || 0);
  if (base <= 0) return;
  const jitter = Math.floor(Math.random() * Math.min(600, base * 0.3));
  await sleep(base + jitter);
}

export async function fetchTextWithRetry(url, { timeoutMs = 20000, retries = 2, accept = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { ...DEFAULT_HEADERS };
      if (accept) headers.Accept = accept;
      const res = await fetch(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      return { status: res.status, finalUrl: res.url || url, text };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export function isWechatArticleUrl(url) {
  return /^https?:\/\/mp\.weixin\.qq\.com\/s(\/|\?)/i.test(String(url || "").trim());
}

export function isWechatAlbumUrl(url) {
  return /^https?:\/\/mp\.weixin\.qq\.com\/mp\/appmsgalbum\?/i.test(String(url || "").trim());
}

/**
 * Enumerate all public articles inside a WeChat public album (合集/专栏 appmsgalbum)
 * No login or private key required.
 */
export async function fetchPublicAlbumArticles(
  albumUrl,
  { maxArticles = 200, delayMs = 2000, dateFrom = "", dateTo = "", signal = null, onPage = null } = {}
) {
  const cleanUrl = String(albumUrl || "").trim().replace(/&amp;/g, "&");
  const u = new URL(cleanUrl);
  const biz = u.searchParams.get("__biz") || "";
  const albumId = u.searchParams.get("album_id") || "";
  if (!biz || !albumId) {
    throw new Error("无效的公众号合集链接：缺少 __biz 或 album_id 参数");
  }

  const collected = [];
  const seenKeys = new Set();
  let beginMsgid = "";
  let beginItemidx = "";
  let page = 0;
  let albumTitle = "";
  const maxPages = Math.ceil(Math.max(1, maxArticles) / 10) + 10;

  while (page < maxPages && collected.length < maxArticles) {
    if (signal?.aborted) break;
    if (page > 0) await politeDelay(delayMs);
    if (signal?.aborted) break;
    page++;

    const params = new URLSearchParams({
      action: "getalbum",
      __biz: biz,
      album_id: albumId,
      count: "20",
      is_reverse: "0",
      f: "json",
    });
    if (beginMsgid) {
      params.set("begin_msgid", beginMsgid);
      params.set("begin_itemidx", beginItemidx || "1");
    }

    const apiUrl = `https://mp.weixin.qq.com/mp/appmsgalbum?${params.toString()}`;
    const { status, text } = await fetchTextWithRetry(apiUrl, { accept: "application/json" });
    if (status !== 200) {
      throw new Error(`合集接口返回异常状态码 ${status}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (page === 1) {
        const htmlItems = extractAlbumLinksFromHtml(text);
        return {
          albumId,
          biz,
          albumTitle: "",
          articles: htmlItems.slice(0, maxArticles),
        };
      }
      throw new Error("合集接口未返回有效 JSON（可能触发风控或合集不可公开访问）");
    }

    const resp = parsed.getalbum_resp || {};
    if (!albumTitle && resp.base_info?.title) {
      albumTitle = decodeHtmlEntities(resp.base_info.title);
    }
    let list = resp.article_list || [];
    if (!Array.isArray(list)) list = list ? [list] : [];
    if (list.length === 0) break;

    let hitOlderThanDateFrom = false;
    for (const item of list) {
      const rawLink = decodeHtmlEntities(item.url || "").replace(/&amp;/g, "&");
      if (!rawLink) continue;
      const id = parseWechatUrlIdentity(rawLink);
      const key = id.articleKey || id.fetchUrl;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      const { date, publishedAt } = formatShanghaiDateTime(item.create_time);
      if (dateFrom && date && date < dateFrom) {
        hitOlderThanDateFrom = true;
        continue;
      }
      if (dateTo && date && date > dateTo) continue;

      collected.push({
        // Preserve exact fetchUrl with chksm intact!
        url: id.fetchUrl || rawLink,
        title: decodeHtmlEntities(item.title || ""),
        date,
        publishedAt,
        msgid: String(item.msgid || ""),
        itemidx: String(item.itemidx || "1"),
      });
      if (collected.length >= maxArticles) break;
    }

    if (onPage) {
      onPage({ page, discovered: collected.length, albumTitle });
    }

    const last = list[list.length - 1];
    const continueFlag = String(resp.continue_flag ?? "0");
    if (hitOlderThanDateFrom || continueFlag !== "1" || !last?.msgid) break;
    if (String(last.msgid) === beginMsgid && String(last.itemidx || "1") === beginItemidx) break;
    beginMsgid = String(last.msgid);
    beginItemidx = String(last.itemidx || "1");
  }

  return {
    albumId,
    biz,
    albumTitle,
    articles: collected,
  };
}

function extractAlbumLinksFromHtml(html) {
  const results = [];
  const seen = new Set();
  const re = /data-link\s*=\s*["'](https?:\/\/mp\.weixin\.qq\.com\/s[^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeHtmlEntities(m[1]).replace(/&amp;/g, "&");
    const id = parseWechatUrlIdentity(raw);
    if (!seen.has(id.canonicalUrl)) {
      seen.add(id.canonicalUrl);
      results.push({ url: id.canonicalUrl, title: "", date: "", publishedAt: "" });
    }
  }
  return results;
}

/**
 * Decode text file supporting UTF-8 (with/without BOM) and GB18030 (common for Chinese Excel CSV exports)
 */
async function readTextSmart(filePath) {
  const buf = await fs.readFile(filePath);
  // Check UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString("utf8");
  }
  // Try strict UTF-8 first
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return buf.toString("utf8");
    }
  }
}

/**
 * Extract WeChat article/album URLs from a string or a file (.txt, .md, .csv, .tsv, .json)
 */
export async function extractUrlsFromInput(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return { articleUrls: [], albumUrls: [] };

  let textContent = trimmed;
  // Check if input is an existing file path
  let isFile = false;
  try {
    const stat = await fs.stat(trimmed);
    if (stat.isFile()) {
      isFile = true;
      textContent = await readTextSmart(trimmed);
    }
  } catch {
    // treat as raw text/URL
  }

  const articleUrls = [];
  const albumUrls = [];
  const seen = new Set();

  const pushUrl = (u) => {
    const clean = decodeHtmlEntities(String(u || "").trim())
      .replace(/&amp;/g, "&")
      .replace(/[)\]}>"'，。；、]+$/, "");
    if (!clean || seen.has(clean)) return;
    if (isWechatAlbumUrl(clean)) {
      seen.add(clean);
      albumUrls.push(clean);
    } else if (isWechatArticleUrl(clean)) {
      seen.add(clean);
      articleUrls.push(clean);
    }
  };

  if (isFile && trimmed.toLowerCase().endsWith(".json")) {
    try {
      const parsed = JSON.parse(textContent);
      const walk = (node) => {
        if (typeof node === "string") {
          pushUrl(node);
        } else if (Array.isArray(node)) {
          for (const item of node) walk(item);
        } else if (node && typeof node === "object") {
          for (const v of Object.values(node)) walk(v);
        }
      };
      walk(parsed);
      return { articleUrls, albumUrls };
    } catch {
      // fall through to regex extraction
    }
  }

  // Regex scan across TXT / MD / CSV / TSV / mixed strings
  const urlRe = /https?:\/\/mp\.weixin\.qq\.com\/(?:s\/[A-Za-z0-9_-]+|s\?[^\s"'<>|,\]]+|mp\/appmsgalbum\?[^\s"'<>|,\]]+)/gi;
  let m;
  while ((m = urlRe.exec(textContent)) !== null) {
    pushUrl(m[0]);
  }

  return { articleUrls, albumUrls };
}

/**
 * Download article images into a local assets directory and return URL -> relative path map
 */
export async function downloadImagesLocally(imageUrls, { assetsDir, relativeBaseDir, delayMs = 300 }) {
  const map = new Map();
  if (!imageUrls || imageUrls.length === 0) return map;
  await fs.mkdir(assetsDir, { recursive: true });

  for (let i = 0; i < imageUrls.length; i++) {
    const imgUrl = imageUrls[i];
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(imgUrl, {
        headers: {
          "User-Agent": DEFAULT_HEADERS["User-Agent"],
          Referer: "https://mp.weixin.qq.com/",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      let ext = "jpg";
      if (contentType.includes("png")) ext = "png";
      else if (contentType.includes("webp")) ext = "webp";
      else if (contentType.includes("gif")) ext = "gif";
      else {
        const fmt = imgUrl.match(/wx_fmt=([a-z0-9]+)/i)?.[1];
        if (fmt && fmt !== "other") ext = sanitizeFilename(fmt, 8);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const fileName = `img_${String(i + 1).padStart(2, "0")}.${ext}`;
      const fullPath = path.join(assetsDir, fileName);
      await fs.writeFile(fullPath, buf);
      const rel = path.relative(relativeBaseDir, fullPath).replace(/\\/g, "/");
      map.set(imgUrl, `./${rel}`);
    } catch {
      // Keep original URL on image failure
    }
  }
  return map;
}
