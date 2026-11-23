#!/usr/bin/env node
/**
 * Local Web UI + SSE Progress Stream + Live Toggleable MCP Server
 * Zero external dependencies. Binds strictly to 127.0.0.1.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OUTPUT_DIR,
  batchFetchInputs,
  cleanLocalDirectory,
  exportArticlesCsv,
  exportArticlesJsonl,
  inspectInputs,
  inspectWeReadAccounts,
  searchCleanedIndex,
  syncWeReadAccounts,
} from "./src/pipeline.mjs";
import { SERVER_INFO, handleJsonRpcMessage } from "./src/mcp-core.mjs";
import {
  getWeReadStatus,
  loadSavedWeReadAccounts,
  openWeReadLoginWindow,
  refreshWeReadLoginQr,
} from "./src/weread-cdp.mjs";
import {
  addSubscriptions,
  loadSubscriptions,
  removeSubscriptionAccount,
  runSubscriptionsCheck,
  updateSubscriptionAccount,
  updateSubscriptionConfig,
} from "./src/subscriptions.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_LOCAL_DOWNLOAD_DIR = path.resolve(__dirname, "..", "下载");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const REQUESTED_PORT = portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 4546;
const AUTO_OPEN = args.includes("--open");
const STRICT_PORT = args.includes("--strict-port");
let PORT = REQUESTED_PORT;
const HOST = "127.0.0.1";

function openUrlInDefaultBrowser(targetUrl) {
  try {
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", targetUrl], { detached: true, stdio: "ignore" });
      child.unref();
    } else if (process.platform === "darwin") {
      const child = spawn("open", [targetUrl], { detached: true, stdio: "ignore" });
      child.unref();
    } else {
      const child = spawn("xdg-open", [targetUrl], { detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch {}
}

let mcpEnabled = true;
const mcpSessions = new Set();
const jobs = new Map();

// Background multi-account subscription auto-sync scheduler state
const schedulerRuntime = {
  timer: null,
  running: false,
  activeJobId: null,
  nextRunAt: "",
  lastScheduledNotice: "",
};

function hasRunningJob() {
  for (const j of jobs.values()) {
    if (j.status === "running") return true;
  }
  return false;
}

async function rescheduleSubscriptionTimer() {
  if (schedulerRuntime.timer) {
    clearTimeout(schedulerRuntime.timer);
    schedulerRuntime.timer = null;
  }
  schedulerRuntime.nextRunAt = "";

  try {
    const data = await loadSubscriptions({ outputDir: DEFAULT_OUTPUT_DIR });
    const enabledAccounts = data.accounts.filter((a) => a.enabled);
    if (!data.scheduler.enabled || enabledAccounts.length === 0) {
      return;
    }

    const intervalMs = Math.max(5, Number(data.scheduler.intervalMinutes) || 60) * 60 * 1000;
    const nextDate = new Date(Date.now() + intervalMs);
    schedulerRuntime.nextRunAt = nextDate.toISOString();

    schedulerRuntime.timer = setTimeout(async () => {
      schedulerRuntime.timer = null;
      await runScheduledSubscriptionCheck();
    }, intervalMs);
    if (typeof schedulerRuntime.timer.unref === "function") {
      schedulerRuntime.timer.unref();
    }
  } catch (err) {
    console.error("[订阅调度器] 初始化定时任务失败:", err?.message || err);
  }
}

async function runScheduledSubscriptionCheck() {
  if (schedulerRuntime.running || hasRunningJob()) {
    schedulerRuntime.lastScheduledNotice = "检测到已有任务正在执行，本次定时检查已顺延至下一周期";
    await rescheduleSubscriptionTimer();
    return;
  }

  schedulerRuntime.running = true;
  const job = createJob("subscriptions-scheduled");
  schedulerRuntime.activeJobId = job.id;

  try {
    console.log(`[订阅调度器] ${new Date().toLocaleTimeString()} 开始定时检查所有已启用公众号更新...`);
    const summary = await runSubscriptionsCheck({
      outputDir: DEFAULT_OUTPUT_DIR,
      trigger: "scheduled",
      signal: job.controller.signal,
      onProgress: (evt) => job.emit("progress", evt),
    });
    schedulerRuntime.lastScheduledNotice = summary.stoppedEarly
      ? `定时检查提前结束：${summary.stopReason}`
      : `定时检查完成（检查 ${summary.accountsChecked} 个公众号，新增 ${summary.totalNewArticles} 篇）`;
    console.log(`[订阅调度器] ${schedulerRuntime.lastScheduledNotice}`);
    job.finish(summary);
  } catch (err) {
    schedulerRuntime.lastScheduledNotice = `定时检查出错：${err?.message || err}`;
    console.error(`[订阅调度器] ${schedulerRuntime.lastScheduledNotice}`);
    job.fail(err);
  } finally {
    schedulerRuntime.running = false;
    schedulerRuntime.activeJobId = null;
    await rescheduleSubscriptionTimer();
  }
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) throw new Error("请求体过大（超过 5MB）");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function createJob(kind) {
  const id = crypto.randomUUID().slice(0, 8);
  const controller = new AbortController();
  const job = {
    id,
    kind,
    status: "running",
    controller,
    events: [],
    listeners: new Set(),
    result: null,
    error: null,
  };
  jobs.set(id, job);

  const emit = (type, data) => {
    const evt = { type, data, ts: new Date().toISOString() };
    job.events.push(evt);
    const frame = `event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of job.listeners) {
      try {
        res.write(frame);
      } catch {
        job.listeners.delete(res);
      }
    }
  };

  job.emit = emit;
  job.finish = (result) => {
    job.status = "done";
    job.result = result;
    emit("done", result);
    for (const res of job.listeners) {
      try {
        res.end();
      } catch {}
    }
    job.listeners.clear();
  };
  job.fail = (err) => {
    job.status = "error";
    job.error = String(err?.message || err);
    emit("error_event", { message: job.error });
    for (const res of job.listeners) {
      try {
        res.end();
      } catch {}
    }
    job.listeners.clear();
  };

  // Keep memory bounded
  if (jobs.size > 30) {
    const oldestKey = jobs.keys().next().value;
    jobs.delete(oldestKey);
  }
  return job;
}

function openDirectoryInOS(dirPath) {
  const resolved = path.resolve(dirPath);
  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [resolved], { detached: true, stdio: "ignore" });
    child.unref();
  } else if (process.platform === "darwin") {
    const child = spawn("open", [resolved], { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    const child = spawn("xdg-open", [resolved], { detached: true, stdio: "ignore" });
    child.unref();
  }
}

async function listCandidateLocalDirs() {
  const candidates = [];
  try {
    const stat = await fs.stat(DEFAULT_LOCAL_DOWNLOAD_DIR);
    if (stat.isDirectory()) {
      candidates.push(DEFAULT_LOCAL_DOWNLOAD_DIR);
      const subs = await fs.readdir(DEFAULT_LOCAL_DOWNLOAD_DIR, { withFileTypes: true });
      for (const s of subs) {
        if (s.isDirectory()) candidates.push(path.join(DEFAULT_LOCAL_DOWNLOAD_DIR, s.name));
      }
    }
  } catch {}
  return candidates;
}

function buildMcpConfig() {
  return {
    streamableHttp: {
      mcpServers: {
        wechatArticleCleaner: {
          type: "streamableHttp",
          url: `http://${HOST}:${PORT}/mcp`,
        },
      },
    },
    stdio: {
      mcpServers: {
        wechatArticleCleaner: {
          command: "node",
          args: [path.join(__dirname, "mcp-server.mjs").replace(/\\/g, "/")],
        },
      },
    },
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const pathname = url.pathname;

    // 1. Live toggleable Streamable HTTP MCP Endpoint
    if (pathname === "/mcp") {
      if (!mcpEnabled) {
        sendJson(res, 503, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "MCP 服务当前已在界面中关闭，请勾选「启动MCP」后重试" },
        });
        return;
      }
      if (req.method === "DELETE") {
        const sid = req.headers["mcp-session-id"];
        if (sid) mcpSessions.delete(String(sid));
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "Method Not Allowed. Send JSON-RPC POST to /mcp" });
        return;
      }
      const msg = await readJsonBody(req);
      let sessionId = req.headers["mcp-session-id"] ? String(req.headers["mcp-session-id"]) : "";
      if (msg.method === "initialize" && !sessionId) {
        sessionId = crypto.randomUUID();
        mcpSessions.add(sessionId);
      }
      const resp = await handleJsonRpcMessage(msg);
      if (resp === null) {
        const headers = sessionId ? { "Mcp-Session-Id": sessionId } : {};
        res.writeHead(202, headers);
        res.end();
        return;
      }
      const extra = sessionId ? { "Mcp-Session-Id": sessionId } : {};
      sendJson(res, 200, resp, extra);
      return;
    }

    // 2. REST API Endpoints
    if (pathname === "/api/state" && req.method === "GET") {
      const outputDir = url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR;
      const idx = await searchCleanedIndex({ outputDir, limit: 1 });
      const localDirs = await listCandidateLocalDirs();
      const wereadStatus = await getWeReadStatus({ probeApi: false });
      const savedWeReadAccounts = await loadSavedWeReadAccounts(idx.outputDir);
      const subsData = await loadSubscriptions({ outputDir: idx.outputDir });
      sendJson(res, 200, {
        server: SERVER_INFO,
        port: PORT,
        outputDir: idx.outputDir,
        indexFile: idx.indexFile,
        archivedCount: idx.total,
        accounts: idx.accounts || [],
        mcpEnabled,
        mcpUrl: `http://${HOST}:${PORT}/mcp`,
        mcpConfig: buildMcpConfig(),
        localDirSuggestions: localDirs,
        wereadStatus,
        savedWeReadAccounts,
        subscriptionSummary: {
          total: subsData.accounts.length,
          enabledCount: subsData.accounts.filter((a) => a.enabled).length,
          autoEnabled: Boolean(subsData.scheduler.enabled),
          intervalMinutes: subsData.scheduler.intervalMinutes,
          nextRunAt: schedulerRuntime.nextRunAt,
          running: schedulerRuntime.running,
          activeJobId: schedulerRuntime.activeJobId,
          lastGlobalCheckAt: subsData.scheduler.lastGlobalCheckAt || "",
          lastNotice: schedulerRuntime.lastScheduledNotice || "",
        },
      });
      return;
    }

    // Subscriptions REST APIs
    if (pathname === "/api/subscriptions" && req.method === "GET") {
      const outputDir = url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR;
      const data = await loadSubscriptions({ outputDir });
      sendJson(res, 200, {
        ...data,
        schedulerState: {
          running: schedulerRuntime.running,
          activeJobId: schedulerRuntime.activeJobId,
          nextRunAt: schedulerRuntime.nextRunAt,
          lastNotice: schedulerRuntime.lastScheduledNotice,
        },
      });
      return;
    }

    if (pathname === "/api/subscriptions/add" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      if (inputs.length === 0) {
        sendJson(res, 400, { error: "请粘贴至少一个公众号文章链接、含 __biz 的合集链接或 MP_WXS_<数字>" });
        return;
      }
      const resAdd = await addSubscriptions(inputs, {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
        nameHint: body.nameHint || "",
        category: body.category || "默认订阅",
        since: body.since || "",
        tags: Array.isArray(body.tags) ? body.tags : [],
      });
      await rescheduleSubscriptionTimer();
      if (resAdd.error && resAdd.added.length === 0 && resAdd.existing.length === 0) {
        sendJson(res, 400, { error: resAdd.error, warnings: resAdd.warnings });
        return;
      }
      sendJson(res, 200, {
        ...resAdd,
        schedulerState: {
          running: schedulerRuntime.running,
          nextRunAt: schedulerRuntime.nextRunAt,
        },
      });
      return;
    }

    if (pathname === "/api/subscriptions/update" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.bookId) {
        sendJson(res, 400, { error: "缺少 bookId 参数" });
        return;
      }
      const updated = await updateSubscriptionAccount(body.bookId, body, {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
      });
      await rescheduleSubscriptionTimer();
      sendJson(res, 200, {
        ...updated,
        schedulerState: {
          running: schedulerRuntime.running,
          nextRunAt: schedulerRuntime.nextRunAt,
        },
      });
      return;
    }

    if (pathname === "/api/subscriptions/remove" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!body.bookId) {
        sendJson(res, 400, { error: "缺少 bookId 参数" });
        return;
      }
      const removed = await removeSubscriptionAccount(body.bookId, {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
      });
      await rescheduleSubscriptionTimer();
      sendJson(res, 200, {
        ...removed,
        schedulerState: {
          running: schedulerRuntime.running,
          nextRunAt: schedulerRuntime.nextRunAt,
        },
      });
      return;
    }

    if (pathname === "/api/subscriptions/config" && req.method === "POST") {
      const body = await readJsonBody(req);
      const updated = await updateSubscriptionConfig(
        {
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(body.intervalMinutes !== undefined ? { intervalMinutes: Number(body.intervalMinutes) } : {}),
          ...(body.delaySec !== undefined ? { delaySec: Number(body.delaySec) } : {}),
          ...(body.lookbackPages !== undefined ? { lookbackPages: Number(body.lookbackPages) } : {}),
          ...(body.maxPerCheck !== undefined ? { maxPerCheck: Number(body.maxPerCheck) } : {}),
          ...(typeof body.downloadImages === "boolean" ? { downloadImages: body.downloadImages } : {}),
          ...(typeof body.saveJsonl === "boolean" ? { saveJsonl: body.saveJsonl } : {}),
        },
        { outputDir: body.outputDir || DEFAULT_OUTPUT_DIR }
      );
      await rescheduleSubscriptionTimer();
      sendJson(res, 200, {
        ...updated,
        schedulerState: {
          running: schedulerRuntime.running,
          nextRunAt: schedulerRuntime.nextRunAt,
        },
      });
      return;
    }

    if (pathname === "/api/run/subscriptions-sync" && req.method === "POST") {
      if (schedulerRuntime.running) {
        sendJson(res, 409, { error: "已有订阅更新检查正在运行，请稍候完成或中止后再试" });
        return;
      }
      const body = await readJsonBody(req);
      const job = createJob("subscriptions-sync");
      schedulerRuntime.running = true;
      schedulerRuntime.activeJobId = job.id;

      (async () => {
        try {
          job.emit("log", {
            level: "info",
            message: `任务 ${job.id} 已启动：检查订阅公众号最新文章并自动下载清洗...`,
          });
          const summary = await runSubscriptionsCheck({
            outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
            bookId: body.bookId || "",
            trigger: "manual",
            delayMs: body.delaySec !== undefined ? Number(body.delaySec) * 1000 : null,
            downloadImages: typeof body.downloadImages === "boolean" ? body.downloadImages : null,
            saveJsonl: typeof body.saveJsonl === "boolean" ? body.saveJsonl : null,
            signal: job.controller.signal,
            onProgress: (evt) => job.emit("progress", evt),
          });
          job.finish(summary);
        } catch (err) {
          job.fail(err);
        } finally {
          schedulerRuntime.running = false;
          schedulerRuntime.activeJobId = null;
          await rescheduleSubscriptionTimer();
        }
      })();
      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    if (pathname === "/api/weread/status" && req.method === "GET") {
      const probeApi = url.searchParams.get("probe") === "1";
      const status = await getWeReadStatus({ probeApi });
      sendJson(res, 200, status);
      return;
    }

    if (pathname === "/api/weread/login" && req.method === "POST") {
      const status = await openWeReadLoginWindow({ includeQr: true });
      sendJson(res, 200, status);
      return;
    }

    if (pathname === "/api/weread/qr" && req.method === "GET") {
      const resQr = await refreshWeReadLoginQr();
      sendJson(res, 200, resQr);
      return;
    }

    if (pathname === "/api/run/weread-inspect" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      if (inputs.length === 0) {
        sendJson(res, 400, {
          error: "请先粘贴公众号任意文章链接、含 __biz 的合集链接，或直接输入 MP_WXS_<数字>（也可点击下方快捷公众号标签）",
        });
        return;
      }

      const job = createJob("weread-inspect");
      (async () => {
        try {
          job.emit("log", {
            level: "info",
            message: `任务 ${job.id} 已启动：通过微信读书接口解析公众号全量历史目录...`,
          });
          const info = await inspectWeReadAccounts(inputs, {
            outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
            dateFrom: body.dateFrom || "",
            dateTo: body.dateTo || "",
            minReads: Math.max(0, Number(body.minReads) || 0),
            onlyOriginal: Boolean(body.onlyOriginal),
            maxArticles: Math.max(1, Number(body.maxArticles) || 200),
            maxPages: Math.max(1, Number(body.maxPages) || 50),
            startPage: Math.max(1, Number(body.startPage) || 1),
            delayMs: Math.max(800, Number(body.delaySec ?? 2) * 1000),
            signal: job.controller.signal,
            onProgress: (evt) => job.emit("progress", evt),
          });
          job.finish(info);
        } catch (err) {
          job.fail(err);
        }
      })();
      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    if (pathname === "/api/run/weread-sync" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      const prefetchedItems = Array.isArray(body.prefetchedItems) ? body.prefetchedItems : null;

      if (inputs.length === 0 && (!prefetchedItems || prefetchedItems.length === 0)) {
        sendJson(res, 400, {
          error: "请先输入公众号链接 / MP_WXS_...，或先点击「1.获取公众号ID/目录」",
        });
        return;
      }

      const job = createJob("weread-sync");
      const options = {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
        dateFrom: body.dateFrom || "",
        dateTo: body.dateTo || "",
        minReads: Math.max(0, Number(body.minReads) || 0),
        minWords: Math.max(0, Number(body.minWords) || 0),
        onlyOriginal: Boolean(body.onlyOriginal),
        maxArticles: Math.max(1, Number(body.maxArticles) || 200),
        maxPages: Math.max(1, Number(body.maxPages) || 50),
        startPage: Math.max(1, Number(body.startPage) || 1),
        delayMs: Math.max(800, Number(body.delaySec ?? 3) * 1000),
        downloadImages: Boolean(body.downloadImages),
        force: body.dedup === false ? true : Boolean(body.force),
        includeDatePrefix: body.includeDatePrefix !== false,
        includeYaml: body.includeYaml !== false,
        saveMd: body.saveMd !== false,
        saveHtml: Boolean(body.saveHtml),
        saveJson: Boolean(body.saveJson),
        saveJsonl: Boolean(body.saveJsonl),
        extraTags: Array.isArray(body.tags) ? body.tags : [],
        prefetchedItems,
        signal: job.controller.signal,
        onProgress: (evt) => job.emit("progress", evt),
      };

      (async () => {
        try {
          job.emit("log", {
            level: "info",
            message: `任务 ${job.id} 已启动：通过微信读书通道批量抓取正文并深度清洗（自动断点续传去重）...`,
          });
          const summary = await syncWeReadAccounts(inputs, options);
          job.finish(summary);
        } catch (err) {
          job.fail(err);
        }
      })();
      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    if (pathname === "/api/mcp-toggle" && req.method === "POST") {
      const body = await readJsonBody(req);
      mcpEnabled = Boolean(body.enabled);
      sendJson(res, 200, {
        mcpEnabled,
        mcpUrl: `http://${HOST}:${PORT}/mcp`,
        mcpConfig: buildMcpConfig(),
      });
      return;
    }

    if (pathname === "/api/open-dir" && req.method === "POST") {
      const body = await readJsonBody(req);
      const target = body.dir ? path.resolve(body.dir) : DEFAULT_OUTPUT_DIR;
      await fs.mkdir(target, { recursive: true });
      openDirectoryInOS(target);
      sendJson(res, 200, { status: "opened", dir: target });
      return;
    }

    if (pathname === "/api/parse-inputs" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      const info = await inspectInputs(inputs, {
        maxArticles: Number(body.maxArticles) || 200,
        dateFrom: body.dateFrom || "",
        dateTo: body.dateTo || "",
        delayMs: Math.max(0, Number(body.delaySec ?? 2) * 1000),
        discoverRelated: body.discoverRelated !== false,
      });
      sendJson(res, 200, info);
      return;
    }

    if (pathname === "/api/run/inspect" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      if (inputs.length === 0) {
        sendJson(res, 400, { error: "请先输入至少一条文章链接、合集链接或导入清单文件" });
        return;
      }
      const job = createJob("inspect");
      (async () => {
        try {
          job.emit("log", {
            level: "info",
            message: `开始解析链接${body.discoverRelated !== false ? "（已启用：自动探测单篇公开合集标签与文内往期推荐）" : ""}...`,
          });
          const info = await inspectInputs(inputs, {
            maxArticles: Number(body.maxArticles) || 200,
            dateFrom: body.dateFrom || "",
            dateTo: body.dateTo || "",
            delayMs: Math.max(0, Number(body.delaySec ?? 2) * 1000),
            discoverRelated: body.discoverRelated !== false,
            signal: job.controller.signal,
            onProgress: (evt) => job.emit("progress", evt),
          });
          job.finish({ kind: "inspect", ...info });
        } catch (err) {
          job.fail(err);
        }
      })();
      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    if (pathname === "/api/export-parsed-csv" && req.method === "POST") {
      const body = await readJsonBody(req);
      const articles = Array.isArray(body.articles) ? body.articles : [];
      const outputDir = path.resolve(body.outputDir || DEFAULT_OUTPUT_DIR);
      await fs.mkdir(outputDir, { recursive: true });
      const csvEsc = (v) => {
        const s = String(v ?? "").replace(/\r?\n/g, " ");
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const hasWeReadCols = articles.some((a) => a.reviewId || typeof a.readNum === "number");
      const rows = [
        hasWeReadCols
          ? "发布日期,发布时间,公众号,标题,阅读数,点赞数,归档状态,review_id,来源,原文链接"
          : "发布日期,标题,来源,链接",
      ];
      for (const a of articles) {
        if (hasWeReadCols) {
          rows.push(
            [
              a.date || "",
              a.publishedAt || "",
              a.account || "",
              a.title || "",
              a.readNum ?? "",
              a.likeNum ?? "",
              a.alreadyArchived ? "已归档" : "待下载",
              a.reviewId || "",
              a.source || "",
              a.url || "",
            ]
              .map(csvEsc)
              .join(",")
          );
        } else {
          rows.push([a.date || "", a.title || "", a.source || "", a.url || ""].map(csvEsc).join(","));
        }
      }
      const csvText = "\uFEFF" + rows.join("\r\n") + "\r\n";
      const csvPath = path.join(outputDir, "00_解析链接清单.csv");
      await fs.writeFile(csvPath, csvText, "utf8");
      sendJson(res, 200, { status: "exported", csvPath, count: articles.length, csvContent: csvText });
      return;
    }

    if (pathname === "/api/export-jsonl" && req.method === "GET") {
      const outputDir = url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR;
      const { jsonlPath, count } = await exportArticlesJsonl({ outputDir });
      sendJson(res, 200, { status: "exported", jsonlPath, count });
      return;
    }

    if ((pathname === "/api/run/fetch" || pathname === "/api/run/batch") && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputs = [];
      if (body.rawText) inputs.push(String(body.rawText));
      if (Array.isArray(body.inputs)) inputs.push(...body.inputs);
      if (inputs.length === 0) {
        sendJson(res, 400, { error: "请先输入至少一条微信公开文章链接、合集链接，或导入链接文件" });
        return;
      }

      const job = createJob(pathname === "/api/run/fetch" ? "fetch" : "batch");
      const options = {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
        delayMs: Math.max(0, Number(body.delaySec ?? 2) * 1000),
        dateFrom: body.dateFrom || "",
        dateTo: body.dateTo || "",
        maxArticles: Math.max(1, Number(body.maxArticles) || 200),
        downloadImages: Boolean(body.downloadImages),
        force: body.dedup === false ? true : Boolean(body.force),
        includeDatePrefix: body.includeDatePrefix !== false,
        includeYaml: body.includeYaml !== false,
        saveMd: body.saveMd !== false,
        saveHtml: Boolean(body.saveHtml),
        saveJson: Boolean(body.saveJson),
        onlyOriginal: Boolean(body.onlyOriginal),
        minWords: Math.max(0, Number(body.minWords) || 0),
        discoverRelated: Boolean(body.discoverRelated),
        extraTags: Array.isArray(body.tags) ? body.tags : [],
        signal: job.controller.signal,
        onProgress: (evt) => job.emit("progress", evt),
      };

      // Run asynchronously
      (async () => {
        try {
          job.emit("log", { level: "info", message: `任务 ${job.id} 已启动，正在解析输入链接...` });
          const summary = await batchFetchInputs(inputs, options);
          job.finish(summary);
        } catch (err) {
          job.fail(err);
        }
      })();

      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    if (pathname === "/api/run/clean-dir" && req.method === "POST") {
      const body = await readJsonBody(req);
      const inputDir = String(body.inputDir || "").trim();
      if (!inputDir) {
        sendJson(res, 400, { error: "请提供待清洗的本地目录路径" });
        return;
      }
      try {
        const st = await fs.stat(inputDir);
        if (!st.isDirectory()) throw new Error("路径不是文件夹");
      } catch {
        sendJson(res, 400, { error: `目录不存在或无法访问：${inputDir}` });
        return;
      }

      const job = createJob("clean-dir");
      const options = {
        outputDir: body.outputDir || DEFAULT_OUTPUT_DIR,
        dateFrom: body.dateFrom || "",
        dateTo: body.dateTo || "",
        force: body.dedup === false ? true : Boolean(body.force),
        accountHint: body.accountHint || "",
        includeDatePrefix: body.includeDatePrefix !== false,
        includeYaml: body.includeYaml !== false,
        saveMd: body.saveMd !== false,
        saveHtml: Boolean(body.saveHtml),
        saveJson: Boolean(body.saveJson),
        onlyOriginal: Boolean(body.onlyOriginal),
        minWords: Math.max(0, Number(body.minWords) || 0),
        signal: job.controller.signal,
        onProgress: (evt) => job.emit("progress", evt),
      };

      (async () => {
        try {
          job.emit("log", { level: "info", message: `开始深度清洗本地目录：${inputDir}` });
          const summary = await cleanLocalDirectory(inputDir, options);
          job.finish(summary);
        } catch (err) {
          job.fail(err);
        }
      })();

      sendJson(res, 202, { jobId: job.id, status: "running" });
      return;
    }

    const cancelMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const job = jobs.get(cancelMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "任务不存在" });
        return;
      }
      job.controller.abort();
      job.emit("log", { level: "warn", message: "正在中止任务，等待当前请求收尾并保存已完成归档..." });
      sendJson(res, 200, { status: "cancelling", jobId: job.id });
      return;
    }

    const eventsMatch = pathname.match(/^\/api\/jobs\/([a-zA-Z0-9-]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const job = jobs.get(eventsMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "任务不存在" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      for (const evt of job.events) {
        res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
      }
      if (job.status !== "running") {
        res.end();
        return;
      }
      job.listeners.add(res);
      req.on("close", () => job.listeners.delete(res));
      return;
    }

    if (pathname === "/api/articles" && req.method === "GET") {
      const outputDir = url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR;
      const account = url.searchParams.get("account") || "";
      const keyword = url.searchParams.get("keyword") || "";
      const dateFrom = url.searchParams.get("dateFrom") || "";
      const dateTo = url.searchParams.get("dateTo") || "";
      const limit = Number(url.searchParams.get("limit") || 200);
      const data = await searchCleanedIndex({ outputDir, account, keyword, dateFrom, dateTo, limit });
      sendJson(res, 200, data);
      return;
    }

    if (pathname === "/api/article-content" && req.method === "GET") {
      const outputDir = path.resolve(url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR);
      const rel = url.searchParams.get("path") || "";
      if (!rel) {
        sendJson(res, 400, { error: "缺少 path 参数" });
        return;
      }
      const target = path.resolve(outputDir, rel);
      // Strict path traversal guard
      if (!target.startsWith(outputDir + path.sep) && target !== outputDir) {
        sendJson(res, 403, { error: "禁止访问归档目录外的文件" });
        return;
      }
      const content = await fs.readFile(target, "utf8");
      sendJson(res, 200, { path: rel, fullPath: target, content });
      return;
    }

    if (pathname === "/api/export-csv" && req.method === "GET") {
      const outputDir = url.searchParams.get("outputDir") || DEFAULT_OUTPUT_DIR;
      const { csvPath, csvContent, count } = await exportArticlesCsv({ outputDir });
      if (url.searchParams.get("download") === "1") {
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("公众号文章清洗归档数据.csv")}`,
        });
        res.end(csvContent);
        return;
      }
      sendJson(res, 200, { status: "exported", csvPath, count });
      return;
    }

    // 3. Static Frontend Assets
    let relStatic = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const staticFile = path.resolve(PUBLIC_DIR, relStatic);
    if (!staticFile.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await fs.readFile(staticFile);
      const ext = path.extname(staticFile).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    }
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
});

let portAttempts = 0;
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE" && !STRICT_PORT && portAttempts < 10) {
    portAttempts++;
    const nextPort = PORT + 1;
    console.warn(`[提示] 端口 ${PORT} 已被占用，自动尝试切换到端口 ${nextPort} ...`);
    PORT = nextPort;
    server.listen(PORT, HOST);
    return;
  }
  console.error(`启动服务失败 (${err?.code || "ERROR"}):`, err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const webUrl = `http://${HOST}:${PORT}`;
  console.log(`========================================================`);
  console.log(`  微信公众号文章采集、订阅与清洗工作台 v2.1 (Web + MCP)`);
  console.log(`  Web 界面: ${webUrl}`);
  console.log(`  MCP 端点: ${webUrl}/mcp`);
  console.log(`  默认归档: ${DEFAULT_OUTPUT_DIR}`);
  console.log(`========================================================`);
  console.log(`  提示：保持此窗口开启即可维持定时自动订阅，按 Ctrl+C 停止服务。`);
  rescheduleSubscriptionTimer().catch(() => {});
  if (AUTO_OPEN) {
    setTimeout(() => openUrlInDefaultBrowser(webUrl), 350);
  }
});
