// @ts-check
/*
 * clock.js — the one place that answers "what content time is it, and are we in an ad?"
 *
 * Inputs, layered so each can fail on its own (docs/phase0-findings.md):
 *   player  — Netflix's player API via the page hook: getSegmentTime() is content time in
 *             ms and freezes during ads; the ad manager's adPresenting is the in-ad flag.
 *             Primary when available.
 *   layer C — self-calibration: every time Netflix's own (invisible) subtitle layer shows
 *             a cue, match its text against our parsed cues and derive
 *             offset = cue.begin − video.currentTime. Content time is then
 *             video.currentTime + offset. Offsets are piecewise constant (they step at
 *             every ad break and every seek), so a new value is adopted after two
 *             agreeing samples, or immediately when nothing is known yet.
 *             Fallback clock, and a cross-check on the player clock when both exist.
 *   layer B — DOM: [data-uia="ads-info-container"] exists exactly while an ad plays.
 *             Fallback for the in-ad flag.
 */
var MC_CLOCK = (() => {
  /** Netflix paints its cue about this much before the WebVTT start time on the player's clock (measured 2026-09-07). */
  const LEAD_S = 0.1;
  /** Two offset samples closer than this are "the same" offset. */
  const STEP_S = 0.5;
  /** Search radius (s) around the current estimate when matching a native cue. */
  const WINDOW_S = 60;
  /** Player vs layer C disagreement that earns a warning. */
  const DIVERGE_S = 1.0;
  const HISTORY = 5;
  /** How long the player clock must be missing before we announce the fallback. */
  const FALLBACK_AFTER_MS = 1500;

  /** @param {number[]} xs */
  function median(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  }

  /**
   * @param {{call: (name: string, arg?: any) => any}} bridge
   * @param {() => HTMLVideoElement | null} getVideo
   * @param {() => boolean} getDomAd layer B: is the DOM ad badge present?
   */
  function create(bridge, getVideo, getDomAd) {
    let source = 'none';
    let playerFailures = 0;
    let failingSince = 0;
    let fallbackAnnounced = false;
    let divergenceWarned = false;
    /** @type {null | ((text: string, estimate: number | null) => {begin: number, ambiguous: boolean} | null)} */
    let matcher = null;
    /** @type {number | null} last player content time (s), for disambiguation and cross-checking */
    let lastPlayerT = null;

    // layer C state
    let offset = 0;
    let offsetKnown = false;
    /** @type {number | null} */
    let pending = null;
    /** @type {number[]} */
    let accepted = [];
    let unmatched = 0;
    let steps = 0;
    /** @type {ReturnType<typeof MC_UTIL.ring<{media: number, begin: number, offset: number, text: string, player: number | null, div: number | null}>>} */
    const matches = MC_UTIL.ring(60);
    /** @type {number[]} */
    let divergences = [];

    /** One sample from the page hook: [contentMs, adPresenting, movieId] or null. */
    function playerSample() {
      try { return bridge.call('t'); } catch { return null; }
    }

    /** @returns {{t: number, inAd: boolean, source: string, movieId: any}} t is content seconds */
    function now() {
      const v = getVideo();
      const media = v ? v.currentTime : 0;
      const r = playerSample();
      const contentMs = r && typeof r[0] === 'number' ? r[0] : null;
      const adFlag = r && typeof r[1] === 'boolean' ? r[1] : null;
      const inAd = adFlag !== null ? adFlag : !!getDomAd();
      if (contentMs !== null) {
        if (source !== 'player') {
          if (source === 'video') MC_UTIL.log('clock: player content clock is back; leaving layer C fallback');
          source = 'player';
        }
        playerFailures = 0;
        failingSince = 0;
        fallbackAnnounced = false;
        lastPlayerT = contentMs / 1000;
        return { t: lastPlayerT + LEAD_S, inAd, source, movieId: r[2] };
      }
      playerFailures++;
      lastPlayerT = null;
      if (!failingSince) failingSince = Date.now();
      if (Date.now() - failingSince >= FALLBACK_AFTER_MS && !fallbackAnnounced) {
        fallbackAnnounced = true;
        source = 'video';
        MC_UTIL.warn(`clock: no player content clock for ${FALLBACK_AFTER_MS} ms (${r ? 'getSegmentTime missing/throwing' : 'no watch player'}); using video.currentTime + layer C offset (${offsetKnown ? offset.toFixed(3) + 's' : 'unknown yet, assuming 0'}). Netflix's own subtitles must be ON for layer C to calibrate.`);
      }
      if (source !== 'player') source = 'video';
      return { t: media + offset, inAd, source, movieId: r ? r[2] : null };
    }

    /** @param {(text: string, estimate: number | null) => {begin: number, ambiguous: boolean} | null} fn */
    function setMatcher(fn) { matcher = fn; }

    /**
     * Feed a native cue appearance. `media` is video.currentTime at that moment.
     * @param {string} text @param {number} media
     */
    function observeNative(text, media) {
      if (!matcher) return;
      const r = playerSample();
      const playerT = r && typeof r[0] === 'number' ? r[0] / 1000 : null;
      const inAd = r && typeof r[1] === 'boolean' ? r[1] : !!getDomAd();
      if (inAd) return;
      const estimate = offsetKnown ? media + offset : null;
      const hint = estimate ?? playerT;
      let m = matcher(text, hint);
      if (!m && hint != null) {
        // Nothing near the estimate: the offset may have stepped further than the window
        // (a long ad break, a seek through an ad). Accept a globally unique text as a candidate.
        m = matcher(text, null);
        if (m && m.ambiguous) m = null;
      }
      if (!m) { unmatched++; return; }
      if (m.ambiguous && hint == null) return; // wait for a cue whose text is unique
      const o = m.begin - media;
      if (!offsetKnown) {
        offset = o; offsetKnown = true; accepted = [o]; pending = null;
      } else if (Math.abs(o - offset) < STEP_S) {
        accepted.push(o);
        if (accepted.length > HISTORY) accepted.shift();
        offset = median(accepted);
        pending = null;
      } else if (pending !== null && Math.abs(o - pending) < STEP_S) {
        const prev = offset;
        offset = (o + pending) / 2; accepted = [pending, o]; pending = null; steps++;
        MC_UTIL.log(`clock: layer C offset stepped ${prev.toFixed(3)}s → ${offset.toFixed(3)}s (confirmed by 2 cues)`);
      } else {
        pending = o;
      }
      const div = playerT != null ? +(playerT - (media + offset)).toFixed(3) : null;
      if (div != null) {
        divergences.push(div);
        if (divergences.length > 8) divergences.shift();
        if (divergences.length >= 3 && Math.abs(median(divergences)) > DIVERGE_S && !divergenceWarned) {
          divergenceWarned = true;
          MC_UTIL.warn(`clock: player clock and layer C disagree by ${median(divergences).toFixed(2)}s (median of ${divergences.length}). One of them changed meaning; check getSegmentTime() vs native cue timing.`);
        }
      }
      matches.push({ media: +media.toFixed(3), begin: m.begin, offset: +o.toFixed(3), text: text.slice(0, 40), player: playerT != null ? +playerT.toFixed(3) : null, div });
    }

    /** A seek or a new <video> element: the media→content mapping is unknown again (plain seeks re-base it to 0). */
    function onSeek() {
      offset = 0; offsetKnown = false; pending = null; accepted = []; divergences = [];
    }

    function status() {
      return {
        source, playerFailures, lead: LEAD_S,
        layerC: { offset: +offset.toFixed(3), known: offsetKnown, pending, accepted: accepted.map((x) => +x.toFixed(3)), steps, matched: matches.length, unmatched },
        divergence: { n: divergences.length, median: divergences.length ? +median(divergences).toFixed(3) : null, last: divergences.slice(-4) },
        recent: matches.items().slice(-6),
      };
    }

    return { now, setMatcher, observeNative, onSeek, status, get source() { return source; } };
  }
  return { create };
})();
