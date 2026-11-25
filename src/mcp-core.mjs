/**
 * Shared MCP JSON-RPC 2.0 handler used by both standalone mcp-server.mjs and web-server.mjs.
 */
import {
  DEFAULT_OUTPUT_DIR,
  batchFetchInputs,
  cleanLocalDirectory,
  exportArticlesCsv,
  fetchAlbum,
  fetchSingleArticle,
  inspectInputs,
  inspectWeReadAccounts,
  searchCleanedIndex,
  syncWeReadAccounts,
} from "./pipeline.mjs";
import { getWeReadStatus, openWeReadLoginWindow } from "./weread-cdp.mjs";
import {
  getMpAdminStatus,
  openMpAdminLoginWindow,
  searchMpAdminAccountsByName,
} from "./mp-admin-cdp.mjs";
import {
  addSubscriptions,
  loadSubscriptions,
  removeSubscriptionAccount,
  runSubscriptionsCheck,
  updateSubscriptionAccount,
  updateSubscriptionConfig,
} from "./subscriptions.mjs";

export const SERVER_INFO = {
  name: "wechat-article-cleaner-mcp",
  version: "2.3.0",
};

export const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

export const MCP_TOOLS = [
  {
    name: "fetch_wechat_article",
    description:
      "抓取并深度清洗单篇公开微信公众号文章为干净 Markdown（去除末尾微信 UI 脏字符、自动补全规范 YAML 头部与三层去重索引）。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "微信公众号公开文章链接（https://mp.weixin.qq.com/s/...）" },
        output_dir: { type: "string", description: `输出目录，默认：${DEFAULT_OUTPUT_DIR}` },
        download_images: { type: "boolean", description: "是否本地化下载图片，默认 false" },
        save_html: { type: "boolean", description: "是否同步导出纯净 HTML，默认 false" },
        save_json: { type: "boolean", description: "是否同步导出结构化 JSON，默认 false" },
        only_original: { type: "boolean", description: "是否只保存原创文章，默认 false" },
        force: { type: "boolean", description: "是否忽略去重强制覆盖更新，默认 false" },
        tags: { type: "array", items: { type: "string" }, description: "附加到 YAML Frontmatter 的自定义标签" },
      },
      required: ["url"],
    },
  },
  {
    name: "batch_fetch_wechat_articles",
    description:
      "批量抓取公开文章 URL 列表、公开合集链接，或 TXT/MD/CSV/JSON 导出文件中的所有微信文章链接，深度清洗为干净 Markdown 并自动去重入库。",
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "输入数组：单篇 URL、合集 URL、多行文本，或本地 TXT/MD/CSV/JSON 绝对路径",
        },
        output_dir: { type: "string", description: `输出目录，默认：${DEFAULT_OUTPUT_DIR}` },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD（含）" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD（含）" },
        delay_ms: { type: "number", description: "相邻请求礼貌间隔毫秒数，默认 1500" },
        max_articles: { type: "number", description: "单次最多抓取篇数，默认 200" },
        min_words: { type: "number", description: "最少字数过滤阈值，默认 0" },
        only_original: { type: "boolean", description: "是否只下载原创文章，默认 false" },
        discover_related: { type: "boolean", description: "是否自动探测单篇文章挂接的公开合集标签与文内往期推荐链接并一并抓取，默认 false" },
        download_images: { type: "boolean", description: "是否本地化下载图片，默认 false" },
        force: { type: "boolean", description: "是否忽略去重强制覆盖，默认 false" },
        tags: { type: "array", items: { type: "string" }, description: "附加自定义标签" },
      },
      required: ["inputs"],
    },
  },
  {
    name: "fetch_wechat_album",
    description:
      "解析微信公众号公开合集/专栏链接（appmsgalbum），零密钥批量抓取并深度清洗合集内文章为干净 Markdown。",
    inputSchema: {
      type: "object",
      properties: {
        album_url: { type: "string", description: "公众号合集链接（https://mp.weixin.qq.com/mp/appmsgalbum?...）" },
        output_dir: { type: "string", description: `输出目录，默认：${DEFAULT_OUTPUT_DIR}` },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD（含）" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD（含）" },
        delay_ms: { type: "number", description: "抓取间隔毫秒数，默认 1500" },
        max_articles: { type: "number", description: "单次最多抓取篇数，默认 200" },
        download_images: { type: "boolean", description: "是否本地化下载图片，默认 false" },
        force: { type: "boolean", description: "是否忽略去重强制覆盖，默认 false" },
        tags: { type: "array", items: { type: "string" }, description: "附加自定义标签" },
      },
      required: ["album_url"],
    },
  },
  {
    name: "clean_local_wechat_dir",
    description:
      "深度清洗本地目录中由 wechatDownload 或网页版导出的公众号 .html / 脏 .md 文件（优先无损重解析 .html），清除末尾微信 UI 垃圾字符，统一补全 YAML 头部、去重并生成 00_文章索引.md。",
    inputSchema: {
      type: "object",
      properties: {
        input_dir: { type: "string", description: "待清洗的本地目录绝对路径（例如 下载/某公众号）" },
        output_dir: { type: "string", description: `输出归档目录，默认：${DEFAULT_OUTPUT_DIR}` },
        account_hint: { type: "string", description: "可选默认公众号名称" },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD" },
        force: { type: "boolean", description: "是否覆盖已有归档，默认 false" },
        tags: { type: "array", items: { type: "string" }, description: "附加自定义标签" },
      },
      required: ["input_dir"],
    },
  },
  {
    name: "search_cleaned_articles",
    description: "检索已清洗入库的公众号文章索引（支持按公众号、关键词、日期范围过滤）。",
    inputSchema: {
      type: "object",
      properties: {
        output_dir: { type: "string", description: `归档目录，默认：${DEFAULT_OUTPUT_DIR}` },
        account: { type: "string", description: "公众号名称模糊筛选" },
        keyword: { type: "string", description: "标题/作者/路径关键词筛选" },
        date_from: { type: "string", description: "起始日期 YYYY-MM-DD" },
        date_to: { type: "string", description: "截止日期 YYYY-MM-DD" },
        limit: { type: "number", description: "返回条数上限，默认 50" },
      },
    },
  },
  {
    name: "inspect_wechat_links",
    description: "解析公开文章链接/合集链接/清单文件，并自动探测单篇文章挂接的公开合集标签（#合集）及文内「往期推荐」链接，返回待抓取文章列表。",
    inputSchema: {
      type: "object",
      properties: {
        inputs: { type: "array", items: { type: "string" }, description: "URL、合集链接或本地清单文件路径数组" },
        discover_related: { type: "boolean", description: "是否自动探测单篇文章的公开合集标签与文内推荐链接，默认 true" },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD" },
        delay_ms: { type: "number", description: "请求间隔毫秒数，默认 2000" },
        max_articles: { type: "number", description: "最多返回篇数，默认 200" },
      },
      required: ["inputs"],
    },
  },
  {
    name: "export_cleaned_articles_csv",
    description: "将已清洗入库的公众号文章索引导出为 UTF-8 BOM CSV 数据表（适配 Excel 直接打开，含阅读数/点赞数与 review_id）。",
    inputSchema: {
      type: "object",
      properties: {
        output_dir: { type: "string", description: `归档目录，默认：${DEFAULT_OUTPUT_DIR}` },
      },
    },
  },
  {
    name: "weread_login_status",
    description: "检查本机微信读书（weread.qq.com）Edge/Chrome 登录态，或拉起可见浏览器窗口供用户微信扫码登录。",
    inputSchema: {
      type: "object",
      properties: {
        open_browser: { type: "boolean", description: "设为 true 时若未登录则拉起/前置可见 Edge 窗口打开微信读书网页版" },
        probe_api: { type: "boolean", description: "是否实时探测微信读书接口以确认 Cookie 未过期，默认 true" },
      },
    },
  },
  {
    name: "weread_list_articles",
    description:
      "通过微信读书接口（/web/mp/articles）解析公众号全量历史文章目录：支持输入单篇文章链接、含 __biz 的合集链接或直接传入 MP_WXS_<数字>，返回文章列表（含阅读数/点赞数/reviewId/是否已归档）。",
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "MP_WXS_<数字>、含 __biz 的公众号/合集链接或单篇文章链接数组",
        },
        output_dir: { type: "string", description: `归档目录（用于比对已归档去重状态），默认：${DEFAULT_OUTPUT_DIR}` },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD（含）" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD（含）" },
        min_reads: { type: "number", description: "最小阅读量过滤阈值，默认 0" },
        max_articles: { type: "number", description: "最多返回篇数，默认 200" },
        max_pages: { type: "number", description: "最多翻页数，默认 50" },
        start_page: { type: "number", description: "起始页码，默认 1" },
        delay_ms: { type: "number", description: "分页请求间隔毫秒数，默认 2000" },
      },
      required: ["inputs"],
    },
  },
  {
    name: "weread_sync_articles",
    description:
      "通过微信读书接口（/web/mp/articles + /web/mp/content）批量拉取公众号历史文章正文并深度清洗为规范 YAML Markdown（自动断点续传去重、防限速保护，可选导出 wechat_articles.jsonl）。",
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "MP_WXS_<数字>、含 __biz 的合集/历史链接或单篇文章链接数组",
        },
        output_dir: { type: "string", description: `输出目录，默认：${DEFAULT_OUTPUT_DIR}` },
        date_from: { type: "string", description: "起始日期过滤 YYYY-MM-DD（含）" },
        date_to: { type: "string", description: "截止日期过滤 YYYY-MM-DD（含）" },
        min_reads: { type: "number", description: "最小阅读量过滤阈值，默认 0" },
        min_words: { type: "number", description: "正文最少字数过滤阈值，默认 0" },
        only_original: { type: "boolean", description: "是否只保留原创文章，默认 false" },
        max_articles: { type: "number", description: "单次最多同步篇数，默认 200" },
        max_pages: { type: "number", description: "目录最多翻页数，默认 50" },
        start_page: { type: "number", description: "目录起始页码，默认 1" },
        delay_ms: { type: "number", description: "正文抓取礼貌间隔毫秒数，默认 2500" },
        download_images: { type: "boolean", description: "是否本地化下载图片，默认 false" },
        save_jsonl: { type: "boolean", description: "是否同步导出 wechat_articles.jsonl，默认 false" },
        force: { type: "boolean", description: "是否忽略去重强制重新拉取覆盖，默认 false" },
        tags: { type: "array", items: { type: "string" }, description: "附加自定义标签" },
      },
      required: ["inputs"],
    },
  },
  {
    name: "manage_wechat_subscriptions",
    description:
      "管理多公众号自动订阅列表与定时检查设置（支持 list 查看、add 批量订阅一个或多个公众号、toggle 启停单号、remove 退订、configure 修改自动更新周期）。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "remove", "toggle", "configure"],
          description: "操作类型：list | add | remove | toggle | configure",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "add 操作时传入：公众号文章链接、合集链接或 MP_WXS_<数字> 数组",
        },
        book_id: { type: "string", description: "remove/toggle 操作时的公众号 bookId（例如 MP_WXS_1234567890）" },
        enabled: { type: "boolean", description: "toggle 或 configure 操作时的启用状态" },
        category: { type: "string", description: "add 操作时的分组标签，默认 默认分组" },
        since: { type: "string", description: "add 操作时的起始追踪日期 YYYY-MM-DD（可选）" },
        interval_minutes: { type: "number", description: "configure 操作时的定时检查间隔分钟数（5~1440）" },
        output_dir: { type: "string", description: `归档目录，默认：${DEFAULT_OUTPUT_DIR}` },
      },
      required: ["action"],
    },
  },
  {
    name: "sync_wechat_subscriptions",
    description:
      "立即对所有已启用的订阅公众号（或指定单个 book_id）执行增量更新检查，有新文章时自动下载并深度清洗入库。",
    inputSchema: {
      type: "object",
      properties: {
        book_id: { type: "string", description: "可选：仅检查指定 bookId；留空则检查全部已启用的订阅号" },
        output_dir: { type: "string", description: `输出目录，默认：${DEFAULT_OUTPUT_DIR}` },
        delay_ms: { type: "number", description: "请求间隔毫秒数，默认读取订阅配置（4000ms）" },
        download_images: { type: "boolean", description: "是否本地化下载图片" },
        save_jsonl: { type: "boolean", description: "是否同步导出 wechat_articles.jsonl" },
      },
    },
  },
  {
    name: "mp_admin_login_status",
    description: "检查本机个人公众号后台（mp.weixin.qq.com）搜号登录态，或拉起浏览器供用户微信扫码登录（用于按公众号名称换算 MP_WXS_...）。",
    inputSchema: {
      type: "object",
      properties: {
        open_browser: { type: "boolean", description: "设为 true 时打开公众号后台登录页" },
        probe_api: { type: "boolean", description: "是否验证后台会话仍然有效，默认 true" },
      },
    },
  },
  {
    name: "mp_admin_search_account",
    description:
      "通过个人公众号后台（/cgi-bin/searchbiz）按公众号名称搜索并自动换算为 MP_WXS_<数字> (bookId) 与 __biz，便于直接交给 weread_list_articles / weread_sync_articles / manage_wechat_subscriptions 使用。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "公众号名称关键词，例如 晚点LatePost" },
        count: { type: "number", description: "返回匹配条数（1~10），默认 5" },
      },
      required: ["query"],
    },
  },
];

export async function executeMcpTool(name, args = {}) {
  switch (name) {
    case "fetch_wechat_article":
      return await fetchSingleArticle(args.url, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        downloadImages: Boolean(args.download_images),
        saveHtml: Boolean(args.save_html),
        saveJson: Boolean(args.save_json),
        onlyOriginal: Boolean(args.only_original),
        force: Boolean(args.force),
        extraTags: Array.isArray(args.tags) ? args.tags : [],
      });

    case "batch_fetch_wechat_articles":
      return await batchFetchInputs(args.inputs, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : 1500,
        maxArticles: typeof args.max_articles === "number" ? args.max_articles : 200,
        minWords: typeof args.min_words === "number" ? args.min_words : 0,
        onlyOriginal: Boolean(args.only_original),
        discoverRelated: Boolean(args.discover_related),
        downloadImages: Boolean(args.download_images),
        force: Boolean(args.force),
        extraTags: Array.isArray(args.tags) ? args.tags : [],
      });

    case "fetch_wechat_album":
      return await fetchAlbum(args.album_url, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : 1500,
        maxArticles: typeof args.max_articles === "number" ? args.max_articles : 200,
        downloadImages: Boolean(args.download_images),
        force: Boolean(args.force),
        extraTags: Array.isArray(args.tags) ? args.tags : [],
      });

    case "clean_local_wechat_dir":
      return await cleanLocalDirectory(args.input_dir, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        accountHint: args.account_hint || "",
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        force: Boolean(args.force),
        extraTags: Array.isArray(args.tags) ? args.tags : [],
      });

    case "search_cleaned_articles":
      return await searchCleanedIndex({
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        account: args.account || "",
        keyword: args.keyword || "",
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        limit: typeof args.limit === "number" ? args.limit : 50,
      });

    case "inspect_wechat_links":
      return await inspectInputs(args.inputs, {
        maxArticles: typeof args.max_articles === "number" ? args.max_articles : 200,
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : 2000,
        discoverRelated: args.discover_related !== false,
      });

    case "export_cleaned_articles_csv": {
      const { csvPath, count } = await exportArticlesCsv({
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
      });
      return { status: "success", csvPath, count };
    }

    case "weread_login_status": {
      if (args.open_browser) {
        return await openWeReadLoginWindow();
      }
      return await getWeReadStatus({ probeApi: args.probe_api !== false });
    }

    case "weread_list_articles":
      return await inspectWeReadAccounts(args.inputs, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        minReads: typeof args.min_reads === "number" ? args.min_reads : 0,
        maxArticles: typeof args.max_articles === "number" ? args.max_articles : 200,
        maxPages: typeof args.max_pages === "number" ? args.max_pages : 50,
        startPage: typeof args.start_page === "number" ? args.start_page : 1,
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : 2000,
      });

    case "weread_sync_articles":
      return await syncWeReadAccounts(args.inputs, {
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        dateFrom: args.date_from || "",
        dateTo: args.date_to || "",
        minReads: typeof args.min_reads === "number" ? args.min_reads : 0,
        minWords: typeof args.min_words === "number" ? args.min_words : 0,
        onlyOriginal: Boolean(args.only_original),
        maxArticles: typeof args.max_articles === "number" ? args.max_articles : 200,
        maxPages: typeof args.max_pages === "number" ? args.max_pages : 50,
        startPage: typeof args.start_page === "number" ? args.start_page : 1,
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : 2500,
        downloadImages: Boolean(args.download_images),
        saveJsonl: Boolean(args.save_jsonl),
        force: Boolean(args.force),
        extraTags: Array.isArray(args.tags) ? args.tags : [],
      });

    case "manage_wechat_subscriptions": {
      const outputDir = args.output_dir || DEFAULT_OUTPUT_DIR;
      const action = args.action;
      if (action === "list") {
        return await loadSubscriptions({ outputDir });
      }
      if (action === "add") {
        return await addSubscriptions(args.inputs || [], {
          outputDir,
          category: args.category || "默认分组",
          since: args.since || "",
        });
      }
      if (action === "remove") {
        return await removeSubscriptionAccount(args.book_id, { outputDir });
      }
      if (action === "toggle") {
        return await updateSubscriptionAccount(
          args.book_id,
          { enabled: Boolean(args.enabled) },
          { outputDir }
        );
      }
      if (action === "configure") {
        return await updateSubscriptionConfig(
          {
            ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
            ...(typeof args.interval_minutes === "number" ? { intervalMinutes: args.interval_minutes } : {}),
          },
          { outputDir }
        );
      }
      throw new Error(`Unsupported subscription action: ${action}`);
    }

    case "sync_wechat_subscriptions":
      return await runSubscriptionsCheck({
        outputDir: args.output_dir || DEFAULT_OUTPUT_DIR,
        bookId: args.book_id || "",
        trigger: "mcp",
        delayMs: typeof args.delay_ms === "number" ? args.delay_ms : null,
        downloadImages: typeof args.download_images === "boolean" ? args.download_images : null,
        saveJsonl: typeof args.save_jsonl === "boolean" ? args.save_jsonl : null,
      });

    case "mp_admin_login_status":
      return args.open_browser
        ? await openMpAdminLoginWindow({ includeQr: false })
        : await getMpAdminStatus({ probeApi: args.probe_api !== false });

    case "mp_admin_search_account":
      return await searchMpAdminAccountsByName(args.query, {
        count: typeof args.count === "number" ? Math.max(1, Math.min(10, args.count)) : 5,
        autoLaunch: true,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleJsonRpcMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: msg?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request" },
    };
  }

  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return null;
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      const output = await executeMcpTool(toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          isError: false,
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: String(err?.message || err) }, null, 2) }],
          isError: true,
        },
      };
    }
  }

  if (isNotification) return null;
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}
