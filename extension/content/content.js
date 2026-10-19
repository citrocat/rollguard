/*
 * RollGuard content script.
 * - Marks known Rickroll links on every web page.
 * - Intercepts clicks before the page can navigate.
 * - Resolves suspicious shortened links through the service worker.
 * - Watches YouTube for title/metadata matches.
 */
(() => {
  "use strict";

  const C = globalThis.RollGuardConfig;
  const D = globalThis.RollGuardDetect;
  if (!C || !D || globalThis.__rollGuardContentLoaded) return;
  globalThis.__rollGuardContentLoaded = true;

  const K = C.STORAGE_KEYS;
  const M = C.MESSAGE;
  const MARK_CLASS = "rg-blocked-link";
  const INLINE_CLASS = "rg-inline-link";
  const MEDIA_CLASS = "rg-media-link";
  const CARD_TOP_CLASS = "rg-card-top";
  const CARD_CORNER_CLASS = "rg-card-corner";
  const DATA_ATTRS = [
    "rgMarked",
    "rgHref",
    "rgVideoId",
    "rgAbbr",
    "rgTargetUrl",
    "rgTitle",
    "rgChannel",
    "rgReason",
    "rgShort",
  ];

  let enabled = true;
  let observer = null;
  let scanTimer = null;
  let youtubeTimer = null;
  let toastTimer = null;
  let resolvingClick = false;
  let initialized = false;
  let handledYoutubeHref = "";
  let lastYoutubeAttempt = 0;
  let youtubeListenersBound = false;
  const marked = new Map();

  const isYouTubeHost = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(
    location.hostname
  );

  function safeStorageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (data) => resolve(data || {}));
      } catch (error) {
        resolve({});
      }
    });
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) resolve({ ok: false, error: error.message });
          else resolve(response ?? { ok: false, error: "No response" });
        });
      } catch (error) {
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function isMarked(anchor) {
    return marked.has(anchor);
  }

  function truncate(value, max = 220) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function visibleRect(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return null;
    }
    return rect;
  }

  function largestVisibleImage(anchor) {
    let best = null;
    for (const image of anchor.querySelectorAll("img, video, canvas")) {
      const rect = visibleRect(image);
      if (!rect || rect.width < 48 || rect.height < 36) continue;
      if (!best || rect.width * rect.height > best.width * best.height) {
        best = { width: rect.width, height: rect.height, top: rect.top };
      }
    }
    return best;
  }

  function classifyAnchor(anchor) {
    // Ignore zero-sized duplicates commonly present in search-engine markup.
    const rect = visibleRect(anchor);
    if (!rect || rect.width < 18 || rect.height < 12) return null;

    if (anchor.closest("ytd-thumbnail, ytd-playlist-thumbnail")) return "media";

    const image = largestVisibleImage(anchor);
    if (!image) return "inline";

    const text = (anchor.innerText || "").replace(/\s+/g, " ").trim();
    const areaShare = (image.width * image.height) / (rect.width * rect.height);
    const heightShare = image.height / rect.height;
    const widthShare = image.width / rect.width;

    // A thumbnail-only link (possibly with a duration overlay) is pure media.
    if (areaShare >= 0.55 && (heightShare >= 0.82 || text.length <= 18)) return "media";

    // A card with a top-edge image gets a strip on the image, never over the
    // title or metadata below it. Side-image cards get a compact corner badge.
    if (widthShare >= 0.78 && image.top - rect.top <= 12) return "card-top";
    return "card-corner";
  }

  function applyMarker(anchor, info) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    if (isMarked(anchor)) return false;
    if (!enabled) return false;

    const href = anchor.href;
    if (!/^https?:\/\//i.test(href)) return false;

    const kind = classifyAnchor(anchor);
    if (!kind) return false;
    const videoId = info.videoId || "";
    const abbreviation = videoId ? D.abbreviateVideoId(videoId) : "";
    const title = truncate(info.title || "");
    const channel = truncate(info.channel || "");
    const targetUrl = info.targetUrl || href;
    const reason = info.reason || "known";

    anchor.classList.add(MARK_CLASS);
    anchor.classList.add(
      kind === "media"
        ? MEDIA_CLASS
        : kind === "card-top"
          ? CARD_TOP_CLASS
          : kind === "card-corner"
            ? CARD_CORNER_CLASS
            : INLINE_CLASS
    );
    anchor.dataset.rgMarked = "1";
    anchor.dataset.rgHref = href;
    anchor.dataset.rgVideoId = videoId;
    anchor.dataset.rgAbbr = abbreviation;
    anchor.dataset.rgTargetUrl = targetUrl;
    anchor.dataset.rgTitle = title;
    anchor.dataset.rgChannel = channel;
    anchor.dataset.rgReason = reason;
    anchor.dataset.rgShort = info.shortLink || "";

    const record = {
      videoId,
      title,
      channel,
      targetUrl,
      reason,
      shortLink: info.shortLink || "",
      previousTitle: anchor.getAttribute("title"),
      positionApplied: false,
    };

    // A small tooltip carries the full target while the visual badge stays
    // compact. The original title is restored when marking is removed.
    try {
      anchor.title = `RollGuard 已标记${title ? `：${title}` : ""}${
        videoId ? ` · 原链 youtube.com/watch?v=${videoId}` : ""
      }${abbreviation ? ` · 缩写 ${abbreviation}` : ""}`;
    } catch (error) {
      // Some element wrappers disallow arbitrary properties; the class still works.
    }

    if (kind !== "inline") {
      const computed = getComputedStyle(anchor);
      if (computed.position === "static") {
        anchor.style.setProperty("position", "relative", "important");
        record.positionApplied = true;
      }
    }

    marked.set(anchor, record);
    return true;
  }

  function removeMarker(anchor) {
    const record = marked.get(anchor);
    if (!record) return;
    anchor.classList.remove(
      MARK_CLASS,
      INLINE_CLASS,
      MEDIA_CLASS,
      CARD_TOP_CLASS,
      CARD_CORNER_CLASS
    );
    for (const attr of DATA_ATTRS) delete anchor.dataset[attr];

    if (record.previousTitle === null) {
      anchor.removeAttribute("title");
    } else {
      anchor.setAttribute("title", record.previousTitle);
    }

    if (record.positionApplied) {
      anchor.style.removeProperty("position");
    }
    marked.delete(anchor);
  }

  function clearAllMarkers() {
    for (const anchor of [...marked.keys()]) {
      removeMarker(anchor);
    }
  }

  function syncExistingMarkers() {
    for (const anchor of [...marked.keys()]) {
      if (anchor.dataset.rgHref !== anchor.href) {
        removeMarker(anchor);
      }
    }
  }

  function knownInfoFor(anchor) {
    const parsed = D.parseLink(anchor.href, location.href);
    if (!parsed?.isYouTube || !parsed.videoId) return null;
    if (!D.isKnownVideo(parsed.videoId)) return null;
    const seed = D.getSeedVideo(parsed.videoId);
    if (!seed) return null;
    return {
      videoId: parsed.videoId,
      title: seed.title,
      channel: seed.channel,
      targetUrl: anchor.href,
      reason: "known",
    };
  }

  function scanKnownLinks() {
    if (!enabled) return 0;
    syncExistingMarkers();

    const anchors = document.querySelectorAll("a[href]");
    let newlyMarked = 0;

    for (const anchor of anchors) {
      if (newlyMarked >= 200) break;
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      if (anchor.closest("#rg-toast")) continue;
      if (marked.has(anchor)) continue;

      const href = anchor.href;
      if (!/^https?:\/\//i.test(href)) continue;

      const info = knownInfoFor(anchor);
      if (info && applyMarker(anchor, info)) {
        newlyMarked += 1;
      }
    }

    return newlyMarked;
  }

  function scheduleScan() {
    if (!enabled || scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanKnownLinks();
      checkYouTubePage();
    }, 220);
  }

  function ensureObserver() {
    if (observer || !enabled) return;
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          scheduleScan();
          return;
        }
        if (mutation.addedNodes.length) {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function showToast(text, { persistent = false } = {}) {
    if (!document.documentElement) return;
    let node = document.getElementById("rg-toast");
    if (!node) {
      node = document.createElement("div");
      node.id = "rg-toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      const mark = document.createElement("span");
      mark.className = "rg-toast-mark";
      mark.textContent = "R!";
      const label = document.createElement("span");
      label.className = "rg-toast-text";
      node.append(mark, label);
      document.documentElement.appendChild(node);
    }
    const label = node.querySelector(".rg-toast-text");
    if (label) label.textContent = text;
    node.classList.add("rg-toast-visible");

    if (toastTimer) clearTimeout(toastTimer);
    if (!persistent) {
      toastTimer = window.setTimeout(() => hideToast(), 2800);
    }
  }

  function hideToast() {
    const node = document.getElementById("rg-toast");
    if (node) node.classList.remove("rg-toast-visible");
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function pauseVideos() {
    for (const video of document.querySelectorAll("video")) {
      try {
        video.pause();
        video.muted = true;
      } catch (error) {
        // Some players can reject pause while loading; redirect follows anyway.
      }
    }
  }

  function getYouTubeTitle() {
    const candidates = [
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent,
      document.querySelector("h1.title yt-formatted-string")?.textContent,
      document.querySelector("meta[property='og:title']")?.getAttribute("content"),
      document.title,
    ];
    for (const candidate of candidates) {
      const clean = D.normalizeTitle(candidate).replace(/\s*-\s*YouTube\s*$/i, "");
      if (clean) return clean;
    }
    return "";
  }

  function getYouTubeChannel() {
    const candidates = [
      document.querySelector("ytd-watch-metadata #owner #channel-name a")?.textContent,
      document.querySelector("#owner #channel-name a")?.textContent,
      document.querySelector("link[itemprop='name']")?.getAttribute("content"),
      document.querySelector("meta[itemprop='author']")?.getAttribute("content"),
    ];
    for (const candidate of candidates) {
      const clean = D.normalizeTitle(candidate);
      if (clean) return clean;
    }
    return "";
  }

  async function blockCurrentYouTubePage({ videoId, title, channel, reason }) {
    if (!enabled) return;
    const targetUrl = location.href;
    const now = Date.now();
    if (handledYoutubeHref === targetUrl && now - lastYoutubeAttempt < 3500) {
      return;
    }
    handledYoutubeHref = targetUrl;
    lastYoutubeAttempt = now;

    pauseVideos();
    const response = await sendMessage({
      type: M.blockCurrentPage,
      url: targetUrl,
      videoId,
      title,
      channel,
      reason,
      sourceUrl: document.referrer || "",
    });
    if (!response?.ok) {
      handledYoutubeHref = "";
    }
  }

  function checkYouTubePage() {
    if (!enabled || !isYouTubeHost) return;

    const parsed = D.parseLink(location.href);
    if (!parsed?.isYouTube || !parsed.videoId) return;

    const seed = D.getSeedVideo(parsed.videoId);
    if (seed) {
      if (handledYoutubeHref === location.href && Date.now() - lastYoutubeAttempt < 3500) {
        return;
      }
      blockCurrentYouTubePage({
        videoId: parsed.videoId,
        title: seed.title,
        channel: seed.channel,
        reason: "known",
      });
      return;
    }

    const title = getYouTubeTitle();
    const channel = getYouTubeChannel();
    const match = D.classifyVideo({
      videoId: parsed.videoId,
      title,
      channel,
    });
    if (!match) return;
    if (handledYoutubeHref === location.href && Date.now() - lastYoutubeAttempt < 3500) {
      return;
    }

    blockCurrentYouTubePage({
      videoId: parsed.videoId,
      title: match.title || title,
      channel: match.channel || channel,
      reason: match.reason || "page",
    });
  }

  function startYouTubeWatch() {
    if (!isYouTubeHost) return;
    if (!youtubeTimer) {
      youtubeTimer = window.setInterval(checkYouTubePage, 1100);
    }

    if (!youtubeListenersBound) {
      youtubeListenersBound = true;
      const onNavigate = () => {
        handledYoutubeHref = "";
        window.setTimeout(() => {
          scanKnownLinks();
          checkYouTubePage();
        }, 350);
      };
      document.addEventListener("yt-navigate-finish", onNavigate, true);
      document.addEventListener("yt-page-data-updated", onNavigate, true);
      window.addEventListener("popstate", () => {
        handledYoutubeHref = "";
        scheduleScan();
      });
    }

    checkYouTubePage();
  }

  function stopYouTubeWatch() {
    if (youtubeTimer) {
      clearInterval(youtubeTimer);
      youtubeTimer = null;
    }
  }

  async function deepScan() {
    if (!enabled) {
      return { ok: false, error: "disabled", markedTotal: marked.size };
    }

    const knownMarked = scanKnownLinks();
    const anchors = [...document.querySelectorAll("a[href]")];
    const candidateAnchors = new Map();
    let checkedCandidateCount = 0;

    for (const anchor of anchors) {
      if (!(anchor instanceof HTMLAnchorElement)) continue;
      if (marked.has(anchor)) continue;
      if (anchor.closest("#rg-toast")) continue;
      if (checkedCandidateCount >= C.PAGE_CANDIDATE_LIMIT) break;

      const parsed = D.parseLink(anchor.href);
      if (!parsed) continue;
      const isUnknownYoutube =
        parsed.isYouTube && parsed.videoId && !D.isKnownVideo(parsed.videoId);
      if (!isUnknownYoutube && !parsed.isShortener) continue;

      const url = anchor.href;
      if (!candidateAnchors.has(url)) candidateAnchors.set(url, []);
      candidateAnchors.get(url).push(anchor);
      checkedCandidateCount = candidateAnchors.size;
    }

    if (!candidateAnchors.size) {
      return {
        ok: true,
        enabled,
        knownMarked,
        checked: 0,
        discovered: 0,
        markedTotal: marked.size,
      };
    }

    const response = await Promise.race([
      sendMessage({
        type: M.probeCandidates,
        candidates: [...candidateAnchors.keys()],
        sourceUrl: location.href,
      }),
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: false, error: "timeout" }), 12_000);
      }),
    ]);

    let discovered = 0;
    if (response?.ok && Array.isArray(response.results)) {
      for (const result of response.results) {
        if (!result?.blocked) continue;
        const matchedAnchors = candidateAnchors.get(result.url) || [];
        const video = result.video || {};
        for (const anchor of matchedAnchors) {
          if (
            applyMarker(anchor, {
              videoId: video.videoId || D.getVideoId(result.finalUrl) || "",
              title: video.title || "",
              channel: video.channel || "",
              targetUrl: result.finalUrl || anchor.href,
              reason: result.reason || "title",
              shortLink: result.url,
            })
          ) {
            discovered += 1;
          }
        }
      }
    }

    return {
      ok: true,
      enabled,
      knownMarked,
      checked: candidateAnchors.size,
      discovered,
      markedTotal: marked.size,
      timedOut: response?.error === "timeout",
    };
  }

  async function handleShortLink(anchor, parsed) {
    if (resolvingClick) return;
    resolvingClick = true;
    const originalHref = anchor.href;
    showToast("RollGuard 正在展开短链…", { persistent: true });

    try {
      const result = await sendMessage({
        type: M.checkShortLink,
        url: originalHref,
        sourceUrl: location.href,
      });

      if (!enabled) {
        window.location.href = originalHref;
        return;
      }

      if (result?.blocked) {
        showToast("短链已展开 · Rickroll 已拦截", { persistent: true });
        await sendMessage({
          type: M.blockLink,
          targetUrl: result.finalUrl || originalHref,
          videoId: result.video?.videoId || D.getVideoId(result.finalUrl) || "",
          title: result.video?.title || "",
          channel: result.video?.channel || "",
          reason: "shortlink",
          shortLink: originalHref,
          sourceUrl: location.href,
        });
        return;
      }

      hideToast();
      window.location.href = originalHref;
    } catch (error) {
      hideToast();
      window.location.href = originalHref;
    } finally {
      resolvingClick = false;
    }
  }

  function onClickCapture(event) {
    if (!enabled) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const target = event.target;
    if (!isElement(target)) return;
    const anchor = target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (anchor.closest("#rg-toast")) return;

    const record = marked.get(anchor);
    if (record) {
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast("RollGuard 已拦截这次跳转");
      sendMessage({
        type: M.blockLink,
        targetUrl: record.targetUrl || anchor.href,
        videoId: record.videoId || "",
        title: record.title || "",
        channel: record.channel || "",
        reason: "click",
        shortLink: record.shortLink || "",
        sourceUrl: location.href,
      });
      return;
    }

    const parsed = D.parseLink(anchor.href);
    if (!parsed) return;

    if (parsed.isYouTube && parsed.videoId && D.isKnownVideo(parsed.videoId)) {
      const seed = D.getSeedVideo(parsed.videoId);
      event.preventDefault();
      event.stopImmediatePropagation();
      showToast("RollGuard 已拦截这次跳转");
      sendMessage({
        type: M.blockLink,
        targetUrl: anchor.href,
        videoId: parsed.videoId,
        title: seed?.title || "",
        channel: seed?.channel || "",
        reason: "known",
        sourceUrl: location.href,
      });
      return;
    }

    if (parsed.isShortener) {
      if (resolvingClick) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      handleShortLink(anchor, parsed);
    }
  }

  async function setEnabled(nextEnabled) {
    if (enabled === nextEnabled && initialized) return;
    enabled = nextEnabled;

    if (!enabled) {
      stopObserver();
      stopYouTubeWatch();
      hideToast();
      clearAllMarkers();
      return;
    }

    ensureObserver();
    if (isYouTubeHost) startYouTubeWatch();
    await new Promise((resolve) => setTimeout(resolve, 80));
    scanKnownLinks();
    checkYouTubePage();
  }

  async function init() {
    document.addEventListener("click", onClickCapture, true);
    const data = await safeStorageGet([K.settings]);
    enabled = data[K.settings]?.enabled !== false;
    initialized = true;

    if (enabled) {
      ensureObserver();
      scanKnownLinks();
      if (isYouTubeHost) {
        startYouTubeWatch();
        checkYouTubePage();
      }
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[K.settings]) return;
      const nextEnabled = changes[K.settings].newValue?.enabled !== false;
      setEnabled(nextEnabled);
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== M.scanPage) return false;

    (async () => {
      if (!enabled) {
        const data = await safeStorageGet([K.settings]);
        enabled = data[K.settings]?.enabled !== false;
      }
      if (!enabled) {
        sendResponse({ ok: false, error: "disabled", markedTotal: marked.size });
        return;
      }

      try {
        const result = await deepScan();
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          markedTotal: marked.size,
        });
      }
    })();

    return true;
  });

  init().catch((error) => {
    console.warn("[RollGuard] content init failed:", error);
  });
})();
