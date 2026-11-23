/**
 * Frontend controller for WeChat Article Cleaner Workstation v2.0
 * Dual-channel: WeRead Full History Channel (Edge CDP) + Public Link Direct Fetch
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
  loginPollTimer: null,
  activeJobId: null,
  activeEventSource: null,
  clipboardTimer: null,
  lastClipboardText: "",
  previewRawText: "",
  lastParsedResult: null,
  lastWeReadCatalog: null,
  lastWeReadInputKey: "",
  subscriptionSummary: null,
  subscriptionsData: null,
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
    $("urlCounter").textContent = `已识别 ${idCount} 个公众号 ID/__biz · ${articles.size} 条文章链接 · ${albums.size} 条合集链接`;
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

function renderWeReadStatus(st) {
  state.wereadStatus = st || null;
  const dot = $("wereadStatusDot");
  const text = $("wereadStatusText");
  const hint = $("wereadHintText");

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
    stopLoginPolling();
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
  state.channel = channel;
  localStorage.setItem("wxclean_channel", channel);
  const isWeRead = channel === "weread";

  $("btnChannelWeRead").classList.toggle("active", isWeRead);
  $("btnChannelWeRead").setAttribute("aria-selected", String(isWeRead));
  $("btnChannelPublic").classList.toggle("active", !isWeRead);
  $("btnChannelPublic").setAttribute("aria-selected", String(!isWeRead));

  $("wereadChannelMeta").classList.toggle("hidden", !isWeRead);
  $("pillDiscoverRelated").classList.toggle("hidden", isWeRead);

  if (isWeRead) {
    $("inputSectionLabel").textContent = "公众号 ID / 文章链接 / 合集链接（自动换算 MP_WXS_...）";
    $("urlInput").placeholder =
      "提示：粘贴任意一篇该公众号文章链接、含 __biz 的合集链接，或直接输入 MP_WXS_1234567890（也可点击下方快捷公众号标签）";
    $("inputFooterTip").textContent = "支持单篇链接自动换算全量历史 · 断点续传去重";
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

  renderSavedAccounts();
  updateUrlCounter();
}

function stopLoginPolling() {
  if (state.loginPollTimer) {
    clearInterval(state.loginPollTimer);
    state.loginPollTimer = null;
  }
}

function startLoginPolling() {
  stopLoginPolling();
  let ticks = 0;
  state.loginPollTimer = setInterval(async () => {
    ticks++;
    if (ticks > 60) {
      stopLoginPolling();
      return;
    }
    try {
      const res = await fetch("/api/weread/status?probe=1");
      const st = await res.json();
      renderWeReadStatus(st);
      if (st.loggedIn) {
        stopLoginPolling();
        $("wereadLoginModal").classList.add("hidden");
        appendLog(`✓ 微信读书扫码登录成功！当前账号：${st.userName || `vid:${st.vid}`}，现在可以点击「1.获取公众号目录」或「2.批量下载清洗」。`, "ok");
        showToast("微信读书扫码登录成功！");
      }
    } catch {}
  }, 2500);
}

function showWeReadQrModal(dataUrl = "") {
  $("wereadLoginModal").classList.remove("hidden");
  if (dataUrl) {
    $("wereadQrImg").src = dataUrl;
    $("wereadQrImg").classList.remove("hidden");
    $("wereadQrLoading").classList.add("hidden");
    $("wereadModalStatusText").textContent = "请用手机微信扫描上方二维码（或直接在弹出的 Edge 窗口扫码）";
  } else {
    $("wereadQrImg").classList.add("hidden");
    $("wereadQrLoading").classList.remove("hidden");
    $("wereadQrLoading").textContent = "正在打开微信读书并加载二维码，请稍候...";
    $("wereadModalStatusText").textContent = "正在连接本地 Edge 窗口...";
  }
}

async function handleRefreshQrImage() {
  $("wereadQrImg").classList.add("hidden");
  $("wereadQrLoading").classList.remove("hidden");
  $("wereadQrLoading").textContent = "正在刷新微信读书实时二维码...";
  try {
    const res = await fetch("/api/weread/qr");
    const data = await res.json();
    if (data.loggedIn) {
      renderWeReadStatus(data);
      $("wereadLoginModal").classList.add("hidden");
      appendLog(`✓ 微信读书已登录（${data.userName || `vid:${data.vid}`}）`, "ok");
      showToast("微信读书已登录！");
      return;
    }
    if (data.qrImageDataUrl) {
      showWeReadQrModal(data.qrImageDataUrl);
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
  showWeReadQrModal("");
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
        showWeReadQrModal(data.qrImageDataUrl);
      } else {
        $("wereadQrLoading").textContent = "请在已弹出的 Edge 窗口中点击右上角「登录」并微信扫码（或点下方「刷新二维码」）";
      }
      appendLog(
        `已在 ${data.browserName || "Edge"} 中打开微信读书网页版并同步截取实时二维码，请直接扫码登录（扫码后 3 秒内自动感知并关闭弹窗）。`,
        "warn"
      );
      showToast("请用手机微信扫描二维码登录");
      startLoginPolling();
    }
  } catch (err) {
    $("wereadLoginModal").classList.add("hidden");
    appendLog(`连接本地微信读书登录接口失败：${err.message}`, "err");
  }
}

async function handleRefreshWeReadStatus(silent = false) {
  try {
    const res = await fetch("/api/weread/status?probe=1");
    const st = await res.json();
    renderWeReadStatus(st);
    if (!silent) {
      if (st.loggedIn) {
        appendLog(`微信读书登录态有效：${st.userName || `vid:${st.vid}`}`, "ok");
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
    if (!silent) appendLog(`查询登录态失败：${err.message}`, "err");
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
    renderWeReadStatus(data.wereadStatus);
    renderSavedAccounts();
    renderSubscriptionSummary(data.subscriptionSummary);
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
      appendLog("工作台已升级至 v2.1（微信读书全量通道 + 多公众号自动订阅）：支持同时订阅多个公众号并按周期自动检测更新、下载并深度清洗入库。", "ok");
      appendLog("使用方式：① 登录微信读书后，可随时切换到「公众号订阅」标签批量添加多个公众号并开启定时自动更新；② 也可在上方直接粘贴单篇/合集链接进行历史全量回溯。", "info");
      if (state.mcpEnabled && state.mcpConfig) {
        appendLog(
          `MCP 服务已启动在 ${state.mcpUrl}（共 12 个工具，含多号订阅管理与自动同步），Streamable HTTP 配置示例：`,
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

function switchTab(which) {
  state.activeTab = which;
  const isLog = which === "log";
  const isSubs = which === "subs";
  const isArchive = which === "archive";

  $("tabLog").classList.toggle("active", isLog);
  $("tabLog").setAttribute("aria-selected", String(isLog));
  $("tabSubs").classList.toggle("active", isSubs);
  $("tabSubs").setAttribute("aria-selected", String(isSubs));
  $("tabArchive").classList.toggle("active", isArchive);
  $("tabArchive").setAttribute("aria-selected", String(isArchive));

  $("panelLog").classList.toggle("hidden", !isLog);
  $("panelSubs").classList.toggle("hidden", !isSubs);
  $("panelArchive").classList.toggle("hidden", !isArchive);
  $("btnClearLog").classList.toggle("hidden", !isLog);

  if (isSubs) {
    loadSubscriptionsTable();
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

  // WeRead header & refresh buttons
  $("pillWeReadStatus").addEventListener("click", () => {
    if (state.wereadStatus?.loggedIn) {
      handleRefreshWeReadStatus(false);
    } else {
      handleWeReadLogin();
    }
  });
  $("btnRefreshWeRead").addEventListener("click", () => handleRefreshWeReadStatus(false));

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
