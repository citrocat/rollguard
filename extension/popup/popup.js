(() => {
  "use strict";

  const C = globalThis.RollGuardConfig;
  const D = globalThis.RollGuardDetect;
  const K = C.STORAGE_KEYS;
  const M = C.MESSAGE;

  const $ = (selector) => document.querySelector(selector);

  const els = {
    powerToggle: $("#powerToggle"),
    powerLabel: $("#powerLabel"),
    todayCount: $("#todayCount"),
    heroCaption: $("#heroCaption"),
    scanButton: $("#scanButton"),
    scanLabel: $("#scanLabel"),
    scanSub: $("#scanSub"),
    wantedCards: $("#wantedCards"),
    latestBox: $("#latestBox"),
    openHistory: $("#openHistory"),
    totalCount: $("#totalCount"),
    toast: $("#toast"),
    toastText: $("#toastText"),
  };

  let settings = { ...C.DEFAULT_SETTINGS };
  let visits = [];
  let stats = { totalBlocked: 0 };
  let scanning = false;
  let hasScanned = false;
  let lastScanSummary = "";
  let toastTimer = null;

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (data) => resolve(data || {}));
      } catch (error) {
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => resolve(true));
      } catch (error) {
        resolve(false);
      }
    });
  }

  function getActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs?.[0] || null);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, error: error.message });
          } else {
            resolve(response || { ok: false, error: "empty-response" });
          }
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function relativeCompact(timestamp) {
    const delta = Math.max(0, Date.now() - Number(timestamp || 0));
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (delta < minute) return "JUST NOW";
    if (delta < hour) return `${Math.floor(delta / minute)} MIN`;
    if (delta < day) return `${Math.floor(delta / hour)} HR`;
    return `${Math.floor(delta / day)} D`;
  }

  function countToday() {
    return visits.filter((visit) => D.isSameLocalDay(visit.blockedAt)).length;
  }

  function renderWantedCards() {
    if (!els.wantedCards || els.wantedCards.childElementCount) return;
    D.SEED_VIDEOS.forEach((video, index) => {
      const card = createEl("div", "pb-card");
      const tape = createEl("span", "pb-card-tape");
      const img = document.createElement("img");
      img.src = `../${video.thumbnail}`;
      img.alt = "";
      const copy = createEl("div", "pb-card-copy");
      copy.append(
        createEl("b", "", video.posterTitle),
        createEl("code", "", D.abbreviateVideoId(video.id))
      );
      const badge = createEl("span", "pb-card-badge", `#${index + 1}`);
      card.append(tape, img, copy, badge);
      els.wantedCards.appendChild(card);
    });
  }

  function renderLatest() {
    if (!els.latestBox) return;
    els.latestBox.replaceChildren();

    const latest = visits[0];
    if (!latest) {
      const empty = createEl("div", "pb-log is-empty");
      empty.append(createEl("span", "pb-log-mark", "◎"));
      const copy = createEl("div");
      copy.append(
        createEl("b", "", "还没有猎物。"),
        createEl("p", "", "防护在线 · 第一条记录会出现在这里")
      );
      empty.append(copy, createEl("span", "pb-log-time", "READY"));
      els.latestBox.appendChild(empty);
      return;
    }

    const source = latest.sourceHost || "直接访问";
    const display = latest.displayUrl || latest.abbreviation || "youtu.be/…";
    const row = createEl("div", "pb-log");
    const mark = createEl("span", "pb-log-mark", "⟶");
    const copy = createEl("div");
    const title = createEl("b", "", latest.title || "未命名 Rickroll");
    const meta = createEl("p");
    const sourceCode = createEl("code", "", source);
    const arrow = createEl("span", "pb-log-arrow", "→");
    const targetCode = createEl("code", "", display);
    meta.append(sourceCode, arrow, targetCode);
    copy.append(title, meta);

    const time = createEl("span", "pb-log-time", relativeCompact(latest.blockedAt));
    row.append(mark, copy, time);
    els.latestBox.appendChild(row);
  }

  function defaultScanSub() {
    if (settings.enabled === false) return "当前未拦截任何链接";
    return "防护已开启 · 扫描本页链接";
  }

  function renderScanButton() {
    if (!els.scanButton) return;
    els.scanButton.classList.toggle("is-scanning", scanning);
    els.scanButton.classList.toggle(
      "is-powered-off",
      settings.enabled === false && !scanning
    );

    if (scanning) {
      els.scanLabel.textContent = "正在展开短链…";
      els.scanSub.textContent = "检查页面上的可疑 YouTube 链接";
      return;
    }

    if (settings.enabled === false) {
      els.scanLabel.textContent = "一键重启防护";
      els.scanSub.textContent = defaultScanSub();
      return;
    }

    els.scanLabel.textContent = hasScanned ? "再扫一次本页" : "一键全量拦截";
    els.scanSub.textContent = lastScanSummary || defaultScanSub();
  }

  function render() {
    const today = countToday();
    const total = Number(stats.totalBlocked || 0) || visits.length;
    const enabled = settings.enabled !== false;

    if (els.todayCount) {
      const text = today > 99 ? "99+" : String(today).padStart(2, "0");
      els.todayCount.textContent = text;
      els.todayCount.classList.toggle("is-off", !enabled);
    }
    if (els.heroCaption) {
      els.heroCaption.textContent = !enabled
        ? "防护已暂停"
        : today > 0
          ? "成功拦截 Rickroll"
          : "今天风平浪静";
    }
    if (els.powerToggle) {
      els.powerToggle.setAttribute("aria-pressed", String(enabled));
      els.powerToggle.title = enabled ? "点击暂停防护" : "点击恢复防护";
    }
    if (els.powerLabel) els.powerLabel.textContent = enabled ? "ON AIR" : "OFF AIR";
    if (els.totalCount) els.totalCount.textContent = String(total);

    renderWantedCards();
    renderLatest();
    renderScanButton();
  }

  function showToast(text) {
    if (!els.toast || !els.toastText) return;
    els.toastText.textContent = text;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("is-visible");
    }, 2800);
  }

  async function togglePower() {
    if (scanning) return;
    const nextEnabled = settings.enabled === false;
    settings = { ...settings, enabled: nextEnabled };
    await storageSet({ [K.settings]: settings });
    render();
    showToast(nextEnabled ? "全量防护已开启" : "防护已暂停 · 页面标记会移除");
  }

  async function persistEnabled() {
    const enabled = settings.enabled !== false;
    if (!enabled) {
      settings = { ...settings, enabled: true };
      await storageSet({ [K.settings]: settings });
      render();
    }
  }

  async function scanCurrentPage() {
    if (scanning) return;

    await persistEnabled();
    const tab = await getActiveTab();
    if (!tab || !/^https?:\/\//i.test(tab.url || "")) {
      showToast("当前页面无法扫描（Chrome 内置页或扩展页）");
      lastScanSummary = "当前页面不支持扫描";
      renderScanButton();
      return;
    }

    scanning = true;
    renderScanButton();

    const result = await sendToTab(tab.id, { type: M.scanPage });
    scanning = false;
    hasScanned = true;

    if (!result?.ok) {
      lastScanSummary = "无法扫描此页面 · 刷新页面后再试";
      renderScanButton();
      showToast(
        result?.error === "disabled"
          ? "防护刚刚被关闭，请重试"
          : "这个页面暂时无法扫描"
      );
      return;
    }

    const markedTotal = Number(result.markedTotal || 0);
    const discovered = Number(result.discovered || 0);
    const checked = Number(result.checked || 0);

    if (result.timedOut) {
      lastScanSummary =
        markedTotal > 0
          ? `本页已标记 ${markedTotal} 个 · 部分短链检查超时`
          : "部分链接检查超时 · 已保留已知标记";
      showToast("短链检查超时，先替你拦下已知链接");
    } else if (discovered > 0) {
      lastScanSummary = `本页新增 ${discovered} 个标记 · 已全部拦截`;
      showToast(`新发现 ${discovered} 个 Rickroll，已标记并拦截`);
    } else if (markedTotal > 0) {
      lastScanSummary = `本页已标记 ${markedTotal} 个链接`;
      showToast(`本页已标记 ${markedTotal} 个 Rickroll 链接`);
    } else if (checked > 0) {
      lastScanSummary = `检查 ${checked} 条可疑链接 · 未发现 Rickroll`;
      showToast("检查完成，本页没有发现 Rickroll");
    } else {
      lastScanSummary = "本页没有发现 Rickroll 链接";
      showToast("本页干净，继续上网吧");
    }

    renderScanButton();
  }

  async function openHistory() {
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("history/history.html"),
      });
      window.close();
    } catch (error) {
      showToast("无法打开记录页");
    }
  }

  function bindEvents() {
    els.powerToggle?.addEventListener("click", togglePower);
    els.scanButton?.addEventListener("click", scanCurrentPage);
    els.openHistory?.addEventListener("click", openHistory);
  }

  async function load() {
    const data = await storageGet([K.settings, K.visits, K.stats]);
    if (data[K.settings] && typeof data[K.settings] === "object") {
      settings = { ...C.DEFAULT_SETTINGS, ...data[K.settings] };
    }
    visits = Array.isArray(data[K.visits]) ? data[K.visits] : [];
    stats = data[K.stats] && typeof data[K.stats] === "object"
      ? data[K.stats]
      : { totalBlocked: 0 };
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[K.settings]) {
      settings = {
        ...C.DEFAULT_SETTINGS,
        ...(changes[K.settings].newValue || {}),
      };
    }
    if (changes[K.visits]) {
      visits = Array.isArray(changes[K.visits].newValue)
        ? changes[K.visits].newValue
        : [];
    }
    if (changes[K.stats]) {
      stats = changes[K.stats].newValue || { totalBlocked: 0 };
    }
    render();
  });

  bindEvents();
  load().catch(() => {
    render();
    showToast("读取本地状态失败");
  });
})();
