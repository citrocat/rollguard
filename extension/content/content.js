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
  const BLOCK_CLASS = "rg-block-link";
  const MEDIA_CLASS = "rg-media-link";
  const RESULT_CLASS = "rg-result-link";
  const BLACKOUT_CLASS = "rg-blackout";
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
  let overlayFrame = null;
  let overlaySettleTimer = null;
  let pruneTimer = null;
  let overlayResizeObserver = null;
  let layerRoot = null;
  let pageCountTimer = null;
  const marked = new Map();
  const BLOCK_SIDE_WIDTH = 154;

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
        best = {
          element: image,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
        };
      }
    }
    return best;
  }

  function classifyAnchor(anchor) {
    // Ignore zero-sized duplicates commonly present in search-engine markup.
    const rect = visibleRect(anchor);
    if (!rect || rect.width < 18 || rect.height < 12) return null;

    // Google video results wrap an <h3> title and a breadcrumb <cite> in the
    // same anchor. Treating that mixed block as an inline link breaks the
    // line boxes and makes the inline label inherit Google's flip transform.
    if (anchor.querySelector("h3") && anchor.querySelector("cite")) {
      return { kind: "result", rect, image: null };
    }

    const image = largestVisibleImage(anchor);
    if (anchor.closest("ytd-thumbnail, ytd-playlist-thumbnail")) {
      return { kind: "media", rect, image };
    }
    if (!image) {
      const display = getComputedStyle(anchor).display;
      const textLength = (anchor.innerText || "").replace(/\s+/g, " ").trim().length;
      const blockLike =
        rect.width >= 300 &&
        rect.height >= 44 &&
        (display !== "inline" || anchor.getClientRects().length > 1 || textLength >= 80);
      return { kind: blockLike ? "block" : "inline", rect, image: null };
    }

    const areaShare = (image.width * image.height) / (rect.width * rect.height);
    if (areaShare < 0.22 && image.width < rect.width * 0.7) {
      return { kind: "inline", rect, image: null };
    }
    return { kind: "media", rect, image };
  }

  // Overlay placement. The Split Slab side panel, the Blackout veil and the
  // Google result tag are real elements rather than anchor pseudo-elements.
  // Whenever the marked link can host upright children, the overlay becomes a
  // child of the link and is laid out in the link's own box, so the browser
  // scrolls, clips and stacks it together with the link — fast scrolling or a
  // nested scroller can no longer leave it behind. Links inside mirrored or
  // rotated subtrees (Google's flipped video results) and inline links fall
  // back to a document-level layer positioned in document coordinates, which
  // still moves with page scrolling and is re-synced for nested scrollers.

  function isUprightSubtree(element) {
    let flipX = false;
    let flipY = false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.transform && style.transform !== "none") {
        let matrix;
        try {
          matrix = new DOMMatrixReadOnly(style.transform);
        } catch (error) {
          return false;
        }
        if (Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6) return false;
        if (matrix.a < 0) flipX = !flipX;
        if (matrix.d < 0) flipY = !flipY;
      }
      if (style.rotate && style.rotate !== "none" && parseFloat(style.rotate) % 360 !== 0) {
        return false;
      }
      if (style.scale && style.scale !== "none") {
        const [scaleX, scaleY = scaleX] = style.scale.split(/\s+/).map(parseFloat);
        if (scaleX < 0) flipX = !flipX;
        if (scaleY < 0) flipY = !flipY;
      }
    }
    return !flipX && !flipY;
  }

  function canHostOverlay(anchor) {
    const display = getComputedStyle(anchor).display;
    if (display === "inline" || display === "contents" || display === "none") return false;
    return isUprightSubtree(anchor);
  }

  function hasPinnedAncestor(element) {
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  }

  function ensureLayer() {
    if (!layerRoot) {
      layerRoot = document.createElement("rollguard-layer");
      layerRoot.setAttribute("aria-hidden", "true");
    }
    if (!layerRoot.isConnected) (document.body || document.documentElement).append(layerRoot);
    return layerRoot;
  }

  // The veil should follow the rounded corners of whatever visibly frames the
  // image: the image itself or a same-sized wrapper inside the link.
  function veilRadius(target, anchor) {
    const targetRect = target.getBoundingClientRect();
    for (let node = target; node instanceof Element; node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const sameBox =
        Math.abs(rect.width - targetRect.width) < 3 && Math.abs(rect.height - targetRect.height) < 3;
      if (!sameBox) break;
      const radius = getComputedStyle(node).borderRadius;
      if (radius && !/^0(px)?$/.test(radius)) return radius;
      if (node === anchor) break;
    }
    return "2px";
  }

  // Overlay labels are rendered through pseudo-elements so a hosted overlay
  // never adds text nodes to the page's own link.
  function createOverlay(kind, abbreviation) {
    if (kind === "block") {
      const side = document.createElement("rollguard-side-panel");
      side.className = "rg-block-side";
      side.dataset.rgAbbr = abbreviation || "BLOCKED";
      return side;
    }
    if (kind === "media") {
      const veil = document.createElement("rollguard-blackout");
      veil.className = "rg-blackout-overlay";
      const stamp = document.createElement("rollguard-stamp");
      stamp.className = "rg-blackout-stamp";
      stamp.dataset.rgAbbr = abbreviation || "BLOCKED";
      veil.append(stamp);
      return veil;
    }
    const badge = document.createElement("rollguard-result-mark");
    badge.className = "rg-result-mark";
    badge.dataset.rgLabel = `! RICKROLL${abbreviation ? ` / ${abbreviation}` : ""}`;
    return badge;
  }

  function mountOverlay(record) {
    const parent = record.host || ensureLayer();
    if (record.overlay.parentNode !== parent) parent.append(record.overlay);
  }

  function attachOverlay(anchor, record, kind, image) {
    const target =
      kind === "media"
        ? image?.element || anchor
        : kind === "result"
          ? anchor.querySelector("cite") || anchor
          : anchor;
    // Google's h3 + cite result anchors always use the upright layer.
    const hosted = kind !== "result" && canHostOverlay(anchor);
    const overlay = createOverlay(kind, record.abbreviation);
    overlay.setAttribute("aria-hidden", "true");
    overlay.dataset.rgMode = hosted ? "hosted" : "layer";
    if (kind === "media") {
      overlay.style.setProperty("--rg-veil-radius", veilRadius(target, anchor));
    }

    record.overlay = overlay;
    record.overlayKind = kind;
    record.overlayTarget = target;
    record.host = hosted ? anchor : null;
    record.pinned = !hosted && hasPinnedAncestor(target);

    if (hosted && getComputedStyle(anchor).position === "static") {
      anchor.style.setProperty("position", "relative", "important");
      record.positionApplied = true;
    }

    mountOverlay(record);
    if (!overlayResizeObserver && typeof ResizeObserver !== "undefined") {
      overlayResizeObserver = new ResizeObserver(() => scheduleOverlaySync());
    }
    overlayResizeObserver?.observe(anchor);
    if (target !== anchor) overlayResizeObserver?.observe(target);
    scheduleOverlaySync({ settle: true });
  }

  function detachOverlay(anchor, record) {
    if (!record.overlay) return;
    record.overlay.remove();
    overlayResizeObserver?.unobserve(anchor);
    if (record.overlayTarget && record.overlayTarget !== anchor) {
      overlayResizeObserver?.unobserve(record.overlayTarget);
    }
    record.overlay = null;
    record.overlayTarget = null;
    record.host = null;
  }

  // Box of the overlay target in the overlay's own containing block: the
  // link's padding box when hosted, the document-level layer otherwise.
  function measureOverlay(record, layerRect) {
    const rect = record.overlayTarget.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;

    let originLeft = layerRect?.left || 0;
    let originTop = layerRect?.top || 0;
    let scaleX = 1;
    let scaleY = 1;
    if (record.host) {
      const host = record.host;
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width && host.offsetWidth) scaleX = hostRect.width / host.offsetWidth;
      if (hostRect.height && host.offsetHeight) scaleY = hostRect.height / host.offsetHeight;
      originLeft = hostRect.left + host.clientLeft * scaleX;
      originTop = hostRect.top + host.clientTop * scaleY;
    }

    return {
      top: (rect.top - originTop) / scaleY,
      left: (rect.left - originLeft) / scaleX,
      width: rect.width / scaleX,
      height: rect.height / scaleY,
    };
  }

  function setOverlayBox(overlay, box) {
    for (const [property, value] of Object.entries(box)) {
      overlay.style.setProperty(property, `${value}px`, "important");
    }
  }

  function applyOverlay(record, box) {
    const { overlay, overlayKind: kind } = record;
    if (!box) {
      overlay.style.setProperty("display", "none", "important");
      return;
    }
    overlay.style.removeProperty("display");

    if (kind === "media") {
      setOverlayBox(overlay, box);
      const stampSize = Math.max(9, Math.min(31, box.width / 8.5));
      overlay.style.setProperty("--rg-stamp-size", `${stampSize.toFixed(1)}px`);
    } else if (kind === "block") {
      setOverlayBox(overlay, {
        top: box.top,
        left: box.left + box.width - BLOCK_SIDE_WIDTH,
        height: box.height,
      });
    } else {
      setOverlayBox(overlay, { top: box.top, left: box.left + box.width + 8 });
    }
  }

  function syncOverlays() {
    overlayFrame = null;

    // Structural writes first: drop marks whose link left the DOM and
    // re-mount overlays that the page removed while re-rendering.
    for (const [anchor, record] of marked) {
      if (!anchor.isConnected) removeMarker(anchor);
      else if (record.overlay && !record.overlay.isConnected) mountOverlay(record);
    }

    // Then read every box before writing any of them, so a page with many
    // marks costs one layout per frame instead of one per overlay.
    const jobs = [];
    let layerRect = null;
    for (const record of marked.values()) {
      if (!record.overlay) continue;
      // A hosted side panel is docked by CSS alone.
      if (record.host && record.overlayKind === "block") continue;
      if (!record.host && !layerRect) layerRect = ensureLayer().getBoundingClientRect();
      jobs.push([record, measureOverlay(record, layerRect)]);
    }
    for (const [record, box] of jobs) applyOverlay(record, box);
  }

  function scheduleOverlaySync({ settle = false } = {}) {
    if (!marked.size) return;
    if (!overlayFrame) overlayFrame = window.requestAnimationFrame(syncOverlays);
    // Late image decoding and web fonts can still move a freshly marked link.
    if (settle && !overlaySettleTimer) {
      overlaySettleTimer = window.setTimeout(() => {
        overlaySettleTimer = null;
        scheduleOverlaySync();
      }, 350);
    }
  }

  // Hosted overlays scroll natively. A layer overlay already moves with the
  // document, so it only needs a nudge when a nested scroller moved, or when
  // its target sits in a fixed/sticky box that the document scrolls past.
  function onScrollCapture(event) {
    const documentScroll = event.target === document;
    for (const record of marked.values()) {
      if (!record.overlay || record.host) continue;
      if (!documentScroll || record.pinned) {
        scheduleOverlaySync();
        return;
      }
    }
  }

  function applyMarker(anchor, info) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    if (isMarked(anchor)) return false;
    if (!enabled) return false;

    const href = anchor.href;
    if (!/^https?:\/\//i.test(href)) return false;

    const classification = classifyAnchor(anchor);
    if (!classification) return false;
    const { kind, image } = classification;
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
        : kind === "block"
          ? BLOCK_CLASS
          : kind === "result"
            ? RESULT_CLASS
            : INLINE_CLASS
    );
    if (kind === "media") {
      anchor.classList.add(BLACKOUT_CLASS);
    }
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
      abbreviation,
      title,
      channel,
      targetUrl,
      reason,
      shortLink: info.shortLink || "",
      previousTitle: anchor.getAttribute("title"),
      positionApplied: false,
      overlay: null,
      overlayKind: "",
      overlayTarget: null,
      host: null,
      pinned: false,
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

    marked.set(anchor, record);
    if (kind !== "inline") attachOverlay(anchor, record, kind, image);
    schedulePageCountReport();
    return true;
  }

  function removeMarker(anchor) {
    const record = marked.get(anchor);
    if (!record) return;
    anchor.classList.remove(
      MARK_CLASS,
      INLINE_CLASS,
      BLOCK_CLASS,
      MEDIA_CLASS,
      RESULT_CLASS,
      BLACKOUT_CLASS
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
    detachOverlay(anchor, record);
    marked.delete(anchor);
    schedulePageCountReport();
  }

  function clearAllMarkers() {
    for (const anchor of [...marked.keys()]) {
      removeMarker(anchor);
    }
    layerRoot?.remove();
  }

  // Links the page removed or re-pointed (YouTube recycles its cards) must
  // not keep an overlay or inflate the toolbar count.
  function syncExistingMarkers() {
    for (const anchor of [...marked.keys()]) {
      if (!anchor.isConnected || anchor.dataset.rgHref !== anchor.href) {
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

  function schedulePageCountReport() {
    if (!enabled || pageCountTimer) return;
    pageCountTimer = window.setTimeout(() => {
      pageCountTimer = null;
      sendMessage({ type: M.pageMarkedCount, count: marked.size });
    }, 140);
  }

  function ensureObserver() {
    if (observer || !enabled) return;
    observer = new MutationObserver((mutations) => {
      scheduleOverlaySync();
      let removedNodes = false;
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          scheduleScan();
          return;
        }
        if (mutation.addedNodes.length) {
          scheduleScan();
          return;
        }
        if (mutation.removedNodes.length) removedNodes = true;
      }
      if (removedNodes) scheduleDetachedPrune();
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  }

  // Removal-only mutations don't need a full scan, but a deleted link must
  // still drop its record (and any layer overlay) even while the tab is in
  // the background and animation frames are paused.
  function scheduleDetachedPrune() {
    if (pruneTimer || !marked.size) return;
    pruneTimer = window.setTimeout(() => {
      pruneTimer = null;
      for (const anchor of [...marked.keys()]) {
        if (!anchor.isConnected) removeMarker(anchor);
      }
    }, 220);
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
    if (pruneTimer) {
      clearTimeout(pruneTimer);
      pruneTimer = null;
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

  // A detached copy of the paused link. Clicking it later lets the browser
  // apply the original target, rel and referrer policy without re-running the
  // page's click handlers or this script's capture listener.
  function snapshotLink(anchor) {
    const copy = document.createElement("a");
    copy.href = anchor.href;
    for (const name of ["target", "rel", "referrerpolicy"]) {
      const value = anchor.getAttribute(name);
      if (value !== null) copy.setAttribute(name, value);
    }
    return copy;
  }

  function resumeLink(copy) {
    const target =
      copy.getAttribute("target") ||
      document.querySelector("base[target]")?.getAttribute("target") ||
      "";
    if (target.trim().toLowerCase() === "_blank" && navigator.userActivation?.isActive === false) {
      // A slow expansion can outlive the click's user activation, and the
      // popup blocker would silently drop the new tab.
      sendMessage({ type: M.openLinkInTab, url: copy.href });
      return;
    }
    copy.click();
  }

  async function handleShortLink(anchor, parsed) {
    if (resolvingClick) return;
    resolvingClick = true;
    const originalHref = anchor.href;
    const link = snapshotLink(anchor);
    showToast("RollGuard 正在展开短链…", { persistent: true });

    try {
      const result = await sendMessage({
        type: M.checkShortLink,
        url: originalHref,
        sourceUrl: location.href,
      });

      if (!enabled) {
        resumeLink(link);
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
      resumeLink(link);
    } catch (error) {
      hideToast();
      resumeLink(link);
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
    schedulePageCountReport();
    checkYouTubePage();
  }

  async function init() {
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("scroll", onScrollCapture, { capture: true, passive: true });
    window.addEventListener("resize", () => scheduleOverlaySync(), { passive: true });
    window.addEventListener("load", () => scheduleOverlaySync(), { passive: true });
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => scheduleOverlaySync()).catch(() => {});
    }
    const data = await safeStorageGet([K.settings]);
    enabled = data[K.settings]?.enabled !== false;
    initialized = true;

    if (enabled) {
      ensureObserver();
      scanKnownLinks();
      schedulePageCountReport();
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
    if (!message) return false;

    if (message.type === M.getPageCount) {
      sendResponse({ ok: true, count: marked.size });
      return false;
    }

    if (message.type !== M.scanPage) return false;

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
