/*
 * RollGuard service worker.
 * Records blocks in chrome.storage.local and routes risky navigation to the
 * local intercept page. It never sends browsing data to a remote server.
 */
importScripts("shared/config.js", "shared/detection.js");

const C = self.RollGuardConfig;
const D = self.RollGuardDetect;
const K = C.STORAGE_KEYS;
const M = C.MESSAGE;
const MAX_VISITS = C.MAX_VISITS;

let cachedSettings = null;
let initializePromise = null;
let storageWriteQueue = Promise.resolve();
const recentBlocks = new Map();
const videoCache = new Map();
const redirectCache = new Map();
const pageCounts = new Map();

function createId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `rg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function friendlyError(error) {
  return error instanceof Error ? error.message : String(error);
}

function trimText(value, max = 500) {
  return String(value || "").slice(0, max);
}

function isSafeReturnUrl(url, targetUrl) {
  if (!url || url === targetUrl) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (D.getVideoId(url) && D.getVideoId(url) === D.getVideoId(targetUrl)) return false;
  return true;
}

async function getVisits() {
  const data = await chrome.storage.local.get(K.visits);
  return Array.isArray(data[K.visits]) ? data[K.visits] : [];
}

async function getStats() {
  const data = await chrome.storage.local.get(K.stats);
  if (data[K.stats] && typeof data[K.stats] === "object") return data[K.stats];
  return { totalBlocked: 0, updatedAt: 0 };
}

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  const data = await chrome.storage.local.get(K.settings);
  const stored = data[K.settings];
  if (stored && typeof stored === "object") {
    cachedSettings = { ...C.DEFAULT_SETTINGS, ...stored };
    return cachedSettings;
  }

  const fresh = {
    ...C.DEFAULT_SETTINGS,
    installedAt: Date.now(),
  };
  cachedSettings = fresh;
  await chrome.storage.local.set({ [K.settings]: fresh });
  return fresh;
}

async function initialize() {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    await getSettings();
    const data = await chrome.storage.local.get([K.visits, K.stats]);
    const patch = {};

    if (!Array.isArray(data[K.visits])) patch[K.visits] = [];
    if (!data[K.stats] || typeof data[K.stats] !== "object") {
      patch[K.stats] = { totalBlocked: 0, updatedAt: Date.now() };
    }

    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
    await updateActiveBadge(true);
  })().catch((error) => {
    console.warn("[RollGuard] init failed:", friendlyError(error));
  });

  return initializePromise;
}

async function activeTabId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return Number.isInteger(tab?.id) ? tab.id : null;
  } catch (error) {
    return null;
  }
}

async function queryTabCount(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: M.getPageCount });
    const count = Number(response?.count);
    return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null;
  } catch (error) {
    // Pages without a content script (chrome://, Web Store) simply have no count.
    return null;
  }
}

async function paintBadge(tabId, settings, count) {
  const enabled = settings.enabled !== false;
  const target = Number.isInteger(tabId) ? { tabId } : {};

  let text;
  let background = "#ff4d82";
  let foreground = "#191a16";

  if (!enabled) {
    text = "OFF";
    background = "#55564c";
    foreground = "#f8edd6";
  } else if (count > 0) {
    text = count > 99 ? "99+" : String(count);
  } else {
    text = "";
  }

  await chrome.action.setBadgeBackgroundColor({ color: background, ...target });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: foreground, ...target });
  }
  await chrome.action.setBadgeText({ text, ...target });
  await chrome.action.setTitle({
    title: enabled
      ? `RollGuard 正在防护 · 本页已标记 ${count} 个 Rickroll 链接`
      : "RollGuard 已暂停",
    ...target,
  });
}

async function updateBadge(tabId, refreshFromTab = false) {
  try {
    const settings = await getSettings();
    let targetTabId = Number.isInteger(tabId) ? tabId : await activeTabId();

    if (refreshFromTab && Number.isInteger(targetTabId)) {
      const liveCount = await queryTabCount(targetTabId);
      if (liveCount !== null) pageCounts.set(targetTabId, liveCount);
    }

    const count = Number.isInteger(targetTabId) ? pageCounts.get(targetTabId) ?? 0 : 0;
    await paintBadge(Number.isInteger(targetTabId) ? targetTabId : null, settings, count);
  } catch (error) {
    // Badge APIs can be unavailable for a moment during browser startup.
    console.warn("[RollGuard] badge update failed:", friendlyError(error));
  }
}

async function updateActiveBadge(refreshFromTab = false) {
  const tabId = await activeTabId();
  await updateBadge(tabId, refreshFromTab);
}

async function updateAllBadges() {
  try {
    const settings = await getSettings();
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({});
    } catch (error) {
      tabs = [];
    }
    if (!tabs.length) {
      await paintBadge(null, settings, 0);
      return;
    }
    await Promise.all(
      tabs.map(async (tab) => {
        if (!Number.isInteger(tab.id)) return;
        await paintBadge(tab.id, settings, pageCounts.get(tab.id) ?? 0);
      })
    );
  } catch (error) {
    console.warn("[RollGuard] badge refresh failed:", friendlyError(error));
  }
}

function queueStorageWrite(task) {
  const run = storageWriteQueue.then(task, task);
  storageWriteQueue = run.catch(() => {});
  return run;
}

async function recordVisit(input) {
  return queueStorageWrite(async () => {
    const visits = await getVisits();
    const stats = await getStats();
    const now = Date.now();
    const videoId = input.videoId || D.getVideoId(input.targetUrl);
    const seed = D.getSeedVideo(videoId);
    const reason =
      input.reason || (D.isKnownVideo(videoId) ? "known" : "title");
    const targetUrl = trimText(input.targetUrl, 3000);
    const sourceUrl = trimText(input.sourceUrl, 3000);
    const sourceHost = sourceUrl ? D.hostOf(sourceUrl) : "";

    const visit = {
      id: createId(),
      videoId: videoId || "",
      title: trimText(input.title) || seed?.title || "未识别的 Rickroll 视频",
      channel: trimText(input.channel) || seed?.channel || "",
      targetUrl,
      sourceUrl,
      sourceHost,
      displayUrl: videoId
        ? D.abbreviatedLink(videoId)
        : trimText(input.displayUrl) || D.shortHost(targetUrl) || "未知链接",
      abbreviation: videoId ? D.abbreviatedLink(videoId) : "",
      reason,
      reasonLabel: D.reasonLabel(reason),
      shortLink: trimText(input.shortLink, 1000),
      blockedAt: now,
    };

    const nextVisits = [visit, ...visits].slice(0, MAX_VISITS);
    const nextStats = {
      totalBlocked: Number(stats.totalBlocked || 0) + 1,
      updatedAt: now,
    };

    await chrome.storage.local.set({
      [K.visits]: nextVisits,
      [K.stats]: nextStats,
    });

    return visit;
  });
}

function pruneMap(map, max, ttl) {
  if (map.size <= max) return;
  const now = Date.now();
  for (const [key, value] of map) {
    const timestamp = typeof value === "number" ? value : value?.timestamp;
    if (!timestamp || now - timestamp > ttl) map.delete(key);
  }
  while (map.size > max) {
    map.delete(map.keys().next().value);
  }
}

async function blockTab(tabId, targetUrl, input = {}) {
  if (!tabId || tabId < 0) return { ok: false, error: "No tab" };
  if (!/^https?:\/\//i.test(targetUrl || "")) {
    return { ok: false, error: "Not a web URL" };
  }

  const settings = await getSettings();
  if (settings.enabled === false) return { ok: false, error: "Disabled" };

  const dedupeKey = `${tabId}:${targetUrl}`;
  const lastBlock = recentBlocks.get(dedupeKey);
  if (lastBlock && Date.now() - lastBlock < C.DEDUPE_WINDOW_MS) {
    return { ok: true, duplicate: true };
  }
  recentBlocks.set(dedupeKey, Date.now());
  pruneMap(recentBlocks, 120, 15_000);

  try {
    const videoId = input.videoId || D.getVideoId(targetUrl);
    const visit = await recordVisit({
      ...input,
      targetUrl,
      videoId,
    });

    const url = new URL(chrome.runtime.getURL("blocked/blocked.html"));
    url.searchParams.set("visitId", visit.id);
    if (isSafeReturnUrl(input.sourceUrl, targetUrl)) {
      url.searchParams.set("returnUrl", input.sourceUrl);
    }

    pageCounts.delete(tabId);
    await chrome.tabs.update(tabId, { url: url.toString() });
    await updateBadge(tabId);
    return { ok: true, visit };
  } catch (error) {
    recentBlocks.delete(dedupeKey);
    console.warn("[RollGuard] block failed:", friendlyError(error));
    return { ok: false, error: friendlyError(error) };
  }
}

async function fetchWithTimeout(url, options = {}, timeout = C.PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRedirect(url) {
  const cached = redirectCache.get(url);
  if (cached && Date.now() - cached.timestamp < 120_000) {
    return { ...cached.value, cached: true };
  }

  let response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "GET",
        redirect: "follow",
        credentials: "omit",
        cache: "no-store",
      },
      C.PROBE_TIMEOUT_MS
    );
    const finalUrl = response.url || url;
    try {
      await response.body?.cancel();
    } catch (error) {
      // The response body is irrelevant for redirect discovery.
    }

    const parsed = D.parseLink(finalUrl);
    const result = {
      finalUrl,
      isYouTube: parsed?.isYouTube || false,
      videoId: parsed?.videoId || null,
    };
    redirectCache.set(url, { timestamp: Date.now(), value: result });
    pruneMap(redirectCache, 80, 120_000);
    return result;
  } catch (error) {
    return { finalUrl: url, isYouTube: false, videoId: null, error: friendlyError(error) };
  } finally {
    response = null;
  }
}

async function probeVideo(videoId) {
  if (!videoId) return null;
  if (D.isKnownVideo(videoId)) {
    const seed = D.getSeedVideo(videoId);
    return {
      videoId,
      title: seed.title,
      channel: seed.channel,
      thumbnail: seed.thumbnail,
      blocked: true,
      reason: "known",
    };
  }

  const cached = videoCache.get(videoId);
  if (cached && Date.now() - cached.timestamp < 300_000) {
    return { ...cached.value, cached: true };
  }

  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const response = await fetchWithTimeout(
      oembedUrl,
      { credentials: "omit", cache: "no-store" },
      C.PROBE_TIMEOUT_MS
    );
    if (!response.ok) {
      const missing = {
        videoId,
        title: "",
        channel: "",
        thumbnail: "",
        blocked: false,
        reason: null,
      };
      videoCache.set(videoId, { timestamp: Date.now(), value: missing });
      return missing;
    }

    const data = await response.json();
    const classification = D.classifyVideo({
      videoId,
      title: data.title,
      channel: data.author_name,
    });

    const metadata = {
      videoId,
      title: D.normalizeTitle(data.title),
      channel: D.normalizeTitle(data.author_name),
      thumbnail: data.thumbnail_url || "",
      blocked: Boolean(classification),
      reason: classification?.reason || null,
    };
    videoCache.set(videoId, { timestamp: Date.now(), value: metadata });
    pruneMap(videoCache, 150, 300_000);
    return metadata;
  } catch (error) {
    return {
      videoId,
      title: "",
      channel: "",
      thumbnail: "",
      blocked: false,
      reason: null,
      error: friendlyError(error),
    };
  }
}

async function inspectCandidateUrl(url) {
  const parsed = D.parseLink(url);
  if (!parsed) return { url, blocked: false };

  if (parsed.isYouTube && parsed.videoId) {
    const video = await probeVideo(parsed.videoId);
    if (video?.blocked) {
      return {
        url,
        blocked: true,
        reason: video.reason || "title",
        video,
        finalUrl: url,
      };
    }
    return {
      url,
      blocked: false,
      video: video || null,
      finalUrl: url,
    };
  }

  if (parsed.isShortener) {
    const resolved = await resolveRedirect(parsed.url.toString());
    if (!resolved.isYouTube || !resolved.videoId) {
      return {
        url,
        blocked: false,
        finalUrl: resolved.finalUrl,
        error: resolved.error || null,
      };
    }

    const video = await probeVideo(resolved.videoId);
    return {
      url,
      blocked: Boolean(video?.blocked),
      reason: video?.reason || "shortlink",
      video,
      finalUrl: resolved.finalUrl,
      shortLink: parsed.url.toString(),
    };
  }

  return { url, blocked: false };
}

async function checkShortLink(url, sourceUrl = "") {
  const inspected = await inspectCandidateUrl(url);
  return {
    ok: true,
    ...inspected,
    sourceUrl,
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = { url: items[index], blocked: false, error: friendlyError(error) };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

async function inspectCandidates(candidates, sourceUrl = "") {
  const unique = [...new Set(
    (Array.isArray(candidates) ? candidates : [])
      .map((item) => (typeof item === "string" ? item : item?.url))
      .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
  )].slice(0, C.PAGE_CANDIDATE_LIMIT);

  return mapLimit(unique, 8, async (url) => {
    const result = await inspectCandidateUrl(url);
    return { ...result, sourceUrl };
  });
}

async function sourceUrlForTab(tabId, targetUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url && tab.url !== targetUrl && /^https?:\/\//i.test(tab.url)) {
      return tab.url;
    }
  } catch (error) {
    // The tab can disappear between navigation events.
  }
  return "";
}

async function handleNavigation(details) {
  if (!details || details.frameId !== 0) return;
  if (!/^https?:\/\//i.test(details.url || "")) return;

  const settings = await getSettings();
  if (settings.enabled === false) return;

  const parsed = D.parseLink(details.url);
  if (!parsed?.isYouTube || !parsed.videoId) return;
  if (!D.isKnownVideo(parsed.videoId)) return;

  const sourceUrl = await sourceUrlForTab(details.tabId, details.url);
  const seed = D.getSeedVideo(parsed.videoId);
  await blockTab(details.tabId, details.url, {
    videoId: parsed.videoId,
    title: seed?.title || "",
    channel: seed?.channel || "",
    sourceUrl,
    reason: "known",
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  initialize().then(async () => {
    if (details.reason === "install") {
      const settings = await getSettings();
      if (settings.installedAt === null) {
        cachedSettings = { ...settings, installedAt: Date.now() };
        await chrome.storage.local.set({ [K.settings]: cachedSettings });
      }
    }
    await updateActiveBadge(true);
  });
});

chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[K.settings]) {
    cachedSettings = {
      ...C.DEFAULT_SETTINGS,
      ...(changes[K.settings].newValue || {}),
    };
    updateAllBadges();
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId, true);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading" && !changeInfo.url) return;
  pageCounts.delete(tabId);
  updateBadge(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageCounts.delete(tabId);
});

chrome.windows.onFocusChanged.addListener(() => {
  updateActiveBadge(true);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  handleNavigation(details).catch((error) =>
    console.warn("[RollGuard] navigation check failed:", friendlyError(error))
  );
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handleNavigation(details).catch((error) =>
    console.warn("[RollGuard] history state check failed:", friendlyError(error))
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;

  const respond = (payload) => {
    try {
      sendResponse(payload);
    } catch (error) {
      // The popup may have closed while an async check was in flight.
    }
  };

  initialize();

  if (message.type === M.checkShortLink) {
    checkShortLink(String(message.url || ""), String(message.sourceUrl || ""))
      .then(respond)
      .catch((error) => respond({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message.type === M.probeCandidates) {
    inspectCandidates(message.candidates, String(message.sourceUrl || ""))
      .then((results) => respond({ ok: true, results }))
      .catch((error) => respond({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message.type === M.blockLink) {
    const tabId = sender.tab?.id;
    const targetUrl = String(message.targetUrl || "");
    const parsed = D.parseLink(targetUrl);
    const videoId = message.videoId || parsed?.videoId || null;
    const seed = D.getSeedVideo(videoId);

    blockTab(tabId, targetUrl, {
      videoId,
      title: message.title || seed?.title || "",
      channel: message.channel || seed?.channel || "",
      sourceUrl: message.sourceUrl || sender.tab?.url || "",
      reason: message.reason || (D.isKnownVideo(videoId) ? "known" : "click"),
      shortLink: message.shortLink || "",
    })
      .then(respond)
      .catch((error) => respond({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message.type === M.blockCurrentPage) {
    const tabId = sender.tab?.id;
    const targetUrl = String(message.url || sender.tab?.url || "");
    const parsed = D.parseLink(targetUrl);
    const videoId = message.videoId || parsed?.videoId || null;
    const seed = D.getSeedVideo(videoId);

    blockTab(tabId, targetUrl, {
      videoId,
      title: message.title || seed?.title || "",
      channel: message.channel || seed?.channel || "",
      sourceUrl: message.sourceUrl || "",
      reason: message.reason || "page",
      shortLink: "",
    })
      .then(respond)
      .catch((error) => respond({ ok: false, error: friendlyError(error) }));
    return true;
  }

  if (message.type === M.pageMarkedCount) {
    const tabId = sender.tab?.id;
    if (Number.isInteger(tabId)) {
      const count = Math.max(0, Math.floor(Number(message.count) || 0));
      pageCounts.set(tabId, count);
      updateBadge(tabId);
    }
    respond({ ok: true });
    return false;
  }

  if (message.type === M.storagePing) {
    respond({ ok: true });
    return false;
  }

  return false;
});

// Wake up early and keep the badge honest after a browser restart.
initialize();
