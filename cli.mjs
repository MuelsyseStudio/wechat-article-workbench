#!/usr/bin/env node
/**
 * wxclean — Zero-dependency CLI for WeChat Official Account Archiver,
 * Account Name Lookup, Multi-Account Auto-Subscriptions & Deep Markdown Cleaner.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OUTPUT_DIR,
  batchFetchInputs,
  cleanLocalDirectory,
  exportArticlesCsv,
  exportArticlesJsonl,
  fetchAlbum,
  fetchSingleArticle,
  inspectInputs,
  inspectWeReadAccounts,
  searchCleanedIndex,
  syncWeReadAccounts,
} from "./src/pipeline.mjs";
import {
  DEFAULT_DAILY_WEREAD_LIMIT,
  findChromiumExecutable,
  getDailyWeReadQuota,
  getWeReadStatus,
  openWeReadLoginWindow,
  saveWeReadAccount,
} from "./src/weread-cdp.mjs";
import {
  getMpAdminStatus,
  openMpAdminLoginWindow,
  searchMpAdminAccountsByName,
} from "./src/mp-admin-cdp.mjs";
import {
  addSubscriptions,
  loadSubscriptions,
  removeSubscriptionAccount,
  runSubscriptionsCheck,
  updateSubscriptionAccount,
  updateSubscriptionConfig,
} from "./src/subscriptions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fsSync.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const VERSION = PKG.version || "2.3.0";

function printHelp() {
  console.log(`wxclean v${VERSION} — 微信公众号文章采集、搜号换算、多号订阅与深度清洗 CLI

使用方式:
  wxclean <命令> [参数...] [选项]          （npm link 全局安装后任意目录可用）
  .\\wxclean.cmd <命令> [参数...] [选项]    （Windows 绿色便携版零安装直接运行）
  node cli.mjs <命令> [参数...] [选项]     （源码目录直接运行）

服务与环境体检:
  doctor / status                   一键体检（Node/浏览器/微信读书&搜号登录态/今日配额/归档统计）
  serve / ui [--port 4546] [--open] 启动本地 Web 可视化工作台 + Streamable HTTP MCP
  mcp [--http] [--port 4546]        启动本地 MCP 服务（默认 stdio，加 --http 启动 HTTP 端点）
  quota                             查看今日微信读书拉取计数与单日安全上限（建议 ≤1200~1500 篇）
  version / -v                      查看当前版本号

微信读书全量采集 & 搜号换算:
  login / weread-login              拉起可见 Edge/Chrome 打开微信读书网页版扫码登录
  weread-status                     查看微信读书登录态详情（JSON）
  mp-login / mp-status              登录或检查个人公众号后台会话（用于按公众号名搜号）
  search / mp-search <公众号名称>    按公众号名称搜索并自动换算为 MP_WXS_<数字> 与 __biz
  list / weread-list <目标...>      解析公众号全量历史目录（支持名称 / 单篇链接 / 合集 / MP_WXS_...）
  sync / weread-sync <目标...>      批量拉取正文并深度清洗为干净 YAML Markdown（断点续传去重）

多公众号定时订阅:
  sub / sub-list                    查看所有已订阅公众号与自动更新设置
  sub-add <目标...> [选项]           批量订阅一个或多个公众号（支持名称 / 链接 / MP_WXS_...）
  sub-toggle <bookId> [--on|--off]  启用或暂停单个公众号的自动订阅
  sub-remove <bookId>               退订指定公众号（保留本地已下载的文章文件）
  sub-sync [--book-id <id>]         立即增量检查订阅更新并自动下载清洗新文章
  sub-watch [--interval 60]         前台常驻守护：按周期自动检查全部已启用订阅

公开链接直抓 & 本地清洗:
  fetch <url...> [选项]             抓取单篇或多篇公开微信文章链接
  inspect <url-or-file...> [选项]   解析合集/清单并探测单篇文章的公开合集标签与文内推荐
  batch <file-or-url...> [选项]     批量抓取（支持 URL、合集链接、TXT/MD/CSV/JSON 文件）
  album <album-url> [选项]          抓取公开合集/专栏 (appmsgalbum) 全部文章
  clean-dir <input-dir> [选项]      深度清洗本地导出目录（无损重解析 .html 或净化脏 .md）

本地知识库检索、阅读与导出:
  index [选项]                      按公众号/关键词/日期查询已归档的干净 Markdown 列表
  read <关键词或相对路径>            在终端直接预览指定已归档文章的干净 Markdown 正文
  export-csv                        导出已归档文章汇总表（UTF-8 BOM CSV，Excel 直接打开）
  export-jsonl                      导出全量归档数据为 wechat_articles.jsonl（AI / RAG 就绪）

常用选项（均支持 --flag value 或 --flag=value）:
  -o, --out <dir>          输出归档目录（默认: ${DEFAULT_OUTPUT_DIR}）
  --from <YYYY-MM-DD>      仅保留该日期及之后的文章（sub-add 时作为起始追踪日期）
  --to <YYYY-MM-DD>        仅保留该日期及之前的文章
  --delay <ms>             批量抓取礼貌间隔毫秒数（默认: 3000）
  --daily-limit <n>        微信读书单日安全上限篇数（默认: ${DEFAULT_DAILY_WEREAD_LIMIT}，建议 ≤1500；0 为不限）
  -n, --max <n>            单次最多处理/返回篇数（默认: 200）
  --max-pages <n>          微信读书目录最多翻页数（默认: 50）
  --start-page <n>         微信读书目录起始页码（默认: 1）
  --min-reads <n>          最小阅读量过滤阈值（默认: 0）
  --min-words <n>          正文最少字数过滤阈值（默认: 0）
  --only-original          仅保留原创文章
  --download-images        将文章图片本地化下载到 assets/ 并改为相对路径
  --save-html / --save-json 额外导出纯净 HTML / 单篇 JSON 元数据
  --no-yaml                不在 Markdown 顶部写入 YAML Frontmatter
  --no-date-prefix         文件名不加发布日期前缀
  --jsonl                  同步完成后同时导出 wechat_articles.jsonl
  --discover-related       公开单篇抓取时自动探测公开合集标签与文内往期推荐
  --force                  忽略去重，强制重新抓取并覆盖已有文件
  --tag <标签>             附加额外 YAML 标签（可重复传入）
  -a, --account <名称>     按公众号名称筛选（index / read / clean-dir）
  -q, --keyword <关键词>   按标题/作者/路径关键词筛选（index / read）
  --category <分组>        订阅分组名（sub-add，默认: 默认分组）
  --book-id <bookId>       仅同步单个订阅公众号（sub-sync）
  --interval <分钟>        定时检查间隔分钟数（sub-watch，默认: 60）
  --on / --off             明确指定启用或暂停（sub-toggle）
  -p, --port <端口>        指定服务端口（serve / mcp --http，默认: 4546）
  --open                   启动 Web 工作台后自动打开浏览器（serve）
  --http                   以 Streamable HTTP 模式启动 MCP（mcp）
  --json                   以纯 JSON 输出结果（适合脚本与 AI 管道）
  -v, --version            输出版本号
  -h, --help               显示此帮助信息

快捷示例:
  wxclean doctor
  wxclean login
  wxclean search "晚点LatePost"
  wxclean sync MP_WXS_1234567890 --from 2025-01-01 --delay 4000 --jsonl
  wxclean sub-add MP_WXS_1234567890 --category 投研
  wxclean index -a 晚点LatePost -q 财报 -n 20
  wxclean export-csv
  wxclean serve --open
`);
}

function parseArgs(argv) {
  // Normalize --flag=value into ["--flag", "value"]
  const expanded = [];
  for (const token of argv) {
    if (token.startsWith("--") && token.includes("=")) {
      const idx = token.indexOf("=");
      expanded.push(token.slice(0, idx), token.slice(idx + 1));
    } else {
      expanded.push(token);
    }
  }

  const positionals = [];
  const opts = {
    out: DEFAULT_OUTPUT_DIR,
    from: "",
    to: "",
    delay: 3000,
    dailyLimit: DEFAULT_DAILY_WEREAD_LIMIT,
    max: 200,
    maxPages: 50,
    startPage: 1,
    minReads: 0,
    minWords: 0,
    onlyOriginal: false,
    includeYaml: true,
    includeDatePrefix: true,
    saveHtml: false,
    saveJson: false,
    jsonl: false,
    discoverRelated: false,
    downloadImages: false,
    force: false,
    tags: [],
    account: "",
    keyword: "",
    category: "默认分组",
    bookId: "",
    interval: 60,
    port: 4546,
    open: false,
    http: false,
    toggleOn: false,
    toggleOff: false,
    json: false,
    version: false,
    help: false,
  };

  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if ((a === "-o" || a === "--out") && expanded[i + 1]) opts.out = path.resolve(expanded[++i]);
    else if (a === "--from" && expanded[i + 1]) opts.from = expanded[++i];
    else if (a === "--to" && expanded[i + 1]) opts.to = expanded[++i];
    else if (a === "--delay" && expanded[i + 1]) opts.delay = Number(expanded[++i]);
    else if (a === "--daily-limit" && expanded[i + 1]) opts.dailyLimit = Number(expanded[++i]);
    else if ((a === "-n" || a === "--max") && expanded[i + 1]) opts.max = Number(expanded[++i]);
    else if (a === "--max-pages" && expanded[i + 1]) opts.maxPages = Number(expanded[++i]);
    else if (a === "--start-page" && expanded[i + 1]) opts.startPage = Number(expanded[++i]);
    else if (a === "--min-reads" && expanded[i + 1]) opts.minReads = Number(expanded[++i]);
    else if (a === "--min-words" && expanded[i + 1]) opts.minWords = Number(expanded[++i]);
    else if (a === "--only-original") opts.onlyOriginal = true;
    else if (a === "--no-yaml") opts.includeYaml = false;
    else if (a === "--no-date-prefix") opts.includeDatePrefix = false;
    else if (a === "--save-html") opts.saveHtml = true;
    else if (a === "--save-json") opts.saveJson = true;
    else if (a === "--category" && expanded[i + 1]) opts.category = expanded[++i];
    else if (a === "--book-id" && expanded[i + 1]) opts.bookId = expanded[++i];
    else if (a === "--interval" && expanded[i + 1]) opts.interval = Number(expanded[++i]);
    else if ((a === "-p" || a === "--port") && expanded[i + 1]) opts.port = Number(expanded[++i]);
    else if (a === "--open") opts.open = true;
    else if (a === "--http") opts.http = true;
    else if (a === "--on") opts.toggleOn = true;
    else if (a === "--off") opts.toggleOff = true;
    else if (a === "--jsonl") opts.jsonl = true;
    else if (a === "--discover-related") opts.discoverRelated = true;
    else if (a === "--download-images") opts.downloadImages = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--tag" && expanded[i + 1]) opts.tags.push(expanded[++i]);
    else if ((a === "-a" || a === "--account") && expanded[i + 1]) opts.account = expanded[++i];
    else if ((a === "-q" || a === "--keyword") && expanded[i + 1]) opts.keyword = expanded[++i];
    else if (a === "--json") opts.json = true;
    else positionals.push(a);
  }
  return { command: positionals[0] || "", args: positionals.slice(1), opts };
}

function renderSummary(title, res, asJson) {
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`\n=== ${title} ===`);
  if (res.outputDir) console.log(`输出目录: ${res.outputDir}`);
  if (res.indexFile) console.log(`索引文件: ${res.indexFile}`);
  if (typeof res.totalInputs === "number") {
    console.log(
      `总计: ${res.totalInputs} | 新增: ${res.saved} | 更新: ${res.updated} | 去重跳过: ${res.skipped} | 条件过滤: ${res.filteredOut} | 失败: ${res.errors}`
    );
  } else if (typeof res.scanned === "number") {
    console.log(
      `扫描: ${res.scanned} | 新增: ${res.saved} | 更新: ${res.updated} | 去重跳过: ${res.skipped} | 条件过滤: ${res.filteredOut} | 失败: ${res.errors}`
    );
  } else if (res.status) {
    console.log(
      `状态: ${res.status}${res.reason ? ` (${res.reason})` : ""}${res.message ? ` - ${res.message}` : ""}`
    );
    if (res.meta?.title) {
      console.log(`标题: ${res.meta.title} (${res.meta.account} | ${res.meta.publishedAt || res.meta.date})`);
    }
    if (res.filePath) console.log(`文件: ${res.filePath}`);
  }
  if (res.stoppedEarly) {
    console.log(`⚠️ 提前中止: ${res.stopReason}`);
  }
  if (Array.isArray(res.items) && res.items.length > 0 && res.items.length <= 30) {
    console.log("\n明细:");
    for (const it of res.items) {
      const label = it.title || it.url || it.sourceFile || "";
      console.log(
        `  - [${it.status}] ${it.date ? it.date + " " : ""}${label}${it.relativePath ? " -> " + it.relativePath : ""}${
          it.reason ? " (" + it.reason + ")" : ""
        }`
      );
    }
  }
}

async function checkLocalWebReachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnForegroundScript(scriptName, scriptArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, scriptName), ...scriptArgs], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

async function main() {
  const { command, args, opts } = parseArgs(process.argv.slice(2));

  if (opts.version || command === "version") {
    if (opts.json) {
      console.log(JSON.stringify({ name: PKG.name, version: VERSION, node: process.version }));
    } else {
      console.log(`wxclean v${VERSION} (Node ${process.version})`);
    }
    return;
  }

  if (opts.help || !command) {
    printHelp();
    process.exit(0);
  }

  const progressLogger = opts.json
    ? null
    : (evt) => {
        if (evt.message && !evt.total) {
          console.error(evt.message);
        } else if (evt.total) {
          console.error(`[${evt.index}/${evt.total}] ${evt.status} | ${evt.title || evt.url}`);
        }
      };

  // --- Service & Diagnostics ---
  if (command === "doctor" || command === "status") {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const browser = findChromiumExecutable();
    const [weread, mpAdmin, quota, idx, subs, webUp] = await Promise.all([
      getWeReadStatus({ probeApi: false }).catch(() => ({ loggedIn: false })),
      getMpAdminStatus({ probeApi: false }).catch(() => ({ loggedIn: false })),
      getDailyWeReadQuota(opts.out).catch(() => ({ date: "", contentFetches: 0, defaultLimit: DEFAULT_DAILY_WEREAD_LIMIT })),
      searchCleanedIndex({ outputDir: opts.out, limit: 1 }).catch(() => ({ total: 0, accounts: [], outputDir: opts.out })),
      loadSubscriptions({ outputDir: opts.out }).catch(() => ({ accounts: [], scheduler: { enabled: false, intervalMinutes: 60 } })),
      checkLocalWebReachable(opts.port),
    ]);

    const report = {
      version: VERSION,
      node: { version: process.version, major: nodeMajor, ok: nodeMajor >= 22 },
      browser: { available: Boolean(browser.executablePath), name: browser.browserName || "未检测到" },
      webUi: { port: opts.port, running: webUp, url: `http://127.0.0.1:${opts.port}` },
      weread: {
        loggedIn: Boolean(weread.loggedIn),
        browserRunning: Boolean(weread.browserRunning),
        profileExists: Boolean(weread.profileExists),
        userName: weread.userName || "",
      },
      mpAdminSearch: {
        loggedIn: Boolean(mpAdmin.loggedIn),
        browserRunning: Boolean(mpAdmin.browserRunning),
        profileExists: Boolean(mpAdmin.profileExists),
        accountName: mpAdmin.accountName || "",
      },
      dailyQuota: quota,
      archive: {
        outputDir: idx.outputDir || opts.out,
        totalArticles: idx.total || 0,
        accountCount: (idx.accounts || []).length,
        accounts: idx.accounts || [],
      },
      subscriptions: {
        total: subs.accounts.length,
        enabled: subs.accounts.filter((a) => a.enabled).length,
        autoEnabled: Boolean(subs.scheduler?.enabled),
        intervalMinutes: subs.scheduler?.intervalMinutes || 60,
      },
    };

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`\n=== wxclean v${VERSION} 环境与状态体检 ===`);
    console.log(`Node.js     : ${report.node.version} ${report.node.ok ? "✓" : "✕ (需要 >= 22)"}`);
    console.log(`本地浏览器  : ${report.browser.available ? `${report.browser.name} ✓` : "✕ 未检测到 Edge/Chrome"}`);
    console.log(`Web 工作台  : ${report.webUi.running ? `运行中 (${report.webUi.url}) ✓` : `未启动（可用 wxclean serve --open 启动）`}`);
    console.log(
      `微信读书    : ${
        report.weread.loggedIn
          ? `已登录${report.weread.userName ? ` (${report.weread.userName})` : ""} ✓`
          : report.weread.profileExists
          ? "已有本地档案（执行时自动唤醒）"
          : "未登录（运行 wxclean login 扫码）"
      }`
    );
    console.log(
      `搜号后台    : ${
        report.mpAdminSearch.loggedIn
          ? `已登录${report.mpAdminSearch.accountName ? ` (${report.mpAdminSearch.accountName})` : ""} ✓`
          : report.mpAdminSearch.profileExists
          ? "已有本地档案（按名称搜号时自动唤醒）"
          : "未登录（可选，运行 wxclean mp-login 扫码）"
      }`
    );
    console.log(
      `今日配额    : ${quota.contentFetches || 0} / ${quota.defaultLimit || DEFAULT_DAILY_WEREAD_LIMIT} 篇 (${quota.date || "今日"} · 建议每日 ≤1500 防 -2041)`
    );
    console.log(
      `已归档知识库: ${report.archive.totalArticles} 篇 / ${report.archive.accountCount} 个公众号 (${report.archive.outputDir})`
    );
    console.log(
      `多号订阅    : ${report.subscriptions.enabled}/${report.subscriptions.total} 个启用（自动检查：${
        report.subscriptions.autoEnabled ? `每 ${report.subscriptions.intervalMinutes} 分钟` : "关闭"
      }）\n`
    );
    return;
  }

  if (command === "quota") {
    const q = await getDailyWeReadQuota(opts.out);
    if (opts.json) {
      console.log(JSON.stringify(q, null, 2));
    } else {
      console.log(
        `[${q.date}] 今日微信读书正文拉取：${q.contentFetches} 篇（默认安全上限 ${q.defaultLimit || DEFAULT_DAILY_WEREAD_LIMIT} 篇，建议单日不超过 ${q.advisoryMax || q.advisoryLimit || 1500} 篇防 -2041 风控）`
      );
    }
    return;
  }

  if (command === "serve" || command === "ui") {
    const passArgs = ["--port", String(opts.port)];
    if (opts.open) passArgs.push("--open");
    const exitCode = await spawnForegroundScript("web-server.mjs", passArgs);
    process.exit(exitCode);
  }

  if (command === "mcp") {
    const passArgs = [];
    if (opts.http) {
      passArgs.push("--http", "--port", String(opts.port));
    }
    const exitCode = await spawnForegroundScript("mcp-server.mjs", passArgs);
    process.exit(exitCode);
  }

  // --- WeRead Full-History & MP Name Search ---
  if (command === "weread-login" || command === "login") {
    const res = await openWeReadLoginWindow();
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.loggedIn) {
      console.log(`✓ 微信读书已登录（${res.userName || `vid:${res.vid}`}），持久化目录：${res.profileDir}`);
    } else {
      console.log(`已打开 ${res.browserName} 访问 https://weread.qq.com/，请在弹出的窗口中完成微信扫码登录。`);
      console.log(`Cookie 将自动保存至：${res.profileDir}`);
    }
    return;
  }

  if (command === "weread-status") {
    const res = await getWeReadStatus({ probeApi: true });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "weread-list" || command === "list") {
    if (args.length === 0) {
      console.error("错误：请提供公众号名称、文章链接、含 __biz 的合集链接，或 MP_WXS_<数字>");
      process.exit(1);
    }
    const res = await inspectWeReadAccounts(args, {
      outputDir: opts.out,
      dateFrom: opts.from,
      dateTo: opts.to,
      minReads: opts.minReads,
      onlyOriginal: opts.onlyOriginal,
      maxArticles: opts.max,
      maxPages: opts.maxPages,
      startPage: opts.startPage,
      delayMs: opts.delay,
      onProgress: progressLogger,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      const emptyPart = res.emptyCount > 0 ? ` / 已知空文 ${res.emptyCount}` : "";
      console.log(`\n共命中 ${res.articleCount} 篇（新增待抓 ${res.newCount} / 已归档 ${res.archivedCount}${emptyPart}）`);
      for (const a of res.accounts || []) {
        console.log(`  [公众号] ${a.accountName || "未知"} -> ${a.bookId} (__biz=${a.biz})`);
      }
      for (const art of (res.articles || []).slice(0, 25)) {
        console.log(
          `  - [${art.date || "未知日期"}] ${art.title} | 阅读 ${art.readNum} / 点赞 ${art.likeNum}${
            art.alreadyArchived ? " [已归档]" : art.alreadyEmpty ? " [空文]" : ""
          }`
        );
      }
      if ((res.articles || []).length > 25) console.log(`  ... 共 ${res.articles.length} 篇`);
      if (res.stoppedEarly && res.stopReason) console.log(`⚠️ ${res.stopReason}`);
    }
    return;
  }

  if (command === "weread-sync" || command === "sync") {
    if (args.length === 0) {
      console.error("错误：请提供公众号名称、文章链接、含 __biz 的合集链接，或 MP_WXS_<数字>");
      process.exit(1);
    }
    const res = await syncWeReadAccounts(args, {
      outputDir: opts.out,
      dateFrom: opts.from,
      dateTo: opts.to,
      minReads: opts.minReads,
      minWords: opts.minWords,
      onlyOriginal: opts.onlyOriginal,
      maxArticles: opts.max,
      maxPages: opts.maxPages,
      startPage: opts.startPage,
      delayMs: opts.delay,
      dailyLimit: opts.dailyLimit,
      downloadImages: opts.downloadImages,
      includeYaml: opts.includeYaml,
      includeDatePrefix: opts.includeDatePrefix,
      saveHtml: opts.saveHtml,
      saveJson: opts.saveJson,
      force: opts.force,
      extraTags: opts.tags,
      saveJsonl: opts.jsonl,
      onProgress: progressLogger,
    });
    renderSummary("微信读书通道同步结果", res, opts.json);
    if (!opts.json && res.jsonlFile) console.log(`JSONL 文件: ${res.jsonlFile}`);
    return;
  }

  if (command === "mp-login") {
    const res = await openMpAdminLoginWindow({ includeQr: false });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.loggedIn) {
      console.log(`✓ 公众号后台已登录（${res.accountName || `token:${res.token}`}），持久化目录：${res.profileDir}`);
    } else {
      console.log(`已打开 ${res.browserName} 访问 https://mp.weixin.qq.com/，请用微信扫码并选择你的个人公众号登录。`);
    }
    return;
  }

  if (command === "mp-status") {
    const res = await getMpAdminStatus({ probeApi: true });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (command === "mp-search" || command === "search") {
    const query = args.join(" ").trim();
    if (!query) {
      console.error("错误：请提供要搜索的公众号名称，例如：wxclean search 晚点LatePost");
      process.exit(1);
    }
    const res = await searchMpAdminAccountsByName(query, { count: 8, autoLaunch: true });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (!res.ok) {
      console.error(`⚠️ 搜索失败：${res.errMsg || "未知错误"}`);
      process.exit(1);
    } else if (!res.accounts || res.accounts.length === 0) {
      console.log(`未找到与「${query}」匹配的公众号。`);
    } else {
      console.log(`\n搜到 ${res.accounts.length} 个匹配公众号（可直接把 MP_WXS_... 传给 sync / list / sub-add）：`);
      for (const a of res.accounts) {
        console.log(`  - ${a.nickname}${a.alias ? ` (微信号: ${a.alias})` : ""} -> ${a.bookId}  [__biz=${a.biz}]`);
      }
      const exact = res.accounts.find((a) => a.nickname.toLowerCase() === query.toLowerCase()) || res.accounts[0];
      if (exact?.bookId) {
        await saveWeReadAccount({
          bookId: exact.bookId,
          biz: exact.biz,
          numericId: exact.numericId,
          accountName: exact.nickname,
        });
      }
    }
    return;
  }

  // --- Multi-Account Auto-Subscriptions ---
  if (command === "sub" || command === "sub-list") {
    const data = await loadSubscriptions({ outputDir: opts.out });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(
        `订阅总数: ${data.accounts.length} | 自动定时: ${
          data.scheduler.enabled ? `开启 (每 ${data.scheduler.intervalMinutes} 分钟)` : "关闭"
        }`
      );
      for (const a of data.accounts) {
        console.log(
          `- [${a.enabled ? "启用" : "暂停"}] ${a.name} (${a.bookId}) | 分组: ${a.category} | 已归档: ${a.totalSynced} | 状态: ${a.lastStatus} | 最新: ${a.lastArticleDate || "—"} ${a.lastArticleTitle || ""}`
        );
      }
    }
    return;
  }

  if (command === "sub-add") {
    if (args.length === 0) {
      console.error("错误：请提供至少一个公众号名称、文章链接、合集链接或 MP_WXS_<数字>");
      process.exit(1);
    }
    const res = await addSubscriptions(args, {
      outputDir: opts.out,
      category: opts.category,
      since: opts.from,
      tags: opts.tags,
      onProgress: progressLogger,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.error && res.added.length === 0 && res.existing.length === 0) {
      console.error(`添加订阅失败: ${res.error}`);
      process.exit(1);
    } else {
      console.log(`订阅成功：新增 ${res.added.length} 个，已存在并启用 ${res.existing.length} 个`);
      for (const a of [...res.added, ...res.existing]) {
        console.log(`  - ${a.name} (${a.bookId}) [分组: ${a.category}]`);
      }
    }
    return;
  }

  if (command === "sub-toggle") {
    if (!args[0]) {
      console.error("错误：请提供要切换状态的 bookId（例如 wxclean sub-toggle MP_WXS_1234567890 --off）");
      process.exit(1);
    }
    const data = await loadSubscriptions({ outputDir: opts.out });
    const target = data.accounts.find((a) => a.bookId === args[0] || a.name === args[0]);
    if (!target) {
      console.error(`未找到订阅：${args[0]}`);
      process.exit(1);
    }
    const nextEnabled = opts.toggleOn ? true : opts.toggleOff ? false : !target.enabled;
    const res = await updateSubscriptionAccount(target.bookId, { enabled: nextEnabled }, { outputDir: opts.out });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`已将订阅「${target.name} (${target.bookId})」设为：${nextEnabled ? "启用" : "暂停"}`);
    }
    return;
  }

  if (command === "sub-remove") {
    if (!args[0]) {
      console.error("错误：请提供要退订的 bookId（例如 MP_WXS_1234567890）");
      process.exit(1);
    }
    const res = await removeSubscriptionAccount(args[0], { outputDir: opts.out });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(res.removed > 0 ? `已退订 ${args[0]}` : `未找到订阅 ${args[0]}`);
    return;
  }

  if (command === "sub-sync") {
    const res = await runSubscriptionsCheck({
      outputDir: opts.out,
      bookId: opts.bookId,
      trigger: "cli",
      delayMs: opts.delay,
      dailyLimit: opts.dailyLimit,
      downloadImages: opts.downloadImages,
      saveJsonl: opts.jsonl,
      onProgress: progressLogger,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`\n=== 订阅增量同步完成 ===`);
      console.log(`检查公众号: ${res.accountsChecked} | 新增文章: ${res.totalNewArticles} | 失败: ${res.errors}`);
      for (const a of res.newArticles || []) {
        console.log(`  + [${a.date}] ${a.account} | ${a.title}`);
      }
      if (res.stoppedEarly && res.stopReason) console.log(`⚠️ ${res.stopReason}`);
    }
    return;
  }

  if (command === "sub-watch") {
    const mins = Math.max(5, Number(opts.interval) || 60);
    await updateSubscriptionConfig({ enabled: true, intervalMinutes: mins }, { outputDir: opts.out });
    console.log(`已启动多公众号订阅守护模式（每 ${mins} 分钟检查一次更新，按 Ctrl+C 退出）...`);
    while (true) {
      const res = await runSubscriptionsCheck({
        outputDir: opts.out,
        trigger: "scheduled",
        delayMs: opts.delay,
        dailyLimit: opts.dailyLimit,
        downloadImages: opts.downloadImages,
        saveJsonl: opts.jsonl,
        onProgress: progressLogger,
      });
      console.log(
        `[${new Date().toLocaleTimeString()}] 检查完成：${res.accountsChecked} 个公众号，新增 ${res.totalNewArticles} 篇${
          res.stoppedEarly ? `（${res.stopReason}）` : ""
        }`
      );
      await new Promise((r) => setTimeout(r, mins * 60 * 1000));
    }
  }

  // --- Public Fetch & Local Clean ---
  if (command === "inspect") {
    if (args.length === 0) {
      console.error("错误：请提供文章链接、合集链接或清单文件");
      process.exit(1);
    }
    const res = await inspectInputs(args, {
      maxArticles: opts.max,
      dateFrom: opts.from,
      dateTo: opts.to,
      delayMs: opts.delay,
      discoverRelated: true,
      onProgress: opts.json ? null : (e) => console.error(e.message || ""),
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`\n共提取 ${res.articleCount} 条文章链接（公开合集 ${res.albumCount} 个，文内推荐 ${res.relatedLinkCount} 条）`);
      for (const a of res.albums) console.log(`  [合集] #${a.title} (${a.count} 篇) -> ${a.albumUrl}`);
      for (const r of res.relatedLinks) console.log(`  [文内推荐] ${r.title || "未命名"} -> ${r.url}`);
      for (const u of res.articles.slice(0, 20)) console.log(`  - ${u.date ? `[${u.date}] ` : ""}${u.title || ""} ${u.url}`);
      if (res.articles.length > 20) console.log(`  ... 共 ${res.articles.length} 条`);
    }
    return;
  }

  if (command === "fetch") {
    if (args.length === 0) {
      console.error("错误：请至少提供一个微信文章链接");
      process.exit(1);
    }
    if (args.length === 1 && !opts.discoverRelated) {
      const res = await fetchSingleArticle(args[0], {
        outputDir: opts.out,
        downloadImages: opts.downloadImages,
        onlyOriginal: opts.onlyOriginal,
        includeYaml: opts.includeYaml,
        includeDatePrefix: opts.includeDatePrefix,
        saveHtml: opts.saveHtml,
        saveJson: opts.saveJson,
        force: opts.force,
        extraTags: opts.tags,
      });
      renderSummary("单篇抓取结果", res, opts.json);
    } else {
      const res = await batchFetchInputs(args, {
        outputDir: opts.out,
        delayMs: opts.delay,
        dateFrom: opts.from,
        dateTo: opts.to,
        maxArticles: opts.max,
        minWords: opts.minWords,
        onlyOriginal: opts.onlyOriginal,
        includeYaml: opts.includeYaml,
        includeDatePrefix: opts.includeDatePrefix,
        saveHtml: opts.saveHtml,
        saveJson: opts.saveJson,
        discoverRelated: opts.discoverRelated,
        downloadImages: opts.downloadImages,
        force: opts.force,
        extraTags: opts.tags,
        onProgress: progressLogger,
      });
      renderSummary("批量抓取结果", res, opts.json);
    }
    return;
  }

  if (command === "batch") {
    if (args.length === 0) {
      console.error("错误：请提供链接、合集 URL 或 TXT/MD/CSV/JSON 文件路径");
      process.exit(1);
    }
    const res = await batchFetchInputs(args, {
      outputDir: opts.out,
      delayMs: opts.delay,
      dateFrom: opts.from,
      dateTo: opts.to,
      maxArticles: opts.max,
      minWords: opts.minWords,
      onlyOriginal: opts.onlyOriginal,
      includeYaml: opts.includeYaml,
      includeDatePrefix: opts.includeDatePrefix,
      saveHtml: opts.saveHtml,
      saveJson: opts.saveJson,
      discoverRelated: opts.discoverRelated,
      downloadImages: opts.downloadImages,
      force: opts.force,
      extraTags: opts.tags,
      onProgress: progressLogger,
    });
    renderSummary("批量抓取结果", res, opts.json);
    return;
  }

  if (command === "album") {
    if (!args[0]) {
      console.error("错误：请提供公众号合集链接 (appmsgalbum)");
      process.exit(1);
    }
    const res = await fetchAlbum(args[0], {
      outputDir: opts.out,
      maxArticles: opts.max,
      delayMs: opts.delay,
      dateFrom: opts.from,
      dateTo: opts.to,
      onlyOriginal: opts.onlyOriginal,
      includeYaml: opts.includeYaml,
      includeDatePrefix: opts.includeDatePrefix,
      saveHtml: opts.saveHtml,
      saveJson: opts.saveJson,
      downloadImages: opts.downloadImages,
      force: opts.force,
      extraTags: opts.tags,
      onProgress: progressLogger,
    });
    renderSummary("合集抓取结果", res, opts.json);
    return;
  }

  if (command === "clean-dir") {
    if (!args[0]) {
      console.error("错误：请提供待清洗的本地目录路径");
      process.exit(1);
    }
    const res = await cleanLocalDirectory(args[0], {
      outputDir: opts.out,
      dateFrom: opts.from,
      dateTo: opts.to,
      onlyOriginal: opts.onlyOriginal,
      minWords: opts.minWords,
      includeYaml: opts.includeYaml,
      includeDatePrefix: opts.includeDatePrefix,
      saveHtml: opts.saveHtml,
      saveJson: opts.saveJson,
      force: opts.force,
      extraTags: opts.tags,
      accountHint: opts.account,
    });
    renderSummary("本地目录深度清洗结果", res, opts.json);
    return;
  }

  // --- Archive Index, Read & Exports ---
  if (command === "index") {
    const res = await searchCleanedIndex({
      outputDir: opts.out,
      account: opts.account,
      keyword: opts.keyword || args.join(" ").trim(),
      dateFrom: opts.from,
      dateTo: opts.to,
      limit: opts.max,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`索引目录: ${res.outputDir} | 命中 ${res.total} 篇（展示前 ${res.items.length} 篇）`);
      for (const a of res.items) {
        const stat = typeof a.read_num === "number" ? ` | 阅 ${a.read_num}` : "";
        console.log(`- [${a.date || "未知日期"}] ${a.account} | ${a.title} (${a.word_count}字${stat}) -> ${a.relative_path}`);
      }
    }
    return;
  }

  if (command === "read") {
    const query = args.join(" ").trim() || opts.keyword;
    if (!query) {
      console.error("错误：请提供文章标题关键词或相对路径，例如：wxclean read 复盘");
      process.exit(1);
    }
    const res = await searchCleanedIndex({
      outputDir: opts.out,
      account: opts.account,
      keyword: query,
      dateFrom: opts.from,
      dateTo: opts.to,
      limit: 5,
    });
    const hit = res.items?.[0];
    if (!hit) {
      console.error(`未在归档目录找到匹配「${query}」的文章。`);
      process.exit(1);
    }
    const fullPath = path.resolve(res.outputDir, hit.relative_path);
    const content = await fs.readFile(fullPath, "utf8");
    if (opts.json) {
      console.log(JSON.stringify({ article: hit, filePath: fullPath, content }, null, 2));
    } else {
      console.log(content);
    }
    return;
  }

  if (command === "export-csv") {
    const res = await exportArticlesCsv({ outputDir: opts.out });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`✓ 已导出 ${res.count} 篇文章元数据到 CSV：${res.csvPath}`);
    return;
  }

  if (command === "export-jsonl") {
    const res = await exportArticlesJsonl({ outputDir: opts.out });
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else console.log(`✓ 已导出 ${res.count} 篇文章到 JSONL：${res.jsonlPath}`);
    return;
  }

  console.error(`未知命令: ${command}\n运行 wxclean --help 查看所有可用命令。`);
  process.exit(1);
}

main().catch((err) => {
  console.error("执行失败:", err?.message || err);
  process.exit(1);
});
