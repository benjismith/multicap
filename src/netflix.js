// @ts-check
/*
 * netflix.js — every Netflix-specific assumption lives in this one file.
 *
 * Schema shapes (manifest response/request, timed-text tracks), DOM selectors,
 * profile names, and the path to the undocumented player API. When Netflix
 * changes something, this is the file to fix. Loaded by BOTH worlds (the MAIN
 * world page hook and the isolated-world extension side), so it must not
 * depend on either.
 *
 * Nothing here should throw. Callers treat null / [] as "assumption failed"
 * and log loudly.
 */
// `var`: shared with the entry file that build.js concatenates after this one.
var MC_NFLX = (() => {
  /** Subtitle profile that makes Netflix serve WebVTT instead of TTML/DFXP. */
  const WEBVTT_PROFILE = 'webvtt-lssdh-ios8';

  /**
   * Formats keyed by `ttDownloadables` name. `text` is our BELIEF about whether
   * the format is text-based; Phase 0 exists to verify it.
   * @type {Record<string, {text: boolean, note: string}>}
   */
  const FORMATS = {
    'webvtt-lssdh-ios8': { text: true,  note: 'WebVTT (only offered if we injected the profile)' },
    'dfxp-ls-sdh':       { text: true,  note: 'TTML/DFXP' },
    'imsc1.1':           { text: true,  note: 'IMSC1.1 (TTML profile)' },
    'simplesdh':         { text: true,  note: 'unverified' },
    'nflx-cmisc':        { text: false, note: 'image-based (belief from NflxMultiSubs; unverified)' },
  };

  /** Kill switch for the JSON.stringify request-shaping hook. Flip off if playback misbehaves. */
  const SHAPE_MANIFEST_REQUESTS = true;

  /** Manifest subtrees too big to dump in full (shape is listed one level deep instead). */
  const PRUNE_KEYS = new Set([
    'video_tracks', 'audio_tracks', 'timedtexttracks', 'trickplays', 'links',
    'media', 'servers', 'locations', 'cdnResponseData', 'eligibleABTests',
  ]);

  /**
   * Keys that might describe ad breaks / server-side stitching. Case-sensitive on purpose:
   * matches ad, ads, isAd, adBreaks, ad_breaks, adverts, adPods, adUnit... but not address/adaptive.
   */
  const INTEREST_KEY_RE = /^(is)?[aA]d([A-Z_]\w*|s|vert\w*)?$|[sS]sai|SSAI|[sS]titch|[cC]ue[pP]oint|[mM]arker|[sS]kippable|[tT]imeline|[oO]ffset/;

  // ---- manifest response ---------------------------------------------------

  /**
   * Subadub-lineage capture: a manifest arriving through JSON.parse as
   *   { result: { movieId, timedtexttracks, adverts?, auxiliaryManifests?, ... } }
   * On the current client the manifest does NOT pass through main-thread JSON.parse
   * (verified 2026-09-07), so this is a passive extra; manifestFromPlayer() is primary.
   * Returns the manifest object (the `result`) or null.
   * @param {any} value
   * @returns {any | null}
   */
  function manifestFromParsed(value) {
    if (!value || typeof value !== 'object') return null;
    const r = value.result;
    if (r && typeof r === 'object' && r.movieId != null && Array.isArray(r.timedtexttracks)) return r;
    if (value.movieId != null && Array.isArray(value.timedtexttracks)) return value; // defensive: unwrapped
    return null;
  }

  /**
   * "Smells like a manifest but didn't match" — so schema drift is loud, not silent.
   * @param {any} value
   * @returns {string | null} a reason, or null if it doesn't smell like one
   */
  function nearMissReason(value) {
    if (!value || typeof value !== 'object') return null;
    const r = value.result && typeof value.result === 'object' ? value.result : value;
    if (Array.isArray(r)) return null;
    const hasTT = 'timedtexttracks' in r;
    const hasId = 'movieId' in r;
    if (hasTT && !hasId) return 'has timedtexttracks but no movieId';
    if (hasId && !hasTT && ('video_tracks' in r || 'audio_tracks' in r)) return 'has movieId + video/audio tracks but no timedtexttracks';
    return null;
  }

  // ---- manifest request ----------------------------------------------------

  /**
   * The manifest request body passes through JSON.stringify as
   *   { ..., params: { profiles: [...], showAllSubDubTracks?, ... } }
   * Returns the params object (the thing to shape) or null.
   * @param {any} value
   * @returns {any | null}
   */
  function manifestRequestParams(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const p = value.params;
    if (p && typeof p === 'object' && Array.isArray(p.profiles)) return p;
    if (Array.isArray(value.profiles) && ('viewableId' in value || 'viewableIds' in value)) return value; // defensive: flat shape
    return null;
  }

  /**
   * Mutates params in place. Returns the list of changes made ([] = already shaped).
   * @param {any} params
   * @returns {string[]}
   */
  function shapeManifestRequest(params) {
    const changes = [];
    if (!params.profiles.includes(WEBVTT_PROFILE)) {
      params.profiles.push(WEBVTT_PROFILE);
      changes.push(`profiles += ${WEBVTT_PROFILE}`);
    }
    if (params.showAllSubDubTracks !== true) {
      params.showAllSubDubTracks = true;
      changes.push('showAllSubDubTracks = true');
    }
    return changes;
  }

  // ---- timed-text tracks ---------------------------------------------------

  /**
   * Download URL for one format of one track. Two shapes have existed:
   *   ttDownloadables[fmt].urls = [{ cdn_id, url }]          (current, per Subadub)
   *   ttDownloadables[fmt].downloadUrls = { [cdnId]: url }    (older)
   * @param {any} track
   * @param {string} format
   * @returns {string | null}
   */
  function trackDownloadUrl(track, format) {
    const d = track && track.ttDownloadables && track.ttDownloadables[format];
    if (!d) return null;
    if (Array.isArray(d.urls) && d.urls.length && typeof d.urls[0].url === 'string') return d.urls[0].url;
    if (d.downloadUrls && typeof d.downloadUrls === 'object') {
      const first = Object.values(d.downloadUrls)[0];
      if (typeof first === 'string') return first;
    }
    return null;
  }

  /**
   * One-row description of a track for tables/logs. Field names are assumptions.
   * @param {any} t
   */
  function describeTrack(t) {
    const formats = t && t.ttDownloadables && typeof t.ttDownloadables === 'object' ? Object.keys(t.ttDownloadables) : [];
    const anyText = formats.some((f) => FORMATS[f] && FORMATS[f].text);
    const anyUnknown = formats.some((f) => !FORMATS[f]);
    return {
      id: t.new_track_id ?? t.id ?? t.trackId ?? '?',
      lang: t.language ?? '?',
      name: t.languageDescription ?? '?',
      type: t.trackType ?? '?',
      raw: t.rawTrackType ?? '?',
      forced: !!t.isForcedNarrative,
      none: !!t.isNoneTrack,
      formats: formats.join(' ') || '-',
      text: anyText ? 'yes' : formats.length ? (anyUnknown ? 'UNKNOWN' : 'NO') : '-',
    };
  }

  /**
   * Choose the track to render for a language, from describeTrack() rows plus `url`.
   * Exact BCP-47 match beats a base-language match; subtitles beat closed captions;
   * PRIMARY beats ASSISTIVE. Forced, "none", and URL-less tracks are skipped.
   * @param {Array<any>} tracks
   * @param {string} lang
   */
  function pickTrack(tracks, lang) {
    const base = (/** @type {any} */ l) => String(l).toLowerCase().split('-')[0];
    const want = lang.toLowerCase();
    const score = (/** @type {any} */ t) => {
      if (!t.url || t.forced || t.none) return -1;
      let sc = 0;
      if (String(t.lang).toLowerCase() === want) sc += 100;
      else if (base(t.lang) === base(want)) sc += 50;
      else return -1;
      if (/^subtitles$/i.test(t.raw)) sc += 10;
      else if (/closedcaptions|sdh/i.test(t.raw)) sc += 5;
      if (t.type === 'PRIMARY') sc += 1;
      return sc;
    };
    let best = null;
    let bestScore = -1;
    for (const t of tracks) { const sc = score(t); if (sc > bestScore) { best = t; bestScore = sc; } }
    return best;
  }

  // ---- DOM -----------------------------------------------------------------

  const SEL = {
    video: 'video',
    /** Player shell on /watch pages; scopes DOM discovery so browse-page churn is ignored. */
    playerRoot: '.watch-video',
    /** The element our picker mounts into (inside whatever Netflix fullscreens). */
    playerView: '.watch-video--player-view',
    /** Present while Netflix's control bar is showing. */
    controls: '[data-uia="controls-standard"]',
    /** Netflix's own subtitle layer (later: kept alive but invisible, observed for sync Layer C). */
    timedtext: '.player-timedtext',
    timedtextText: '.player-timedtext-text-container',
    /** Present exactly while an ad plays ("Ad" badge + countdown). DOM fallback for isInAd(). */
    adsInfo: '[data-uia="ads-info-container"]',
    adsInfoTime: '[data-uia="ads-info-time"]',
    /** Netflix "pause ads" overlay, present while playback is paused. */
    pauseAd: '[data-uia^="pause-ad"]',
    /** Ad-break markers inside the scrubber (only while controls are shown). */
    adMarkers: '[data-uia="ad-markers"]',
  };

  /** Text that suggests ad UI ("Ad 1 of 3", "Advertisement"). Discovery heuristic only. */
  const AD_TEXT_RE = /(^|\s)(ad|ads|advert\w*|sponsored?)(\s|$|[.:·])/i;
  /** Class / data-uia tokens that suggest ad UI. */
  const AD_TOKEN_RE = /(^|[-_ ])ad(s|vert\w*|break\w*|pod\w*)?([-_ ]|$)/i;

  // ---- player API (MAIN world only) ------------------------------------------
  // Everything here is undocumented and was verified 2026-09-07 (docs/phase0-findings.md).

  /** Undocumented: netflix.appContext.state.playerApp.getAPI().videoPlayer */
  function playerApi() {
    const w = /** @type {any} */ (globalThis);
    try {
      return w.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Pick the main /watch playback session (ids look like "watch-<uuid>"; previews differ).
   * @param {any} ids
   * @returns {string | null}
   */
  function pickWatchSession(ids) {
    if (!Array.isArray(ids) || !ids.length) return null;
    return ids.find((i) => /^watch/i.test(String(i))) ?? null; // strict: previews/billboards have other prefixes
  }

  /** The active /watch player object, or null. */
  function watchPlayer() {
    const vp = playerApi();
    if (!vp || typeof vp.getAllPlayerSessionIds !== 'function' || typeof vp.getVideoPlayerBySessionId !== 'function') return null;
    try {
      const sid = pickWatchSession(vp.getAllPlayerSessionIds());
      return sid == null ? null : vp.getVideoPlayerBySessionId(sid) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Where the manifest lives inside player.getInternalPlayer(). The manifest does NOT pass
   * through main-thread JSON.parse on the current client, so this is the primary source.
   */
  const MANIFEST_PATH = ['playback', 'segmentWithBoundObservables', 'manifest', 'manifestResult'];

  /** @param {any} v */
  function looksLikeManifest(v) { return !!v && typeof v === 'object' && v.movieId != null && Array.isArray(v.timedtexttracks); }

  /**
   * Bounded search of an object graph for something manifest-shaped. Repair path for when
   * MANIFEST_PATH goes stale: it found the manifest at depth 4 after ~1,100 objects.
   * @param {any} root
   * @returns {{value: any, path: string} | null}
   */
  function findManifest(root) {
    const seen = new WeakSet();
    let visited = 0;
    /** @type {{value: any, path: string} | null} */
    let found = null;
    /** @param {any} v @param {string} path @param {number} depth */
    const walk = (v, path, depth) => {
      if (found || !v || typeof v !== 'object' || depth > 6 || visited > 60000) return;
      if (seen.has(v)) return;
      seen.add(v);
      visited++;
      if (typeof Node !== 'undefined' && v instanceof Node) return;
      if (looksLikeManifest(v)) { found = { value: v, path }; return; }
      let keys;
      try { keys = Object.keys(v); } catch { return; }
      for (const k of keys.slice(0, 400)) {
        let c;
        try { c = v[k]; } catch { continue; }
        if (c && typeof c === 'object') walk(c, path + '.' + k, depth + 1);
      }
    };
    walk(root, '$', 0);
    return found;
  }

  /**
   * The current manifest from the player object graph: direct path first, search second.
   * @param {any} player
   * @returns {{manifest: any, via: string} | null}
   */
  function manifestFromPlayer(player) {
    let ip;
    try { ip = player && typeof player.getInternalPlayer === 'function' ? player.getInternalPlayer() : null; } catch { ip = null; }
    if (!ip) return null;
    let v = ip;
    for (const k of MANIFEST_PATH) v = v && typeof v === 'object' ? v[k] : undefined;
    if (looksLikeManifest(v)) return { manifest: v, via: 'path' };
    const hit = findManifest(ip);
    return hit ? { manifest: hit.value, via: 'search ' + hit.path } : null;
  }

  /** Content time in ms: advances with content, frozen at the break location during ads. */
  function contentTimeMs(player) {
    try { return typeof player.getSegmentTime === 'function' ? player.getSegmentTime() : null; } catch { return null; }
  }

  /** Media time in ms as the player sees it (tracks video.currentTime). */
  function mediaTimeMs(player) {
    try { return typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : null; } catch { return null; }
  }

  /**
   * Live ad state from the ad manager. `presenting` is the authoritative in-ad flag.
   * @param {any} player
   * @returns {{presenting: boolean, breakIndex: number | null} | null}
   */
  function adState(player) {
    try {
      const am = typeof player.getAdManager === 'function' ? player.getAdManager() : null;
      if (!am) return null;
      const presenting = !!(am.adPresenting && am.adPresenting._value);
      let breakIndex = null;
      try { const b = am.getPresentingAdBreak(); breakIndex = b && typeof b.viewableAdBreakIndex === 'number' ? b.viewableAdBreakIndex : null; } catch { /* absent */ }
      return { presenting, breakIndex };
    } catch {
      return null;
    }
  }

  /**
   * Ad breaks as the ad manager knows them. locationMs is CONTENT time. `ads` is only
   * populated while a break is hydrated (shortly before it plays) and emptied afterwards.
   * @param {any} player
   * @returns {Array<{locationMs: number, isPreroll: boolean, hasPlayed: boolean, isHydrated: boolean, adMs: number | null}>}
   */
  function adBreaks(player) {
    try {
      const am = typeof player.getAdManager === 'function' ? player.getAdManager() : null;
      const list = am && typeof am.getAds === 'function' ? am.getAds() : null;
      if (!Array.isArray(list)) return [];
      return list.map((b) => ({
        locationMs: b.locationMs,
        isPreroll: !!b.isPreroll,
        hasPlayed: !!b.hasPlayed,
        isHydrated: !!b.isHydrated,
        adMs: Array.isArray(b.ads) ? b.ads.reduce((/** @type {number} */ s, /** @type {any} */ a) => s + ((a.endTimeMs ?? 0) - (a.startTimeMs ?? 0)), 0) : null,
      }));
    } catch {
      return [];
    }
  }

  // ---- URLs ----------------------------------------------------------------

  /** @param {string} href */
  function watchIdFromUrl(href) {
    const m = /\/watch\/(\d+)/.exec(href);
    return m ? m[1] : null;
  }

  return {
    WEBVTT_PROFILE, FORMATS, SHAPE_MANIFEST_REQUESTS, PRUNE_KEYS, INTEREST_KEY_RE,
    manifestFromParsed, nearMissReason, manifestRequestParams, shapeManifestRequest,
    trackDownloadUrl, describeTrack, pickTrack,
    SEL, AD_TEXT_RE, AD_TOKEN_RE,
    playerApi, pickWatchSession, watchPlayer, MANIFEST_PATH, looksLikeManifest, findManifest, manifestFromPlayer,
    contentTimeMs, mediaTimeMs, adState, adBreaks,
    watchIdFromUrl,
  };
})();
