/**
 * WeChat Public Article HTML Extractor & Deep Markdown Cleaner
 * Zero-dependency, tuned for live mp.weixin.qq.com HTML, wechatDownload HTML, and dirty Markdown files.
 */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  laquo: "«",
  raquo: "»",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  plusmn: "±",
  yen: "¥",
  euro: "€",
  pound: "£",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
};

export function decodeHtmlEntities(str) {
  if (!str) return "";
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch {
        return "";
      }
    })
    .replace(/&([a-zA-Z]+);/g, (full, name) => {
      const lower = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)
        ? NAMED_ENTITIES[lower]
        : full;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function stripZeroWidth(str) {
  if (!str) return "";
  return str.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "");
}

export function formatShanghaiDateTime(tsSeconds) {
  const ms = Number(tsSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return { date: "", publishedAt: "" };
  // UTC+8 (Asia/Shanghai)
  const d = new Date(ms + 8 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    publishedAt: `${yyyy}-${mm}-${dd} ${hh}:${mi}`,
  };
}

export function normalizeDateString(raw) {
  if (!raw) return { date: "", publishedAt: "" };
  const s = String(raw).trim();
  // Pure unix timestamp (10 digits)
  if (/^\d{10}$/.test(s)) {
    return formatShanghaiDateTime(Number(s));
  }
  // [202611231239] or 202611231239
  const compact = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (compact) {
    const [, y, m, d, hh, mi] = compact;
    return { date: `${y}-${m}-${d}`, publishedAt: `${y}-${m}-${d} ${hh}:${mi}` };
  }
  // 2026年11月23日 12:39 or 2026-11-23 12:39 or 2026/11/23 12:39
  const full = s.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})日?(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (full) {
    const y = full[1];
    const m = full[2].padStart(2, "0");
    const d = full[3].padStart(2, "0");
    if (full[4] && full[5]) {
      return {
        date: `${y}-${m}-${d}`,
        publishedAt: `${y}-${m}-${d} ${full[4].padStart(2, "0")}:${full[5]}`,
      };
    }
    return { date: `${y}-${m}-${d}`, publishedAt: `${y}-${m}-${d}` };
  }
  return { date: "", publishedAt: "" };
}

/**
 * Extract balanced innerHTML of an element matching an id (e.g. id="js_content")
 */
export function extractBalancedElementById(html, id) {
  const idRegex = new RegExp(`<([a-zA-Z0-9-]+)\\b[^>]*\\bid\\s*=\\s*["']${id}["'][^>]*>`, "i");
  const openMatch = idRegex.exec(html);
  if (!openMatch) return null;

  const tagName = openMatch[1].toLowerCase();
  const contentStart = openMatch.index + openMatch[0].length;
  if (openMatch[0].endsWith("/>")) return "";

  const tagRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagRegex.lastIndex = contentStart;

  let depth = 1;
  let m;
  while ((m = tagRegex.exec(html)) !== null) {
    const token = m[0];
    if (token.startsWith("</")) {
      depth--;
    } else if (!token.endsWith("/>")) {
      depth++;
    }
    if (depth === 0) {
      return html.slice(contentStart, m.index);
    }
  }
  return null;
}

function getAttr(tagHtml, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tagHtml);
  if (!m) return "";
  return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
}

function extractMetaContent(html, key, attr = "property") {
  const re1 = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${key}["'][^>]*>`, "i");
  const m1 = re1.exec(html);
  if (!m1) return "";
  return getAttr(m1[0], "content");
}

function cleanTextInline(str) {
  return stripZeroWidth(decodeHtmlEntities(str))
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseWechatUrlIdentity(rawUrl) {
  if (!rawUrl) return { fetchUrl: "", canonicalUrl: "", biz: "", mid: "", idx: "", sn: "", articleKey: "" };
  let urlStr = String(rawUrl).trim().replace(/&amp;/g, "&");
  if (urlStr.startsWith("//")) urlStr = "https:" + urlStr;
  // Preserve exact query params (especially chksm & unencoded == in __biz) for fetchUrl
  const fetchUrl = urlStr
    .replace(/^http:\/\/mp\.weixin\.qq\.com/i, "https://mp.weixin.qq.com")
    .replace(/#.*$/, "");
  try {
    const u = new URL(fetchUrl);
    // Short link: https://mp.weixin.qq.com/s/<shortCode>
    const shortMatch = u.pathname.match(/^\/s\/([A-Za-z0-9_-]{10,})$/);
    if (shortMatch) {
      const code = shortMatch[1];
      const cleanShort = `https://mp.weixin.qq.com/s/${code}`;
      return {
        fetchUrl: cleanShort,
        canonicalUrl: cleanShort,
        biz: u.searchParams.get("__biz") || "",
        mid: u.searchParams.get("mid") || "",
        idx: u.searchParams.get("idx") || "",
        sn: u.searchParams.get("sn") || "",
        articleKey: `short:${code}`,
      };
    }
    const biz = u.searchParams.get("__biz") || "";
    const mid = u.searchParams.get("mid") || u.searchParams.get("appmsgid") || "";
    const idx = u.searchParams.get("idx") || u.searchParams.get("itemidx") || "1";
    const sn = u.searchParams.get("sn") || "";
    if (biz && mid) {
      return {
        fetchUrl,
        canonicalUrl: fetchUrl,
        biz,
        mid,
        idx,
        sn,
        articleKey: `biz:${biz}|mid:${mid}|idx:${idx}`,
      };
    }
    u.hash = "";
    return {
      fetchUrl,
      canonicalUrl: fetchUrl,
      biz,
      mid,
      idx,
      sn,
      articleKey: sn ? `sn:${sn}` : `url:${u.origin}${u.pathname}${u.search}`,
    };
  } catch {
    return { fetchUrl, canonicalUrl: fetchUrl, biz: "", mid: "", idx: "", sn: "", articleKey: `url:${fetchUrl}` };
  }
}

/**
 * Auto-detect public albums (#合集 tags) and in-article recommended WeChat links (文内往期推荐/关联文章)
 * from a fetched WeChat article HTML.
 */
export function extractRelatedLinksAndAlbums(html, { currentUrl = "", biz = "" } = {}) {
  const albums = [];
  const seenAlbumIds = new Set();
  const relatedArticles = [];
  const seenArticleKeys = new Set();

  const curId = parseWechatUrlIdentity(currentUrl);
  if (curId.articleKey) seenArticleKeys.add(curId.articleKey);
  if (curId.fetchUrl) seenArticleKeys.add(curId.fetchUrl);

  const resolvedBiz =
    biz ||
    curId.biz ||
    html.match(/var\s+biz\s*=\s*["']([^"']+)["']/)?.[1] ||
    html.match(/__biz=([A-Za-z0-9=_-]+)/)?.[1] ||
    "";

  const addAlbum = (albumId, title = "", explicitUrl = "") => {
    const cleanId = String(albumId || "").trim();
    if (!cleanId || !/^\d{5,}$/.test(cleanId) || seenAlbumIds.has(cleanId)) return;
    seenAlbumIds.add(cleanId);
    const cleanTitle = cleanTextInline(title || "").replace(/^#/, "");
    const albumUrl =
      explicitUrl ||
      (resolvedBiz
        ? `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${resolvedBiz}&action=getalbum&album_id=${cleanId}`
        : "");
    if (!albumUrl) return;
    albums.push({
      albumId: cleanId,
      title: cleanTitle || `合集 ${cleanId}`,
      url: albumUrl,
    });
  };

  // 1A. Detect appmsg_album_infos JS array in live WeChat HTML
  const albumBlockMatch = html.match(/appmsg_album_infos\s*[:=]\s*\[([\s\S]{0,12000}?)\]/);
  if (albumBlockMatch) {
    const block = albumBlockMatch[1];
    const objRe = /\{[^{}]*?\}/g;
    let om;
    while ((om = objRe.exec(block)) !== null) {
      const obj = om[0];
      const idM = obj.match(/(?:album_id|\bid)\s*:\s*['"]?(\d{5,})['"]?/);
      const titleM = obj.match(/title\s*:\s*['"]([^'"]+)['"]/);
      if (idM) addAlbum(idM[1], titleM ? titleM[1] : "");
    }
  }

  // 1B. Detect DOM album tags (data-album_id / data-id inside album tag elements)
  const domAlbumRe = /<(?:span|a|div)\b[^>]*\bdata-album_id\s*=\s*["'](\d{5,})["'][^>]*>([\s\S]{0,200}?)<\/(?:span|a|div)>/gi;
  let dm;
  while ((dm = domAlbumRe.exec(html)) !== null) {
    addAlbum(dm[1], dm[2]);
  }
  const tagElRe = /<span\b[^>]*class\s*=\s*["'][^"']*js_article_tags[^"']*["'][^>]*>([\s\S]{0,200}?)<\/span>/gi;
  let tm;
  while ((tm = tagElRe.exec(html)) !== null) {
    const idVal = getAttr(tm[0], "data-album_id") || getAttr(tm[0], "data-id");
    if (idVal) addAlbum(idVal, tm[1]);
  }

  // 1C. Detect explicit appmsgalbum links anywhere in article HTML
  const albumUrlRe = /https?:\/\/mp\.weixin\.qq\.com\/mp\/appmsgalbum\?[^\s"'<>|,\]]+/gi;
  let am;
  while ((am = albumUrlRe.exec(html)) !== null) {
    const raw = decodeHtmlEntities(am[0]).replace(/&amp;/g, "&").replace(/#.*$/, "");
    try {
      const u = new URL(raw);
      const aid = u.searchParams.get("album_id");
      const abiz = u.searchParams.get("__biz") || resolvedBiz;
      if (aid && abiz) {
        addAlbum(aid, "", `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${abiz}&action=getalbum&album_id=${aid}`);
      }
    } catch {}
  }

  // 2. Detect in-article recommended/related WeChat links strictly inside #js_content
  const bodyHtml = extractBalancedElementById(html, "js_content") || "";
  if (bodyHtml) {
    const addRelated = (rawUrl, title = "") => {
      const id = parseWechatUrlIdentity(rawUrl);
      if (!id.fetchUrl) return;
      if (!/^https?:\/\/mp\.weixin\.qq\.com\/s(\/|\?)/i.test(id.fetchUrl)) return;
      if (seenArticleKeys.has(id.articleKey) || seenArticleKeys.has(id.fetchUrl)) return;
      seenArticleKeys.add(id.articleKey);
      seenArticleKeys.add(id.fetchUrl);
      relatedArticles.push({
        url: id.fetchUrl,
        title: cleanTextInline(title || ""),
        articleKey: id.articleKey,
      });
    };

    // 2A. Anchor tags with href or data-link
    const aRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
    let aMatch;
    while ((aMatch = aRe.exec(bodyHtml)) !== null) {
      const href = getAttr(aMatch[0], "href") || getAttr(aMatch[0], "data-link") || getAttr(aMatch[0], "data-url");
      if (href && /mp\.weixin\.qq\.com\/s(\/|\?)/i.test(href)) {
        addRelated(href, aMatch[1]);
      } else if (href && /mp\.weixin\.qq\.com\/mp\/appmsgalbum\?/i.test(href)) {
        try {
          const u = new URL(decodeHtmlEntities(href).replace(/&amp;/g, "&"));
          const aid = u.searchParams.get("album_id");
          const abiz = u.searchParams.get("__biz") || resolvedBiz;
          if (aid && abiz) addAlbum(aid, aMatch[1], `https://mp.weixin.qq.com/mp/appmsgalbum?__biz=${abiz}&action=getalbum&album_id=${aid}`);
        } catch {}
      }
    }

    // 2B. WeChat article card elements with data-link / data-url attributes
    const cardRe = /\b(?:data-link|data-url)\s*=\s*["'](https?:\/\/mp\.weixin\.qq\.com\/s[^"']+)["']/gi;
    let cMatch;
    while ((cMatch = cardRe.exec(bodyHtml)) !== null) {
      addRelated(cMatch[1], "");
    }

    // 2C. Bare URLs mentioned as plain text in article body
    const bareRe = /https?:\/\/mp\.weixin\.qq\.com\/(?:s\/[A-Za-z0-9_-]+|s\?[^\s"'<>|,\]]+)/gi;
    let bMatch;
    while ((bMatch = bareRe.exec(bodyHtml)) !== null) {
      addRelated(bMatch[0], "");
    }
  }

  return {
    biz: resolvedBiz,
    albums,
    relatedArticles,
  };
}

/**
 * Detect if fetched HTML is a WeChat anti-bot / verification / deleted / unavailable page
 */
export function detectWechatBlockOrUnavailable(html) {
  if (!html || html.length < 200) {
    return { blocked: true, reason: "empty_response", message: "返回页面为空或过短" };
  }
  const hasJsContent = /\bid\s*=\s*["']js_content["']/i.test(html);
  const hasImageDesc = /\bid\s*=\s*["']js_image_desc["']/i.test(html) || /picture_page_info_list/.test(html);
  if (hasJsContent || hasImageDesc) {
    return { blocked: false };
  }
  if (/环境异常|完成验证后即可继续访问|去验证|secitptpage\/verify/.test(html)) {
    return {
      blocked: true,
      reason: "verification_required",
      message: "触发微信安全验证（环境异常/人机验证），已按合规策略立即停止，请稍后放慢抓取间隔或在浏览器中正常访问",
    };
  }
  if (/该内容已被发布者删除|此内容因违规无法查看|内容已被删除|该公众号已被屏蔽/.test(html)) {
    return {
      blocked: true,
      reason: "article_deleted",
      message: "该文章已被删除或无法公开访问",
    };
  }
  return {
    blocked: true,
    reason: "no_article_body",
    message: "未检测到微信公众号正文容器（可能非公开文章页或需要登录）",
  };
}

/**
 * Extract metadata from live or saved WeChat HTML
 */
export function extractWechatMetadata(html, { sourceUrl = "", fileName = "" } = {}) {
  const ogTitle = extractMetaContent(html, "og:title");
  const ogUrl = extractMetaContent(html, "og:url");
  const ogDesc = extractMetaContent(html, "og:description");
  const metaAuthor = extractMetaContent(html, "author", "name");

  // JS variables in live WeChat HTML
  const jsMsgTitle =
    html.match(/var\s+msg_title\s*=\s*['"]([^'"]+)['"]/)?.[1] ||
    html.match(/msg_title\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    "";
  const jsNickname =
    html.match(/var\s+nickname\s*=\s*htmlDecode\(\s*["']([^"']+)["']\s*\)/)?.[1] ||
    html.match(/nick_name\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    html.match(/var\s+nickname\s*=\s*["']([^"']+)["']/)?.[1] ||
    "";
  const jsAuthor = html.match(/var\s+author\s*=\s*["']([^"']+)["']/)?.[1] || "";
  const jsCt =
    html.match(/var\s+ct\s*=\s*["']?(\d{10})["']?/)?.[1] ||
    html.match(/create_time\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    "";
  const jsBiz =
    html.match(/var\s+biz\s*=\s*["']([^"']+)["']/)?.[1] ||
    html.match(/__biz=([A-Za-z0-9=_-]+)/)?.[1] ||
    "";
  const jsMid = html.match(/var\s+mid\s*=\s*["']?(\d+)["']?/)?.[1] || "";
  const jsIdx = html.match(/var\s+idx\s*=\s*["']?(\d+)["']?/)?.[1] || "";
  const jsSn = html.match(/var\s+sn\s*=\s*["']([^"']+)["']/)?.[1] || "";
  const jsMsgLink = html.match(/var\s+msg_link\s*=\s*["']([^"']+)["']/)?.[1] || "";
  const jsProvince =
    html.match(/provinceName\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    html.match(/province_name\s*:\s*['"]([^'"]+)['"]/)?.[1] ||
    "";

  // DOM fallback (essential for wechatDownload-saved HTML where <script> tags may be stripped)
  const domTitle = cleanTextInline(extractBalancedElementById(html, "activity-name") || "");
  const domAccount = cleanTextInline(extractBalancedElementById(html, "js_name") || "");
  const domAuthor = cleanTextInline(extractBalancedElementById(html, "js_author_name") || "");
  const domPublishTime = cleanTextInline(extractBalancedElementById(html, "publish_time") || "");
  const domIp = cleanTextInline(extractBalancedElementById(html, "js_ip_wording") || "");
  const htmlTitleTag = cleanTextInline(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

  const isOriginal =
    /\bid\s*=\s*["']copyright_logo["']/i.test(html) ||
    /var\s+is_original\s*=\s*['"]?1['"]?/.test(html);

  const title = cleanTextInline(ogTitle || jsMsgTitle || domTitle || htmlTitleTag || fileName.replace(/\.[^.]+$/, ""));
  const account = cleanTextInline(jsNickname || domAccount || "");
  const author = cleanTextInline(metaAuthor || jsAuthor || domAuthor || account);

  let { date, publishedAt } = normalizeDateString(jsCt);
  if (!date && domPublishTime) {
    ({ date, publishedAt } = normalizeDateString(domPublishTime));
  }
  if (!date && fileName) {
    ({ date, publishedAt } = normalizeDateString(fileName));
  }

  let ipRegion = cleanTextInline(jsProvince || domIp || "");
  ipRegion = ipRegion.replace(/^发表于\s*/, "").replace(/^IP属地[：:]\s*/, "").trim();

  const resolvedUrl = decodeHtmlEntities(sourceUrl || ogUrl || jsMsgLink || "").replace(/\?nwr_flag=1$/, "");
  const urlId = parseWechatUrlIdentity(resolvedUrl);

  const biz = urlId.biz || jsBiz;
  const mid = urlId.mid || jsMid;
  const idx = urlId.idx || jsIdx || (mid ? "1" : "");
  const sn = urlId.sn || jsSn;

  let articleKey = urlId.articleKey;
  if ((!articleKey || articleKey.startsWith("url:")) && biz && mid) {
    articleKey = `biz:${biz}|mid:${mid}|idx:${idx || "1"}`;
  } else if (!articleKey && sn) {
    articleKey = `sn:${sn}`;
  }

  return {
    title,
    account,
    author,
    publishedAt,
    date,
    ipRegion,
    sourceUrl: urlId.canonicalUrl || resolvedUrl,
    digest: cleanTextInline(ogDesc || ""),
    isOriginal,
    biz,
    mid,
    idx,
    sn,
    articleKey,
  };
}

/**
 * Convert HTML table to GFM table
 */
function convertTableToMarkdown(tableHtml) {
  const rows = [];
  const trMatches = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trMatches) {
    const cells = [];
    const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cm;
    while ((cm = cellRegex.exec(tr)) !== null) {
      const cellText = htmlFragmentToMarkdown(cm[2], { inlineOnly: true })
        .replace(/\n+/g, " ")
        .replace(/\|/g, "\\|")
        .trim();
      cells.push(cellText);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";
  const colCount = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const copy = [...r];
    while (copy.length < colCount) copy.push("");
    return copy;
  });
  const header = `| ${norm[0].join(" | ")} |`;
  const sep = `| ${norm[0].map(() => "---").join(" | ")} |`;
  const body = norm.slice(1).map((r) => `| ${r.join(" | ")} |`);
  return `\n\n${[header, sep, ...body].join("\n")}\n\n`;
}

/**
 * Remove tags with display:none or known non-article widgets
 */
function stripNoiseHtml(html) {
  let out = html;
  // Remove comments, scripts, styles, noscript, iframe, svg
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(script|style|noscript|svg|mp-style-type)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<mp-style-type\b[^>]*\/?>/gi, "");
  // Remove simple hidden blocks (display: none)
  out = out.replace(
    /<(p|span|div|section)\b[^>]*style\s*=\s*["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  // Remove WeChat footer/novel/tag widgets if somehow inside
  out = out.replace(/<div\b[^>]*class\s*=\s*["'][^"']*(?:novel-card|article-tag|wx_follow_card|qr_code_pc)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "");
  return out;
}

/**
 * Convert clean WeChat article body HTML fragment into Markdown
 */
export function htmlFragmentToMarkdown(html, options = {}) {
  if (!html) return "";
  const { inlineOnly = false, imageUrlMap = null } = options;

  let s = stripNoiseHtml(html);

  // Extract code blocks first into placeholders
  const placeholders = [];
  const stash = (text) => {
    const key = `@@WXPLACEHOLDER_${placeholders.length}@@`;
    placeholders.push(text);
    return key;
  };

  if (!inlineOnly) {
    // <pre> code blocks
    s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
      const code = stripZeroWidth(
        decodeHtmlEntities(
          inner
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/(p|div|li)>/gi, "\n")
            .replace(/<[^>]+>/g, "")
        )
      ).trim();
      if (!code) return "";
      return stash(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
    });

    // <table>
    s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tbl) => stash(convertTableToMarkdown(tbl)));
  }

  // Inline code
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner) => {
    const t = cleanTextInline(inner);
    return t ? `\`${t}\`` : "";
  });

  // Images
  s = s.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const rawSrc = getAttr(imgTag, "data-src") || getAttr(imgTag, "src") || "";
    if (!rawSrc || rawSrc.startsWith("data:image/svg") || rawSrc.startsWith("data:image/gif")) {
      return "";
    }
    // Skip tiny WeChat emoji / spacer icons if explicitly 1px
    const width = Number(getAttr(imgTag, "width") || getAttr(imgTag, "data-w") || 0);
    if (width > 0 && width <= 2) return "";
    const alt = getAttr(imgTag, "alt").replace(/[\[\]]/g, "").trim() || "图片";
    const finalSrc = (imageUrlMap && imageUrlMap.get(rawSrc)) || rawSrc;
    return inlineOnly ? `![${alt}](${finalSrc})` : `\n\n![${alt}](${finalSrc})\n\n`;
  });

  // Links
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (full, inner) => {
    const href = getAttr(full, "href");
    const label = htmlFragmentToMarkdown(inner, { inlineOnly: true, imageUrlMap }).trim();
    if (!label) return "";
    if (!href || href.startsWith("javascript:") || href === "#") return label;
    return `[${label}](${href})`;
  });

  // Headings h1-h6
  if (!inlineOnly) {
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => {
      const text = htmlFragmentToMarkdown(inner, { inlineOnly: true, imageUrlMap })
        .replace(/\n+/g, " ")
        .trim();
      if (!text) return "";
      const hashes = "#".repeat(Math.min(6, Math.max(2, Number(level) + 1)));
      return `\n\n${hashes} ${text}\n\n`;
    });

    // Blockquotes
    s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
      const content = htmlFragmentToMarkdown(inner, { imageUrlMap }).trim();
      if (!content) return "";
      const quoted = content
        .split("\n")
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n");
      return `\n\n${quoted}\n\n`;
    });

    // Ordered / unordered lists
    s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let i = 1;
      const items = [];
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let lm;
      while ((lm = liRe.exec(inner)) !== null) {
        const txt = htmlFragmentToMarkdown(lm[1], { inlineOnly: true, imageUrlMap })
          .replace(/\n+/g, " ")
          .trim();
        if (txt) items.push(`${i++}. ${txt}`);
      }
      return items.length ? `\n\n${items.join("\n")}\n\n` : "";
    });
    s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
      const items = [];
      const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let lm;
      while ((lm = liRe.exec(inner)) !== null) {
        const txt = htmlFragmentToMarkdown(lm[1], { inlineOnly: true, imageUrlMap })
          .replace(/\n+/g, " ")
          .trim();
        if (txt) items.push(`- ${txt}`);
      }
      return items.length ? `\n\n${items.join("\n")}\n\n` : "";
    });

    // Horizontal rule
    s = s.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  }

  // Bold & Italic
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
    const txt = htmlFragmentToMarkdown(inner, { inlineOnly: true, imageUrlMap }).trim();
    if (!txt) return "";
    if (/^\*\*.*\*\*$/.test(txt)) return txt;
    return `**${txt}**`;
  });
  // WeChat bold spans: <span style="...font-weight: bold / 700...">
  s = s.replace(
    /<span\b[^>]*style\s*=\s*["'][^"']*font-weight\s*:\s*(?:bold|[6-9]00)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi,
    (_, inner) => {
      const txt = htmlFragmentToMarkdown(inner, { inlineOnly: true, imageUrlMap }).trim();
      if (!txt) return "";
      if (/^\*\*.*\*\*$/.test(txt)) return txt;
      return `**${txt}**`;
    }
  );
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, inner) => {
    const txt = htmlFragmentToMarkdown(inner, { inlineOnly: true, imageUrlMap }).trim();
    if (!txt) return "";
    return `*${txt}*`;
  });

  // Line breaks & block boundaries
  s = s.replace(/<br\s*\/?>/gi, inlineOnly ? " " : "\n");
  if (!inlineOnly) {
    s = s.replace(/<\/(p|div|section|article|header|footer|li|figcaption)>/gi, "\n\n");
    s = s.replace(/<(p|div|section|article)\b[^>]*>/gi, "\n");
  } else {
    s = s.replace(/<\/?(p|div|section|span|font|label)\b[^>]*>/gi, "");
  }

  // Strip remaining HTML tags
  s = s.replace(/<[^>]+>/g, "");
  s = stripZeroWidth(decodeHtmlEntities(s));

  // Restore placeholders
  for (let i = 0; i < placeholders.length; i++) {
    s = s.replace(`@@WXPLACEHOLDER_${i}@@`, placeholders[i]);
  }

  if (inlineOnly) {
    return s.replace(/\s+/g, " ").trim();
  }

  return deepCleanMarkdownBody(s);
}

/**
 * Extract all image URLs inside WeChat article body HTML
 */
export function extractImageUrlsFromHtml(bodyHtml) {
  if (!bodyHtml) return [];
  const urls = [];
  const seen = new Set();
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    const rawSrc = getAttr(m[0], "data-src") || getAttr(m[0], "src") || "";
    if (!rawSrc || rawSrc.startsWith("data:")) continue;
    const width = Number(getAttr(m[0], "width") || getAttr(m[0], "data-w") || 0);
    if (width > 0 && width <= 2) continue;
    if (!seen.has(rawSrc)) {
      seen.add(rawSrc);
      urls.push(rawSrc);
    }
  }
  return urls;
}

/**
 * Extract article body HTML from live or saved WeChat HTML (including picture-post fallback)
 */
export function extractWechatBodyHtml(html) {
  const jsContent = extractBalancedElementById(html, "js_content");
  if (jsContent && cleanTextInline(jsContent).length > 0) {
    return jsContent;
  }
  // Fallback for image-only / 贴图号 articles
  const imgDesc = extractBalancedElementById(html, "js_image_desc");
  const picUrls = [];
  const picMatch = html.match(/window\.picture_page_info_list\s*=\s*\[([\s\S]*?)\];/);
  if (picMatch) {
    const urlRe = /cdn_url\s*:\s*['"]([^'"]+)['"]/g;
    let pm;
    while ((pm = urlRe.exec(picMatch[1])) !== null) {
      picUrls.push(decodeHtmlEntities(pm[1]).replace(/\\x26/g, "&"));
    }
  }
  if (imgDesc || picUrls.length > 0) {
    const parts = [];
    if (imgDesc) parts.push(`<p>${imgDesc}</p>`);
    for (const u of picUrls) parts.push(`<p><img src="${u}" alt="贴图"/></p>`);
    return parts.join("\n");
  }
  return jsContent || "";
}

/**
 * Extract article body HTML from WeRead /web/mp/content HTML response.
 * Prefers #js_content / #js_image_desc. If #js_content exists in the full WeChat page
 * but is genuinely empty (e.g. video/audio card without text/images), returns "" instead of
 * falling back to <body> page chrome (title/author/novel-banner).
 */
export function extractWeReadBodyHtml(html) {
  if (!html) return "";
  const standard = extractWechatBodyHtml(html);
  if (standard && (cleanTextInline(standard).length > 0 || /<img\b/i.test(standard))) {
    return standard;
  }
  // If full WeChat HTML has an explicit #js_content container that is empty, don't capture outer header chrome!
  if (/\bid\s*=\s*["']js_content["']/i.test(html)) {
    return "";
  }
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch && bodyMatch[1]) {
    let inner = bodyMatch[1];
    inner = inner.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    if (cleanTextInline(inner).length > 0 || /<img\b/i.test(inner)) {
      return inner.trim();
    }
  }
  const stripped = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, "").trim();
  if (cleanTextInline(stripped).length > 0 || /<img\b/i.test(stripped)) {
    return stripped;
  }
  return "";
}

/**
 * Detect soft rate-limit, auth-expired, or deleted/unavailable placeholder pages returned as HTTP 200 HTML
 * (e.g. WeRead returning "操作频繁，请稍后再试。" inside a normal 200 HTML shell).
 */
export function detectWeReadSoftError(html, extractedBodyText = "") {
  const plain = cleanTextInline(extractedBodyText || String(html || "").replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ""));
  if (!plain) return { isError: false };

  // Only treat as error page when there is no full article body (short text or no #js_content)
  const hasJsContent = /\bid\s*=\s*["']js_content["']/i.test(String(html || ""));
  const isShort = plain.length <= 160;

  if (
    (isShort || !hasJsContent) &&
    /操作频繁|操作过于频繁|请求过于频繁|访问过于频繁|系统繁忙，请稍后再试|请稍后再试。?$/.test(plain)
  ) {
    return {
      isError: true,
      kind: "rate_limit",
      message: `微信读书返回频控提示（${plain.slice(0, 40)}）`,
    };
  }
  if (
    (isShort || !hasJsContent) &&
    /环境异常|完成验证后即可继续访问|去验证|secitptpage\/verify/.test(plain)
  ) {
    return {
      isError: true,
      kind: "rate_limit",
      message: "触发安全验证提示（环境异常），已安全保护停止",
    };
  }
  if (
    (isShort || !hasJsContent) &&
    /该内容已被发布者删除|此内容因违规无法查看|内容已被删除|该公众号已被屏蔽/.test(plain)
  ) {
    return {
      isError: true,
      kind: "deleted",
      message: `该文章已被删除或无法查看（${plain.slice(0, 40)}）`,
    };
  }
  return { isError: false };
}

/**
 * Extract unique outbound http(s) links from article body HTML
 */
export function extractOutboundLinksFromHtml(bodyHtml) {
  if (!bodyHtml) return [];
  const urls = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(bodyHtml)) !== null) {
    const clean = decodeHtmlEntities(m[1]).replace(/&amp;/g, "&").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      urls.push(clean);
    }
  }
  return urls;
}

/**
 * Deeply clean WeChat UI noise from Markdown text (works for both HTML->MD output and dirty .md files exported by wechatDownload)
 */
export function deepCleanMarkdownBody(rawMd, { title = "", account = "" } = {}) {
  if (!rawMd) return "";
  let text = stripZeroWidth(rawMd).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 1. Truncate hard WeChat UI footer markers (everything from these UI widgets onward is WeChat chrome)
  const hardFooterPatterns = [
    /^\s*预览时标签不可点\s*$/m,
    /^\s*继续滑动看下一个\s*$/m,
    /^\s*轻触阅读原文\s*$/m,
    /^\s*微信扫一扫\s*\n\s*使用小程序\s*$/m,
    /^\s*微信扫一扫\s*\n\s*关注该公众号\s*$/m,
    /^\s*：[\s，,。.]*视频\s+小程序\s+赞.*$/m,
    /^\s*轻点两下取消赞.*$/m,
    /^\s*取消\s+允许\s*$/m,
  ];
  for (const pat of hardFooterPatterns) {
    const m = pat.exec(text);
    if (m && m.index > Math.min(80, text.length * 0.25)) {
      text = text.slice(0, m.index);
    }
  }

  // 2. Clean line-by-line UI noise
  const noiseLinePatterns = [
    /^\s*在小说阅读器读本章\s*$/,
    /^\s*去阅读\s*$/,
    /^\s*预览时标签不可点\s*$/,
    /^\s*不喜欢\s*$/,
    /^\s*知道了\s*$/,
    /^\s*取消\s+允许\s*$/,
    /^\s*\*{4,}\s*$/,
    /^\s*_{2,}\s*$/,
    /^\s*阅读原文\s*$/,
    /^\s*写留言\s*$/,
    /^\s*精选留言\s*$/,
    /^\s*赞\s*在看\s*$/,
    /^\s*分享\s*收藏\s*在看\s*赞\s*$/,
    /^\s*[：:，,。.\s]+$/,
    /^\s*点击上方蓝字关注.*$/,
    /^\s*点击蓝字\s*关注我们\s*$/,
    /^\s*向上滑动看下一个\s*$/,
  ];

  const lines = text.split("\n");
  const cleanedLines = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      cleanedLines.push(rawLine.trimEnd());
      continue;
    }
    if (inCodeBlock) {
      cleanedLines.push(rawLine);
      continue;
    }

    // Skip duplicate H1 title right at top if matches metadata title
    if (i < 6 && title && trimmed.replace(/^#\s+/, "").trim() === title.trim()) {
      continue;
    }
    // Skip top byline lines exported by wechatDownload (e.g. "原创 作者名 公众号名" or "_2026年11月23日 12:39_ __ 上海 _")
    if (i < 12) {
      if (/^原创\s+/.test(trimmed)) continue;
      if (/^_?\d{4}年\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}_?/.test(trimmed)) continue;
      if (account && trimmed === account) continue;
    }

    if (noiseLinePatterns.some((re) => re.test(trimmed))) {
      continue;
    }

    // Normalize weird inner spacing inside WeChat-converted lines (but keep markdown table / list indentation)
    let line = rawLine.replace(/\u00A0/g, " ").trimEnd();
    if (!line.startsWith(">") && !line.startsWith("|") && !/^\s*([-*]|\d+\.)\s/.test(line)) {
      line = line.replace(/^\s+/, "");
    }
    // Collapse empty bold markers like ** **
    line = line.replace(/\*\*\s*\*\*/g, "");
    cleanedLines.push(line);
  }

  let result = cleanedLines.join("\n");
  // Collapse 3+ consecutive newlines into 2
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

/**
 * Parse a dirty Markdown file (e.g. exported by wechatDownload 4.5/5.0) to extract metadata + cleaned body
 */
export function parseDirtyMarkdownFile(rawMd, { fileName = "", accountHint = "" } = {}) {
  let content = stripZeroWidth(rawMd).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let existingFrontmatter = {};

  // Check if file already has YAML frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    for (const line of fmMatch[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
      if (kv) {
        existingFrontmatter[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
      }
    }
    content = content.slice(fmMatch[0].length);
  }

  const headLines = content.split("\n").slice(0, 15);
  let title = existingFrontmatter.title || "";
  let author = existingFrontmatter.author || "";
  let account = existingFrontmatter.account || accountHint || "";
  let date = existingFrontmatter.date || "";
  let publishedAt = existingFrontmatter.published_at || "";
  let ipRegion = existingFrontmatter.ip_region || "";
  let sourceUrl = existingFrontmatter.source_url || "";
  let isOriginal = false;

  for (const l of headLines) {
    const t = l.trim();
    if (!title && /^#\s+/.test(t)) {
      title = t.replace(/^#\s+/, "").trim();
      continue;
    }
    if (/^原创\s+/.test(t)) {
      isOriginal = true;
      const parts = t.replace(/^原创\s+/, "").split(/\s+/).filter(Boolean);
      if (!author && parts[0]) author = parts[0];
      if (!account && parts[parts.length - 1]) account = parts[parts.length - 1];
      continue;
    }
    if (!date) {
      const d = normalizeDateString(t);
      if (d.date) {
        date = d.date;
        publishedAt = d.publishedAt;
        const regMatch = t.match(/\d{1,2}:\d{2}_?[\s_]+([^\s_]{2,10})/);
        if (regMatch && !ipRegion) ipRegion = regMatch[1];
      }
    }
    if (!sourceUrl) {
      const u = t.match(/https?:\/\/mp\.weixin\.qq\.com\/s[^\s)>\]]+/);
      if (u) sourceUrl = u[0];
    }
  }

  if (!date && fileName) {
    const d = normalizeDateString(fileName);
    date = d.date;
    publishedAt = d.publishedAt;
  }
  if (!title && fileName) {
    title = fileName
      .replace(/\.[^.]+$/, "")
      .replace(/^\[?\d{8,14}\]?[-_\s]*/, "")
      .replace(/^\d{4}-\d{2}-\d{2}[-_\s]*/, "")
      .trim();
  }

  const body = deepCleanMarkdownBody(content, { title, account });
  const urlId = parseWechatUrlIdentity(sourceUrl);

  return {
    meta: {
      title,
      account: account || "未知公众号",
      author: author || account || "未知作者",
      publishedAt,
      date,
      ipRegion,
      sourceUrl: urlId.canonicalUrl || sourceUrl,
      digest: "",
      isOriginal,
      biz: urlId.biz || existingFrontmatter.biz || "",
      mid: urlId.mid || "",
      idx: urlId.idx || "",
      sn: urlId.sn || "",
      articleKey: urlId.articleKey || existingFrontmatter.article_key || "",
    },
    body,
  };
}
