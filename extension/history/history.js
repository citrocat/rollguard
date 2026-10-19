(() => {
  "use strict";

  const C = globalThis.RollGuardConfig;
  const D = globalThis.RollGuardDetect;
  const K = C.STORAGE_KEYS;

  const $ = (id) => document.getElementById(id);
  let visits = [];
  let stats = { totalBlocked: 0 };
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

  function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function showToast(text) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
  }

  function dateParts(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const pad = (value) => String(value).padStart(2, "0");
    return {
      date: `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`,
      time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    };
  }

  function copyText(text, success = "原链接已复制") {
    if (!text) return;
    const done = () => showToast(success);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand("copy");
      done();
    } catch (error) {
      showToast("复制失败，请手动选择链接");
    }
    helper.remove();
  }

  function makeCopyButton(text) {
    const button = createEl("button", "hist-copy");
    button.type = "button";
    button.title = "复制原链";
    button.setAttribute("aria-label", "复制原链");
    button.innerHTML =
      '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
    button.addEventListener("click", () => copyText(text));
    return button;
  }

  function renderRecords() {
    const list = $("recordList");
    const empty = $("emptyState");
    if (!list || !empty) return;

    list.replaceChildren();
    const sorted = [...visits].sort((a, b) => (b.blockedAt || 0) - (a.blockedAt || 0));
    const total = Number(stats.totalBlocked || 0) || sorted.length;

    if (!sorted.length) {
      empty.hidden = false;
      list.hidden = true;
      $("recordCount").textContent = "0";
      return;
    }

    empty.hidden = true;
    list.hidden = false;
    sorted.forEach((visit, index) => {
      const recordNumber = Math.max(1, total - index);
      const time = dateParts(visit.blockedAt);
      const article = createEl("article", "hist-record");
      const indexBox = createEl("div", "hist-record-index");
      indexBox.append(
        createEl("b", "", `#${String(recordNumber).padStart(3, "0")}`),
        createEl("span", "", `${time.date}\n${time.time}`)
      );

      const main = createEl("div", "hist-record-main");
      const title = createEl("h3", "", visit.title || "未命名 Rickroll");
      title.title = visit.title || "";
      const meta = createEl("div", "hist-record-meta");
      const source = visit.sourceHost || "直接访问";
      meta.append(
        createEl("code", "", source),
        createEl("span", "hist-meta-arrow", "→"),
        createEl("code", "", visit.displayUrl || visit.abbreviation || "youtu.be/…")
      );
      if (visit.reasonLabel || visit.reason) {
        meta.appendChild(
          createEl("span", "hist-record-reason", visit.reasonLabel || D.reasonLabel(visit.reason))
        );
      }
      const url = createEl("p", "hist-record-url", visit.targetUrl || D.fullVideoUrl(visit.videoId));
      url.title = visit.targetUrl || "";

      main.append(title, meta, url);

      const side = createEl("div", "hist-record-side");
      side.append(
        createEl("span", "hist-chip", "已拦截"),
        makeCopyButton(visit.targetUrl || D.fullVideoUrl(visit.videoId))
      );

      article.append(indexBox, main, side);
      list.appendChild(article);
    });

    $("recordCount").textContent = String(sorted.length);
  }

  function render() {
    const records = [...visits].sort((a, b) => (b.blockedAt || 0) - (a.blockedAt || 0));
    const total = Number(stats.totalBlocked || 0) || records.length;
    const today = records.filter((visit) => D.isSameLocalDay(visit.blockedAt)).length;
    $("totalCount").textContent = String(total);
    $("todayCount").textContent = String(today);
    $("archiveNumber").textContent = String(total).padStart(3, "0");
    $("recordCount").textContent = String(records.length);
    renderRecords();
  }

  async function load() {
    const data = await storageGet([K.visits, K.stats]);
    visits = Array.isArray(data[K.visits]) ? data[K.visits] : [];
    stats = data[K.stats] && typeof data[K.stats] === "object"
      ? data[K.stats]
      : { totalBlocked: 0 };
    render();
  }

  function exportJson() {
    const payload = {
      product: "RollGuard",
      exportedAt: new Date().toISOString(),
      totalBlocked: Number(stats.totalBlocked || 0) || visits.length,
      visits,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `rollguard-history-${date}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("记录已导出为 JSON");
  }

  async function clearHistory() {
    if (!visits.length) {
      showToast("记录本来就是空的");
      return;
    }
    const ok = window.confirm("清空全部本地拦截记录？这个操作无法撤销。");
    if (!ok) return;

    visits = [];
    stats = { totalBlocked: 0, updatedAt: Date.now() };
    await storageSet({
      [K.visits]: [],
      [K.stats]: stats,
    });
    render();
    showToast("本地记录已清空");
  }

  function goBack() {
    if (history.length > 1) {
      history.back();
    } else {
      window.close();
      showToast("没有可返回的上一页，可以直接关闭这个标签页");
    }
  }

  $("exportButton")?.addEventListener("click", exportJson);
  $("clearButton")?.addEventListener("click", clearHistory);
  $("backButton")?.addEventListener("click", goBack);
  $("goBack")?.addEventListener("click", (event) => {
    event.preventDefault();
    goBack();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
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

  load().catch(() => {
    render();
    showToast("读取本地记录失败");
  });
})();
