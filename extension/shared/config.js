(() => {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    settings: "rg_settings_v1",
    visits: "rg_visits_v1",
    stats: "rg_stats_v1",
  });

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    installedAt: null,
    version: 1,
  });

  const MESSAGE = Object.freeze({
    scanPage: "RG_SCAN_PAGE",
    probeCandidates: "RG_PROBE_CANDIDATES",
    checkShortLink: "RG_CHECK_SHORT_LINK",
    blockLink: "RG_BLOCK_LINK",
    blockCurrentPage: "RG_BLOCK_CURRENT_PAGE",
    storagePing: "RG_STORAGE_PING",
  });

  globalThis.RollGuardConfig = Object.freeze({
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    MESSAGE,
    MAX_VISITS: 200,
    PAGE_CANDIDATE_LIMIT: 8,
    PROBE_TIMEOUT_MS: 4000,
    DEDUPE_WINDOW_MS: 2500,
  });
})();
