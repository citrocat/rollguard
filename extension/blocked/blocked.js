(() => {
  "use strict";

  const C = globalThis.RollGuardConfig;
  const D = globalThis.RollGuardDetect;
  const K = C.STORAGE_KEYS;

  const params = new URLSearchParams(location.search);
  const visitId = params.get("visitId") || "";
  const returnUrl = params.get("returnUrl") || "";
  const officialThumbnail = "../assets/official-4k.jpg";

  const $ = (id) => document.getElementById(id);
  let currentVisit = null;
  let toastTimer = null;

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text || "";
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (data) => resolve(data || {}));
      } catch (error) {
        resolve({});
      }
    });
  }

  function showToast(text) {
    const toast = $("toast");
    if (!toast) return;
    setText("toastText", text);
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2400);
  }

  function isSafeReturnUrl(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (currentVisit?.targetUrl && url === currentVisit.targetUrl) return false;
    const sourceId = D.getVideoId(url);
    if (sourceId && currentVisit?.videoId && sourceId === currentVisit.videoId) return false;
    return true;
  }

  async function goSafe() {
    if (isSafeReturnUrl(returnUrl)) {
      location.replace(returnUrl);
      return;
    }
    if (isSafeReturnUrl(currentVisit?.sourceUrl)) {
      location.replace(currentVisit.sourceUrl);
      return;
    }
    if (history.length > 1) {
      history.back();
      return;
    }
    showToast("没有可返回的上一页了，请手动关闭此标签页。");
  }

  async function copyOriginal() {
    const text = currentVisit?.targetUrl || $("targetUrl")?.textContent || "";
    if (!text) {
      showToast("没有可复制的原链");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      try {
        document.execCommand("copy");
      } catch (fallbackError) {
        // The toast still explains what happened.
      }
      helper.remove();
    }

    showToast("原链接已复制（短链已展开）");
    const button = $("copyLink");
    if (button) {
      button.textContent = "已复制 ✓";
      setTimeout(() => {
        button.textContent = "复制原链";
      }, 1800);
    }
  }

  function openHistory() {
    location.href = chrome.runtime.getURL("history/history.html");
  }

  function renderVisit(visit, stats) {
    if (!visit) {
      setText("sourceValue", "本地记录未找到");
      setText("sourceUrlValue", "这条拦截可能已经被清理。");
      setText("targetTitle", "未知的 Rickroll 目标");
      setText("targetChannel", "没有读取到视频信息");
      setText("targetUrl", "—");
      setText("shortUrl", "—");
      setText("reasonValue", "已拦截");
      setText("timeValue", "刚刚");
      document.title = "RollGuard · Rickroll 已拦截";
      return;
    }

    currentVisit = visit;
    const seed = D.getSeedVideo(visit.videoId);
    const count = Number(stats?.totalBlocked || 0) || 1;
    const number = String(count).padStart(3, "0");
    const displaySource = visit.sourceHost || (visit.sourceUrl ? D.hostOf(visit.sourceUrl) : "") || "直接访问";
    const sourceDetailParts = [];
    if (visit.sourceUrl) sourceDetailParts.push(visit.sourceUrl);
    if (visit.shortLink && visit.shortLink !== visit.sourceUrl) {
      sourceDetailParts.push(`短链 ${visit.shortLink}`);
    }

    setText("blockNumber", number);
    setText("localCount", String(count));
    setText("countValue", String(count));
    setText("sourceValue", displaySource);
    setText("sourceUrlValue", sourceDetailParts.join(" · "));
    setText("targetTitle", visit.title || "Unknown Rickroll");
    setText(
      "targetChannel",
      [visit.channel, visit.videoId ? `ID ${visit.videoId}` : ""].filter(Boolean).join(" · ")
    );
    setText("targetUrl", visit.targetUrl || (visit.videoId ? D.fullVideoUrl(visit.videoId) : "—"));
    setText("shortUrl", visit.abbreviation || (visit.videoId ? D.abbreviatedLink(visit.videoId) : "—"));
    setText("reasonValue", visit.reasonLabel || D.reasonLabel(visit.reason));
    setText("timeValue", `刚刚 · ${D.formatTimestamp(visit.blockedAt || Date.now())}`);

    const hero = $("heroImage");
    if (hero) hero.src = seed?.thumbnail ? `../${seed.thumbnail}` : officialThumbnail;
    document.title = `已拦截 · ${visit.title || "Rickroll"} — RollGuard`;
  }

  async function load() {
    const data = await storageGet([K.visits, K.stats]);
    const visits = Array.isArray(data[K.visits]) ? data[K.visits] : [];
    const stats = data[K.stats] || { totalBlocked: 0 };
    const visit = visits.find((item) => item.id === visitId) || null;
    renderVisit(visit, stats);
  }

  $("safeReturn")?.addEventListener("click", goSafe);
  $("copyLink")?.addEventListener("click", copyOriginal);
  $("openHistory")?.addEventListener("click", openHistory);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") goSafe();
  });

  load().catch(() => {
    showToast("没有读取到这条本地记录");
  });
})();
