#!/usr/bin/env node
/**
 * CLI for WeChat Public Article Batch Fetcher & Deep Markdown Cleaner
 */
import path from "node:path";
import {
  DEFAULT_OUTPUT_DIR,
  batchFetchInputs,
  cleanLocalDirectory,
  fetchAlbum,
  fetchSingleArticle,
  inspectInputs,
  inspectWeReadAccounts,
  searchCleanedIndex,
  syncWeReadAccounts,
} from "./src/pipeline.mjs";
import { getWeReadStatus, openWeReadLoginWindow } from "./src/weread-cdp.mjs";
import {
  addSubscriptions,
  loadSubscriptions,
  removeSubscriptionAccount,
  runSubscriptionsCheck,
  updateSubscriptionConfig,
} from "./src/subscriptions.mjs";

function printHelp() {
  console.log(`微信公众号文章采集、多号订阅与深度清洗工具 (wxclean v2.1.0)

用法:
  node cli.mjs weread-login                     拉起可见 Edge/Chrome 打开微信读书网页版扫码登录
  node cli.mjs weread-list <url|bookId> [选项]  通过微信读书接口解析公众号全量历史目录
  node cli.mjs weread-sync <url|bookId> [选项]  通过微信读书接口批量拉取正文并深度清洗入库
  node cli.mjs sub-list                         查看已订阅的多公众号列表与自动更新配置
  node cli.mjs sub-add <url|bookId...> [选项]   订阅一个或多个公众号（支持单篇/合集链接或 MP_WXS_...）
  node cli.mjs sub-remove <bookId>              退订指定公众号（保留本地已下载文章）
  node cli.mjs sub-sync [选项]                  立即增量检查所有已启用订阅并自动下载新文章
  node cli.mjs sub-watch [选项]                 终端常驻模式：按设定间隔循环检测订阅更新
  node cli.mjs fetch <url...> [选项]            抓取单篇或多篇公开文章链接
  node cli.mjs inspect <url-or-file...> [选项]  解析合集/清单并探测单篇文章的公开合集标签与文内推荐
  node cli.mjs batch <file-or-url...> [选项]    批量抓取（支持 URL、合集链接、TXT/MD/CSV/JSON 文件）
  node cli.mjs album <album-url> [选项]         抓取公开合集/专栏 (appmsgalbum) 全部文章
  node cli.mjs clean-dir <input-dir> [选项]     深度清洗本地目录（重解析 .html 或清洗脏 .md）
  node cli.mjs index [选项]                     查询已入库的干净 Markdown 索引

常用选项:
  --out <dir>          输出归档目录（默认: ${DEFAULT_OUTPUT_DIR}）
  --from <YYYY-MM-DD>  仅保留该日期及之后的文章（sub-add 时作为起始追踪日期）
  --to <YYYY-MM-DD>    仅保留该日期及之前的文章
  --delay <ms>         批量抓取间隔毫秒数（默认: 3000）
  --daily-limit <n>    微信读书单日安全上限篇数（默认: 1200，建议 ≤1500 防 -2041 风控；0 为不限）
  --max <n>            单次最多抓取篇数（默认: 200）
  --category <分组>    订阅分组名（sub-add 子命令，默认: 默认分组）
  --book-id <bookId>   仅检查单个订阅公众号（sub-sync 子命令）
  --interval <分钟>    定时检查间隔分钟数（sub-watch 子命令，默认: 60）
  --max-pages <n>      微信读书目录最多翻页数（默认: 50）
  --start-page <n>     微信读书目录起始页码（默认: 1）
  --min-reads <n>      微信读书通道最小阅读量过滤阈值（默认: 0）
  --min-words <n>      正文最少字数过滤阈值（默认: 0）
  --jsonl              同步导出兼容攻略格式的 wechat_articles.jsonl
  --discover-related   抓取单篇时自动探测公开合集标签与文内「往期推荐」链接并一并抓取
  --download-images    将文章图片本地化下载到 assets/ 并改为相对路径
  --force              忽略去重，强制覆盖更新已归档文章
  --tag <标签>         附加额外 YAML 标签（可多次传入）
  --account <名称>     按公众号名称筛选（index 子命令，或 clean-dir 默认公众号名）
  --keyword <关键词>   按标题/作者/路径关键词筛选（index 子命令）
  --json               以纯 JSON 输出结果
  -h, --help           显示此帮助信息
`);
}

function parseArgs(argv) {
  const positionals = [];
  const opts = {
    out: DEFAULT_OUTPUT_DIR,
    from: "",
    to: "",
    delay: 2500,
    dailyLimit: 1200,
    max: 200,
    maxPages: 50,
    startPage: 1,
    minReads: 0,
    minWords: 0,
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
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--out" && argv[i + 1]) opts.out = path.resolve(argv[++i]);
    else if (a === "--from" && argv[i + 1]) opts.from = argv[++i];
    else if (a === "--to" && argv[i + 1]) opts.to = argv[++i];
    else if (a === "--delay" && argv[i + 1]) opts.delay = Number(argv[++i]);
    else if (a === "--daily-limit" && argv[i + 1]) opts.dailyLimit = Number(argv[++i]);
    else if (a === "--max" && argv[i + 1]) opts.max = Number(argv[++i]);
    else if (a === "--max-pages" && argv[i + 1]) opts.maxPages = Number(argv[++i]);
    else if (a === "--start-page" && argv[i + 1]) opts.startPage = Number(argv[++i]);
    else if (a === "--min-reads" && argv[i + 1]) opts.minReads = Number(argv[++i]);
    else if (a === "--min-words" && argv[i + 1]) opts.minWords = Number(argv[++i]);
    else if (a === "--category" && argv[i + 1]) opts.category = argv[++i];
    else if (a === "--book-id" && argv[i + 1]) opts.bookId = argv[++i];
    else if (a === "--interval" && argv[i + 1]) opts.interval = Number(argv[++i]);
    else if (a === "--jsonl") opts.jsonl = true;
    else if (a === "--discover-related") opts.discoverRelated = true;
    else if (a === "--download-images") opts.downloadImages = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--tag" && argv[i + 1]) opts.tags.push(argv[++i]);
    else if (a === "--account" && argv[i + 1]) opts.account = argv[++i];
    else if (a === "--keyword" && argv[i + 1]) opts.keyword = argv[++i];
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
      `总计: ${res.totalInputs} | 新增: ${res.saved} | 更新: ${res.updated} | 去重跳过: ${res.skipped} | 日期过滤: ${res.filteredOut} | 失败: ${res.errors}`
    );
  } else if (typeof res.scanned === "number") {
    console.log(
      `扫描: ${res.scanned} | 新增: ${res.saved} | 更新: ${res.updated} | 去重跳过: ${res.skipped} | 日期过滤: ${res.filteredOut} | 失败: ${res.errors}`
    );
  } else if (res.status) {
    console.log(
      `状态: ${res.status}${res.reason ? ` (${res.reason})` : ""}${res.message ? ` - ${res.message}` : ""}`
    );
    if (res.meta?.title) console.log(`标题: ${res.meta.title} (${res.meta.account} | ${res.meta.publishedAt || res.meta.date})`);
    if (res.filePath) console.log(`文件: ${res.filePath}`);
  }
  if (res.stoppedEarly) {
    console.log(`⚠️ 提前中止: ${res.stopReason}`);
  }
  if (Array.isArray(res.items) && res.items.length > 0 && res.items.length <= 30) {
    console.log("\n明细:");
    for (const it of res.items) {
      const label = it.title || it.url || it.sourceFile || "";
      console.log(`  - [${it.status}] ${it.date ? it.date + " " : ""}${label}${it.relativePath ? " -> " + it.relativePath : ""}${it.reason ? " (" + it.reason + ")" : ""}`);
    }
  }
}

async function main() {
  const { command, args, opts } = parseArgs(process.argv.slice(2));
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

  if (command === "weread-login") {
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

  if (command === "weread-list") {
    if (args.length === 0) {
      console.error("错误：请提供文章链接、含 __biz 的合集链接，或 MP_WXS_<数字>");
      process.exit(1);
    }
    const res = await inspectWeReadAccounts(args, {
      outputDir: opts.out,
      dateFrom: opts.from,
      dateTo: opts.to,
      minReads: opts.minReads,
      maxArticles: opts.max,
      maxPages: opts.maxPages,
      startPage: opts.startPage,
      delayMs: opts.delay,
      onProgress: progressLogger,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`\n共命中 ${res.articleCount} 篇（新增待抓 ${res.newCount} / 已归档 ${res.archivedCount}）`);
      for (const a of res.accounts || []) {
        console.log(`  [公众号] ${a.accountName || "未知"} -> ${a.bookId} (__biz=${a.biz})`);
      }
      for (const art of (res.articles || []).slice(0, 25)) {
        console.log(
          `  - [${art.date || "未知日期"}] ${art.title} | 阅读 ${art.readNum} / 点赞 ${art.likeNum}${art.alreadyArchived ? " [已归档]" : ""}`
        );
      }
      if ((res.articles || []).length > 25) console.log(`  ... 共 ${res.articles.length} 篇`);
      if (res.stoppedEarly && res.stopReason) console.log(`⚠️ ${res.stopReason}`);
    }
    return;
  }

  if (command === "weread-sync") {
    if (args.length === 0) {
      console.error("错误：请提供文章链接、含 __biz 的合集链接，或 MP_WXS_<数字>");
      process.exit(1);
    }
    const res = await syncWeReadAccounts(args, {
      outputDir: opts.out,
      dateFrom: opts.from,
      dateTo: opts.to,
      minReads: opts.minReads,
      minWords: opts.minWords,
      maxArticles: opts.max,
      maxPages: opts.maxPages,
      startPage: opts.startPage,
      delayMs: opts.delay,
      dailyLimit: opts.dailyLimit,
      downloadImages: opts.downloadImages,
      force: opts.force,
      extraTags: opts.tags,
      saveJsonl: opts.jsonl,
      onProgress: progressLogger,
    });
    renderSummary("微信读书通道同步结果", res, opts.json);
    if (!opts.json && res.jsonlFile) console.log(`JSONL 文件: ${res.jsonlFile}`);
    return;
  }

  if (command === "sub-list") {
    const data = await loadSubscriptions({ outputDir: opts.out });
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(
        `订阅总数: ${data.accounts.length} | 自动定时: ${data.scheduler.enabled ? `开启 (每 ${data.scheduler.intervalMinutes} 分钟)` : "关闭"}`
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
      console.error("错误：请提供至少一个公众号文章链接、合集链接或 MP_WXS_<数字>");
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
      force: opts.force,
      extraTags: opts.tags,
      accountHint: opts.account,
    });
    renderSummary("本地目录深度清洗结果", res, opts.json);
    return;
  }

  if (command === "index") {
    const res = await searchCleanedIndex({
      outputDir: opts.out,
      account: opts.account,
      keyword: opts.keyword,
      dateFrom: opts.from,
      dateTo: opts.to,
      limit: opts.max,
    });
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`索引目录: ${res.outputDir} | 命中 ${res.total} 篇（展示前 ${res.items.length} 篇）`);
      for (const a of res.items) {
        console.log(`- [${a.date || "未知日期"}] ${a.account} | ${a.title} (${a.word_count}字) -> ${a.relative_path}`);
      }
    }
    return;
  }

  console.error(`未知命令: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error("执行失败:", err?.message || err);
  process.exit(1);
});
