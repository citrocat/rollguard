/*
 * RollGuard shared detection helpers.
 * This file is loaded by the service worker, content scripts and extension
 * pages before everything else. It intentionally has no build dependencies.
 */
(() => {
  "use strict";

  const YOUTUBE_HOSTS = new Set([
    "youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "youtu.be",
  ]);

  const SHORTENER_HOSTS = new Set([
    "bit.ly",
    "tinyurl.com",
    "t.co",
    "is.gd",
    "buff.ly",
    "cutt.ly",
    "rb.gy",
    "rebrand.ly",
    "shorturl.at",
    "tiny.cc",
    "ow.ly",
    "t.ly",
    "short.gy",
    "v.gd",
    "s.id",
    "lnkd.in",
    "trib.al",
  ]);

  const SEED_VIDEOS = [
    {
      id: "dQw4w9WgXcQ",
      title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
      channel: "Rick Astley",
      posterTitle: "OFFICIAL 4K",
      thumbnail: "assets/official-4k.jpg",
      alias: "官方 4K 版",
    },
    {
      id: "oHg5SJYRHA0",
      title: "RickRoll'D",
      channel: "cotter548",
      posterTitle: "RICKROLL'D",
      thumbnail: "assets/rickrolld.jpg",
      alias: "2007 原版",
    },
    {
      id: "ceRfyROxeJQ",
      title: "The best Rickroll EVER",
      channel: "Ali Spagnola",
      posterTitle: "BEST EVER",
      thumbnail: "assets/best-ever.jpg",
      alias: "高传播变体",
    },
  ].map((video) => Object.freeze(video));

  const SEED_BY_ID = new Map(SEED_VIDEOS.map((video) => [video.id, video]));

  const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const SONG_TITLE_RE = /never\s+gonna\s+give\s+you\s+up/i;

  // These words usually mark commentary, covers or remixes rather than the
  // prank target itself. They keep title-based detection from blocking every
  // video that merely mentions the song.
  const TITLE_NOISE_RE =
    /reaction|reacts?\b|interview|behind the|story behind|documentary|explained|tutorial|dance|evolution|then and now|history|review|unboxing|trailer|teaser|news|analysis|breakdown|parody|cover|instrumental|karaoke|singing|sings\b|talks\b|burnout|10\s*hours?|thirty|30\s*min|lyrics? video breakdown/i;

  function normalizeHost(hostname) {
    return String(hostname || "")
      .toLowerCase()
      .replace(/^www\./, "");
  }

  /**
   * Parse any URL into RollGuard's link model.
   * @param {string} input
   * @param {string} [base]
   * @returns {{url: URL, host: string, isYouTube: boolean, isShortener: boolean, videoId: string|null}|null}
   */
  function parseLink(input, base) {
    let url;
    try {
      url = new URL(input, base || undefined);
    } catch (error) {
      return null;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const host = normalizeHost(url.hostname);
    const isYouTube = YOUTUBE_HOSTS.has(host);
    const isShortener = SHORTENER_HOSTS.has(host);
    let videoId = null;

    if (isYouTube) {
      if (host === "youtu.be") {
        const segment = url.pathname.split("/").filter(Boolean)[0] || "";
        if (YOUTUBE_ID_RE.test(segment)) videoId = segment;
      } else {
        const path = url.pathname.split("/").filter(Boolean);

        if (path[0] === "watch") {
          const candidate = url.searchParams.get("v");
          if (candidate && YOUTUBE_ID_RE.test(candidate)) videoId = candidate;
        } else if (
          ["shorts", "embed", "live", "v"].includes(path[0] || "") &&
          path[1] &&
          YOUTUBE_ID_RE.test(path[1])
        ) {
          videoId = path[1];
        }
      }
    }

    return { url, host, isYouTube, isShortener, videoId };
  }

  function getVideoId(input, base) {
    return parseLink(input, base)?.videoId || null;
  }

  function isKnownVideo(videoId) {
    return Boolean(videoId && SEED_BY_ID.has(videoId));
  }

  function getSeedVideo(videoId) {
    return SEED_BY_ID.get(videoId) || null;
  }

  function abbreviateVideoId(videoId) {
    if (!videoId) return "";
    if (videoId.length <= 8) return videoId;
    return `${videoId.slice(0, 4)}…${videoId.slice(-3)}`;
  }

  function abbreviatedLink(videoId) {
    return videoId ? `youtu.be/${abbreviateVideoId(videoId)}` : "";
  }

  function fullVideoUrl(videoId) {
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : "";
  }

  function hostOf(input) {
    try {
      return normalizeHost(new URL(input).hostname);
    } catch (error) {
      return "";
    }
  }

  function shortHost(url) {
    if (!url) return "";
    const host = hostOf(url);
    if (!host) return "";
    return host.length > 27 ? `${host.slice(0, 24)}…` : host;
  }

  function normalizeTitle(title) {
    return String(title || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function titleIsSong(title) {
    const clean = normalizeTitle(title);
    if (!clean || !SONG_TITLE_RE.test(clean)) return false;
    if (TITLE_NOISE_RE.test(clean)) return false;

    if (/rick\s*astley/i.test(clean)) return true;

    const stripped = clean
      .replace(/[\(\[【].*?[\)\]】]/g, " ")
      .replace(/\b(official|video|music|4k|remaster|remastered|audio|lyrics?|hd|hdmi)\b/gi, " ")
      .replace(/[|:—–\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    return stripped === "never gonna give you up" || stripped === "never gonna give you up.";
  }

  /**
   * Whether metadata (not just the URL) identifies a Rickroll video.
   * @param {{title?: string, channel?: string, videoId?: string|null}} input
   * @returns {{reason: string, title: string, channel: string, videoId: string|null}|null}
   */
  function classifyVideo(input = {}) {
    const videoId = input.videoId || null;
    if (isKnownVideo(videoId)) {
      const seed = getSeedVideo(videoId);
      return {
        reason: "known",
        videoId,
        title: normalizeTitle(input.title) || seed.title,
        channel: normalizeTitle(input.channel) || seed.channel,
      };
    }

    const title = normalizeTitle(input.title);
    const channel = normalizeTitle(input.channel);
    if (!titleIsSong(title)) return null;

    const channelLooksOfficial =
      /rick\s*astley/i.test(channel) || /-\s*topic$/i.test(channel);
    const hasStrongTitleSignal =
      /rick\s*astley/i.test(title) ||
      /official|lyrics?|music video|4k|remaster|audio/i.test(title);
    const exactSongTitle =
      title
        .replace(/[\[【(].*?[\]】)]/g, " ")
        .replace(/\b(official|video|music|4k|remaster|remastered|audio|lyrics?|hd)\b/gi, " ")
        .replace(/[|:—–\-]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase() === "never gonna give you up";

    if (!channelLooksOfficial && !hasStrongTitleSignal && !exactSongTitle) {
      return null;
    }

    return { reason: "title", videoId, title, channel };
  }

  function reasonLabel(reason) {
    return (
      {
        known: "热门样本命中",
        title: "标题特征命中",
        shortlink: "短链展开后命中",
        page: "YouTube 页面命中",
        click: "已标记链接命中",
      }[reason] || "Rickroll 特征命中"
    );
  }

  function formatRelativeTime(timestamp, now = Date.now()) {
    const delta = Math.max(0, now - Number(timestamp || 0));
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;

    if (delta < minute) return "刚刚";
    if (delta < hour) return `${Math.floor(delta / minute)} 分钟前`;
    if (delta < day) return `${Math.floor(delta / hour)} 小时前`;
    if (delta < 7 * day) return `${Math.floor(delta / day)} 天前`;
    return new Date(timestamp).toLocaleDateString("zh-CN", {
      month: "short",
      day: "numeric",
    });
  }

  function formatTimestamp(timestamp) {
    return new Date(timestamp).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function isSameLocalDay(a, b = Date.now()) {
    const da = new Date(a);
    const db = new Date(b);
    return (
      da.getFullYear() === db.getFullYear() &&
      da.getMonth() === db.getMonth() &&
      da.getDate() === db.getDate()
    );
  }

  globalThis.RollGuardDetect = Object.freeze({
    SEED_VIDEOS,
    SEED_BY_ID,
    YOUTUBE_HOSTS,
    SHORTENER_HOSTS,
    parseLink,
    getVideoId,
    isKnownVideo,
    getSeedVideo,
    abbreviateVideoId,
    abbreviatedLink,
    fullVideoUrl,
    hostOf,
    shortHost,
    normalizeTitle,
    titleIsSong,
    classifyVideo,
    reasonLabel,
    formatRelativeTime,
    formatTimestamp,
    isSameLocalDay,
  });
})();
