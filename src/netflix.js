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
// `var` on purpose: it becomes a property of the world's global object, which is what
// later files in the same content-script `js` list can see (top-level const is not shared).
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
   * The playback manifest arrives through JSON.parse as
   *   { result: { movieId, timedtexttracks, adverts?, auxiliaryManifests?, ... } }
   * (Subadub lineage). Returns the manifest object (the `result`) or null.
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

  // ---- DOM -----------------------------------------------------------------

  const SEL = {
    video: 'video',
    /** Player shell on /watch pages; scopes DOM discovery so browse-page churn is ignored. */
    playerRoot: '.watch-video',
    /** Netflix's own subtitle layer (later: kept alive but invisible, observed for sync Layer C). */
    timedtext: '.player-timedtext',
    timedtextText: '.player-timedtext-text-container',
  };

  /** Text that suggests ad UI ("Ad 1 of 3", "Advertisement"). Discovery heuristic only. */
  const AD_TEXT_RE = /(^|\s)(ad|ads|advert\w*|sponsored?)(\s|$|[.:·])/i;
  /** Class / data-uia tokens that suggest ad UI. */
  const AD_TOKEN_RE = /(^|[-_ ])ad(s|vert\w*|break\w*|pod\w*)?([-_ ]|$)/i;

  // ---- player API (MAIN world only) ------------------------------------------

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
    return ids.find((i) => /^watch/i.test(String(i))) ?? ids[ids.length - 1];
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
    trackDownloadUrl, describeTrack,
    SEL, AD_TEXT_RE, AD_TOKEN_RE,
    playerApi, pickWatchSession, watchIdFromUrl,
  };
})();
