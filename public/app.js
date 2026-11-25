/**
 * Frontend controller for WeChat Article Cleaner Workstation v2.2
 * WeRead Full History Channel (Edge CDP) + MP Admin Account Search Helper (searchbiz) + Public Link Direct Fetch
 */
const $ = (id) => document.getElementById(id);

const state = {
  channel: "weread", // "weread" | "public"
  outputDir: "",
  mcpEnabled: true,
  mcpUrl: "",
  mcpConfig: null,
  localDirSuggestions: [],
  savedWeReadAccounts: [],
  wereadStatus: null,
  mpAdminStatus: null,
  qrModalMode: "weread", // "weread" | "mp_admin"
  loginPollTimer: null,
  activeJobId: null,
  activeEventSource: null,
  clipboardTimer: null,
  lastClipboardText: "",
  previewRawText: "",
  lastParsedResult: null,
  lastWeReadCatalog: null,
  lastWeReadInputKey: "",
  dailyQuota: null,
  subscriptionSummary: null,
  subscriptionsData: null,
  pushConfig: null,
  digestPreviewData: null,
  digestPreviewFormat: "wx", // "wx" | "md"
  activeTab: "log",
};

function nowTimeStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function showToast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  $("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

function appendLog(message, level = "info", codeBlock = "") {
  const consoleEl = $("logConsole");
  const line = document.createElement("div");
  line.className = `log-line log-${level}`;

  const timeSpan = document.createElement("span");
  timeSpan.className = "log-time";
  timeSpan.textContent = `[${nowTimeStr()}]`;
  line.appendChild(timeSpan);

  line.appendChild(document.createTextNode(message));

  if (codeBlock) {
    const code = document.createElement("code");
    code.className = "log-code";
    code.textContent = codeBlock;
    line.appendChild(code);
  }

  consoleEl.appendChild(line);
  requestAnimationFrame(() => {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  });
}

function updateUrlCounter() {
  const text = $("urlInput").value || "";
  const bookIds = new Set(text.match(/\bMP_WXS_\d{5,20}\b/gi) || []);
  const bizMatches = new Set(text.match(/[?&]__biz=[A-Za-z0-9%+/=_-]+/gi) || []);
  const articles = new Set(
    text.match(/https?:\/\/mp\.weixin\.qq\.com\/(?:s\/[A-Za-z0-9_-]+|s\?[^\s"'<>|,\]]+)/gi) || []
  );
  const albums = new Set(
    text.match(/https?:\/\/mp\.weixin\.qq\.com\/mp\/appmsgalbum\?[^\s"'<>|,\]]+/gi) || []
  );

  if (state.channel === "weread") {
    const idCount = bookIds.size + bizMatches.size;
    const nameLines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length > 0 &&
          s.length <= 40 &&
          !/^https?:\/\//i.test(s) &&
          !/\bMP_WXS_\d+/i.test(s) &&
          !/[?&]__biz=/i.test(s)
      );
    const namePart = nameLines.length > 0 ? `${nameLines.length} 个公众号名 · ` : "";
    $("urlCounter").textContent = `已识别 ${namePart}${idCount} 个 ID/__biz · ${articles.size} 条文章 · ${albums.size} 条合集`;
  } else {
    $("urlCounter").textContent = `已识别 ${articles.size} 条文章链接 · ${albums.size} 条合集链接`;
  }
}

function computeDateRange() {
  const mode = document.querySelector('input[name="timeMode"]:checked')?.value || "all";
  const today = new Date();
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  if (mode === "all") return { dateFrom: "", dateTo: "" };
  if (mode === "today") {
    const t = fmt(today);
    return { dateFrom: t, dateTo: t };
  }
  if (mode === "month") {
    const start = new Date(today);
    start.setMonth(start.getMonth() - 1);
    return { dateFrom: fmt(start), dateTo: fmt(today) };
  }
  if (mode === "year") {
    const start = new Date(today);
    start.setFullYear(start.getFullYear() - 1);
    return { dateFrom: fmt(start), dateTo: fmt(today) };
  }
  return {
    dateFrom: $("optDateFrom").value || "",
    dateTo: $("optDateTo").value || "",
  };
}

function collectOptions() {
  const { dateFrom, dateTo } = computeDateRange();
  return {
    outputDir: state.outputDir || undefined,
    saveMd: $("optSaveMd").checked,
    includeYaml: $("optIncludeYaml").checked,
    saveHtml: $("optSaveHtml").checked,
    saveJson: $("optSaveJson").checked,
    saveJsonl: $("optSaveJsonl").checked,
    includeDatePrefix: $("optDatePrefix").checked,
    dedup: $("optDedup").checked,
    downloadImages: $("optDownloadImages").checked,
    discoverRelated: $("optDiscoverRelated").checked,
    onlyOriginal: $("optOnlyOriginal").checked,
    delaySec: Number($("optDelaySec").value || 3),
    dailyLimit: Math.max(0, Number($("optDailyLimit")?.value ?? 1200)),
    minReads: Math.max(0, Number($("optMinReads").value || 0)),
    startPage: Math.max(1, Number($("optStartPage").value || 1)),
    minWords: Math.max(0, Number($("optMinWords").value || 0)),
    maxArticles: Math.max(1, Number($("optMaxArticles").value || 200)),
    dateFrom,
    dateTo,
  };
}

function setRunningUi(running) {
  const disableIds = ["btnPrimaryLeft", "btnParseInputs", "btnBatchDownload", "btnCleanLocalDir", "btnSyncAllSubs"];
  for (const id of disableIds) {
    const el = $(id);
    if (el) el.disabled = running;
  }
  $("btnCancelJob").classList.toggle("hidden", !running);
  $("progressWrap").classList.toggle("hidden", !running);
  if (!running) {
    state.activeJobId = null;
    if (state.activeEventSource) {
      state.activeEventSource.close();
      state.activeEventSource = null;
    }
  }
}

function formatShortTime(isoStr) {
  if (!isoStr) return "尚未检查";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr).slice(0, 16);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderDailyQuota(q) {
  const el = $("dailyQuotaBadge");
  if (!el || !q) return;
  const used = Number(q.contentFetches || 0);
  const limit = Math.max(0, Number($("optDailyLimit")?.value ?? q.defaultLimit ?? 1200));
  el.classList.remove("quota-warn", "quota-over");
  el.title = "单日微信读书正文拉取超过约 1500 篇极易触发 -2041 安全校验，建议控制在 1200~1500 篇以内";
  if (limit > 0) {
    el.textContent = `今日拉取：${used} / ${limit} 篇（建议每日 ≤ 1200~1500 防 -2041 风控）`;
    if (used >= limit) {
      el.classList.add("quota-over");
    } else if (used >= Math.floor(limit * 0.8)) {
      el.classList.add("quota-warn");
    }
  } else {
    el.textContent = `今日拉取：${used} 篇（未设上限 · 建议每日 ≤ 1500 防 -2041 风控）`;
    if (used >= 1200) el.classList.add("quota-warn");
  }
}

function renderSubscriptionSummary(sum) {
  state.subscriptionSummary = sum || null;
  if (!sum) return;
  $("subCountTab").textContent = String(sum.total || 0);
  const dot = $("subStatusDot");
  const text = $("subStatusText");
  if (sum.running) {
    dot.className = "dot dot-amber";
    text.textContent = `订阅更新检查中...`;
  } else if (sum.autoEnabled && sum.enabledCount > 0) {
    dot.className = "dot dot-pulse";
    text.textContent = `订阅 ${sum.enabledCount}/${sum.total} 号 · 每${sum.intervalMinutes}分自动`;
  } else {
    dot.className = "dot dot-off";
    text.textContent = `订阅 ${sum.total} 个号 · 手动`;
  }

  const nextInfo = $("subNextRunInfo");
  if (nextInfo) {
    if (sum.running) {
      nextInfo.textContent = "正在后台检查订阅更新...";
    } else if (sum.autoEnabled && sum.enabledCount > 0 && sum.nextRunAt) {
      nextInfo.textContent = `下次自动检查：${formatShortTime(sum.nextRunAt)}`;
    } else if (sum.enabledCount === 0) {
      nextInfo.textContent = "暂无已启用的订阅公众号";
    } else {
      nextInfo.textContent = "定时自动更新已关闭（可手动点击检查）";
    }
  }
}

function renderMcpStatus() {
  const dot = $("mcpStatusDot");
  const text = $("mcpStatusText");
  $("optEnableMcp").checked = state.mcpEnabled;
  if (state.mcpEnabled) {
    dot.className = "dot dot-pulse";
    text.textContent = "MCP 运行中";
  } else {
    dot.className = "dot dot-off";
    text.textContent = "MCP 已暂停";
  }
}

function renderMpAdminModalStatus() {
  const dot = $("mpModalStatusDot");
  const text = $("mpModalStatusText");
  if (!dot || !text) return;
  const st = state.mpAdminStatus;
  if (!st) {
    dot.className = "dot dot-off";
    text.textContent = "公众号后台：未检测";
    return;
  }
  if (st.loggedIn) {
    dot.className = "dot dot-pulse";
    const who = st.accountName ? ` (${st.accountName})` : "";
    text.textContent = `公众号后台：已登录${who} · 可直接按名称搜索换算 MP_WXS_...`;
  } else if (st.browserRunning) {
    dot.className = "dot dot-amber";
    text.textContent = st.expired ? "公众号后台：登录过期，请重新扫码" : "公众号后台：等待微信扫码确认...";
  } else {
    dot.className = "dot dot-off";
    text.textContent = st.profileExists
      ? "公众号后台：本地已有档案（搜索时将自动唤醒）"
      : "公众号后台：未登录（点击右侧按钮扫码个人订阅号即可搜名）";
  }
}

function renderAuthStatusBar() {
  const dot = $("wereadStatusDot");
  const text = $("wereadStatusText");
  const hint = $("wereadHintText");
  const wrDot = $("dotChannelWeRead");
  const st = state.wereadStatus;

  if (wrDot) {
    wrDot.className = st?.loggedIn
      ? "channel-dot dot-on"
      : st?.browserRunning
      ? "channel-dot dot-wait"
      : "channel-dot dot-idle";
  }

  renderMpAdminModalStatus();

  if (!st) {
    dot.className = "dot dot-off";
    text.textContent = "微信读书：未检测";
    return;
  }

  if (st.loggedIn) {
    dot.className = "dot dot-pulse";
    const who = st.userName ? ` (${st.userName})` : st.vid ? ` (ID:${st.vid})` : "";
    text.textContent = `微信读书：已登录${who}`;
    hint.textContent = `已连接 ${st.browserName || "Edge"} 持久化会话，可直接全量解析与下载清洗`;
    if (state.qrModalMode === "weread") stopLoginPolling();
  } else if (st.browserRunning) {
    dot.className = "dot dot-amber";
    text.textContent = st.expired ? "微信读书：登录过期" : "微信读书：等待扫码";
    hint.textContent = st.expired
      ? "登录态已过期，请在弹出的 Edge 窗口中重新微信扫码"
      : "请在弹出的 Edge 窗口中完成微信扫码，扫码后页面会自动识别登录状态";
  } else {
    dot.className = "dot dot-off";
    text.textContent = st.profileExists ? "微信读书：待唤醒(已有档案)" : "微信读书：未登录";
    hint.textContent = st.profileExists
      ? "本地已有登录档案，点击「登录微信读书」或直接「获取公众号目录」将自动唤醒独立 Edge"
      : "点击「登录微信读书」拉起独立 Edge 窗口微信扫码一次，Cookie 自动持久化";
  }
}

function renderWeReadStatus(st) {
  state.wereadStatus = st || null;
  renderAuthStatusBar();
}

function renderMpAdminStatus(st) {
  state.mpAdminStatus = st || null;
  renderMpAdminModalStatus();
}

function renderSavedAccounts() {
  const row = $("savedAccountsRow");
  const container = $("savedAccountChips");
  const list = state.savedWeReadAccounts || [];
  if (state.channel !== "weread" || list.length === 0) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  container.innerHTML = "";
  for (const acc of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    const label = acc.accountName && acc.accountName !== "未知公众号" ? `${acc.accountName} (${acc.bookId})` : acc.bookId;
    btn.textContent = `⚡ ${label}`;
    btn.title = `点击填入 ${acc.bookId} (__biz=${acc.biz || ""})`;
    btn.addEventListener("click", () => {
      $("urlInput").value = acc.bookId;
      updateUrlCounter();
      showToast(`已填入 ${label}`);
    });
    container.appendChild(btn);
  }
}

function applyChannelUi(channel) {
  const valid = channel === "public" ? "public" : "weread";
  state.channel = valid;
  localStorage.setItem("wxclean_channel", valid);
  const isWeRead = valid === "weread";

  $("btnChannelWeRead").classList.toggle("active", isWeRead);
  $("btnChannelWeRead").setAttribute("aria-selected", String(isWeRead));

  $("btnChannelPublic").classList.toggle("active", !isWeRead);
  $("btnChannelPublic").setAttribute("aria-selected", String(!isWeRead));

  $("wereadChannelMeta").classList.toggle("hidden", !isWeRead);
  $("pillDiscoverRelated").classList.toggle("hidden", isWeRead);

  if (isWeRead) {
    $("inputSectionLabel").textContent = "公众号名 / ID / 链接（自动换算 MP_WXS_...）";
    $("urlInput").placeholder =
      "提示：输入公众号名称（或点右上角「搜公众号名」）、粘贴任意单篇文章/合集链接、或直接输入 MP_WXS_1234567890";
    $("inputFooterTip").textContent = "支持公众号名/单篇链接自动换算 · 断点续传去重";
    $("btnPrimaryLeft").className = "btn btn-weread";
    $("btnPrimaryLeftLabel").textContent = "登录微信读书";
    $("btnPrimaryLeftIcon").innerHTML =
      '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>';
    $("btnParseInputsLabel").textContent = "1.获取公众号目录";
  } else {
    $("inputSectionLabel").textContent = "微信文章链接 / 合集 / 清单";
    $("urlInput").placeholder =
      "提示：可用换行输入多篇公开文章链接（mp.weixin.qq.com/s/...）、公开合集链接（appmsgalbum），或直接将 TXT / CSV / JSON 链接清单拖拽到此框内";
    $("inputFooterTip").textContent = "支持拖拽导入文件 · 自动去重";
    $("btnPrimaryLeft").className = "btn btn-secondary";
    $("btnPrimaryLeftLabel").textContent = "文章下载";
    $("btnPrimaryLeftIcon").innerHTML =
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>';
    $("btnParseInputsLabel").textContent = "1.解析合集/清单";
  }

  renderAuthStatusBar();
  renderDailyQuota(state.dailyQuota);
  renderSavedAccounts();
  updateUrlCounter();
}

function stopLoginPolling() {
  if (state.loginPollTimer) {
    clearInterval(state.loginPollTimer);
    state.loginPollTimer = null;
  }
}

function startLoginPolling(mode = "weread") {
  stopLoginPolling();
  state.qrModalMode = mode;
  let ticks = 0;
  state.loginPollTimer = setInterval(async () => {
    ticks++;
    if (ticks > 72) {
      stopLoginPolling();
      return;
    }
    try {
      if (mode === "mp_admin") {
        const res = await fetch("/api/mp-admin/status?probe=1");
        const st = await res.json();
        renderMpAdminStatus(st);
        if (st.loggedIn) {
          stopLoginPolling();
          $("wereadLoginModal").classList.add("hidden");
          const who = st.accountName ? `（${st.accountName}）` : "";
          appendLog(
            `✓ 个人公众号后台扫码登录成功${who}！现在可在「搜公众号名」中直接按名称换算 MP_WXS_...。`,
            "ok"
          );
          showToast("公众号后台扫码成功，可以直接搜号了！");
        } else if (st.scanTip) {
          $("wereadModalStatusText").textContent = st.scanTip;
        }
      } else {
        const res = await fetch("/api/weread/status?probe=1");
        const st = await res.json();
        renderWeReadStatus(st);
        if (st.loggedIn) {
          stopLoginPolling();
          $("wereadLoginModal").classList.add("hidden");
          appendLog(
            `✓ 微信读书扫码登录成功！当前账号：${st.userName || `vid:${st.vid}`}，现在可以点击「1.获取公众号目录」或「2.批量下载清洗」。`,
            "ok"
          );
          showToast("微信读书扫码登录成功！");
        }
      }
    } catch {}
  }, 2500);
}

function showQrModal(mode = "weread", dataUrl = "") {
  state.qrModalMode = mode;
  const isMp = mode === "mp_admin";
  $("wereadLoginModalTitle").textContent = isMp ? "微信扫码登录个人公众号后台" : "微信扫码登录微信读书";
  $("wereadQrHint").textContent = isMp
    ? "请用手机微信「扫一扫」扫描下方微信公众平台（mp.weixin.qq.com）官方二维码；扫码后在手机上选择你的个人公众号/订阅号并点击确认，工作台将在 3 秒内自动获取 token 并持久化会话。"
    : "请直接用手机微信「扫一扫」扫描下方微信读书官方登录二维码；在手机上点击确认后，工作台将在 3 秒内自动完成登录并持久化保存 Cookie。";
  $("wereadLoginModal").classList.remove("hidden");
  if (dataUrl) {
    $("wereadQrImg").src = dataUrl;
    $("wereadQrImg").classList.remove("hidden");
    $("wereadQrLoading").classList.add("hidden");
    $("wereadModalStatusText").textContent = isMp
      ? "请用手机微信扫描上方二维码，并在手机上选择你的个人公众号确认登录"
      : "请用手机微信扫描上方二维码（或直接在弹出的 Edge 窗口扫码）";
  } else {
    $("wereadQrImg").classList.add("hidden");
    $("wereadQrLoading").classList.remove("hidden");
    $("wereadQrLoading").textContent = isMp
      ? "正在打开微信公众平台（mp.weixin.qq.com）并截取实时二维码，请稍候..."
      : "正在打开微信读书并加载二维码，请稍候...";
    $("wereadModalStatusText").textContent = "正在连接本地 Edge 窗口...";
  }
}

async function handleRefreshQrImage() {
  const mode = state.qrModalMode || "weread";
  const isMp = mode === "mp_admin";
  $("wereadQrImg").classList.add("hidden");
  $("wereadQrLoading").classList.remove("hidden");
  $("wereadQrLoading").textContent = isMp
    ? "正在刷新公众号后台实时二维码..."
    : "正在刷新微信读书实时二维码...";
  try {
    const res = await fetch(isMp ? "/api/mp-admin/qr" : "/api/weread/qr");
    const data = await res.json();
    if (data.loggedIn) {
      if (isMp) renderMpAdminStatus(data);
      else renderWeReadStatus(data);
      $("wereadLoginModal").classList.add("hidden");
      appendLog(
        isMp
          ? `✓ 个人公众号后台已登录${data.accountName ? `（${data.accountName}）` : ""}`
          : `✓ 微信读书已登录（${data.userName || `vid:${data.vid}`}）`,
        "ok"
      );
      showToast(isMp ? "公众号后台已登录！" : "微信读书已登录！");
      return;
    }
    if (data.qrImageDataUrl) {
      showQrModal(mode, data.qrImageDataUrl);
      showToast("二维码已刷新");
    } else {
      $("wereadQrLoading").textContent = "未能截取二维码，请直接在任务栏切换到 Edge 窗口扫码";
    }
  } catch (err) {
    $("wereadQrLoading").textContent = `刷新失败：${err.message}`;
  }
}

async function handleWeReadLogin() {
  switchTab("log");
  appendLog("正在拉起独立可见的 Edge 窗口打开 https://weread.qq.com/ 并加载微信扫码登录...", "info");
  showQrModal("weread", "");
  try {
    const res = await fetch("/api/weread/login", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      $("wereadLoginModal").classList.add("hidden");
      appendLog(`启动微信读书登录窗口失败：${data.error || "未知错误"}`, "err");
      showToast(data.error || "启动失败");
      return;
    }
    renderWeReadStatus(data);
    if (data.loggedIn) {
      $("wereadLoginModal").classList.add("hidden");
      appendLog(`✓ 检测到微信读书已处于有效登录态（${data.userName || `vid:${data.vid}`}），Cookie 目录：${data.profileDir}`, "ok");
      showToast("微信读书已登录");
    } else {
      if (data.qrImageDataUrl) {
        showQrModal("weread", data.qrImageDataUrl);
      } else {
        $("wereadQrLoading").textContent = "请在已弹出的 Edge 窗口中点击右上角「登录」并微信扫码（或点下方「刷新二维码」）";
      }
      appendLog(
        `已在 ${data.browserName || "Edge"} 中打开微信读书网页版并同步截取实时二维码，请直接扫码登录（扫码后 3 秒内自动感知并关闭弹窗）。`,
        "warn"
      );
      showToast("请用手机微信扫描二维码登录");
      startLoginPolling("weread");
    }
  } catch (err) {
    $("wereadLoginModal").classList.add("hidden");
    appendLog(`连接本地微信读书登录接口失败：${err.message}`, "err");
  }
}

async function handleMpAdminLogin() {
  switchTab("log");
  appendLog("正在拉起独立可见的 Edge 窗口打开 https://mp.weixin.qq.com/ 并加载公众号后台微信扫码...", "info");
  showQrModal("mp_admin", "");
  try {
    const res = await fetch("/api/mp-admin/login", { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      $("wereadLoginModal").classList.add("hidden");
      appendLog(`启动公众号后台登录窗口失败：${data.error || "未知错误"}`, "err");
      showToast(data.error || "启动失败");
      return;
    }
    renderMpAdminStatus(data);
    if (data.loggedIn) {
      $("wereadLoginModal").classList.add("hidden");
      appendLog(
        `✓ 检测到个人公众号后台已处于有效登录态${data.accountName ? `（${data.accountName}）` : ""}，档案目录：${data.profileDir}`,
        "ok"
      );
      showToast("公众号后台已登录");
    } else {
      if (data.qrImageDataUrl) {
        showQrModal("mp_admin", data.qrImageDataUrl);
      } else {
        $("wereadQrLoading").textContent = "请在已弹出的 Edge 窗口中扫描公众平台二维码（或点下方「刷新二维码」）";
      }
      appendLog(
        `已在 ${data.browserName || "Edge"} 中打开微信公众平台并截取实时二维码，请微信扫码并在手机上选择你的个人公众号确认登录。`,
        "warn"
      );
      showToast("请用手机微信扫描公众号后台二维码");
      startLoginPolling("mp_admin");
    }
  } catch (err) {
    $("wereadLoginModal").classList.add("hidden");
    appendLog(`连接本地公众号后台登录接口失败：${err.message}`, "err");
  }
}

async function handleRefreshWeReadStatus(silent = false) {
  try {
    const res = await fetch("/api/weread/status?probe=1");
    const st = await res.json();
    renderWeReadStatus(st);
    if (!silent) {
      if (st.loggedIn) {
        appendLog(`1号微信读书登录态有效：${st.userName || `vid:${st.vid}`}`, "ok");
        showToast("微信读书登录态有效");
      } else if (st.browserRunning) {
        appendLog("微信读书窗口已打开但尚未完成扫码登录，请扫码后稍候。", "warn");
        showToast("等待扫码登录");
      } else {
        appendLog("独立微信读书浏览器未启动，请点击「登录微信读书」。", "info");
        showToast("微信读书窗口未启动");
      }
    }
  } catch (err) {
    if (!silent) appendLog(`查询微信读书登录态失败：${err.message}`, "err");
  }
}

async function handleRefreshMpAdminStatus(silent = false) {
  try {
    const res = await fetch("/api/mp-admin/status?probe=1");
    const st = await res.json();
    renderMpAdminStatus(st);
    if (!silent) {
      if (st.loggedIn) {
        appendLog(`2号个人公众号后台登录态有效${st.accountName ? `（${st.accountName}）` : ""}`, "ok");
        showToast("公众号后台登录态有效");
      } else if (st.browserRunning) {
        appendLog("公众号后台窗口已打开但尚未完成扫码确认，请扫码并在手机选择个人公众号。", "warn");
        showToast("等待公众号后台扫码");
      } else {
        appendLog("独立公众号后台浏览器未启动，请点击「登录公众号后台」。", "info");
        showToast("公众号后台窗口未启动");
      }
    }
  } catch (err) {
    if (!silent) appendLog(`查询公众号后台登录态失败：${err.message}`, "err");
  }
}

async function refreshState(printBootLog = false) {
  try {
    const res = await fetch("/api/state");
    const data = await res.json();
    state.outputDir = data.outputDir;
    state.mcpEnabled = data.mcpEnabled;
    state.mcpUrl = data.mcpUrl;
    state.mcpConfig = data.mcpConfig;
    state.localDirSuggestions = data.localDirSuggestions || [];
    state.savedWeReadAccounts = data.savedWeReadAccounts || [];

    $("outputDirLabel").textContent = `归档目录：${data.outputDir}`;
    $("archivedCountTop").textContent = String(data.archivedCount || 0);
    $("archivedCountTab").textContent = String(data.archivedCount || 0);
    renderMcpStatus();
    state.wereadStatus = data.wereadStatus || null;
    state.mpAdminStatus = data.mpAdminStatus || null;
    renderAuthStatusBar();
    renderSavedAccounts();
    renderSubscriptionSummary(data.subscriptionSummary);
    if (data.pushSummary && $("pushCountTab")) {
      $("pushCountTab").textContent = String(data.pushSummary.enabledChannels || 0);
    }
    state.dailyQuota = data.dailyQuota || null;
    renderDailyQuota(data.dailyQuota);

    // Update Account filter dropdown
    const sel = $("filterAccount");
    const currentVal = sel.value;
    sel.innerHTML = `<option value="">全部公众号 (${(data.accounts || []).length})</option>`;
    for (const acc of data.accounts || []) {
      const opt = document.createElement("option");
      opt.value = acc;
      opt.textContent = acc;
      sel.appendChild(opt);
    }
    if (currentVal) sel.value = currentVal;

    // Render quick local dir chips
    const chips = $("localDirSuggestions");
    chips.innerHTML = "";
    for (const dir of state.localDirSuggestions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip";
      btn.textContent = dir.split(/[\\/]/).slice(-2).join("/");
      btn.title = dir;
      btn.addEventListener("click", () => {
        $("cleanDirPathInput").value = dir;
      });
      chips.appendChild(btn);
    }
    if (!$("cleanDirPathInput").value && state.localDirSuggestions.length > 0) {
      $("cleanDirPathInput").value = state.localDirSuggestions[state.localDirSuggestions.length - 1];
    }

    if (printBootLog) {
      appendLog("工作台已升级至 v2.4（微信读书全量 + 搜号换算 + wxclean CLI + 群聊机器人定时日报）：支持企业微信、飞书、钉钉、WxPusher（推个人微信）、自定义 Webhook 及个人微信群一键复制日报！", "ok");
      appendLog("使用方式：① 切到「公众号订阅」批量添加要追更的博主；② 切到「群聊推送与日报」添加企微/飞书/钉钉/WxPusher 机器人并开启每日定时日报或新文实时推送。", "info");
      if (state.mcpEnabled && state.mcpConfig) {
        appendLog(
          `MCP 服务已启动在 ${state.mcpUrl}（共 16 个工具，含按名称搜号、多号订阅与群聊机器人定时日报），Streamable HTTP 配置示例：`,
          "ok",
          JSON.stringify(state.mcpConfig.streamableHttp, null, 2)
        );
      }
    }
  } catch (err) {
    appendLog(`连接本地后端失败：${err.message}`, "err");
  }
}

function watchJob(jobId) {
  state.activeJobId = jobId;
  setRunningUi(true);
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "准备中...";

  const es = new EventSource(`/api/jobs/${jobId}/events`);
  state.activeEventSource = es;

  es.addEventListener("log", (e) => {
    const payload = JSON.parse(e.data);
    appendLog(payload.data?.message || "", payload.data?.level || "info");
  });

  es.addEventListener("progress", (e) => {
    const payload = JSON.parse(e.data);
    const d = payload.data || {};
    if (
      d.phase === "album" ||
      d.phase === "discover" ||
      d.phase === "weread_resolve" ||
      d.phase === "weread_list" ||
      d.phase === "mp_admin" ||
      d.phase === "sub" ||
      d.phase === "sub_new"
    ) {
      appendLog(
        d.message,
        d.phase === "discover" || d.phase === "weread_resolve" || d.phase === "sub_new" ? "ok" : "info"
      );
      return;
    }
    if (d.phase === "weread_warn") {
      appendLog(d.message, "warn");
      return;
    }
    if (d.total > 0) {
      const pct = Math.round((d.index / d.total) * 100);
      $("progressFill").style.width = `${pct}%`;
      $("progressText").textContent = `${d.index}/${d.total}`;
    }
    const label = d.title || d.url || "";
    const readTag = typeof d.readNum === "number" && d.readNum > 0 ? ` [阅读 ${d.readNum} / 赞 ${d.likeNum ?? 0}]` : "";
    if (d.status === "saved" || d.status === "updated") {
      appendLog(
        `[${d.index}/${d.total}] ✓ ${d.status === "saved" ? "新增归档" : "已更新"}：${d.date ? d.date + " " : ""}${label}${readTag}`,
        "ok"
      );
    } else if (d.status === "skipped") {
      const isEmptySkip = String(d.reason || "").startsWith("known_empty");
      appendLog(
        `[${d.index}/${d.total}] ↷ ${isEmptySkip ? "已知空文跳过" : "去重跳过"}：${label} (${d.reason || "duplicate"})`,
        "skip"
      );
    } else if (d.status === "filtered_out") {
      appendLog(`[${d.index}/${d.total}] ○ 条件过滤：${label} (${d.reason || "filter"})`, "skip");
    } else if (d.status === "blocked") {
      appendLog(`[${d.index}/${d.total}] ⛔ 触发限速/登录保护：${d.message || d.reason}`, "warn");
    } else {
      appendLog(`[${d.index}/${d.total}] ✕ 失败：${label} (${d.message || d.reason || "error"})`, "err");
    }
  });

  es.addEventListener("done", async (e) => {
    const payload = JSON.parse(e.data);
    const s = payload.data || {};

    // Case 1: WeRead Catalog Inspect finished
    if (s.kind === "weread_inspect") {
      state.lastParsedResult = s;
      state.lastWeReadCatalog = s;
      state.lastWeReadInputKey = $("urlInput").value.trim();

      const hasItems = Array.isArray(s.articles) && s.articles.length > 0;
      $("btnSyncParsedWeRead").classList.toggle("hidden", !hasItems);
      $("btnFillParsedUrls").classList.add("hidden");
      $("btnExportParsedCsv").classList.toggle("hidden", !hasItems);

      if (hasItems) {
        $("btnSyncParsedWeRead").textContent = `直接下载本次目录 (新 ${s.newCount ?? s.articleCount} 篇)`;
      }

      if (s.needsLogin) {
        appendLog(`⚠️ ${s.stopReason}`, "warn");
        showToast("请先扫码登录微信读书");
      } else {
        const emptySuffix = s.emptyCount > 0 ? ` · 已知空文跳过 ${s.emptyCount} 篇` : "";
        appendLog(
          `微信读书目录解析完成！共命中 ${s.articleCount || 0} 篇（新增待下载 ${s.newCount || 0} 篇 · 已归档 ${s.archivedCount || 0} 篇${emptySuffix}）。`,
          s.stoppedEarly ? "warn" : "ok"
        );
        if (Array.isArray(s.accounts) && s.accounts.length > 0) {
          appendLog(
            "已识别公众号信息：",
            "info",
            s.accounts.map((a) => `${a.accountName || "未知"} | bookId: ${a.bookId} | __biz: ${a.biz || "—"} | 命中 ${a.articleCount ?? 0} 篇`).join("\n")
          );
        }
        if (hasItems) {
          const preview = s.articles
            .slice(0, 10)
            .map(
              (a) =>
                `${a.date ? `[${a.date}] ` : ""}${a.title} | 阅读 ${a.readNum ?? 0} / 赞 ${a.likeNum ?? 0}${a.alreadyArchived ? " [已归档]" : ""}`
            )
            .join("\n") +
            (s.articles.length > 10
              ? `\n... 其余 ${s.articles.length - 10} 篇（点击「直接下载本次目录」或「2.批量下载清洗」将复用此目录直接拉取正文，无需重复翻页）`
              : "");
          appendLog("历史文章目录预览：", "info", preview);
        }
        if (s.stoppedEarly && s.stopReason) {
          appendLog(`提前停止原因：${s.stopReason}`, "warn");
        }
        showToast(`目录解析完成：共 ${s.articleCount || 0} 篇（新 ${s.newCount || 0} 篇）`);
      }

      setRunningUi(false);
      await refreshState(false);
      return;
    }

    // Case 2: Public Link Inspect finished
    if (s.kind === "inspect") {
      state.lastParsedResult = s;
      const hasUrls = Array.isArray(s.urls) && s.urls.length > 0;
      $("btnSyncParsedWeRead").classList.add("hidden");
      $("btnFillParsedUrls").textContent = "填入解析链接";
      $("btnFillParsedUrls").classList.toggle("hidden", !hasUrls);
      $("btnExportParsedCsv").classList.toggle("hidden", !hasUrls);

      appendLog(
        `解析完成！共提取 ${s.articleCount || 0} 条文章链接（公开合集 ${s.albumCount || 0} 个，文内往期推荐 ${s.relatedLinkCount || 0} 条）。`,
        s.stoppedEarly ? "warn" : "ok"
      );
      if (Array.isArray(s.albums) && s.albums.length > 0) {
        appendLog(
          "已探测并展开的公开合集：",
          "info",
          s.albums.map((a) => `#${a.title}（${a.count} 篇）| ${a.albumUrl}`).join("\n")
        );
      }
      if (Array.isArray(s.relatedLinks) && s.relatedLinks.length > 0) {
        appendLog(
          "已探测的文内「往期推荐/关联文章」链接：",
          "info",
          s.relatedLinks
            .slice(0, 15)
            .map((r) => `${r.title ? `《${r.title}》 ` : ""}${r.url}`)
            .join("\n") + (s.relatedLinks.length > 15 ? `\n... 共 ${s.relatedLinks.length} 条` : "")
        );
      }
      if (hasUrls) {
        const preview = (s.articles || [])
          .slice(0, 8)
          .map((a) => `${a.date ? `[${a.date}] ` : ""}${a.title ? `${a.title} | ` : ""}${a.url}`)
          .join("\n") + (s.urls.length > 8 ? `\n... 其余 ${s.urls.length - 8} 条（可点上方「填入解析链接」或「导出解析清单CSV」）` : "");
        appendLog("解析结果预览：", "info", preview);
      }
      if (s.stoppedEarly && s.stopReason) {
        appendLog(`提前停止原因：${s.stopReason}`, "warn");
      }
      setRunningUi(false);
      showToast(`解析完成：共 ${s.articleCount || 0} 条链接`);
      return;
    }

    // Case 2.5: Subscription sync finished
    if (s.kind === "subscription_sync") {
      appendLog(
        `订阅更新检查完成！共检查 ${s.accountsChecked || 0} 个公众号｜新下载清洗 ${s.totalNewArticles || 0} 篇｜失败 ${s.errors || 0}`,
        s.stoppedEarly || s.errors > 0 ? "warn" : "ok"
      );
      if (Array.isArray(s.newArticles) && s.newArticles.length > 0) {
        appendLog(
          "本次新增入库文章：",
          "ok",
          s.newArticles.map((a) => `[${a.date || ""}] ${a.account} | ${a.title}`).join("\n")
        );
      }
      if (s.stoppedEarly && s.stopReason) {
        appendLog(`提前停止原因：${s.stopReason}`, "warn");
      }
      setRunningUi(false);
      await refreshState(false);
      if (state.activeTab === "subs") await loadSubscriptionsTable();
      if (state.activeTab === "archive") await loadArchiveTable();
      showToast(
        s.totalNewArticles > 0
          ? `订阅同步完成：新增 ${s.totalNewArticles} 篇`
          : s.stoppedEarly
          ? "订阅检查已提前停止，请看日志"
          : "所有订阅公众号均已是最新"
      );
      return;
    }

    // Case 3: Batch download / WeRead sync / Clean local dir finished
    const total = typeof s.totalInputs === "number" ? s.totalInputs : s.scanned ?? 0;
    appendLog(
      `任务完成！共处理 ${total} 项｜新增 ${s.saved || 0}｜更新 ${s.updated || 0}｜去重跳过 ${s.skipped || 0}｜条件过滤 ${s.filteredOut || 0}｜失败 ${s.errors || 0}`,
      s.errors > 0 || s.stoppedEarly ? "warn" : "ok"
    );
    if (s.stoppedEarly && s.stopReason) {
      appendLog(`提前停止原因：${s.stopReason}`, "warn");
    }
    if (s.indexFile) {
      appendLog(`索引已同步更新：${s.indexFile}`, "info");
    }
    if (s.jsonlFile) {
      appendLog(`JSONL 已同步导出：${s.jsonlFile}`, "ok");
    }
    setRunningUi(false);
    await refreshState(false);
    if (!$("panelArchive").classList.contains("hidden")) {
      await loadArchiveTable();
    }
    showToast(`完成：新增 ${s.saved || 0} 篇，跳过 ${s.skipped || 0} 篇`);
  });

  es.addEventListener("error_event", (e) => {
    const payload = JSON.parse(e.data);
    appendLog(`任务执行出错：${payload.data?.message || "未知错误"}`, "err");
    setRunningUi(false);
  });

  es.onerror = () => {
    if (state.activeJobId === jobId) {
      setRunningUi(false);
    }
  };
}

async function startPublicFetchJob(endpoint) {
  const rawText = $("urlInput").value.trim();
  if (!rawText) {
    showToast("请先输入或导入微信公开文章/合集链接");
    $("urlInput").focus();
    return;
  }
  switchTab("log");
  const opts = collectOptions();
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(data.error || "启动任务失败", "err");
      showToast(data.error || "启动失败");
      return;
    }
    watchJob(data.jobId);
  } catch (err) {
    appendLog(`请求失败：${err.message}`, "err");
  }
}

async function startWeReadInspectJob() {
  const rawText = $("urlInput").value.trim();
  if (!rawText) {
    showToast("请先粘贴文章/合集链接、输入 MP_WXS_...，或点击下方快捷公众号标签");
    $("urlInput").focus();
    return;
  }
  switchTab("log");
  const opts = collectOptions();
  try {
    const res = await fetch("/api/run/weread-inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(data.error || "启动目录解析失败", "err");
      showToast(data.error || "启动失败");
      return;
    }
    watchJob(data.jobId);
  } catch (err) {
    appendLog(`请求失败：${err.message}`, "err");
  }
}

async function startWeReadSyncJob({ usePrefetched = false } = {}) {
  const rawText = $("urlInput").value.trim();
  const canReuseCatalog =
    (usePrefetched || (state.lastWeReadCatalog && state.lastWeReadInputKey === rawText)) &&
    Array.isArray(state.lastWeReadCatalog?.articles) &&
    state.lastWeReadCatalog.articles.length > 0;

  if (!rawText && !canReuseCatalog) {
    showToast("请先输入公众号链接 / MP_WXS_...，或点击下方快捷公众号标签");
    $("urlInput").focus();
    return;
  }

  switchTab("log");
  const opts = collectOptions();
  const payload = { rawText, ...opts };
  if (canReuseCatalog) {
    payload.prefetchedItems = state.lastWeReadCatalog.articles;
  }

  try {
    const res = await fetch("/api/run/weread-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(data.error || "启动微信读书同步失败", "err");
      showToast(data.error || "启动失败");
      return;
    }
    watchJob(data.jobId);
  } catch (err) {
    appendLog(`请求失败：${err.message}`, "err");
  }
}

function openMpSearchModal() {
  $("mpSearchModal").classList.remove("hidden");
  renderMpAdminModalStatus();
  handleRefreshMpAdminStatus(true);
  setTimeout(() => $("mpSearchQueryInput")?.focus(), 40);
}

function renderMpSearchResults(accounts = [], emptyMsg = "") {
  const container = $("mpSearchResults");
  if (!container) return;
  if (!accounts || accounts.length === 0) {
    container.innerHTML = "";
    const div = document.createElement("div");
    div.className = "mp-empty-hint";
    div.textContent = emptyMsg || "未找到匹配的公众号，请换个关键词重试。";
    container.appendChild(div);
    return;
  }
  container.innerHTML = "";
  for (const acc of accounts) {
    const row = document.createElement("div");
    row.className = "mp-result-item";

    const meta = document.createElement("div");
    meta.className = "mp-result-meta";

    const nameRow = document.createElement("div");
    nameRow.className = "mp-result-name-row";
    const nameEl = document.createElement("span");
    nameEl.className = "mp-result-name";
    nameEl.textContent = acc.nickname || "未知公众号";
    nameRow.appendChild(nameEl);
    if (acc.alias) {
      const aliasEl = document.createElement("span");
      aliasEl.className = "mp-result-alias";
      aliasEl.textContent = `微信号：${acc.alias}`;
      nameRow.appendChild(aliasEl);
    }

    const idsEl = document.createElement("div");
    idsEl.className = "mp-result-ids";
    idsEl.textContent = `${acc.bookId || "无 bookId"}  ·  __biz=${acc.biz || acc.fakeid || "—"}`;

    meta.append(nameRow, idsEl);

    const ops = document.createElement("div");
    ops.className = "mp-result-ops";

    const btnFill = document.createElement("button");
    btnFill.type = "button";
    btnFill.className = "mini-btn mini-btn-primary";
    btnFill.textContent = "填入采集框";
    btnFill.addEventListener("click", async () => {
      if (!acc.bookId) return showToast("该结果缺少有效的 MP_WXS ID");
      await fetch("/api/mp-admin/save-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: acc.bookId,
          biz: acc.biz || acc.fakeid,
          numericId: acc.numericId || "",
          accountName: acc.nickname || "",
        }),
      }).catch(() => {});
      if (state.channel !== "weread") applyChannelUi("weread");
      $("urlInput").value = acc.bookId;
      updateUrlCounter();
      $("mpSearchModal").classList.add("hidden");
      appendLog(`已按名称换算并填入公众号：「${acc.nickname}」-> ${acc.bookId} (__biz=${acc.biz})`, "ok");
      showToast(`已填入 ${acc.nickname} (${acc.bookId})`);
      await refreshState(false);
    });

    const btnSub = document.createElement("button");
    btnSub.type = "button";
    btnSub.className = "mini-btn mini-btn-accent";
    btnSub.textContent = "+ 订阅";
    btnSub.addEventListener("click", async () => {
      if (!acc.bookId) return showToast("该结果缺少有效的 MP_WXS ID");
      await fetch("/api/mp-admin/save-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookId: acc.bookId,
          biz: acc.biz || acc.fakeid,
          numericId: acc.numericId || "",
          accountName: acc.nickname || "",
        }),
      }).catch(() => {});
      const ok = await handleSubmitAddSubscriptions(acc.bookId, { category: "默认订阅" });
      if (ok) {
        $("mpSearchModal").classList.add("hidden");
        switchTab("subs");
      }
    });

    ops.append(btnFill, btnSub);
    row.append(meta, ops);
    container.appendChild(row);
  }
}

async function handleMpSearchSubmit() {
  const query = ($("mpSearchQueryInput")?.value || "").trim();
  if (!query) {
    showToast("请输入要搜索的公众号名称");
    $("mpSearchQueryInput")?.focus();
    return;
  }
  const btn = $("btnMpSearchGo");
  btn.disabled = true;
  btn.textContent = "搜索中...";
  renderMpSearchResults([], `正在通过公众号后台搜索「${query}」...`);
  try {
    const res = await fetch("/api/mp-admin/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: 8 }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.errMsg || data.error || "搜索失败";
      renderMpSearchResults([], msg);
      if (data.needsLogin) {
        showToast("请先点击「登录公众号后台」微信扫码");
      } else {
        showToast(msg);
      }
      await handleRefreshMpAdminStatus(true);
      return;
    }
    await handleRefreshMpAdminStatus(true);
    renderMpSearchResults(data.accounts || [], `未找到名为「${query}」的公众号`);
    if ((data.accounts || []).length > 0) {
      showToast(`搜到 ${data.accounts.length} 个匹配公众号`);
    }
  } catch (err) {
    renderMpSearchResults([], `搜索请求失败：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "搜索";
  }
}

async function handleParseInputs() {
  if (state.channel === "weread") {
    return startWeReadInspectJob();
  }
  const rawText = $("urlInput").value.trim();
  if (!rawText) {
    showToast("请先粘贴文章链接、合集链接，或导入清单文件");
    return;
  }
  switchTab("log");
  const opts = collectOptions();
  try {
    const res = await fetch("/api/run/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText, ...opts }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(`启动解析失败：${data.error || "未知错误"}`, "err");
      return;
    }
    watchJob(data.jobId);
  } catch (err) {
    appendLog(`解析异常：${err.message}`, "err");
  }
}

async function loadArchiveTable() {
  const account = $("filterAccount").value;
  const keyword = $("filterKeyword").value.trim();
  const params = new URLSearchParams({ account, keyword, limit: "300" });
  const tbody = $("archiveTableBody");
  try {
    const res = await fetch(`/api/articles?${params.toString()}`);
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">暂无匹配的已归档文章</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    for (const a of items) {
      const tr = document.createElement("tr");

      const tdDate = document.createElement("td");
      tdDate.textContent = a.date || "—";

      const tdAcc = document.createElement("td");
      tdAcc.textContent = a.account || "未知";

      const tdTitle = document.createElement("td");
      const titleBtn = document.createElement("button");
      titleBtn.type = "button";
      titleBtn.className = "article-title-btn";
      titleBtn.textContent = a.title || "未命名";
      titleBtn.addEventListener("click", () => openArticlePreview(a));
      tdTitle.appendChild(titleBtn);
      if (a.original) {
        const badge = document.createElement("span");
        badge.className = "tag-orig";
        badge.textContent = "原创";
        tdTitle.appendChild(badge);
      }

      const tdWords = document.createElement("td");
      tdWords.style.textAlign = "right";
      tdWords.textContent = String(a.word_count ?? 0);

      const tdStats = document.createElement("td");
      tdStats.style.textAlign = "right";
      tdStats.className = "stats-cell";
      if (typeof a.read_num === "number" || typeof a.like_num === "number") {
        const rn = typeof a.read_num === "number" ? a.read_num.toLocaleString() : "-";
        const ln = typeof a.like_num === "number" ? a.like_num.toLocaleString() : "-";
        tdStats.textContent = `${rn} / ${ln}`;
      } else {
        tdStats.textContent = "—";
      }

      const tdOps = document.createElement("td");
      tdOps.style.textAlign = "right";
      const ops = document.createElement("div");
      ops.className = "row-ops";

      const btnPreview = document.createElement("button");
      btnPreview.type = "button";
      btnPreview.className = "link-btn";
      btnPreview.textContent = "预览MD";
      btnPreview.addEventListener("click", () => openArticlePreview(a));
      ops.appendChild(btnPreview);

      if (a.source_url) {
        const link = document.createElement("a");
        link.className = "link-btn";
        link.href = a.source_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "原文";
        ops.appendChild(link);
      }
      tdOps.appendChild(ops);

      tr.append(tdDate, tdAcc, tdTitle, tdWords, tdStats, tdOps);
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">加载失败：${err.message}</td></tr>`;
  }
}

async function openArticlePreview(article) {
  try {
    const params = new URLSearchParams({ path: article.relative_path });
    const res = await fetch(`/api/article-content?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "读取失败");
      return;
    }
    state.previewRawText = data.content || "";
    $("previewTitle").textContent = article.title || "文章预览";
    const statText =
      typeof article.read_num === "number"
        ? ` · 阅读 ${article.read_num} / 赞 ${article.like_num ?? 0}`
        : "";
    $("previewMeta").textContent = `${article.account} · ${article.published_at || article.date} · ${article.word_count} 字${statText} · ${article.relative_path}`;
    $("previewContent").textContent = state.previewRawText;
    $("previewDrawer").classList.remove("hidden");
  } catch (err) {
    showToast(`预览失败：${err.message}`);
  }
}

function renderStatusBadge(status, lastRunAdded) {
  const span = document.createElement("span");
  if (status === "updated") {
    span.className = "sub-status-pill sub-st-ok";
    span.textContent = `新增 ${lastRunAdded || 0} 篇`;
  } else if (status === "up_to_date") {
    span.className = "sub-status-pill sub-st-ok";
    span.textContent = "已是最新";
  } else if (status === "needs_login") {
    span.className = "sub-status-pill sub-st-warn";
    span.textContent = "需扫码登录";
  } else if (status === "rate_limited") {
    span.className = "sub-status-pill sub-st-warn";
    span.textContent = "频控冷却中";
  } else {
    span.className = "sub-status-pill sub-st-idle";
    span.textContent = "待首次检查";
  }
  return span;
}

async function loadSubscriptionsTable() {
  const tbody = $("subsTableBody");
  try {
    const res = await fetch("/api/subscriptions");
    const data = await res.json();
    state.subscriptionsData = data;

    const sch = data.scheduler || {};
    $("optSubAutoEnabled").checked = Boolean(sch.enabled);
    if ([15, 30, 60, 120, 360, 720, 1440].includes(Number(sch.intervalMinutes))) {
      $("optSubInterval").value = String(sch.intervalMinutes);
    }

    const accounts = data.accounts || [];
    renderSubscriptionSummary({
      total: accounts.length,
      enabledCount: accounts.filter((a) => a.enabled).length,
      autoEnabled: Boolean(sch.enabled),
      intervalMinutes: sch.intervalMinutes || 60,
      nextRunAt: data.schedulerState?.nextRunAt || "",
      running: Boolean(data.schedulerState?.running),
    });

    if (accounts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">暂无订阅公众号，点击右上角「+ 添加订阅（支持多号）」即可一键监控更新</td></tr>`;
    } else {
      tbody.innerHTML = "";
      for (const acc of accounts) {
        const tr = document.createElement("tr");

        // 1. Toggle enabled
        const tdToggle = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "sub-toggle-input";
        cb.checked = Boolean(acc.enabled);
        cb.title = acc.enabled ? "已开启自动更新（点击暂停）" : "已暂停（点击恢复）";
        cb.addEventListener("change", async () => {
          try {
            await fetch("/api/subscriptions/update", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ bookId: acc.bookId, enabled: cb.checked }),
            });
            showToast(`${acc.name} 已${cb.checked ? "开启" : "暂停"}自动订阅`);
            await loadSubscriptionsTable();
          } catch (err) {
            showToast(`更新状态失败：${err.message}`);
          }
        });
        tdToggle.appendChild(cb);

        // 2. Account name + category + bookId
        const tdAcc = document.createElement("td");
        const accBox = document.createElement("div");
        accBox.className = "sub-acc-cell";
        const titleRow = document.createElement("div");
        titleRow.className = "sub-acc-title-row";
        const nameEl = document.createElement("span");
        nameEl.className = "sub-acc-name";
        nameEl.textContent = acc.name || acc.bookId;
        titleRow.appendChild(nameEl);
        if (acc.category) {
          const cat = document.createElement("span");
          cat.className = "sub-cat-tag";
          cat.textContent = acc.category;
          titleRow.appendChild(cat);
        }
        const idEl = document.createElement("span");
        idEl.className = "sub-book-id";
        idEl.textContent = acc.bookId;
        accBox.append(titleRow, idEl);
        tdAcc.appendChild(accBox);

        // 3. Latest article
        const tdLatest = document.createElement("td");
        if (acc.lastArticleTitle || acc.lastArticleDate) {
          const tSpan = document.createElement("span");
          tSpan.className = "sub-latest-title";
          tSpan.textContent = acc.lastArticleTitle || "—";
          tSpan.title = acc.lastArticleTitle || "";
          const dSpan = document.createElement("span");
          dSpan.className = "sub-latest-date";
          dSpan.textContent = acc.lastArticleDate || "";
          tdLatest.append(tSpan, dSpan);
        } else {
          tdLatest.textContent = "—";
        }

        // 4. Archived count
        const tdCount = document.createElement("td");
        tdCount.style.textAlign = "right";
        tdCount.textContent = String(acc.totalSynced ?? 0);

        // 5. Status & last check time
        const tdStatus = document.createElement("td");
        const pill = renderStatusBadge(acc.lastStatus, acc.lastRunAdded);
        if (acc.lastError) pill.title = acc.lastError;
        const timeEl = document.createElement("span");
        timeEl.className = "sub-check-time";
        timeEl.textContent = formatShortTime(acc.lastCheckedAt);
        tdStatus.append(pill, timeEl);

        // 6. Ops
        const tdOps = document.createElement("td");
        tdOps.style.textAlign = "right";
        const ops = document.createElement("div");
        ops.className = "row-ops";

        const btnCheckOne = document.createElement("button");
        btnCheckOne.type = "button";
        btnCheckOne.className = "link-btn";
        btnCheckOne.textContent = "更新";
        btnCheckOne.title = `立即检查「${acc.name}」是否有新文章`;
        btnCheckOne.addEventListener("click", () => startSubscriptionsSync(acc.bookId));
        ops.appendChild(btnCheckOne);

        const btnViewArt = document.createElement("button");
        btnViewArt.type = "button";
        btnViewArt.className = "link-btn";
        btnViewArt.textContent = "文章";
        btnViewArt.addEventListener("click", () => {
          $("filterAccount").value = acc.name || "";
          switchTab("archive");
        });
        ops.appendChild(btnViewArt);

        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "link-btn link-btn-danger";
        btnDel.textContent = "退订";
        btnDel.addEventListener("click", async () => {
          await fetch("/api/subscriptions/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bookId: acc.bookId }),
          });
          appendLog(`已退订公众号：${acc.name} (${acc.bookId})（已下载到本地的文章文件保留不删）`, "skip");
          showToast(`已退订 ${acc.name}`);
          await loadSubscriptionsTable();
          await refreshState(false);
        });
        ops.appendChild(btnDel);

        tdOps.appendChild(ops);
        tr.append(tdToggle, tdAcc, tdLatest, tdCount, tdStatus, tdOps);
        tbody.appendChild(tr);
      }
    }

    // Render recent run bar
    const histBar = $("subHistoryBar");
    const runs = data.recentRuns || [];
    if (runs.length > 0) {
      const latest = runs[0];
      const trigLabel = latest.trigger === "scheduled" ? "定时自动" : "手动";
      histBar.innerHTML = "";
      const leftSpan = document.createElement("span");
      leftSpan.textContent = `最近检查（${trigLabel} · ${formatShortTime(latest.at)}）：检查 ${latest.accountsChecked} 个号，新增 ${latest.newArticles} 篇${
        latest.stoppedEarly && latest.stopReason ? `（${latest.stopReason}）` : ""
      }`;
      const rightSpan = document.createElement("span");
      rightSpan.textContent =
        Array.isArray(latest.titles) && latest.titles.length > 0
          ? `最新入库：${latest.titles.slice(0, 2).join(" / ")}`
          : "配置已持久化：data/subscriptions.json";
      histBar.append(leftSpan, rightSpan);
    } else {
      histBar.innerHTML = `<span>暂无历史检查记录，点击右上角「立即检查全部更新」或等待定时自动触发。</span><span>配置文件：data/subscriptions.json</span>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">加载订阅列表失败：${err.message}</td></tr>`;
  }
}

async function startSubscriptionsSync(bookId = "") {
  switchTab("log");
  const opts = collectOptions();
  try {
    const res = await fetch("/api/run/subscriptions-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bookId,
        outputDir: state.outputDir || undefined,
        delaySec: opts.delaySec,
        downloadImages: opts.downloadImages,
        saveJsonl: opts.saveJsonl,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(data.error || "启动订阅同步失败", "warn");
      showToast(data.error || "启动失败");
      return;
    }
    watchJob(data.jobId);
  } catch (err) {
    appendLog(`订阅同步请求失败：${err.message}`, "err");
  }
}

async function handleSaveSubSchedulerConfig() {
  const enabled = $("optSubAutoEnabled").checked;
  const intervalMinutes = Number($("optSubInterval").value || 60);
  try {
    const res = await fetch("/api/subscriptions/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, intervalMinutes }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "保存设置失败");
      return;
    }
    appendLog(
      enabled
        ? `已开启多公众号定时自动更新（每 ${intervalMinutes} 分钟自动检查一次，下次检查：${formatShortTime(data.schedulerState?.nextRunAt)}）`
        : "已暂停定时自动更新（仍可随时手动点击「立即检查全部更新」）",
      enabled ? "ok" : "warn"
    );
    showToast(enabled ? `已设为每 ${intervalMinutes} 分钟自动更新` : "已暂停定时自动更新");
    await loadSubscriptionsTable();
  } catch (err) {
    showToast(`更新定时配置失败：${err.message}`);
  }
}

async function handleSubmitAddSubscriptions(rawText, { category = "默认订阅", since = "" } = {}) {
  const clean = String(rawText || "").trim();
  if (!clean) {
    showToast("请先输入至少一个公众号链接或 MP_WXS_<数字>");
    return false;
  }
  try {
    const res = await fetch("/api/subscriptions/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawText: clean, category, since, outputDir: state.outputDir || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendLog(`添加订阅失败：${data.error || "未知错误"}`, "err");
      showToast(data.error || "添加订阅失败");
      return false;
    }
    const addedCount = (data.added || []).length;
    const existCount = (data.existing || []).length;
    const names = [...(data.added || []), ...(data.existing || [])].map((a) => `${a.name}(${a.bookId})`).join("、");
    appendLog(`订阅列表已更新：新增 ${addedCount} 个、已存在启用 ${existCount} 个（${names}）`, "ok");
    showToast(`已成功订阅 ${addedCount + existCount} 个公众号`);
    await refreshState(false);
    await loadSubscriptionsTable();
    return true;
  } catch (err) {
    appendLog(`添加订阅异常：${err.message}`, "err");
    showToast(`添加失败：${err.message}`);
    return false;
  }
}

const PUSH_TYPE_GUIDES = {
  wecom:
    "在企业微信内部群右上角「添加群机器人」复制 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...），零封号风险且自动按 4KB 分片防截断。",
  feishu:
    "在飞书群「设置 → 群机器人 → 添加自定义机器人」复制 Webhook（https://open.feishu.cn/open-apis/bot/v2/hook/...）；若开启了签名校验请填入 Secret。",
  dingtalk:
    "在钉钉群「群设置 → 机器人 → 添加自定义机器人」复制 Webhook（https://oapi.dingtalk.com/robot/send?access_token=...）；推荐开启「加签」并填入 SEC 开头的密钥。",
  wxpusher:
    "使用 WxPusher 官方微信服务号直推到个人微信（https://wxpusher.zjiecode.com/）：创建应用获取 AppToken，建一个主题获取 TopicID，群友扫码关注主题即可每天在个人微信里收到日报卡片。",
  custom_webhook:
    "向任意自定义 HTTP 接口 POST 结构化 JSON（含 title、markdown、plainText、articles 数组），可直接接入 n8n、Zapier、Telegram/Discord 中转或自建服务。",
};

const PUSH_TYPE_LABELS = {
  wecom: "企业微信群",
  feishu: "飞书群",
  dingtalk: "钉钉群",
  wxpusher: "个人微信 (WxPusher)",
  custom_webhook: "自定义 Webhook",
};

function syncPushModalFields() {
  const type = $("pushChannelType").value || "wecom";
  const isWxPusher = type === "wxpusher";
  const needsSecret = type === "feishu" || type === "dingtalk";
  $("pushTypeGuide").textContent = PUSH_TYPE_GUIDES[type] || "";
  $("pushWebhookFields").classList.toggle("hidden", isWxPusher);
  $("pushWxPusherFields").classList.toggle("hidden", !isWxPusher);
  $("pushSecretGroup").classList.toggle("hidden", !needsSecret);

  const urlInput = $("pushWebhookUrl");
  if (type === "wecom") urlInput.placeholder = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...";
  else if (type === "feishu") urlInput.placeholder = "https://open.feishu.cn/open-apis/bot/v2/hook/...";
  else if (type === "dingtalk") urlInput.placeholder = "https://oapi.dingtalk.com/robot/send?access_token=...";
  else urlInput.placeholder = "https://your-webhook-endpoint.example.com/hook";
}

function openPushChannelModal(existing = null) {
  $("pushChannelId").value = existing?.id || "";
  $("pushChannelModalTitle").textContent = existing ? "编辑推送通道" : "添加群聊 / 微信推送通道";
  $("pushChannelType").value = existing?.type || "wecom";
  $("pushChannelName").value = existing?.name || "";
  $("pushWebhookUrl").value = existing?.webhookUrl || "";
  $("pushSecret").value = existing?.secret || "";
  $("pushAppToken").value = existing?.appToken || "";
  $("pushTopicIds").value = Array.isArray(existing?.topicIds) ? existing.topicIds.join(", ") : "";
  $("pushUids").value = Array.isArray(existing?.uids) ? existing.uids.join(", ") : "";
  syncPushModalFields();
  $("pushChannelModal").classList.remove("hidden");
  setTimeout(() => $("pushChannelName")?.focus(), 40);
}

function collectPushChannelModalPayload() {
  const type = $("pushChannelType").value;
  return {
    id: $("pushChannelId").value.trim() || undefined,
    type,
    name: $("pushChannelName").value.trim() || PUSH_TYPE_LABELS[type] || type,
    webhookUrl: $("pushWebhookUrl").value.trim(),
    secret: $("pushSecret").value.trim(),
    appToken: $("pushAppToken").value.trim(),
    topicIds: $("pushTopicIds").value.trim(),
    uids: $("pushUids").value.trim(),
    enabled: true,
  };
}

async function loadPushConfigTable() {
  const tbody = $("pushTableBody");
  if (!tbody) return;
  try {
    const res = await fetch("/api/push/config");
    const cfg = await res.json();
    state.pushConfig = cfg;

    const s = cfg.settings || {};
    $("optPushRealtime").checked = Boolean(s.pushOnNewArticles);
    $("optPushDaily").checked = Boolean(s.dailyDigestEnabled);
    $("optPushDailyTime").value = s.dailyDigestTime || "21:00";
    if ([24, 48, 72, 168].includes(Number(s.lookbackHours))) {
      $("optPushHours").value = String(s.lookbackHours);
    }
    if ([0, 80, 160, 300].includes(Number(s.excerptChars))) {
      $("optPushExcerpt").value = String(s.excerptChars);
    }

    const channels = cfg.channels || [];
    $("pushCountTab").textContent = String(channels.filter((c) => c.enabled).length);

    if (channels.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">尚未添加群聊/微信推送通道，点击右上角「+ 添加推送通道」（支持企微/飞书/钉钉/WxPusher），或直接点「预览 / 复制微信群文案」手动转发。</td></tr>`;
    } else {
      tbody.innerHTML = "";
      for (const ch of channels) {
        const tr = document.createElement("tr");

        const tdEn = document.createElement("td");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.className = "sub-toggle-input";
        cb.checked = Boolean(ch.enabled);
        cb.addEventListener("change", async () => {
          await fetch("/api/push/channels/toggle", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ch.id, enabled: cb.checked }),
          });
          showToast(`${ch.name} 已${cb.checked ? "启用" : "停用"}`);
          await loadPushConfigTable();
        });
        tdEn.appendChild(cb);

        const tdName = document.createElement("td");
        const box = document.createElement("div");
        box.className = "sub-acc-cell";
        const row = document.createElement("div");
        row.className = "sub-acc-title-row";
        const nameEl = document.createElement("span");
        nameEl.className = "sub-acc-name";
        nameEl.textContent = ch.name;
        const badge = document.createElement("span");
        badge.className = `push-type-badge push-type-${ch.type}`;
        badge.textContent = PUSH_TYPE_LABELS[ch.type] || ch.type;
        row.append(nameEl, badge);
        const idEl = document.createElement("span");
        idEl.className = "sub-book-id";
        idEl.textContent = ch.id;
        box.append(row, idEl);
        tdName.appendChild(box);

        const tdTarget = document.createElement("td");
        tdTarget.className = "sub-book-id";
        tdTarget.textContent = ch.targetHint || "—";

        const tdSt = document.createElement("td");
        const pill = document.createElement("span");
        if (ch.lastStatus === "ok") {
          pill.className = "sub-status-pill sub-st-ok";
          pill.textContent = "发送成功";
        } else if (ch.lastStatus === "error") {
          pill.className = "sub-status-pill sub-st-warn";
          pill.textContent = "发送失败";
          if (ch.lastError) pill.title = ch.lastError;
        } else {
          pill.className = "sub-status-pill sub-st-idle";
          pill.textContent = "尚未发送";
        }
        const tm = document.createElement("span");
        tm.className = "sub-check-time";
        tm.textContent = ch.lastSentAt ? formatShortTime(ch.lastSentAt) : "—";
        tdSt.append(pill, tm);

        const tdOps = document.createElement("td");
        tdOps.style.textAlign = "right";
        const ops = document.createElement("div");
        ops.className = "row-ops";

        const btnTest = document.createElement("button");
        btnTest.type = "button";
        btnTest.className = "link-btn";
        btnTest.textContent = "发测试";
        btnTest.addEventListener("click", async () => {
          btnTest.disabled = true;
          btnTest.textContent = "发送中...";
          try {
            const r = await fetch("/api/push/test", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: ch.id }),
            });
            const d = await r.json();
            if (d.ok) {
              appendLog(`✓ 测试推送成功 [${ch.name}]：${d.message}`, "ok");
              showToast(`测试消息已发送至 ${ch.name}`);
            } else {
              appendLog(`✕ 测试推送失败 [${ch.name}]：${d.error || "未知错误"}`, "err");
              showToast(`发送失败：${d.error || "请检查 Webhook"}`);
            }
            await loadPushConfigTable();
          } finally {
            btnTest.disabled = false;
            btnTest.textContent = "发测试";
          }
        });

        const btnEdit = document.createElement("button");
        btnEdit.type = "button";
        btnEdit.className = "link-btn";
        btnEdit.textContent = "编辑";
        btnEdit.addEventListener("click", () => openPushChannelModal(ch));

        const btnDel = document.createElement("button");
        btnDel.type = "button";
        btnDel.className = "link-btn link-btn-danger";
        btnDel.textContent = "删除";
        btnDel.addEventListener("click", async () => {
          await fetch("/api/push/channels/remove", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: ch.id }),
          });
          showToast(`已删除通道 ${ch.name}`);
          await loadPushConfigTable();
        });

        ops.append(btnTest, btnEdit, btnDel);
        tdOps.appendChild(ops);
        tr.append(tdEn, tdName, tdTarget, tdSt, tdOps);
        tbody.appendChild(tr);
      }
    }

    const histBar = $("pushHistoryBar");
    const hist = cfg.history || [];
    if (hist.length > 0) {
      const h = hist[0];
      const trig = h.trigger === "scheduled" ? "定时" : h.trigger === "subscription" ? "新文实时" : "手动";
      histBar.innerHTML = "";
      const left = document.createElement("span");
      left.textContent = `最近推送（${trig} · ${formatShortTime(h.at)}）：收录 ${h.articleCount} 篇 · 成功 ${h.sent} 通道 · 失败 ${h.failed}`;
      const right = document.createElement("span");
      right.textContent = s.dailyDigestEnabled
        ? `每日 ${s.dailyDigestTime} 自动推送近 ${s.lookbackHours} 小时日报 · 配置：data/push-config.json`
        : "配置已本地持久化：data/push-config.json";
      histBar.append(left, right);
    } else {
      histBar.innerHTML = `<span>支持企业微信群、飞书群、钉钉群、WxPusher（个人微信直推）与自定义 Webhook；密钥仅存本地。</span><span>配置文件：data/push-config.json</span>`;
    }
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">加载推送配置失败：${err.message}</td></tr>`;
  }
}

async function handleSavePushSettings() {
  try {
    const payload = {
      pushOnNewArticles: $("optPushRealtime").checked,
      dailyDigestEnabled: $("optPushDaily").checked,
      dailyDigestTime: $("optPushDailyTime").value || "21:00",
      lookbackHours: Number($("optPushHours").value || 24),
      excerptChars: Number($("optPushExcerpt").value ?? 160),
    };
    const res = await fetch("/api/push/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return showToast("保存推送设置失败");
    showToast(
      payload.dailyDigestEnabled
        ? `已保存：每天 ${payload.dailyDigestTime} 自动推送近 ${payload.lookbackHours} 小时日报`
        : "已保存推送设置"
    );
    await loadPushConfigTable();
  } catch (err) {
    showToast(`保存失败：${err.message}`);
  }
}

function renderDigestPreviewBody() {
  const d = state.digestPreviewData;
  if (!d) return;
  const isWx = state.digestPreviewFormat === "wx";
  $("btnDigestFormatWx").classList.toggle("active", isWx);
  $("btnDigestFormatMd").classList.toggle("active", !isWx);
  $("digestPreviewText").value = isWx ? d.wechatGroupText || "" : d.markdown || "";
  $("digestPreviewMeta").textContent = `${d.title} · 共收录 ${d.articleCount} 篇（涉及 ${d.accountCount} 个公众号 · 近 ${d.hours} 小时）`;
}

async function openDigestPreviewModal(hoursOverride = null) {
  $("digestPreviewModal").classList.remove("hidden");
  const hours = hoursOverride ?? Number($("optPushHours")?.value || 24);
  $("digestPreviewHours").value = String(hours);
  $("digestPreviewMeta").textContent = "正在汇总归档文章生成日报...";
  $("digestPreviewText").value = "生成中，请稍候...";
  try {
    const res = await fetch("/api/push/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: state.outputDir || undefined, hours }),
    });
    const data = await res.json();
    state.digestPreviewData = data.digest || null;
    renderDigestPreviewBody();
  } catch (err) {
    $("digestPreviewText").value = `生成预览失败：${err.message}`;
  }
}

async function handleSendDigestNow(hoursOverride = null) {
  const hours = hoursOverride ?? Number($("optPushHours")?.value || 24);
  const btn = $("btnSendDigestNow");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "推送中...";
  }
  try {
    const res = await fetch("/api/push/send-digest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outputDir: state.outputDir || undefined, hours }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || (data.results || []).find((r) => !r.ok)?.error || "推送失败";
      appendLog(`⚠️ 日报推送未完全成功：${msg}`, "warn");
      showToast(msg);
    } else {
      appendLog(
        `✓ 已推送今日订阅日报（收录 ${data.digest?.articleCount || 0} 篇，成功送达 ${data.sent} 个通道）${
          data.digestFile ? `，本地已保存：${data.digestFile}` : ""
        }`,
        "ok"
      );
      showToast(`日报已成功推送至 ${data.sent} 个通道！`);
    }
    await loadPushConfigTable();
  } catch (err) {
    appendLog(`推送日报异常：${err.message}`, "err");
    showToast(`推送失败：${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "立即推送日报";
    }
  }
}

function switchTab(which) {
  state.activeTab = which;
  const isLog = which === "log";
  const isSubs = which === "subs";
  const isPush = which === "push";
  const isArchive = which === "archive";

  $("tabLog").classList.toggle("active", isLog);
  $("tabLog").setAttribute("aria-selected", String(isLog));
  $("tabSubs").classList.toggle("active", isSubs);
  $("tabSubs").setAttribute("aria-selected", String(isSubs));
  $("tabPush").classList.toggle("active", isPush);
  $("tabPush").setAttribute("aria-selected", String(isPush));
  $("tabArchive").classList.toggle("active", isArchive);
  $("tabArchive").setAttribute("aria-selected", String(isArchive));

  $("panelLog").classList.toggle("hidden", !isLog);
  $("panelSubs").classList.toggle("hidden", !isSubs);
  $("panelPush").classList.toggle("hidden", !isPush);
  $("panelArchive").classList.toggle("hidden", !isArchive);
  $("btnClearLog").classList.toggle("hidden", !isLog);

  if (isSubs) {
    loadSubscriptionsTable();
  } else if (isPush) {
    loadPushConfigTable();
  } else if (isArchive) {
    loadArchiveTable();
  }
}

function applyDarkMode(enabled) {
  document.documentElement.classList.toggle("dark", enabled);
  $("optDarkMode").checked = enabled;
  localStorage.setItem("wxclean_dark_mode", enabled ? "1" : "0");
}

function appendImportedText(text, sourceLabel) {
  const current = $("urlInput").value.trim();
  const tokens =
    text.match(
      /(?:MP_WXS_\d{5,20}|https?:\/\/mp\.weixin\.qq\.com\/(?:s\/[A-Za-z0-9_-]+|s\?[^\s"'<>|,\]]+|mp\/appmsgalbum\?[^\s"'<>|,\]]+|mp\/profile_ext\?[^\s"'<>|,\]]+))/gi
    ) || [];
  const unique = [...new Set(tokens)];
  if (unique.length === 0) {
    showToast(`${sourceLabel}中未识别到微信公众号链接或 MP_WXS ID`);
    return;
  }
  const existingSet = new Set(current.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  let added = 0;
  for (const u of unique) {
    if (!existingSet.has(u)) {
      existingSet.add(u);
      added++;
    }
  }
  $("urlInput").value = [...existingSet].join("\n");
  updateUrlCounter();
  appendLog(`已从 ${sourceLabel} 导入 ${added} 条新链接/ID（去重后共 ${existingSet.size} 条）`, "ok");
  showToast(`已导入 ${added} 条`);
}

function bindEvents() {
  // Theme init
  const savedDark = localStorage.getItem("wxclean_dark_mode") === "1";
  applyDarkMode(savedDark);
  $("optDarkMode").addEventListener("change", (e) => applyDarkMode(e.target.checked));
  $("optDailyLimit")?.addEventListener("input", () => renderDailyQuota(state.dailyQuota));

  // Channel init & switcher
  const savedChannel = localStorage.getItem("wxclean_channel") || "weread";
  applyChannelUi(savedChannel === "public" ? "public" : "weread");
  $("btnChannelWeRead").addEventListener("click", () => applyChannelUi("weread"));
  $("btnChannelPublic").addEventListener("click", () => applyChannelUi("public"));

  // WeRead auth status header & refresh buttons
  $("pillWeReadStatus").addEventListener("click", () => {
    if (state.wereadStatus?.loggedIn) {
      handleRefreshWeReadStatus(false);
    } else {
      handleWeReadLogin();
    }
  });
  $("btnRefreshWeRead").addEventListener("click", () => handleRefreshWeReadStatus(false));

  // MP Account Name Search Modal controls
  $("btnSearchMpAccount").addEventListener("click", openMpSearchModal);
  $("btnCloseMpSearchModal").addEventListener("click", () => $("mpSearchModal").classList.add("hidden"));
  $("btnDoneMpSearchModal").addEventListener("click", () => $("mpSearchModal").classList.add("hidden"));
  $("btnMpModalLogin").addEventListener("click", handleMpAdminLogin);
  $("btnMpModalRefresh").addEventListener("click", () => handleRefreshMpAdminStatus(false));
  $("btnMpSearchGo").addEventListener("click", handleMpSearchSubmit);
  $("mpSearchQueryInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleMpSearchSubmit();
    }
  });

  // URL Input & Drag-drop
  $("urlInput").addEventListener("input", () => {
    updateUrlCounter();
    if ($("urlInput").value.trim() !== state.lastWeReadInputKey) {
      $("btnSyncParsedWeRead").classList.add("hidden");
    }
  });
  $("btnClearInput").addEventListener("click", () => {
    $("urlInput").value = "";
    state.lastWeReadCatalog = null;
    state.lastWeReadInputKey = "";
    $("btnSyncParsedWeRead").classList.add("hidden");
    updateUrlCounter();
  });
  $("btnPaste").addEventListener("click", async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (!txt) return showToast("剪贴板为空");
      const cur = $("urlInput").value.trim();
      $("urlInput").value = cur ? `${cur}\n${txt}` : txt;
      updateUrlCounter();
      showToast("已粘贴剪贴板内容");
    } catch {
      showToast("浏览器未授予剪贴板读取权限，请直接按 Ctrl+V 粘贴");
    }
  });

  $("btnImportFile").addEventListener("click", () => $("fileImportInput").click());
  $("fileImportInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    appendImportedText(text, `文件 ${file.name}`);
    e.target.value = "";
  });

  const dz = $("dropZone");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("drag-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("drag-over");
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const text = await file.text();
    appendImportedText(text, `拖拽文件 ${file.name}`);
  });

  // Clipboard watcher
  const checkClipboard = async () => {
    if (!$("optWatchClipboard").checked || !document.hasFocus()) return;
    try {
      const txt = (await navigator.clipboard.readText()).trim();
      if (!txt || txt === state.lastClipboardText) return;
      state.lastClipboardText = txt;
      if (/(?:MP_WXS_\d+|https?:\/\/mp\.weixin\.qq\.com\/(?:s|mp\/appmsgalbum))/i.test(txt)) {
        appendImportedText(txt, "剪贴板自动捕获");
      }
    } catch {}
  };
  $("optWatchClipboard").addEventListener("change", (e) => {
    if (e.target.checked) {
      window.addEventListener("focus", checkClipboard);
      state.clipboardTimer = setInterval(checkClipboard, 2500);
      appendLog("已开启剪贴板自动监听（复制公众号链接或 MP_WXS ID 后切回本页自动追加）", "info");
    } else {
      window.removeEventListener("focus", checkClipboard);
      clearInterval(state.clipboardTimer);
      state.clipboardTimer = null;
      appendLog("已关闭剪贴板自动监听", "skip");
    }
  });

  // Time range radios
  document.querySelectorAll('input[name="timeMode"]').forEach((r) => {
    r.addEventListener("change", () => {
      const isCustom = r.value === "custom" && r.checked;
      $("optDateFrom").disabled = !isCustom;
      $("optDateTo").disabled = !isCustom;
    });
  });

  // Core 6 action buttons
  $("btnPrimaryLeft").addEventListener("click", () => {
    if (state.channel === "weread") {
      handleWeReadLogin();
    } else {
      startPublicFetchJob("/api/run/fetch");
    }
  });
  $("btnParseInputs").addEventListener("click", handleParseInputs);
  $("btnBatchDownload").addEventListener("click", () => {
    if (state.channel === "weread") {
      startWeReadSyncJob({ usePrefetched: false });
    } else {
      startPublicFetchJob("/api/run/batch");
    }
  });
  $("btnSyncParsedWeRead").addEventListener("click", () => startWeReadSyncJob({ usePrefetched: true }));

  $("btnOpenDir").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/open-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: state.outputDir }),
      });
      const data = await res.json();
      appendLog(`已在资源管理器打开归档目录：${data.dir}`, "ok");
      showToast("已打开归档目录");
    } catch (err) {
      appendLog(`打开目录失败：${err.message}`, "err");
    }
  });

  $("btnExportCsv").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/export-csv");
      const data = await res.json();
      appendLog(`已导出 ${data.count} 条文章记录到 CSV：${data.csvPath}`, "ok");
      showToast(`已导出 ${data.count} 篇数据 CSV`);
      window.location.href = "/api/export-csv?download=1";
    } catch (err) {
      appendLog(`导出 CSV 失败：${err.message}`, "err");
    }
  });

  // WeRead QR modal controls
  $("btnCloseWeReadModal").addEventListener("click", () => $("wereadLoginModal").classList.add("hidden"));
  $("btnDoneWeReadModal").addEventListener("click", () => $("wereadLoginModal").classList.add("hidden"));
  $("btnRefreshQrImg").addEventListener("click", handleRefreshQrImage);

  // Clean local directory modal
  $("btnCleanLocalDir").addEventListener("click", () => $("cleanDirModal").classList.remove("hidden"));
  $("btnCloseCleanModal").addEventListener("click", () => $("cleanDirModal").classList.add("hidden"));
  $("btnCancelCleanModal").addEventListener("click", () => $("cleanDirModal").classList.add("hidden"));
  $("btnConfirmCleanDir").addEventListener("click", async () => {
    const inputDir = $("cleanDirPathInput").value.trim();
    if (!inputDir) {
      showToast("请填写待清洗的本地目录路径");
      return;
    }
    $("cleanDirModal").classList.add("hidden");
    switchTab("log");
    const opts = collectOptions();
    try {
      const res = await fetch("/api/run/clean-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputDir,
          accountHint: $("cleanAccountHint").value.trim(),
          ...opts,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        appendLog(data.error || "清洗失败", "err");
        showToast(data.error || "清洗失败");
        return;
      }
      watchJob(data.jobId);
    } catch (err) {
      appendLog(`请求失败：${err.message}`, "err");
    }
  });

  // MCP live toggle
  $("optEnableMcp").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    try {
      const res = await fetch("/api/mcp-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      state.mcpEnabled = data.mcpEnabled;
      renderMcpStatus();
      if (state.mcpEnabled) {
        appendLog(
          `MCP 服务已启用：${data.mcpUrl}`,
          "ok",
          JSON.stringify(data.mcpConfig.streamableHttp, null, 2)
        );
      } else {
        appendLog("MCP 服务已暂停（/mcp 端点现返回 503，随时可重新勾选开启）", "warn");
      }
    } catch (err) {
      appendLog(`切换 MCP 状态失败：${err.message}`, "err");
    }
  });

  // Cancel job
  $("btnCancelJob").addEventListener("click", async () => {
    if (!state.activeJobId) return;
    await fetch(`/api/jobs/${state.activeJobId}/cancel`, { method: "POST" });
    showToast("正在中止当前任务...");
  });

  // Fill parsed URLs & Export parsed CSV
  $("btnFillParsedUrls").addEventListener("click", () => {
    const urls = state.lastParsedResult?.urls || [];
    if (urls.length === 0) return showToast("暂无可填入的解析链接");
    $("urlInput").value = urls.join("\n");
    updateUrlCounter();
    appendLog(`已将 ${urls.length} 条解析链接填入输入框`, "ok");
    showToast(`已填入 ${urls.length} 条链接`);
  });

  $("btnExportParsedCsv").addEventListener("click", async () => {
    const articles = state.lastParsedResult?.articles || [];
    if (articles.length === 0) return showToast("暂无可导出的解析清单");
    try {
      const res = await fetch("/api/export-parsed-csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ articles, outputDir: state.outputDir }),
      });
      const data = await res.json();
      appendLog(`已导出 ${data.count} 条解析目录清单到：${data.csvPath}`, "ok");
      const blob = new Blob([data.csvContent], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "公众号解析目录清单.csv";
      a.click();
      URL.revokeObjectURL(a.href);
      showToast(`已导出 ${data.count} 条目录清单 CSV`);
    } catch (err) {
      appendLog(`导出清单失败：${err.message}`, "err");
    }
  });

  // Copy MCP config & clear log
  $("btnCopyMcp").addEventListener("click", async () => {
    if (!state.mcpConfig) return;
    const text = JSON.stringify(state.mcpConfig.streamableHttp, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制 MCP Streamable HTTP 配置");
    } catch {
      appendLog("请手动复制下方 MCP 配置：", "info", text);
    }
  });

  $("btnClearLog").addEventListener("click", () => {
    $("logConsole").innerHTML = "";
  });

  // Quick subscribe from main textarea
  $("btnQuickSubscribe").addEventListener("click", async () => {
    const raw = $("urlInput").value.trim();
    if (!raw) {
      $("addSubRawInput").value = "";
      $("addSubModal").classList.remove("hidden");
      $("addSubRawInput").focus();
      return;
    }
    const ok = await handleSubmitAddSubscriptions(raw, { category: "默认订阅" });
    if (ok) switchTab("subs");
  });

  // Subscriptions tab controls & Add Modal
  $("tabSubs").addEventListener("click", () => switchTab("subs"));
  $("pillSubStatus").addEventListener("click", () => switchTab("subs"));
  $("optSubAutoEnabled").addEventListener("change", handleSaveSubSchedulerConfig);
  $("optSubInterval").addEventListener("change", handleSaveSubSchedulerConfig);
  $("btnSyncAllSubs").addEventListener("click", () => startSubscriptionsSync(""));

  $("btnOpenAddSubModal").addEventListener("click", () => {
    $("addSubRawInput").value = "";
    $("addSubModal").classList.remove("hidden");
    $("addSubRawInput").focus();
  });
  $("btnCloseAddSubModal").addEventListener("click", () => $("addSubModal").classList.add("hidden"));
  $("btnCancelAddSubModal").addEventListener("click", () => $("addSubModal").classList.add("hidden"));
  $("btnConfirmAddSub").addEventListener("click", async () => {
    const btn = $("btnConfirmAddSub");
    btn.disabled = true;
    btn.textContent = "解析并加入中...";
    try {
      const ok = await handleSubmitAddSubscriptions($("addSubRawInput").value, {
        category: $("addSubCategoryInput").value.trim() || "默认订阅",
        since: $("addSubSinceInput").value || "",
      });
      if (ok) $("addSubModal").classList.add("hidden");
    } finally {
      btn.disabled = false;
      btn.textContent = "确认加入订阅";
    }
  });

  // Push & Daily Digest tab controls + modals
  $("tabPush").addEventListener("click", () => switchTab("push"));
  $("optPushRealtime").addEventListener("change", handleSavePushSettings);
  $("optPushDaily").addEventListener("change", handleSavePushSettings);
  $("optPushDailyTime").addEventListener("change", handleSavePushSettings);
  $("optPushHours").addEventListener("change", handleSavePushSettings);
  $("optPushExcerpt").addEventListener("change", handleSavePushSettings);
  $("btnOpenAddPushModal").addEventListener("click", () => openPushChannelModal(null));
  $("btnPreviewDigest").addEventListener("click", () => openDigestPreviewModal());
  $("btnSendDigestNow").addEventListener("click", () => handleSendDigestNow());

  $("pushChannelType").addEventListener("change", syncPushModalFields);
  $("btnClosePushModal").addEventListener("click", () => $("pushChannelModal").classList.add("hidden"));
  $("btnCancelPushModal").addEventListener("click", () => $("pushChannelModal").classList.add("hidden"));
  $("btnSavePushChannel").addEventListener("click", async () => {
    const payload = collectPushChannelModalPayload();
    try {
      const res = await fetch("/api/push/channels/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || "保存失败");
      $("pushChannelModal").classList.add("hidden");
      appendLog(`✓ 已保存推送通道：${data.channel.name} (${data.channel.targetHint})`, "ok");
      showToast(`已保存推送通道 ${data.channel.name}`);
      await loadPushConfigTable();
      await refreshState(false);
    } catch (err) {
      showToast(`保存失败：${err.message}`);
    }
  });
  $("btnTestUnsavedPush").addEventListener("click", async () => {
    const payload = collectPushChannelModalPayload();
    const btn = $("btnTestUnsavedPush");
    btn.disabled = true;
    btn.textContent = "测试中...";
    try {
      const res = await fetch("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`连通测试成功：${data.message}`);
        appendLog(`✓ 推送通道测试成功 [${payload.name}]：${data.message}`, "ok");
      } else {
        showToast(`测试失败：${data.error || "请检查配置"}`);
        appendLog(`✕ 推送通道测试失败 [${payload.name}]：${data.error || "未知错误"}`, "err");
      }
    } catch (err) {
      showToast(`测试异常：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "发送测试消息";
    }
  });

  $("btnCloseDigestModal").addEventListener("click", () => $("digestPreviewModal").classList.add("hidden"));
  $("btnDoneDigestModal").addEventListener("click", () => $("digestPreviewModal").classList.add("hidden"));
  $("btnDigestFormatWx").addEventListener("click", () => {
    state.digestPreviewFormat = "wx";
    renderDigestPreviewBody();
  });
  $("btnDigestFormatMd").addEventListener("click", () => {
    state.digestPreviewFormat = "md";
    renderDigestPreviewBody();
  });
  $("btnReloadDigestPreview").addEventListener("click", () => {
    openDigestPreviewModal(Number($("digestPreviewHours").value || 24));
  });
  $("digestPreviewHours").addEventListener("change", () => {
    openDigestPreviewModal(Number($("digestPreviewHours").value || 24));
  });
  $("btnCopyDigestText").addEventListener("click", async () => {
    const txt = $("digestPreviewText").value;
    if (!txt) return showToast("暂无文案可复制");
    try {
      await navigator.clipboard.writeText(txt);
      showToast("已复制日报文案，可直接粘贴到微信群！");
    } catch {
      $("digestPreviewText").select();
      showToast("请按 Ctrl+C 复制选中内容");
    }
  });
  $("btnPushFromPreview").addEventListener("click", () => {
    handleSendDigestNow(Number($("digestPreviewHours").value || 24));
  });

  // Tabs & Archive controls
  $("tabLog").addEventListener("click", () => switchTab("log"));
  $("tabArchive").addEventListener("click", () => switchTab("archive"));
  $("pillArchiveBtn").addEventListener("click", () => switchTab("archive"));
  $("filterAccount").addEventListener("change", loadArchiveTable);
  $("filterKeyword").addEventListener("input", loadArchiveTable);
  $("btnRefreshArchive").addEventListener("click", async () => {
    await refreshState(false);
    await loadArchiveTable();
    showToast("列表已刷新");
  });

  // Preview drawer
  $("btnClosePreview").addEventListener("click", () => $("previewDrawer").classList.add("hidden"));
  $("previewDrawer").addEventListener("click", (e) => {
    if (e.target === $("previewDrawer")) $("previewDrawer").classList.add("hidden");
  });
  $("btnCopyPreview").addEventListener("click", async () => {
    if (!state.previewRawText) return;
    try {
      await navigator.clipboard.writeText(state.previewRawText);
      showToast("已复制干净 Markdown 全文");
    } catch {
      showToast("复制失败，请手动选中复制");
    }
  });
}

// Init
bindEvents();
updateUrlCounter();
refreshState(true);
// Background silent state refresh every 30s so scheduled auto-sync updates show up live
setInterval(() => {
  if (!document.hidden && !state.activeJobId) {
    refreshState(false);
    if (state.activeTab === "subs") loadSubscriptionsTable();
  }
}, 30000);
