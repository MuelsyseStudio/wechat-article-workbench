/**
 * Zero-dependency Chromium / Microsoft Edge CDP Adapter for WeRead (weread.qq.com)
 *
 * Uses the user's own visibly logged-in WeRead browser session (persistent profile under data/weread-profile/)
 * and invokes WeRead's same-origin endpoints inside the page context via Node's native WebSocket CDP client.
 * Never bypasses login, CAPTCHA, or rate-limit controls: stops cleanly on any errCode / auth expiry.
 */
import { execFile, spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatShanghaiDateTime } from "./html-to-md.mjs";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, "..", "data");
export const WEREAD_PROFILE_DIR = path.join(DATA_DIR, "weread-profile");
export const WEREAD_ACCOUNTS_PATH = path.join(DATA_DIR, "weread-accounts.json");
export const WEREAD_CDP_PORT = Number(process.env.WEREAD_CDP_PORT || 9223);
export const WEREAD_ORIGIN = "https://weread.qq.com";

export function abortableSleep(ms, signal = null) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function politeDelayAbortable(delayMs = 2000, signal = null) {
  const base = Math.max(0, Number(delayMs) || 0);
  if (base <= 0) return;
  const jitter = Math.floor(Math.random() * Math.min(600, base * 0.25));
  await abortableSleep(base + jitter, signal);
}

/**
 * Convert WeChat __biz (Base64) or MP_WXS_<digits> or URL containing __biz into WeRead bookId
 */
export function bizToWeReadBookId(rawInput) {
  const s = String(rawInput || "").trim();
  if (!s) return { bookId: "", biz: "", numericId: "" };

  // 1. Direct MP_WXS_<digits>
  const direct = s.match(/\bMP_WXS_(\d{5,20})\b/i);
  if (direct) {
    const numericId = direct[1];
    const biz = Buffer.from(numericId, "utf8").toString("base64");
    return { bookId: `MP_WXS_${numericId}`, biz, numericId };
  }

  // 2. Extract __biz=... from URL or query snippet
  let bizCandidate = "";
  const bizParam = s.match(/[?&]__biz=([^&#\s"'<>]+)/i);
  if (bizParam) {
    try {
      bizCandidate = decodeURIComponent(bizParam[1]).trim();
    } catch {
      bizCandidate = bizParam[1].trim();
    }
  } else if (/^[A-Za-z0-9+/=_-]{8,32}$/.test(s) && !/^https?:/i.test(s)) {
    bizCandidate = s;
  }

  if (bizCandidate) {
    try {
      let b64 = bizCandidate.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4 !== 0) b64 += "=";
      const decoded = Buffer.from(b64, "base64").toString("utf8");
      const digits = decoded.replace(/[^0-9]/g, "");
      if (digits.length >= 6 && digits.length <= 20) {
        return {
          bookId: `MP_WXS_${digits}`,
          biz: b64,
          numericId: digits,
        };
      }
    } catch {}
  }

  return { bookId: "", biz: "", numericId: "" };
}

/**
 * Extract WeRead bookIds, __biz URLs, and short WeChat article URLs from arbitrary user input
 */
export function extractWeReadIdentifiersFromText(rawText) {
  const text = String(rawText || "");
  const bookIds = new Map(); // bookId -> { bookId, biz, numericId, source }
  const shortArticleUrls = [];
  const seenShort = new Set();

  // Direct MP_WXS_...
  const directRe = /\bMP_WXS_(\d{5,20})\b/gi;
  let m;
  while ((m = directRe.exec(text)) !== null) {
    const parsed = bizToWeReadBookId(m[0]);
    if (parsed.bookId && !bookIds.has(parsed.bookId)) {
      bookIds.set(parsed.bookId, { ...parsed, source: "book_id" });
    }
  }

  // Any URL or snippet with __biz=...
  const bizUrlRe = /(?:https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>|,\]]+|[?&]__biz=[A-Za-z0-9%+/=_-]+)/gi;
  while ((m = bizUrlRe.exec(text)) !== null) {
    const raw = m[0].replace(/&amp;/g, "&");
    const parsed = bizToWeReadBookId(raw);
    if (parsed.bookId && !bookIds.has(parsed.bookId)) {
      bookIds.set(parsed.bookId, { ...parsed, source: "biz_url", sampleUrl: /^https?:/i.test(raw) ? raw : "" });
    }
  }

  // Short article links (https://mp.weixin.qq.com/s/xxxxx)
  const shortRe = /https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/gi;
  while ((m = shortRe.exec(text)) !== null) {
    const u = m[0];
    if (!seenShort.has(u)) {
      seenShort.add(u);
      shortArticleUrls.push(u);
    }
  }

  return {
    bookIds: [...bookIds.values()],
    shortArticleUrls,
  };
}

/**
 * Locate Microsoft Edge or Google Chrome executable on the host OS
 */
export function findChromiumExecutable() {
  const envOverride = process.env.WEREAD_BROWSER_PATH || process.env.CHROME_PATH || "";
  if (envOverride && fsSync.existsSync(envOverride)) {
    return { executablePath: envOverride, browserName: path.basename(envOverride) };
  }

  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates =
    process.platform === "win32"
      ? [
          { path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", name: "Microsoft Edge" },
          { path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", name: "Microsoft Edge" },
          ...(localAppData
            ? [{ path: path.join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe"), name: "Microsoft Edge" }]
            : []),
          { path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", name: "Google Chrome" },
          { path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", name: "Google Chrome" },
          ...(localAppData
            ? [{ path: path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"), name: "Google Chrome" }]
            : []),
        ]
      : process.platform === "darwin"
      ? [
          { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Google Chrome" },
          { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Microsoft Edge" },
        ]
      : [
          { path: "/usr/bin/microsoft-edge", name: "Microsoft Edge" },
          { path: "/usr/bin/google-chrome", name: "Google Chrome" },
          { path: "/usr/bin/chromium", name: "Chromium" },
          { path: "/usr/bin/chromium-browser", name: "Chromium" },
        ];

  for (const c of candidates) {
    if (c.path && fsSync.existsSync(c.path)) {
      return { executablePath: c.path, browserName: c.name };
    }
  }
  return { executablePath: "", browserName: "" };
}

/**
 * Minimal CDP JSON-RPC client over Node's native WebSocket
 */
export class CdpClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = true;
  }

  async connect(wsUrl, timeoutMs = 10000) {
    if (typeof WebSocket !== "function") {
      throw new Error("当前 Node.js 环境不支持原生 WebSocket（需 Node 22+）");
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.closed = false;

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`连接浏览器 CDP 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        if (this.closed) return;
        reject(new Error("连接浏览器 CDP WebSocket 失败"));
      });

      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id && this.pending.has(msg.id)) {
            const entry = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            if (msg.error) {
              entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            } else {
              entry.resolve(msg.result);
            }
          }
        } catch {}
      });

      ws.addEventListener("close", () => {
        this.closed = true;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("浏览器 CDP 连接已关闭"));
        }
        this.pending.clear();
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error("CDP 连接未建立或已关闭"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 指令超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs = 30000 } = {}) {
    const res = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue,
      },
      timeoutMs
    );
    if (res?.exceptionDetails) {
      const desc =
        res.exceptionDetails.exception?.description ||
        res.exceptionDetails.text ||
        "页面脚本执行异常";
      throw new Error(desc);
    }
    return res?.result?.value;
  }

  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

async function fetchCdpJson(endpointPath, { timeoutMs = 1500, port = WEREAD_CDP_PORT } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${endpointPath}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function psSingleQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * On Windows, background Node daemons inherit SW_HIDE, which causes direct spawn()
 * of msedge.exe to create an invisible window (MainWindowHandle == 0).
 * Using PowerShell Start-Process -WindowStyle Normal guarantees a real visible desktop window.
 */
async function launchVisibleBrowserProcess(executablePath, launchArgs) {
  if (process.platform === "win32") {
    const quotedArgs = launchArgs
      .map((a) => {
        // Quote argument values containing spaces/non-ASCII safely for CreateProcess
        const needsInnerQuote = /[\s"]/.test(a);
        const val = needsInnerQuote ? `"${a.replace(/"/g, '\\"')}"` : a;
        return psSingleQuote(val);
      })
      .join(", ");
    const psScript = `$argList = @(${quotedArgs}); Start-Process -FilePath ${psSingleQuote(
      executablePath
    )} -ArgumentList $argList -WindowStyle Normal`;
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
      { timeout: 10000, windowsHide: true }
    );
    return;
  }

  const child = spawn(executablePath, launchArgs, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Check if the running CDP browser actually has a visible desktop HWND on Windows,
 * and restore/bring it to the foreground. Returns { visible, hwnd, pid }.
 */
async function ensureWindowsWindowVisibleAndFront(port = WEREAD_CDP_PORT) {
  if (process.platform !== "win32") return { visible: true, hwnd: 0, pid: 0 };
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32FocusHelper {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
"@
$procs = Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and
  $_.CommandLine -like '*--remote-debugging-port=${port}*' -and
  $_.CommandLine -notlike '*--type=*'
}
$found = $null
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId
  if ($gp) {
    $h = [int64]$gp.MainWindowHandle
    if ($h -ne 0) {
      [Win32FocusHelper]::ShowWindowAsync($gp.MainWindowHandle, 9) | Out-Null
      [Win32FocusHelper]::BringWindowToTop($gp.MainWindowHandle) | Out-Null
      [Win32FocusHelper]::SetForegroundWindow($gp.MainWindowHandle) | Out-Null
      $found = @{ visible = $true; hwnd = $h; pid = $gp.Id; title = $gp.MainWindowTitle }
      break
    } elseif (-not $found) {
      $found = @{ visible = $false; hwnd = 0; pid = $gp.Id; title = '' }
    }
  }
}
if ($found) { $found | ConvertTo-Json -Compress } else { '{"visible":false,"hwnd":0,"pid":0}' }
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
      { timeout: 6000, windowsHide: true }
    );
    return JSON.parse((stdout || "").trim() || '{"visible":false,"hwnd":0,"pid":0}');
  } catch {
    return { visible: true, hwnd: 0, pid: 0 };
  }
}

async function stopHiddenWeReadBrowserOnWindows(port = WEREAD_CDP_PORT) {
  if (process.platform !== "win32") return;
  const psScript = `
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and
  $_.CommandLine -like '*--remote-debugging-port=${port}*'
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", psScript],
    { timeout: 6000, windowsHide: true }
  ).catch(() => {});
  await abortableSleep(700);
}

/**
 * Ensure our dedicated Edge/Chrome browser instance is running with remote debugging enabled.
 */
export async function ensureCdpBrowserRunning({ autoLaunch = true, ensureVisible = false, port = WEREAD_CDP_PORT } = {}) {
  const existing = await fetchCdpJson("/json/version", { timeoutMs: 900, port });
  if (existing && existing.webSocketDebuggerUrl) {
    if (ensureVisible && process.platform === "win32") {
      await ensureWindowsWindowVisibleAndFront(port).catch(() => {});
    }
    return { running: true, launchedNow: false, version: existing };
  }

  if (!autoLaunch) {
    return { running: false, launchedNow: false, version: null };
  }

  const { executablePath, browserName } = findChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      "未在本机找到 Microsoft Edge 或 Google Chrome，请安装 Edge/Chrome 或设置环境变量 WEREAD_BROWSER_PATH"
    );
  }

  await fs.mkdir(WEREAD_PROFILE_DIR, { recursive: true });

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${WEREAD_PROFILE_DIR}`,
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--window-position=120,80",
    "--window-size=1180,820",
    `${WEREAD_ORIGIN}/`,
  ];

  await launchVisibleBrowserProcess(executablePath, launchArgs);

  // Wait up to 15 seconds for CDP port to come alive
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await abortableSleep(300);
    const ver = await fetchCdpJson("/json/version", { timeoutMs: 900, port });
    if (ver && ver.webSocketDebuggerUrl) {
      if (ensureVisible && process.platform === "win32") {
        await abortableSleep(500);
        await ensureWindowsWindowVisibleAndFront(port);
      }
      return { running: true, launchedNow: true, browserName, version: ver, windowVisible: true };
    }
  }

  throw new Error(
    `已尝试启动 ${browserName}，但在 15 秒内未能连上本地调试端口 127.0.0.1:${port}。请关闭可能残留的独立微信读书窗口后重试。`
  );
}

/**
 * Persistent WeRead Browser Session over CDP
 */
export class WeReadSession {
  constructor({ port = WEREAD_CDP_PORT } = {}) {
    this.port = port;
    this.version = null;
    this.pageTarget = null;
    this.cdp = null;
  }

  async connect({ autoLaunch = true, bringToFront = false } = {}) {
    const boot = await ensureCdpBrowserRunning({ autoLaunch, ensureVisible: bringToFront, port: this.port });
    if (!boot.running || !boot.version) {
      return { connected: false, launchedNow: false };
    }
    this.version = boot.version;

    let targets = (await fetchCdpJson("/json/list", { timeoutMs: 2500, port: this.port })) || [];
    let page = targets.find(
      (t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(WEREAD_ORIGIN)
    );

    if (!page) {
      page = targets.find(
        (t) =>
          t.type === "page" &&
          typeof t.url === "string" &&
          !t.url.startsWith("devtools://") &&
          !t.url.startsWith("chrome-extension://") &&
          !t.url.startsWith("extension://")
      );
    }

    if (!page) {
      // Create a new tab via browser-level CDP Target.createTarget
      const browserCdp = new CdpClient();
      await browserCdp.connect(this.version.webSocketDebuggerUrl, 8000);
      try {
        const created = await browserCdp.send("Target.createTarget", { url: `${WEREAD_ORIGIN}/` }, 8000);
        await abortableSleep(500);
        targets = (await fetchCdpJson("/json/list", { timeoutMs: 2500, port: this.port })) || [];
        page = targets.find((t) => t.id === created?.targetId) || targets.find((t) => t.type === "page");
      } finally {
        browserCdp.close();
      }
    }

    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error("未能定位微信读书浏览器标签页，请重新点击「登录微信读书」");
    }

    this.pageTarget = page;
    this.cdp = new CdpClient();
    await this.cdp.connect(page.webSocketDebuggerUrl, 10000);
    await this.cdp.send("Page.enable", {}, 8000).catch(() => {});

    // Navigate to weread.qq.com if tab is elsewhere
    const currentHref = await this.cdp.evaluate("String(location.href || '')", { awaitPromise: false }).catch(() => "");
    if (!currentHref.startsWith(WEREAD_ORIGIN)) {
      await this.cdp.send("Page.navigate", { url: `${WEREAD_ORIGIN}/` }, 15000);
      const navDeadline = Date.now() + 15000;
      while (Date.now() < navDeadline) {
        await abortableSleep(350);
        const state = await this.cdp
          .evaluate("({ href: location.href, ready: document.readyState })", { awaitPromise: false })
          .catch(() => null);
        if (state && String(state.href || "").startsWith(WEREAD_ORIGIN) && state.ready !== "loading") {
          break;
        }
      }
    }

    if (bringToFront) {
      await this.cdp.send("Page.bringToFront", {}, 5000).catch(() => {});
    }

    return { connected: true, launchedNow: boot.launchedNow, browserName: boot.browserName || "" };
  }

  async readCookieSummary() {
    if (!this.cdp || this.cdp.closed) {
      return { vid: "", skey: "", skeyExpires: 0, rt: "", userName: "" };
    }
    const cookieRes = await this.cdp
      .send("Network.getCookies", { urls: [WEREAD_ORIGIN] }, 8000)
      .catch(() => ({ cookies: [] }));
    const cookies = Array.isArray(cookieRes?.cookies) ? cookieRes.cookies : [];
    const byName = new Map(cookies.map((c) => [c.name, c]));
    const vid = String(byName.get("wr_vid")?.value || "").trim();
    const skeyCookie = byName.get("wr_skey");
    const skey = String(skeyCookie?.value || "").trim();
    const skeyExpires = Number(skeyCookie?.expires || 0);
    const rt = String(byName.get("wr_rt")?.value || "").trim();
    let userName = "";
    const rawName = byName.get("wr_name")?.value;
    if (rawName) {
      try {
        userName = decodeURIComponent(rawName);
      } catch {
        userName = String(rawName);
      }
    }
    return { vid, skey, skeyExpires, rt, userName };
  }

  /**
   * Silently refresh WeRead's short-lived wr_skey (~2h TTL) using the long-lived wr_rt refresh cookie
   * simply by reloading the weread.qq.com page (identical to pressing F5 in Edge).
   * Requires NO QR rescan whenever wr_rt is still valid.
   */
  async trySilentRenewSession() {
    if (!this.cdp || this.cdp.closed) return { renewed: false };
    const nowMs = Date.now();
    if (this._lastRenewAt && nowMs - this._lastRenewAt < 4000) {
      const cur = await this.readCookieSummary();
      return { renewed: Boolean(cur.vid && cur.skey), ...cur };
    }
    this._lastRenewAt = nowMs;

    try {
      const href = await this.cdp
        .evaluate("String(location.href || '')", { awaitPromise: false, timeoutMs: 4000 })
        .catch(() => "");
      if (href.startsWith(WEREAD_ORIGIN)) {
        await this.cdp.send("Page.reload", { ignoreCache: false }, 15000).catch(() => {});
      } else {
        await this.cdp.send("Page.navigate", { url: `${WEREAD_ORIGIN}/` }, 15000).catch(() => {});
      }

      const deadline = Date.now() + 9000;
      let latest = { vid: "", skey: "", skeyExpires: 0, rt: "", userName: "" };
      while (Date.now() < deadline) {
        await abortableSleep(450);
        const ready = await this.cdp
          .evaluate("String(document.readyState || '')", { awaitPromise: false, timeoutMs: 3000 })
          .catch(() => "");
        latest = await this.readCookieSummary();
        const nowSec = Date.now() / 1000;
        const skeyFresh = Boolean(latest.skey) && (latest.skeyExpires <= 0 || latest.skeyExpires > nowSec + 60);
        if (ready === "complete" && latest.vid && skeyFresh) {
          return { renewed: true, ...latest };
        }
      }
      return { renewed: Boolean(latest.vid && latest.skey), ...latest };
    } catch {
      return { renewed: false };
    }
  }

  async checkLogin({ probeApi = false, autoRenew = true } = {}) {
    if (!this.cdp || this.cdp.closed) {
      return { browserRunning: false, loggedIn: false, vid: "", userName: "", expired: false };
    }

    let c = await this.readCookieSummary();
    let didRenew = false;
    const nowSec = Date.now() / 1000;
    const skeyMissingOrExpiring = !c.skey || (c.skeyExpires > 0 && c.skeyExpires - nowSec < 300);

    // If long-lived wr_rt is present while short-lived wr_skey expired/missing, silently renew via page reload!
    if (autoRenew && c.vid && c.rt && skeyMissingOrExpiring) {
      await this.trySilentRenewSession();
      didRenew = true;
      c = await this.readCookieSummary();
    }

    let { vid, skey, rt, userName } = c;
    if (!vid || !skey) {
      return { browserRunning: true, loggedIn: false, vid, userName, expired: Boolean(vid) };
    }

    if (probeApi) {
      const runUserProbe = async (targetVid) =>
        await this.cdp.evaluate(
          `(async () => {
            try {
              const res = await fetch('/web/user?userVid=' + encodeURIComponent(${JSON.stringify(targetVid)}), {
                credentials: 'include'
              });
              const data = await res.json().catch(() => null);
              return { status: res.status, data };
            } catch (e) {
              return { status: 0, error: String(e) };
            }
          })()`,
          { awaitPromise: true, timeoutMs: 12000 }
        );

      try {
        let probe = await runUserProbe(vid);
        const isExpiredErr = (p) =>
          p?.data?.errCode === -2012 || p?.data?.errCode === -2010 || p?.status === 401;

        if (isExpiredErr(probe) && autoRenew && rt && !didRenew) {
          const renewed = await this.trySilentRenewSession();
          didRenew = true;
          if (renewed.renewed && renewed.vid) {
            vid = renewed.vid;
            if (renewed.userName) userName = renewed.userName;
            probe = await runUserProbe(vid);
          }
        }

        if (isExpiredErr(probe)) {
          return {
            browserRunning: true,
            loggedIn: false,
            vid,
            userName,
            expired: true,
            errCode: probe?.data?.errCode,
            errMsg: probe?.data?.errMsg || "登录已过期，请重新扫码",
          };
        }
        if (probe?.data?.name) {
          userName = String(probe.data.name);
        }
      } catch {}
    }

    return {
      browserRunning: true,
      loggedIn: true,
      renewed: didRenew,
      vid,
      userName,
      expired: false,
    };
  }

  /**
   * Call GET https://weread.qq.com/web/mp/articles?bookId=...&offset=...
   * Automatically renews wr_skey via wr_rt once if -2012/-2010/401 occurs mid-session.
   */
  async fetchArticlesPage(bookId, offset = 0, { allowRenew = true } = {}) {
    if (!this.cdp || this.cdp.closed) {
      throw new Error("微信读书浏览器连接已断开，请重新点击「登录微信读书」");
    }
    const endpoint = `/web/mp/articles?bookId=${encodeURIComponent(bookId)}&offset=${encodeURIComponent(String(offset))}`;
    const result = await this.cdp.evaluate(
      `(async () => {
        try {
          const res = await fetch(${JSON.stringify(endpoint)}, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*' }
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return { ok: res.ok, status: res.status, json, textHead: text.slice(0, 300) };
        } catch (err) {
          return { ok: false, status: 0, error: String(err && err.message || err) };
        }
      })()`,
      { awaitPromise: true, timeoutMs: 25000 }
    );

    if (!result) {
      return { ok: false, status: 0, errCode: -1, errMsg: "接口返回为空" };
    }
    if (result.error) {
      const isClosed = /Failed to fetch/i.test(result.error);
      return {
        ok: false,
        status: result.status || 0,
        errCode: -1,
        errMsg: isClosed
          ? "连接被微信读书服务器断开（net::ERR_CONNECTION_CLOSED），通常为短时频控冷却，请等待 5~15 分钟后再继续（已归档篇目会自动跳过）"
          : result.error,
      };
    }
    const data = result.json;
    if (!data) {
      return {
        ok: false,
        status: result.status,
        errCode: -1,
        errMsg: `HTTP ${result.status} 返回非 JSON 内容`,
      };
    }
    if (data.errCode) {
      const code = Number(data.errCode);
      if (allowRenew && (code === -2012 || code === -2010)) {
        const renewed = await this.trySilentRenewSession();
        if (renewed.renewed) {
          const retry = await this.fetchArticlesPage(bookId, offset, { allowRenew: false });
          return { ...retry, sessionRenewed: true };
        }
      }
      return {
        ok: false,
        status: result.status,
        errCode: data.errCode,
        errMsg: formatWeReadErrMsg(data.errCode, data.errMsg),
        raw: data,
      };
    }
    if (!result.ok) {
      if (allowRenew && result.status === 401) {
        const renewed = await this.trySilentRenewSession();
        if (renewed.renewed) {
          const retry = await this.fetchArticlesPage(bookId, offset, { allowRenew: false });
          return { ...retry, sessionRenewed: true };
        }
      }
      return {
        ok: false,
        status: result.status,
        errCode: result.status,
        errMsg: `微信读书接口返回 HTTP ${result.status}`,
      };
    }
    return { ok: true, status: result.status, data };
  }

  /**
   * Call GET https://weread.qq.com/web/mp/content?reviewId=...
   * Automatically renews wr_skey via wr_rt once if -2012/-2010/401 occurs during a long batch.
   */
  async fetchContentHtml(reviewId, { allowRenew = true } = {}) {
    if (!this.cdp || this.cdp.closed) {
      throw new Error("微信读书浏览器连接已断开");
    }
    const endpoint = `/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`;
    const result = await this.cdp.evaluate(
      `(async () => {
        try {
          const res = await fetch(${JSON.stringify(endpoint)}, {
            method: 'GET',
            credentials: 'include'
          });
          const contentType = res.headers.get('content-type') || '';
          const text = await res.text();
          return { ok: res.ok, status: res.status, contentType, text };
        } catch (err) {
          return { ok: false, status: 0, error: String(err && err.message || err) };
        }
      })()`,
      { awaitPromise: true, timeoutMs: 30000 }
    );

    if (!result || result.error) {
      return { ok: false, status: 0, errCode: -1, errMsg: result?.error || "拉取正文失败" };
    }

    const trimmed = String(result.text || "").trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && parsed.errCode) {
          const code = Number(parsed.errCode);
          if (allowRenew && (code === -2012 || code === -2010)) {
            const renewed = await this.trySilentRenewSession();
            if (renewed.renewed) {
              const retry = await this.fetchContentHtml(reviewId, { allowRenew: false });
              return { ...retry, sessionRenewed: true };
            }
          }
          return {
            ok: false,
            status: result.status,
            errCode: parsed.errCode,
            errMsg: formatWeReadErrMsg(parsed.errCode, parsed.errMsg),
          };
        }
      } catch {}
    }

    if (!result.ok) {
      if (allowRenew && result.status === 401) {
        const renewed = await this.trySilentRenewSession();
        if (renewed.renewed) {
          const retry = await this.fetchContentHtml(reviewId, { allowRenew: false });
          return { ...retry, sessionRenewed: true };
        }
      }
      return {
        ok: false,
        status: result.status,
        errCode: result.status,
        errMsg: result.status === 429 ? "触发微信读书频控限速 (HTTP 429)，请稍后再试" : `正文接口返回 HTTP ${result.status}`,
      };
    }

    if (!trimmed || trimmed.length < 20) {
      return { ok: false, status: result.status, errCode: -2, errMsg: "微信读书返回的正文为空" };
    }

    return { ok: true, status: result.status, html: result.text };
  }

  /**
   * Open a temporary tab in the running browser to read window.biz from a short article URL.
   * Never bypasses verification pages: if window.biz is empty, closes tab cleanly and reports.
   */
  async resolveBizInTempTab(articleUrl, { timeoutMs = 14000 } = {}) {
    if (!this.version?.webSocketDebuggerUrl) {
      return { ok: false, reason: "no_browser", message: "浏览器未运行" };
    }
    const browserCdp = new CdpClient();
    await browserCdp.connect(this.version.webSocketDebuggerUrl, 8000);
    let targetId = "";
    let tabCdp = null;
    try {
      const created = await browserCdp.send("Target.createTarget", { url: articleUrl }, 8000);
      targetId = created?.targetId || "";
      if (!targetId) {
        return { ok: false, reason: "create_tab_failed", message: "无法打开临时标签页" };
      }

      let targetInfo = null;
      const findDeadline = Date.now() + 5000;
      while (Date.now() < findDeadline) {
        const list = (await fetchCdpJson("/json/list", { timeoutMs: 1500, port: this.port })) || [];
        targetInfo = list.find((t) => t.id === targetId);
        if (targetInfo?.webSocketDebuggerUrl) break;
        await abortableSleep(250);
      }
      if (!targetInfo?.webSocketDebuggerUrl) {
        return { ok: false, reason: "tab_attach_failed", message: "未能附着到临时标签页" };
      }

      tabCdp = new CdpClient();
      await tabCdp.connect(targetInfo.webSocketDebuggerUrl, 8000);

      const loadDeadline = Date.now() + timeoutMs;
      let extracted = null;
      while (Date.now() < loadDeadline) {
        await abortableSleep(450);
        extracted = await tabCdp
          .evaluate(
            `(() => {
              const titleText = document.title || '';
              const biz = (typeof window.biz === 'string' && window.biz)
                || (document.documentElement.innerHTML.match(/var\\s+biz\\s*=\\s*["']([^"']+)["']/)?.[1] || '');
              const account = document.querySelector('#js_name')?.textContent?.trim() || '';
              const title = document.querySelector('#activity-name')?.textContent?.trim() || titleText;
              const isVerify = /环境异常|完成验证后即可继续访问|微信公众平台/.test(document.body?.innerText || '') && !biz;
              return { ready: document.readyState, biz, account, title, isVerify };
            })()`,
            { awaitPromise: false, timeoutMs: 5000 }
          )
          .catch(() => null);
        if (extracted && (extracted.biz || (extracted.ready === "complete" && extracted.isVerify))) {
          break;
        }
      }

      if (extracted?.biz) {
        const converted = bizToWeReadBookId(extracted.biz);
        return {
          ok: Boolean(converted.bookId),
          ...converted,
          accountName: extracted.account || "",
          title: extracted.title || "",
        };
      }
      return {
        ok: false,
        reason: extracted?.isVerify ? "verification_required" : "biz_not_found",
        message: extracted?.isVerify
          ? "该短链页面触发微信验证，无法自动提取 __biz，请改贴含 __biz= 的合集/历史链接或直接输入 MP_WXS_..."
          : "未能在文章页面提取到 window.biz",
      };
    } finally {
      if (tabCdp) tabCdp.close();
      if (targetId) {
        await browserCdp.send("Target.closeTarget", { targetId }, 4000).catch(() => {});
      }
      browserCdp.close();
    }
  }

  /**
   * Automatically click WeRead's top-right "登录" button so the WeChat QR dialog appears immediately,
   * and extract the exact native QR PNG (img.wr_login_modal_qr_img.src) for crisp in-workbench display.
   */
  async openQrDialogAndCapture({ forceRefresh = false } = {}) {
    if (!this.cdp || this.cdp.closed) return { ok: false, reason: "not_connected" };

    // If tab is stuck on a sub-route (e.g. /web/shelf after session expiry), navigate back to root homepage
    // so WeRead's login link (.wr_index_page_top_section_header_action_link) is present.
    const curPath = await this.cdp
      .evaluate("String(location.pathname || '/')", { awaitPromise: false, timeoutMs: 4000 })
      .catch(() => "/");
    if (curPath !== "/") {
      await this.cdp.send("Page.navigate", { url: `${WEREAD_ORIGIN}/` }, 15000).catch(() => {});
      await abortableSleep(600);
    }

    // Ensure page finished initial hydration
    const readyDeadline = Date.now() + 8000;
    while (Date.now() < readyDeadline) {
      const state = await this.cdp
        .evaluate("({ ready: document.readyState, len: (document.body?.innerText || '').length })", {
          awaitPromise: false,
        })
        .catch(() => null);
      if (state && state.ready === "complete" && state.len > 20) break;
      await abortableSleep(300);
    }

    // If forceRefresh is requested, close any existing QR modal so WeRead generates a brand-new QR token
    if (forceRefresh) {
      await this.cdp
        .evaluate(
          `(() => {
            const closeBtn = document.querySelector('.wr_login_modal_close');
            if (closeBtn) { closeBtn.click(); return 'closed'; }
            return 'none';
          })()`,
          { awaitPromise: false, timeoutMs: 4000 }
        )
        .catch(() => {});
      await abortableSleep(450);
    }

    // Click WeRead login link if QR image is not already displayed
    await this.cdp
      .evaluate(
        `(() => {
          const existingImg = document.querySelector('img.wr_login_modal_qr_img');
          if (existingImg && existingImg.src && existingImg.src.startsWith('data:image/') && existingImg.naturalWidth > 60) {
            return 'already_open';
          }
          const el =
            document.querySelector('.wr_index_page_top_section_header_action_link') ||
            document.querySelector('.navBar_link_Login') ||
            [...document.querySelectorAll('a,button,span,div')].find((node) => {
              const t = (node.textContent || '').trim();
              const r = node.getBoundingClientRect();
              return (t === '登录' || t === '微信登录' || t === '扫码登录') && r.width > 10 && r.height > 10 && node.children.length <= 2;
            });
          if (el) {
            el.click();
            return 'clicked';
          }
          return 'not_found';
        })()`,
        { awaitPromise: false, timeoutMs: 6000 }
      )
      .catch(() => "error");

    // Wait up to 6s for img.wr_login_modal_qr_img to render its base64 PNG src
    let qrData = null;
    const qrDeadline = Date.now() + 6000;
    while (Date.now() < qrDeadline) {
      await abortableSleep(350);
      qrData = await this.cdp
        .evaluate(
          `(() => {
            const img = document.querySelector('img.wr_login_modal_qr_img');
            const wrapper = document.querySelector('.wr_login_modal_wrapper');
            const statusText = (wrapper?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
            if (img && img.src && img.complete && img.naturalWidth >= 80) {
              const r = img.getBoundingClientRect();
              return {
                directSrc: img.src,
                statusText,
                rect: { x: r.left, y: r.top, width: r.width, height: r.height }
              };
            }
            if (wrapper) {
              const r = wrapper.getBoundingClientRect();
              if (r.width >= 180 && r.height >= 180) {
                return {
                  directSrc: '',
                  statusText,
                  rect: { x: r.left, y: r.top, width: r.width, height: r.height }
                };
              }
            }
            return null;
          })()`,
          { awaitPromise: false, timeoutMs: 4000 }
        )
        .catch(() => null);
      if (qrData && qrData.directSrc && qrData.directSrc.startsWith("data:image/")) {
        return {
          ok: true,
          dataUrl: qrData.directSrc,
          statusText: qrData.statusText || "",
          direct: true,
        };
      }
    }

    // Fallback: screenshot clipped strictly around the login dialog
    try {
      const shotParams = { format: "png" };
      if (qrData?.rect && qrData.rect.width >= 120 && qrData.rect.height >= 120) {
        shotParams.clip = {
          x: Math.max(0, Math.round(qrData.rect.x - 10)),
          y: Math.max(0, Math.round(qrData.rect.y - 10)),
          width: Math.round(qrData.rect.width + 20),
          height: Math.round(qrData.rect.height + 20),
          scale: 1,
        };
      }
      const shot = await this.cdp.send("Page.captureScreenshot", shotParams, 10000);
      if (shot?.data) {
        return {
          ok: true,
          dataUrl: `data:image/png;base64,${shot.data}`,
          statusText: qrData?.statusText || "",
          direct: false,
        };
      }
    } catch {}
    return { ok: false, reason: "qr_not_found" };
  }

  close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
  }
}

export function formatWeReadErrMsg(errCode, rawMsg = "") {
  const code = Number(errCode);
  if (code === -2012 || code === -2010) {
    return `微信读书登录已过期 (${code}${rawMsg ? `: ${rawMsg}` : ""})，请点击「登录微信读书」重新微信扫码`;
  }
  if (code === -2013 || code === 429 || /limit|freq|频繁|限速/i.test(String(rawMsg))) {
    return `触发微信读书接口限速 (${code}${rawMsg ? `: ${rawMsg}` : ""})，已安全停止，已保存的文章不会丢失，请稍后放慢间隔继续`;
  }
  return `微信读书接口返回错误 (${errCode}${rawMsg ? `: ${rawMsg}` : ""})`;
}

/**
 * Parse one WeRead /web/mp/articles response page into normalized article metadata entries
 */
export function parseWeReadArticlesResponse(data, { bookId = "", accountHint = "" } = {}) {
  const reviews = Array.isArray(data?.reviews) ? data.reviews : [];
  const items = [];
  const seen = new Set();

  const pushSubReview = (subReview, groupCreateTime = 0) => {
    if (!subReview || typeof subReview !== "object") return;
    const reviewId = String(subReview.reviewId || subReview.review?.reviewId || "").trim();
    const mpInfo = subReview.review?.mpInfo || subReview.mpInfo || null;
    if (!reviewId || !mpInfo) return;
    if (seen.has(reviewId)) return;
    seen.add(reviewId);

    const ts = Number(mpInfo.time || mpInfo.createTime || groupCreateTime || 0);
    const { date, publishedAt } = formatShanghaiDateTime(ts);
    const originalId = String(mpInfo.originalId || "").trim();
    const sourceUrl = originalId
      ? /^https?:\/\//i.test(originalId)
        ? originalId
        : `https://mp.weixin.qq.com/s/${originalId}`
      : "";

    items.push({
      reviewId,
      bookId,
      title: String(mpInfo.title || "").trim() || "未命名文章",
      account: String(mpInfo.mp_name || mpInfo.mpName || accountHint || "").trim() || "未知公众号",
      originalId,
      url: sourceUrl,
      timestamp: ts,
      date,
      publishedAt,
      summary: String(mpInfo.content || mpInfo.digest || "").trim(),
      readNum: Number(mpInfo.readNum ?? 0) || 0,
      likeNum: Number(mpInfo.likeNum ?? 0) || 0,
      isOriginal: mpInfo.copyrightStat === 11 || Boolean(mpInfo.isOriginal),
      source: `weread:${bookId}`,
    });
  };

  for (const group of reviews) {
    const groupTime = Number(group?.createTime || group?.review?.createTime || 0);
    if (Array.isArray(group?.subReviews) && group.subReviews.length > 0) {
      for (const sr of group.subReviews) {
        pushSubReview(sr, groupTime);
      }
    } else if (group?.review?.mpInfo) {
      pushSubReview(group, groupTime);
    }
  }

  return {
    rawGroupCount: reviews.length,
    items,
  };
}

/**
 * Non-intrusive live status check (never launches browser by itself)
 */
export async function getWeReadStatus({ probeApi = false, port = WEREAD_CDP_PORT } = {}) {
  const { executablePath, browserName } = findChromiumExecutable();
  const profileExists = fsSync.existsSync(WEREAD_PROFILE_DIR);
  const boot = await ensureCdpBrowserRunning({ autoLaunch: false, port });
  if (!boot.running) {
    return {
      browserAvailable: Boolean(executablePath),
      browserName,
      browserRunning: false,
      loggedIn: false,
      profileExists,
      profileDir: WEREAD_PROFILE_DIR,
      cdpPort: port,
      vid: "",
      userName: "",
      expired: false,
    };
  }

  const session = new WeReadSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: false, bringToFront: false });
    if (!conn.connected) {
      return {
        browserAvailable: Boolean(executablePath),
        browserName,
        browserRunning: true,
        loggedIn: false,
        profileExists,
        profileDir: WEREAD_PROFILE_DIR,
        cdpPort: port,
        vid: "",
        userName: "",
        expired: false,
      };
    }
    const login = await session.checkLogin({ probeApi, autoRenew: true });
    return {
      browserAvailable: Boolean(executablePath),
      browserName,
      profileExists: true,
      profileDir: WEREAD_PROFILE_DIR,
      cdpPort: port,
      ...login,
    };
  } catch (err) {
    return {
      browserAvailable: Boolean(executablePath),
      browserName,
      browserRunning: true,
      loggedIn: false,
      profileExists,
      profileDir: WEREAD_PROFILE_DIR,
      cdpPort: port,
      vid: "",
      userName: "",
      expired: false,
      error: String(err?.message || err),
    };
  } finally {
    session.close();
  }
}

/**
 * Open or focus the visible Edge/Chrome window at https://weread.qq.com/ for user QR login,
 * auto-trigger the WeRead login dialog, and capture a live QR image for inline fallback display.
 */
export async function openWeReadLoginWindow({ port = WEREAD_CDP_PORT, includeQr = true } = {}) {
  const session = new WeReadSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: true, bringToFront: true });
    const login = await session.checkLogin({ probeApi: true, autoRenew: true });
    const { browserName } = findChromiumExecutable();

    let qrImageDataUrl = "";
    if (!login.loggedIn && includeQr) {
      const qr = await session.openQrDialogAndCapture().catch(() => null);
      if (qr?.ok && qr.dataUrl) {
        qrImageDataUrl = qr.dataUrl;
      }
      if (process.platform === "win32") {
        await ensureWindowsWindowVisibleAndFront(port).catch(() => {});
      }
    }

    return {
      status: login.loggedIn ? "logged_in" : "waiting_login",
      launchedNow: conn.launchedNow,
      browserName: conn.browserName || browserName,
      profileDir: WEREAD_PROFILE_DIR,
      cdpPort: port,
      qrImageDataUrl,
      ...login,
    };
  } finally {
    session.close();
  }
}

/**
 * Refresh the live QR code screenshot from the already-open WeRead login window
 */
export async function refreshWeReadLoginQr({ port = WEREAD_CDP_PORT } = {}) {
  const session = new WeReadSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: true, bringToFront: false });
    if (!conn.connected) return { ok: false, loggedIn: false };
    const login = await session.checkLogin({ probeApi: true });
    if (login.loggedIn) {
      return { ok: true, loggedIn: true, ...login };
    }
    const qr = await session.openQrDialogAndCapture({ forceRefresh: true }).catch(() => null);
    return {
      ok: Boolean(qr?.ok),
      loggedIn: false,
      qrImageDataUrl: qr?.dataUrl || "",
      qrStatusText: qr?.statusText || "",
      ...login,
    };
  } finally {
    session.close();
  }
}

/**
 * Load known WeRead accounts (combining data/weread-accounts.json + existing archived index.json biz values)
 */
export async function loadSavedWeReadAccounts(outputDir = "") {
  const byBookId = new Map();

  // 1. Read saved weread-accounts.json
  try {
    const raw = await fs.readFile(WEREAD_ACCOUNTS_PATH, "utf8");
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      for (const a of list) {
        if (a?.bookId) byBookId.set(a.bookId, a);
      }
    }
  } catch {}

  // 2. Merge any accounts with `biz` already present in outputDir/index.json
  if (outputDir) {
    try {
      const idxRaw = await fs.readFile(path.join(path.resolve(outputDir), "index.json"), "utf8");
      const idx = JSON.parse(idxRaw);
      for (const art of idx?.articles || []) {
        if (!art.biz) continue;
        const conv = bizToWeReadBookId(art.biz);
        if (!conv.bookId) continue;
        if (!byBookId.has(conv.bookId)) {
          byBookId.set(conv.bookId, {
            bookId: conv.bookId,
            biz: conv.biz,
            numericId: conv.numericId,
            accountName: art.account || "未知公众号",
            sampleUrl: art.source_url || "",
            updatedAt: art.fetched_at || "",
          });
        } else {
          const cur = byBookId.get(conv.bookId);
          if ((!cur.accountName || cur.accountName === "未知公众号") && art.account) {
            cur.accountName = art.account;
          }
        }
      }
    } catch {}
  }

  return [...byBookId.values()];
}

export async function saveWeReadAccount(record) {
  if (!record?.bookId) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const existing = await loadSavedWeReadAccounts();
  const map = new Map(existing.map((a) => [a.bookId, a]));
  const prev = map.get(record.bookId) || {};
  map.set(record.bookId, {
    bookId: record.bookId,
    biz: record.biz || prev.biz || "",
    numericId: record.numericId || prev.numericId || "",
    accountName:
      record.accountName && record.accountName !== "未知公众号"
        ? record.accountName
        : prev.accountName || record.accountName || "未知公众号",
    sampleUrl: record.sampleUrl || prev.sampleUrl || "",
    updatedAt: new Date().toISOString(),
  });
  await fs.writeFile(WEREAD_ACCOUNTS_PATH, JSON.stringify([...map.values()], null, 2) + "\n", "utf8");
}
