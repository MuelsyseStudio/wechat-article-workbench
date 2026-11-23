/**
 * Deduplication, YAML Frontmatter Builder, CSV/JSONL Exporter & Knowledge Base Indexer
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha256(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

export function normalizeTitleKey(account, date, title) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  return `${norm(account)}|${String(date || "").slice(0, 10)}|${norm(title)}`;
}

export function sanitizeFilename(name, maxLen = 80) {
  const cleaned = String(name || "untitled")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim();
  if (!cleaned) return "untitled";
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen).trim() : cleaned;
}

export function formatLocalIsoNow() {
  const now = new Date();
  const ms = now.getTime() + 8 * 3600 * 1000;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}

function yamlEscape(value) {
  const s = String(value ?? "").replace(/\r?\n/g, " ").trim();
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function csvEscape(value) {
  const s = String(value ?? "").replace(/\r?\n/g, " ");
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCleanMarkdownDocument({
  meta,
  body,
  contentHash,
  fetchedAt,
  extraTags = [],
  includeYaml = true,
}) {
  const heading = `# ${meta.title || "未命名文章"}`;
  const trimmedBody = body.trim();

  if (!includeYaml) {
    const metaLine = [meta.account, meta.author, meta.publishedAt || meta.date, meta.ipRegion]
      .filter(Boolean)
      .join(" · ");
    return `${heading}\n\n> ${metaLine}${meta.sourceUrl ? ` · [原文链接](${meta.sourceUrl})` : ""}\n\n${trimmedBody}\n`;
  }

  const tags = [];
  if (meta.account && meta.account !== "未知公众号") {
    tags.push(`公众号/${meta.account}`);
  }
  if (meta.isOriginal) {
    tags.push("原创");
  }
  for (const t of extraTags) {
    if (t && !tags.includes(t)) tags.push(t);
  }

  const charCount = body.replace(/\s+/g, "").length;
  const fmLines = [
    "---",
    `title: ${yamlEscape(meta.title || "未命名文章")}`,
    `account: ${yamlEscape(meta.account || "未知公众号")}`,
    `author: ${yamlEscape(meta.author || meta.account || "")}`,
    `published_at: ${yamlEscape(meta.publishedAt || meta.date || "")}`,
    `date: ${yamlEscape(meta.date || "")}`,
    `ip_region: ${yamlEscape(meta.ipRegion || "")}`,
    `source_url: ${yamlEscape(meta.sourceUrl || "")}`,
    `source_type: ${yamlEscape(meta.sourceChannel === "weread" ? "wechat_weread_article" : "wechat_public_article")}`,
    `evidence_level: "C"`,
    `original: ${meta.isOriginal ? "true" : "false"}`,
    `word_count: ${charCount}`,
  ];
  if (meta.biz) fmLines.push(`biz: ${yamlEscape(meta.biz)}`);
  if (meta.wereadBookId) fmLines.push(`weread_book_id: ${yamlEscape(meta.wereadBookId)}`);
  if (meta.reviewId) fmLines.push(`review_id: ${yamlEscape(meta.reviewId)}`);
  if (meta.articleKey) fmLines.push(`article_key: ${yamlEscape(meta.articleKey)}`);
  if (typeof meta.readNum === "number" && (meta.readNum > 0 || meta.reviewId)) {
    fmLines.push(`read_num: ${meta.readNum}`);
  }
  if (typeof meta.likeNum === "number" && (meta.likeNum > 0 || meta.reviewId)) {
    fmLines.push(`like_num: ${meta.likeNum}`);
  }
  fmLines.push(`content_sha256: ${yamlEscape(contentHash)}`);
  fmLines.push(`fetched_at: ${yamlEscape(fetchedAt || formatLocalIsoNow())}`);
  if (tags.length > 0) {
    fmLines.push("tags:");
    for (const tag of tags) {
      fmLines.push(`  - ${yamlEscape(tag)}`);
    }
  }
  fmLines.push("---", "");

  return `${fmLines.join("\n")}\n${heading}\n\n${trimmedBody}\n`;
}

export function buildCleanHtmlDocument({ meta, bodyHtml, bodyMd }) {
  const esc = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const inner =
    bodyHtml ||
    bodyMd
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
      .join("\n");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(meta.title || "未命名文章")}</title>
  <style>
    body { max-width: 760px; margin: 40px auto; padding: 0 20px; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; line-height: 1.8; color: #1f2937; background: #fff; }
    header { border-bottom: 1px solid #e5e7eb; padding-bottom: 16px; margin-bottom: 24px; }
    h1 { font-size: 24px; margin: 0 0 8px; }
    .meta { color: #6b7280; font-size: 13px; }
    img { max-width: 100%; height: auto; border-radius: 6px; }
    blockquote { border-left: 3px solid #0d9488; margin: 16px 0; padding: 6px 14px; background: #f8fafc; color: #374151; }
  </style>
</head>
<body>
  <header>
    <h1>${esc(meta.title || "未命名文章")}</h1>
    <div class="meta">${esc(meta.account || "")} · ${esc(meta.author || "")} · ${esc(meta.publishedAt || meta.date || "")} ${esc(meta.ipRegion || "")}${meta.sourceUrl ? ` · <a href="${esc(meta.sourceUrl)}" target="_blank">原文链接</a>` : ""}</div>
  </header>
  <article>${inner}</article>
</body>
</html>
`;
}

export class ArticleIndexStore {
  constructor(outputDir) {
    this.outputDir = path.resolve(outputDir);
    this.indexJsonPath = path.join(this.outputDir, "index.json");
    this.indexMdPath = path.join(this.outputDir, "00_文章索引.md");
    this.exportCsvPath = path.join(this.outputDir, "00_文章数据导出.csv");
    this.exportJsonlPath = path.join(this.outputDir, "wechat_articles.jsonl");
    this.data = {
      version: "2.1",
      updated_at: "",
      articles: [],
      skipped_empty: [],
    };
  }

  async load() {
    await fs.mkdir(this.outputDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexJsonPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.articles)) {
        this.data = {
          version: parsed.version || "2.1",
          updated_at: parsed.updated_at || "",
          articles: parsed.articles,
          skipped_empty: Array.isArray(parsed.skipped_empty) ? parsed.skipped_empty : [],
        };
      }
    } catch {
      this.data = { version: "2.1", updated_at: "", articles: [], skipped_empty: [] };
    }
    return this.data;
  }

  /**
   * Multi-tier deduplication:
   * 1) WeRead review_id / canonical source_url / article_key
   * 2) body content_sha256
   * 3) normalized (account + date + title)
   */
  findDuplicate({ meta, contentHash }) {
    const titleKey = normalizeTitleKey(meta.account, meta.date, meta.title);
    for (const item of this.data.articles) {
      if (meta.reviewId && item.review_id && item.review_id === meta.reviewId) {
        return { duplicate: true, reason: "review_id", existing: item };
      }
      if (meta.articleKey && item.article_key && item.article_key === meta.articleKey) {
        return { duplicate: true, reason: "article_key", existing: item };
      }
      if (meta.sourceUrl && item.source_url && item.source_url === meta.sourceUrl) {
        return { duplicate: true, reason: "source_url", existing: item };
      }
      if (contentHash && item.content_sha256 && item.content_sha256 === contentHash) {
        return { duplicate: true, reason: "content_sha256", existing: item };
      }
      if (meta.date && meta.title && item.title_key && item.title_key === titleKey) {
        return { duplicate: true, reason: "account_date_title", existing: item };
      }
    }
    return { duplicate: false };
  }

  /**
   * Check whether an article was already definitively confirmed as empty/deleted in a previous run.
   */
  findKnownEmpty(meta = {}) {
    const list = Array.isArray(this.data.skipped_empty) ? this.data.skipped_empty : [];
    const titleKey = meta.date && meta.title ? normalizeTitleKey(meta.account, meta.date, meta.title) : "";
    for (const item of list) {
      if (meta.reviewId && item.review_id && item.review_id === meta.reviewId) {
        return { knownEmpty: true, reason: item.reason || "empty_body", entry: item };
      }
      if (meta.articleKey && item.article_key && item.article_key === meta.articleKey) {
        return { knownEmpty: true, reason: item.reason || "empty_body", entry: item };
      }
      if (meta.sourceUrl && item.source_url && item.source_url === meta.sourceUrl) {
        return { knownEmpty: true, reason: item.reason || "empty_body", entry: item };
      }
      if (titleKey && item.title_key && item.title_key === titleKey) {
        return { knownEmpty: true, reason: item.reason || "empty_body", entry: item };
      }
    }
    return { knownEmpty: false };
  }

  /**
   * Record a definitively empty/deleted article so future runs skip it in 0ms without hitting network.
   * Only call for confirmed empty/deleted responses (NEVER transient network or rate-limit errors).
   */
  recordKnownEmpty({
    reviewId = "",
    articleKey = "",
    sourceUrl = "",
    account = "",
    date = "",
    title = "",
    reason = "empty_body",
    message = "",
  } = {}) {
    if (!Array.isArray(this.data.skipped_empty)) {
      this.data.skipped_empty = [];
    }
    const existing = this.findKnownEmpty({ reviewId, articleKey, sourceUrl, account, date, title });
    const titleKey = date && title ? normalizeTitleKey(account, date, title) : "";
    const now = formatLocalIsoNow();
    if (existing.knownEmpty && existing.entry) {
      if (reviewId && !existing.entry.review_id) existing.entry.review_id = reviewId;
      if (articleKey && !existing.entry.article_key) existing.entry.article_key = articleKey;
      if (sourceUrl && !existing.entry.source_url) existing.entry.source_url = sourceUrl;
      if (reason) existing.entry.reason = reason;
      if (message) existing.entry.message = message;
      existing.entry.recorded_at = now;
      return existing.entry;
    }
    const entry = {
      review_id: reviewId || "",
      article_key: articleKey || "",
      source_url: sourceUrl || "",
      account: account || "",
      date: date || "",
      title: title || "",
      title_key: titleKey,
      reason: reason || "empty_body",
      message: message || "",
      recorded_at: now,
    };
    this.data.skipped_empty.push(entry);
    return entry;
  }

  removeKnownEmpty(meta = {}) {
    if (!Array.isArray(this.data.skipped_empty) || this.data.skipped_empty.length === 0) return;
    const titleKey = meta.date && meta.title ? normalizeTitleKey(meta.account, meta.date, meta.title) : "";
    this.data.skipped_empty = this.data.skipped_empty.filter((item) => {
      if (meta.reviewId && item.review_id && item.review_id === meta.reviewId) return false;
      if (meta.articleKey && item.article_key && item.article_key === meta.articleKey) return false;
      if (meta.sourceUrl && item.source_url && item.source_url === meta.sourceUrl) return false;
      if (titleKey && item.title_key && item.title_key === titleKey) return false;
      return true;
    });
  }

  /**
   * Enrich an existing archived entry with non-destructive WeRead metadata (review_id, read_num, like_num)
   */
  enrichExistingMetadata(existing, meta) {
    if (!existing || !meta) return false;
    let changed = false;
    if (meta.reviewId && !existing.review_id) {
      existing.review_id = meta.reviewId;
      changed = true;
    }
    if (meta.wereadBookId && !existing.weread_book_id) {
      existing.weread_book_id = meta.wereadBookId;
      changed = true;
    }
    if (typeof meta.readNum === "number" && meta.readNum > 0 && meta.readNum !== existing.read_num) {
      existing.read_num = meta.readNum;
      changed = true;
    }
    if (typeof meta.likeNum === "number" && meta.likeNum > 0 && meta.likeNum !== existing.like_num) {
      existing.like_num = meta.likeNum;
      changed = true;
    }
    if (meta.summary && !existing.summary) {
      existing.summary = meta.summary;
      changed = true;
    }
    return changed;
  }

  async saveArticle({
    meta,
    body,
    bodyHtml = "",
    force = false,
    extraTags = [],
    includeDatePrefix = true,
    includeYaml = true,
    saveMd = true,
    saveHtml = false,
    saveJson = false,
  }) {
    const contentHash = sha256(body.trim());
    const dup = this.findDuplicate({ meta, contentHash });
    if (dup.duplicate && !force) {
      return {
        status: "skipped",
        reason: `duplicate:${dup.reason}`,
        filePath: path.join(this.outputDir, dup.existing.relative_path),
        relativePath: dup.existing.relative_path,
        existing: dup.existing,
      };
    }

    const accountDirName = sanitizeFilename(meta.account || "未知公众号", 50);
    const accountDir = path.join(this.outputDir, accountDirName);
    await fs.mkdir(accountDir, { recursive: true });

    const datePrefix = meta.date || "0000-00-00";
    const cleanTitle = sanitizeFilename(meta.title || "未命名文章", 75);
    const baseName = includeDatePrefix ? `${datePrefix}_${cleanTitle}` : cleanTitle;
    let fileName = `${baseName}.md`;
    let fullPath = path.join(accountDir, fileName);

    if (dup.duplicate && force && dup.existing?.relative_path) {
      fullPath = path.join(this.outputDir, dup.existing.relative_path);
      fileName = path.basename(fullPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
    } else {
      let suffix = 2;
      while (true) {
        try {
          await fs.access(fullPath);
          const rel = path.relative(this.outputDir, fullPath).replace(/\\/g, "/");
          const owner = this.data.articles.find((a) => a.relative_path === rel);
          if (owner && owner.content_sha256 === contentHash) break;
          fileName = `${baseName}_${suffix++}.md`;
          fullPath = path.join(accountDir, fileName);
        } catch {
          break;
        }
      }
    }

    const fetchedAt = formatLocalIsoNow();
    const stemPath = fullPath.replace(/\.md$/i, "");
    const extraOutputs = [];

    if (saveMd || (!saveHtml && !saveJson)) {
      const mdDoc = buildCleanMarkdownDocument({
        meta,
        body,
        contentHash,
        fetchedAt,
        extraTags,
        includeYaml,
      });
      await fs.writeFile(fullPath, mdDoc, "utf8");
    }

    if (saveHtml) {
      const htmlPath = `${stemPath}.html`;
      await fs.writeFile(htmlPath, buildCleanHtmlDocument({ meta, bodyHtml, bodyMd: body }), "utf8");
      extraOutputs.push(path.relative(this.outputDir, htmlPath).replace(/\\/g, "/"));
    }

    if (saveJson) {
      const jsonPath = `${stemPath}.json`;
      await fs.writeFile(
        jsonPath,
        JSON.stringify({ ...meta, content_sha256: contentHash, fetched_at: fetchedAt, body }, null, 2) + "\n",
        "utf8"
      );
      extraOutputs.push(path.relative(this.outputDir, jsonPath).replace(/\\/g, "/"));
    }

    const relativePath = path.relative(this.outputDir, fullPath).replace(/\\/g, "/");
    const prev = dup.duplicate ? dup.existing : null;
    const entry = {
      title: meta.title || "未命名文章",
      account: meta.account || "未知公众号",
      author: meta.author || meta.account || "",
      date: meta.date || "",
      published_at: meta.publishedAt || meta.date || "",
      ip_region: meta.ipRegion || "",
      original: Boolean(meta.isOriginal),
      source_url: meta.sourceUrl || prev?.source_url || "",
      source_channel: meta.sourceChannel || prev?.source_channel || "public",
      article_key: meta.articleKey || prev?.article_key || "",
      biz: meta.biz || prev?.biz || "",
      weread_book_id: meta.wereadBookId || prev?.weread_book_id || "",
      review_id: meta.reviewId || prev?.review_id || "",
      read_num: typeof meta.readNum === "number" ? meta.readNum : prev?.read_num ?? null,
      like_num: typeof meta.likeNum === "number" ? meta.likeNum : prev?.like_num ?? null,
      summary: meta.summary || meta.digest || prev?.summary || "",
      outbound_links: Array.isArray(meta.outboundLinks) ? meta.outboundLinks : prev?.outbound_links || [],
      title_key: normalizeTitleKey(meta.account, meta.date, meta.title),
      content_sha256: contentHash,
      word_count: body.replace(/\s+/g, "").length,
      relative_path: relativePath,
      extra_outputs: extraOutputs,
      fetched_at: fetchedAt,
    };

    if (dup.duplicate) {
      const idx = this.data.articles.indexOf(dup.existing);
      if (idx >= 0) this.data.articles[idx] = entry;
      else this.data.articles.push(entry);
    } else {
      this.data.articles.push(entry);
    }

    // If this article was previously marked empty and later succeeded on force-retry, remove from skipped_empty
    this.removeKnownEmpty(meta);

    return {
      status: dup.duplicate ? "updated" : "saved",
      filePath: fullPath,
      relativePath,
      extraOutputs,
      entry,
    };
  }

  async flush() {
    this.data.articles.sort((a, b) => {
      const da = a.published_at || a.date || "";
      const db = b.published_at || b.date || "";
      if (da !== db) return db.localeCompare(da);
      return (a.title || "").localeCompare(b.title || "", "zh-CN");
    });
    this.data.updated_at = formatLocalIsoNow();
    await fs.writeFile(this.indexJsonPath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    await this.writeMarkdownIndex();
  }

  async writeMarkdownIndex() {
    const accounts = [...new Set(this.data.articles.map((a) => a.account))];
    const lines = [
      "# 公众号文章清洗归档索引",
      "",
      `- 更新时间：${this.data.updated_at}`,
      `- 归档总数：${this.data.articles.length} 篇（涵盖 ${accounts.length} 个公众号）`,
      `- 证据等级说明：公众号公开文章默认标记为 \`evidence_level: C\`，供个人知识库（Obsidian / Notion / RAG）研究参考与去重溯源。`,
      "",
      "| 发布日期 | 公众号 | 标题 | 字数 | 阅读/点赞 | 原文链接 | SHA256前8位 |",
      "| :--- | :--- | :--- | ---: | ---: | :--- | :--- |",
    ];
    for (const a of this.data.articles) {
      const safeTitle = String(a.title || "").replace(/\|/g, "\\|");
      const linkPath = encodeURI(a.relative_path);
      const srcLink = a.source_url ? `[原文](${a.source_url})` : "—";
      const statsCell =
        typeof a.read_num === "number" || typeof a.like_num === "number"
          ? `${a.read_num ?? "-"} / ${a.like_num ?? "-"}`
          : "—";
      lines.push(
        `| ${a.date || "—"} | ${a.account} | [${safeTitle}](./${linkPath}) | ${a.word_count} | ${statsCell} | ${srcLink} | \`${(
          a.content_sha256 || ""
        ).slice(0, 8)}\` |`
      );
    }
    lines.push("");
    await fs.writeFile(this.indexMdPath, lines.join("\n"), "utf8");
  }

  async exportCsv() {
    const headers = [
      "发布日期",
      "发布时间",
      "公众号",
      "作者",
      "标题",
      "原创",
      "属地",
      "字数",
      "阅读数",
      "点赞数",
      "采集通道",
      "review_id",
      "weread_book_id",
      "原文链接",
      "本地相对路径",
      "SHA256",
      "入库时间",
    ];
    const rows = [headers.join(",")];
    for (const a of this.data.articles) {
      rows.push(
        [
          a.date || "",
          a.published_at || "",
          a.account || "",
          a.author || "",
          a.title || "",
          a.original ? "是" : "否",
          a.ip_region || "",
          a.word_count ?? 0,
          a.read_num ?? "",
          a.like_num ?? "",
          a.source_channel === "weread" ? "微信读书" : "公开链接/本地",
          a.review_id || "",
          a.weread_book_id || "",
          a.source_url || "",
          a.relative_path || "",
          a.content_sha256 || "",
          a.fetched_at || "",
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    const csvWithBom = "\uFEFF" + rows.join("\r\n") + "\r\n";
    await fs.writeFile(this.exportCsvPath, csvWithBom, "utf8");
    return { csvPath: this.exportCsvPath, csvContent: csvWithBom, count: this.data.articles.length };
  }

  /**
   * Export JSONL compatible with the WeRead guide's downstream schema (wechat_articles.jsonl)
   */
  async exportJsonl() {
    const lines = [];
    for (const a of this.data.articles) {
      let bodyText = "";
      try {
        const raw = await fs.readFile(path.join(this.outputDir, a.relative_path), "utf8");
        bodyText = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
      } catch {}
      lines.push(
        JSON.stringify({
          source_id: a.weread_book_id || a.biz || "",
          source_name: a.account || "",
          title: a.title || "",
          url: a.source_url || "",
          published_at: a.published_at || a.date || "",
          summary: a.summary || "",
          content: bodyText,
          outbound_links: a.outbound_links || [],
          review_id: a.review_id || "",
          read_num: a.read_num ?? 0,
          like_num: a.like_num ?? 0,
          word_count: a.word_count ?? 0,
          relative_path: a.relative_path || "",
          content_sha256: a.content_sha256 || "",
        })
      );
    }
    const content = lines.join("\n") + (lines.length ? "\n" : "");
    await fs.writeFile(this.exportJsonlPath, content, "utf8");
    return { jsonlPath: this.exportJsonlPath, count: lines.length };
  }

  query({ account = "", keyword = "", dateFrom = "", dateTo = "", limit = 100 } = {}) {
    const accLower = account.trim().toLowerCase();
    const kwLower = keyword.trim().toLowerCase();
    const matched = this.data.articles.filter((a) => {
      if (accLower && !(a.account || "").toLowerCase().includes(accLower)) return false;
      if (dateFrom && a.date && a.date < dateFrom) return false;
      if (dateTo && a.date && a.date > dateTo) return false;
      if (kwLower) {
        const hay = `${a.title} ${a.account} ${a.author} ${a.relative_path}`.toLowerCase();
        if (!hay.includes(kwLower)) return false;
      }
      return true;
    });
    return {
      total: matched.length,
      accounts: [...new Set(this.data.articles.map((a) => a.account).filter(Boolean))],
      items: matched.slice(0, Math.max(1, limit)),
    };
  }
}
