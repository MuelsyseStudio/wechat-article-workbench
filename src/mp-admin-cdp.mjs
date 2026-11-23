/**
 * Zero-dependency Chromium / Microsoft Edge CDP Adapter for WeChat MP Admin Account Search (mp.weixin.qq.com)
 *
 * Uses the user's own visibly logged-in WeChat Official Account backend session (persistent profile
 * under data/mp-admin-profile/ on CDP port 9224) to search target official accounts by nickname via
 * `/cgi-bin/searchbiz?action=search_biz&...` and convert `fakeid` (__biz) into `MP_WXS_<digits>`
 * for Channel 1 (WeRead full-history archive & multi-account auto-subscriptions).
 *
 * Note: WeChat officially restricted/closed cross-account `/cgi-bin/appmsg` & `/cgi-bin/appmsgpublish`
 * `list_ex` endpoints in July 2026; this module focuses strictly on the working `searchbiz` lookup.
 * Strictly compliant: user scans QR themselves; never bypasses auth, CAPTCHAs, or rate limits.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CdpClient,
  DATA_DIR,
  abortableSleep,
  bizToWeReadBookId,
  ensureWindowsWindowVisibleAndFront,
  fetchCdpJson,
  findChromiumExecutable,
  launchVisibleBrowserProcess,
} from "./weread-cdp.mjs";

export const MP_ADMIN_ORIGIN = "https://mp.weixin.qq.com";
export const MP_ADMIN_PROFILE_DIR = path.join(DATA_DIR, "mp-admin-profile");
export const MP_ADMIN_CDP_PORT = Number(process.env.MP_ADMIN_CDP_PORT || 9224);

export function formatMpAdminError(ret, errMsg = "") {
  const code = Number(ret);
  if (code === 200013) {
    return "触发公众号后台接口频控 (200013: freq control)，已按合规策略立即停止。请等待 15~30 分钟并调大等待间隔后再继续";
  }
  if (code === 200003 || code === 200040) {
    return `公众号后台登录已过期或 token 失效 (${code}${errMsg ? `: ${errMsg}` : ""})，请重新点击「登录公众号后台」扫码`;
  }
  if (code === 200002) {
    return `公众号后台参数无效 (${code}${errMsg ? `: ${errMsg}` : ""})，请确认公众号 __biz / fakeid 或名称是否正确`;
  }
  return `公众号后台接口返回错误 (${ret}${errMsg ? `: ${errMsg}` : ""})`;
}

export async function ensureMpAdminBrowserRunning({
  autoLaunch = true,
  ensureVisible = false,
  port = MP_ADMIN_CDP_PORT,
} = {}) {
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

  await fs.mkdir(MP_ADMIN_PROFILE_DIR, { recursive: true });

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${MP_ADMIN_PROFILE_DIR}`,
    "--disable-extensions",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "--window-position=160,100",
    "--window-size=1180,820",
    `${MP_ADMIN_ORIGIN}/`,
  ];

  await launchVisibleBrowserProcess(executablePath, launchArgs);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await abortableSleep(300);
    const ver = await fetchCdpJson("/json/version", { timeoutMs: 900, port });
    if (ver && ver.webSocketDebuggerUrl) {
      if (ensureVisible && process.platform === "win32") {
        await abortableSleep(500);
        await ensureWindowsWindowVisibleAndFront(port).catch(() => {});
      }
      return { running: true, launchedNow: true, browserName, version: ver };
    }
  }

  throw new Error(
    `已尝试启动 ${browserName} 打开公众号后台，但 15 秒内未能连上调试端口 127.0.0.1:${port}。`
  );
}

export class MpAdminSession {
  constructor({ port = MP_ADMIN_CDP_PORT } = {}) {
    this.port = port;
    this.version = null;
    this.cdp = null;
    this.token = "";
    this.accountName = "";
  }

  async connect({ autoLaunch = true, bringToFront = false } = {}) {
    const boot = await ensureMpAdminBrowserRunning({
      autoLaunch,
      ensureVisible: bringToFront,
      port: this.port,
    });
    if (!boot.running || !boot.version) {
      return { connected: false, launchedNow: false };
    }
    this.version = boot.version;

    let targets = (await fetchCdpJson("/json/list", { timeoutMs: 2500, port: this.port })) || [];
    let page = targets.find(
      (t) => t.type === "page" && typeof t.url === "string" && t.url.startsWith(MP_ADMIN_ORIGIN)
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
      const browserCdp = new CdpClient();
      await browserCdp.connect(this.version.webSocketDebuggerUrl, 8000);
      try {
        const created = await browserCdp.send("Target.createTarget", { url: `${MP_ADMIN_ORIGIN}/` }, 8000);
        await abortableSleep(500);
        targets = (await fetchCdpJson("/json/list", { timeoutMs: 2500, port: this.port })) || [];
        page = targets.find((t) => t.id === created?.targetId) || targets.find((t) => t.type === "page");
      } finally {
        browserCdp.close();
      }
    }

    if (!page || !page.webSocketDebuggerUrl) {
      throw new Error("未能定位公众号后台浏览器标签页，请重新点击「登录公众号后台」");
    }

    this.cdp = new CdpClient();
    await this.cdp.connect(page.webSocketDebuggerUrl, 10000);
    await this.cdp.send("Page.enable", {}, 8000).catch(() => {});

    const currentHref = await this.cdp
      .evaluate("String(location.href || '')", { awaitPromise: false, timeoutMs: 5000 })
      .catch(() => "");
    if (!currentHref.startsWith(MP_ADMIN_ORIGIN)) {
      await this.cdp.send("Page.navigate", { url: `${MP_ADMIN_ORIGIN}/` }, 15000);
      const navDeadline = Date.now() + 15000;
      while (Date.now() < navDeadline) {
        await abortableSleep(350);
        const st = await this.cdp
          .evaluate("({ href: location.href, ready: document.readyState })", { awaitPromise: false })
          .catch(() => null);
        if (st && String(st.href || "").startsWith(MP_ADMIN_ORIGIN) && st.ready !== "loading") break;
      }
    }

    if (bringToFront) {
      await this.cdp.send("Page.bringToFront", {}, 5000).catch(() => {});
    }
    return { connected: true, launchedNow: boot.launchedNow, browserName: boot.browserName || "" };
  }

  async checkLogin({ probeApi = false } = {}) {
    if (!this.cdp || this.cdp.closed) {
      return { browserRunning: false, loggedIn: false, token: "", accountName: "", expired: false };
    }

    const cookieRes = await this.cdp
      .send("Network.getCookies", { urls: [MP_ADMIN_ORIGIN] }, 8000)
      .catch(() => ({ cookies: [] }));
    const cookies = Array.isArray(cookieRes?.cookies) ? cookieRes.cookies : [];
    const byName = new Map(cookies.map((c) => [c.name, c.value]));
    const hasSessionCookie = Boolean(byName.get("slave_sid") && byName.get("slave_user"));

    const readPageState = async () =>
      await this.cdp
        .evaluate(
          `(() => {
            const href = String(location.href || '');
            const m = href.match(/[?&]token=(\\d+)/);
            const wxToken = (typeof window.wx === 'object' && window.wx?.data?.t) ? String(window.wx.data.t) : '';
            const nick =
              document.querySelector('.weui-desktop-account__nickname')?.textContent?.trim() ||
              document.querySelector('.account_name')?.textContent?.trim() ||
              (typeof window.wx === 'object' && window.wx?.cgiData?.nick_name) ||
              '';
            const scanTip =
              document.querySelector('.login__type__container__scan__info, .login_err_panel, .qrcode_login_status')?.textContent?.replace(/\\s+/g, ' ')?.trim() || '';
            return { href, token: m ? m[1] : wxToken, nick: String(nick || '').trim(), scanTip };
          })()`,
          { awaitPromise: false, timeoutMs: 5000 }
        )
        .catch(() => ({ href: "", token: "", nick: "", scanTip: "" }));

    let st = await readPageState();

    // If cookies exist on disk (reopened browser) and page hasn't redirected to /cgi-bin/home yet, reload root once
    if (!st.token && hasSessionCookie && probeApi) {
      await this.cdp.send("Page.navigate", { url: `${MP_ADMIN_ORIGIN}/` }, 15000).catch(() => {});
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await abortableSleep(400);
        st = await readPageState();
        if (st.token) break;
      }
    }

    if (!st.token || !hasSessionCookie) {
      this.token = "";
      return {
        browserRunning: true,
        loggedIn: false,
        token: "",
        accountName: "",
        expired: Boolean(st.token && !hasSessionCookie),
        scanTip: st.scanTip || "",
      };
    }

    // Optional lightweight liveness check on /cgi-bin/home (does NOT spend searchbiz quota)
    if (probeApi) {
      try {
        const probe = await this.cdp.evaluate(
          `(async () => {
            try {
              const res = await fetch('/cgi-bin/home?t=home/index&lang=zh_CN&token=' + encodeURIComponent(${JSON.stringify(
                st.token
              )}), { credentials: 'include' });
              const txt = await res.text();
              const isLogin = /scanloginqrcode|login_frame|重新登录|登录超时/.test(txt) && !/weui-desktop-account__nickname|nick_name/.test(txt);
              return { ok: res.ok, status: res.status, isLogin };
            } catch (e) {
              return { ok: false, status: 0, error: String(e) };
            }
          })()`,
          { awaitPromise: true, timeoutMs: 12000 }
        );
        if (probe?.isLogin || probe?.status === 401) {
          this.token = "";
          return {
            browserRunning: true,
            loggedIn: false,
            token: "",
            accountName: st.nick || "",
            expired: true,
            errMsg: "公众号后台登录已失效，请重新微信扫码",
          };
        }
      } catch {}
    }

    this.token = st.token;
    this.accountName = st.nick || "";
    return {
      browserRunning: true,
      loggedIn: true,
      token: this.token,
      accountName: this.accountName,
      expired: false,
    };
  }

  /**
   * Capture a crisp PNG of the MP Admin QR login box (https://mp.weixin.qq.com/) for inline workbench modal display.
   */
  async captureLoginQr({ forceRefresh = false } = {}) {
    if (!this.cdp || this.cdp.closed) return { ok: false, reason: "not_connected" };

    const href = await this.cdp
      .evaluate("String(location.href || '')", { awaitPromise: false, timeoutMs: 4000 })
      .catch(() => "");
    if (forceRefresh || !href.startsWith(MP_ADMIN_ORIGIN) || /[?&]token=\d+/.test(href)) {
      await this.cdp.send("Page.navigate", { url: `${MP_ADMIN_ORIGIN}/` }, 15000).catch(() => {});
      await abortableSleep(800);
    }

    // Wait up to 8s for login QR image to appear on https://mp.weixin.qq.com/
    let qrInfo = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await abortableSleep(400);
      qrInfo = await this.cdp
        .evaluate(
          `(() => {
            if (/[?&]token=\\d+/.test(location.href)) return { alreadyLoggedIn: true };
            // Click "使用账号登录" -> switch to QR if somehow on password tab
            const switchToScan = document.querySelector('.login__type__container__account .login__type__container__switch, [class*="switch_scan" i]');
            if (switchToScan && switchToScan.offsetParent !== null) {
              switchToScan.click();
            }
            const img =
              document.querySelector('img.login__type__container__scan__qrcode') ||
              document.querySelector('img[src*="scanloginqrcode"]') ||
              document.querySelector('img[src*="loginqrcode"]') ||
              [...document.querySelectorAll('img')].find((im) => {
                const r = im.getBoundingClientRect();
                return r.width >= 110 && r.height >= 110 && r.width <= 320 && Math.abs(r.width - r.height) < 25 && im.complete && im.naturalWidth > 60 && im.closest('[class*="login" i], [class*="scan" i], [class*="qr" i]');
              });
            if (!img || !img.complete || img.naturalWidth < 60) return null;
            const r = img.getBoundingClientRect();
            if (r.width < 80 || r.height < 80) return null;
            // Include a small margin around the QR code (or scan wrapper)
            const tip = document.querySelector('.login__type__container__scan__info, .login__type__container__scan__title')?.textContent?.replace(/\\s+/g, ' ')?.trim() || '';
            return {
              alreadyLoggedIn: false,
              rect: { x: Math.max(0, r.left - 10), y: Math.max(0, r.top - 10), width: r.width + 20, height: r.height + 20 },
              tip
            };
          })()`,
          { awaitPromise: false, timeoutMs: 4000 }
        )
        .catch(() => null);
      if (qrInfo?.alreadyLoggedIn) {
        return { ok: true, alreadyLoggedIn: true };
      }
      if (qrInfo?.rect) break;
    }

    if (!qrInfo?.rect) {
      return { ok: false, reason: "qr_not_found" };
    }

    try {
      const shot = await this.cdp.send(
        "Page.captureScreenshot",
        {
          format: "png",
          clip: {
            x: Math.round(qrInfo.rect.x),
            y: Math.round(qrInfo.rect.y),
            width: Math.round(qrInfo.rect.width),
            height: Math.round(qrInfo.rect.height),
            scale: 1,
          },
        },
        10000
      );
      if (shot?.data) {
        return {
          ok: true,
          dataUrl: `data:image/png;base64,${shot.data}`,
          tip: qrInfo.tip || "",
        };
      }
    } catch {}
    return { ok: false, reason: "screenshot_failed" };
  }

  /**
   * Search official accounts by nickname via /cgi-bin/searchbiz
   */
  async searchAccountByName(query, { count = 5 } = {}) {
    if (!this.cdp || this.cdp.closed || !this.token) {
      throw new Error("公众号后台未登录或连接已断开");
    }
    const endpoint = `/cgi-bin/searchbiz?action=search_biz&begin=0&count=${encodeURIComponent(
      String(count)
    )}&query=${encodeURIComponent(query)}&token=${encodeURIComponent(this.token)}&lang=zh_CN&f=json&ajax=1`;

    const res = await this.cdp.evaluate(
      `(async () => {
        try {
          const r = await fetch(${JSON.stringify(endpoint)}, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest' }
          });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch {}
          return { ok: r.ok, status: r.status, json };
        } catch (e) {
          return { ok: false, status: 0, error: String(e && e.message || e) };
        }
      })()`,
      { awaitPromise: true, timeoutMs: 20000 }
    );

    if (!res || res.error || !res.json) {
      return { ok: false, ret: -1, errMsg: res?.error || `HTTP ${res?.status || 0} 搜索公众号失败` };
    }
    const ret = Number(res.json?.base_resp?.ret ?? -1);
    if (ret !== 0) {
      return {
        ok: false,
        ret,
        rateLimited: ret === 200013,
        sessionExpired: ret === 200003 || ret === 200040,
        errMsg: formatMpAdminError(ret, res.json?.base_resp?.err_msg),
      };
    }
    const list = (res.json.list || []).map((item) => {
      const fakeid = String(item.fakeid || "").trim();
      const conv = bizToWeReadBookId(fakeid);
      return {
        fakeid,
        biz: fakeid,
        bookId: conv.bookId || "",
        numericId: conv.numericId || "",
        nickname: String(item.nickname || "").trim(),
        alias: String(item.alias || "").trim(),
        serviceType: item.service_type,
        roundHeadImg: item.round_head_img || "",
      };
    });
    return { ok: true, ret: 0, total: Number(res.json.total || list.length), accounts: list };
  }

  close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
  }
}

/**
 * High-level helper: search WeChat Official Accounts by nickname via `/cgi-bin/searchbiz`
 * and return normalized `MP_WXS_<digits>` (`bookId`) + `__biz` (`fakeid`) candidates.
 */
export async function searchMpAdminAccountsByName(
  query,
  { count = 8, port = MP_ADMIN_CDP_PORT, autoLaunch = true } = {}
) {
  const cleanQuery = String(query || "").trim();
  if (!cleanQuery) {
    return { ok: false, needsLogin: false, accounts: [], errMsg: "请输入要搜索的公众号名称" };
  }
  const session = new MpAdminSession({ port });
  try {
    const conn = await session.connect({ autoLaunch, bringToFront: false });
    if (!conn.connected) {
      return {
        ok: false,
        needsLogin: true,
        accounts: [],
        errMsg: "个人公众号后台尚未登录，请先点击「登录公众号后台」微信扫码",
      };
    }
    const login = await session.checkLogin({ probeApi: true });
    if (!login.loggedIn) {
      return {
        ok: false,
        needsLogin: true,
        accounts: [],
        errMsg: login.errMsg || "个人公众号后台尚未登录或会话已过期，请重新扫码登录",
      };
    }
    const res = await session.searchAccountByName(cleanQuery, { count });
    if (!res.ok) {
      return {
        ok: false,
        needsLogin: Boolean(res.sessionExpired),
        rateLimited: Boolean(res.rateLimited),
        ret: res.ret,
        accounts: [],
        errMsg: res.errMsg,
      };
    }
    return {
      ok: true,
      needsLogin: false,
      query: cleanQuery,
      total: res.total,
      accountName: login.accountName || "",
      accounts: res.accounts,
    };
  } finally {
    session.close();
  }
}

/**
 * Non-intrusive live status check for MP Admin backend (never launches browser by itself)
 */
export async function getMpAdminStatus({ probeApi = false, port = MP_ADMIN_CDP_PORT } = {}) {
  const { executablePath, browserName } = findChromiumExecutable();
  const profileExists = fsSync.existsSync(MP_ADMIN_PROFILE_DIR);
  const boot = await ensureMpAdminBrowserRunning({ autoLaunch: false, port });
  if (!boot.running) {
    return {
      browserAvailable: Boolean(executablePath),
      browserName,
      browserRunning: false,
      loggedIn: false,
      profileExists,
      profileDir: MP_ADMIN_PROFILE_DIR,
      cdpPort: port,
      token: "",
      accountName: "",
      expired: false,
    };
  }

  const session = new MpAdminSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: false, bringToFront: false });
    if (!conn.connected) {
      return {
        browserAvailable: Boolean(executablePath),
        browserName,
        browserRunning: true,
        loggedIn: false,
        profileExists,
        profileDir: MP_ADMIN_PROFILE_DIR,
        cdpPort: port,
        token: "",
        accountName: "",
        expired: false,
      };
    }
    const login = await session.checkLogin({ probeApi });
    return {
      browserAvailable: Boolean(executablePath),
      browserName,
      profileExists: true,
      profileDir: MP_ADMIN_PROFILE_DIR,
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
      profileDir: MP_ADMIN_PROFILE_DIR,
      cdpPort: port,
      token: "",
      accountName: "",
      expired: false,
      error: String(err?.message || err),
    };
  } finally {
    session.close();
  }
}

/**
 * Open or focus visible Edge at https://mp.weixin.qq.com/ for user MP Admin QR login,
 * and capture crisp QR PNG for inline workbench modal display.
 */
export async function openMpAdminLoginWindow({ port = MP_ADMIN_CDP_PORT, includeQr = true } = {}) {
  const session = new MpAdminSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: true, bringToFront: true });
    const login = await session.checkLogin({ probeApi: true });
    const { browserName } = findChromiumExecutable();

    let qrImageDataUrl = "";
    let qrTip = "";
    if (!login.loggedIn && includeQr) {
      const qr = await session.captureLoginQr({ forceRefresh: false }).catch(() => null);
      if (qr?.alreadyLoggedIn) {
        const recheck = await session.checkLogin({ probeApi: false });
        if (recheck.loggedIn) {
          return {
            status: "logged_in",
            launchedNow: conn.launchedNow,
            browserName: conn.browserName || browserName,
            profileDir: MP_ADMIN_PROFILE_DIR,
            cdpPort: port,
            qrImageDataUrl: "",
            ...recheck,
          };
        }
      }
      if (qr?.ok && qr.dataUrl) {
        qrImageDataUrl = qr.dataUrl;
        qrTip = qr.tip || "";
      }
    }

    return {
      status: login.loggedIn ? "logged_in" : "waiting_login",
      launchedNow: conn.launchedNow,
      browserName: conn.browserName || browserName,
      profileDir: MP_ADMIN_PROFILE_DIR,
      cdpPort: port,
      qrImageDataUrl,
      qrTip,
      ...login,
    };
  } finally {
    session.close();
  }
}

export async function refreshMpAdminLoginQr({ port = MP_ADMIN_CDP_PORT } = {}) {
  const session = new MpAdminSession({ port });
  try {
    const conn = await session.connect({ autoLaunch: true, bringToFront: false });
    if (!conn.connected) return { ok: false, loggedIn: false };
    const login = await session.checkLogin({ probeApi: true });
    if (login.loggedIn) {
      return { ok: true, loggedIn: true, ...login };
    }
    const qr = await session.captureLoginQr({ forceRefresh: true }).catch(() => null);
    if (qr?.alreadyLoggedIn) {
      const recheck = await session.checkLogin({ probeApi: false });
      return { ok: true, loggedIn: recheck.loggedIn, ...recheck };
    }
    return {
      ok: Boolean(qr?.ok),
      loggedIn: false,
      qrImageDataUrl: qr?.dataUrl || "",
      qrTip: qr?.tip || "",
      ...login,
    };
  } finally {
    session.close();
  }
}
