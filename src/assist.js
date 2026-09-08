// @ts-check
/*
 * assist.js — reading assist: give each Chinese caption a minimum on-screen time.
 *
 * Reading time = Han characters in the caption × secondsPerChar, measured in wall time
 * from the caption's first frame. Modes:
 *   pause      — stop just before the caption would vanish; resume when the time is met.
 *   slow       — lower the playback rate for this caption so it lasts long enough
 *                (floored at minRate), restore the rate when it ends.
 *   slowpause  — slow first, then pause for whatever the floor could not cover.
 * Only pauses we started are resumed. A manual pause, a manual resume, a seek, or an ad
 * cancels the current caption's plan. Everything here is driven from the render loop.
 */
var MC_ASSIST = (() => {
  const HAN_RE = /\p{Script=Han}/gu;
  /** Act this many content seconds before the caption's end (≈ 7 frames). */
  const EPS = 0.12;
  /** Don't bother pausing for less than this. */
  const MIN_PAUSE_S = 0.2;

  /** @typedef {{mode: 'off' | 'pause' | 'slow' | 'slowpause', secondsPerChar: number, minRate: number, autoResume: boolean}} Config */
  /** @typedef {{key: string, chars: number, required: number, startWall: number, end: number, baseRate: number, slowed: number | null, pausedByUs: boolean, acted: boolean, resumeHandle: number}} Caption */

  /**
   * @param {{pause: () => void, play: () => void, setRate: (r: number) => void, getRate: () => number}} actions
   * @param {(msg: string) => void} log
   */
  function create(actions, log) {
    /** @type {Config} */
    let cfg = { mode: 'off', secondsPerChar: 0.4, minRate: 0.5, autoResume: true };
    /** @type {Caption | null} */
    let cap = null;
    let expectingPause = false;
    const stats = { captions: 0, slowed: 0, paused: 0, resumed: 0, cancelled: 0 };
    /** Last decisions, for diagnosing "it didn't pause" reports. */
    const trace = MC_UTIL.ring(40);
    /** @type {{t: number, paused: boolean} | null} last frame seen for the current caption */
    let lastFrame = null;
    /** @param {string} ev @param {Record<string, any>} [x] */
    const tr = (ev, x = {}) => trace.push({ ev, at: +(performance.now() / 1000).toFixed(1), ...x });

    /** @param {Partial<Config>} c */
    function configure(c) {
      cfg = { ...cfg, ...c };
      if (cfg.mode === 'off') reset();
    }

    /** Drop the current caption's plan: restore the rate, cancel a pending resume. Never resumes a pause. */
    function reset() {
      if (!cap) return;
      if (!cap.acted) tr('drop-unacted', { key: cap.key.slice(0, 12), end: cap.end, lastT: lastFrame && lastFrame.t, lastPaused: lastFrame && lastFrame.paused });
      if (cap.slowed != null) { try { actions.setRate(cap.baseRate); } catch { /* player gone */ } }
      if (cap.resumeHandle) clearTimeout(cap.resumeHandle);
      cap = null;
      lastFrame = null;
    }

    /**
     * One frame. `zh` is the Chinese caption text ('' when none), `end` its content end time.
     * @param {{t: number, wall: number, paused: boolean, inAd: boolean, zh: string, end: number}} f
     */
    function update(f) {
      if (cfg.mode === 'off') return;
      if (f.inAd || !f.zh) {
        if (cap && !cap.pausedByUs) reset();
        return;
      }
      if (cap && cap.pausedByUs) return; // holding for the reader; the clock is frozen anyway
      const key = f.zh + '@' + f.end; // text alone would merge back-to-back identical captions
      if (!cap || cap.key !== key) {
        reset();
        const chars = (f.zh.match(HAN_RE) || []).length;
        cap = { key, chars, required: chars * cfg.secondsPerChar, startWall: f.wall, end: f.end, baseRate: 1, slowed: null, pausedByUs: false, acted: false, resumeHandle: 0 };
        stats.captions++;
        tr('new', { key: key.slice(0, 12), t: +f.t.toFixed(3), end: +f.end.toFixed(3), chars, paused: f.paused });
        if (cfg.mode !== 'pause' && !f.paused) {
          const natural = f.end - f.t; // content seconds left ≈ wall seconds at the base rate
          if (natural > 0.05 && natural < cap.required) {
            const base = Number(actions.getRate()) || 1;
            cap.baseRate = base;
            const rate = Math.max(cfg.minRate, natural / cap.required) * base;
            if (rate < base - 0.01) {
              actions.setRate(Math.round(rate * 100) / 100);
              cap.slowed = rate;
              stats.slowed++;
            }
          }
        }
        return;
      }
      lastFrame = { t: +f.t.toFixed(3), paused: f.paused };
      if (cap.acted || f.paused) return;
      if (f.t < cap.end - EPS) return;
      // The caption is about to vanish.
      cap.acted = true;
      tr('act', { t: +f.t.toFixed(3), elapsed: +((f.wall - cap.startWall) / 1000).toFixed(2), required: cap.required });
      if (cap.slowed != null) { actions.setRate(cap.baseRate); cap.slowed = null; }
      const elapsed = (f.wall - cap.startWall) / 1000;
      const needed = cap.required - elapsed;
      if (needed < MIN_PAUSE_S || cfg.mode === 'slow') return;
      cap.pausedByUs = true;
      expectingPause = true;
      stats.paused++;
      actions.pause();
      log(`assist: paused ${needed.toFixed(1)}s for ${cap.chars} chars "${f.zh.slice(0, 24)}"`);
      if (cfg.autoResume) cap.resumeHandle = window.setTimeout(() => resume('reading time met'), needed * 1000);
    }

    /** @param {string} why */
    function resume(why) {
      if (!cap || !cap.pausedByUs) return;
      cap.pausedByUs = false;
      cap.resumeHandle = 0;
      stats.resumed++;
      tr('resume', { why });
      log(`assist: resumed (${why})`);
      actions.play();
    }

    /** video 'pause' event: ours, or the user's. */
    function onVideoPause() {
      if (expectingPause) { expectingPause = false; tr('pause-ours'); return; }
      tr('pause-manual', { cap: cap ? cap.key.slice(0, 12) : null, pausedByUs: cap ? cap.pausedByUs : null });
      if (cap) { // manual pause: leave it alone, and don't act again on this caption
        if (cap.slowed != null) { try { actions.setRate(cap.baseRate); } catch { /* ignore */ } cap.slowed = null; }
        if (cap.resumeHandle) clearTimeout(cap.resumeHandle);
        cap.pausedByUs = false;
        cap.acted = true;
        stats.cancelled++;
      }
    }

    /** video 'play' event: the user (or we) resumed. */
    function onVideoPlay() {
      tr('play', { cap: cap ? cap.key.slice(0, 12) : null, pausedByUs: cap ? cap.pausedByUs : null });
      if (cap && cap.pausedByUs) {
        if (cap.resumeHandle) clearTimeout(cap.resumeHandle);
        cap.pausedByUs = false;
        cap.resumeHandle = 0;
        stats.cancelled++;
      }
    }

    function status() {
      return { mode: cfg.mode, secondsPerChar: cfg.secondsPerChar, minRate: cfg.minRate, autoResume: cfg.autoResume, stats, current: cap ? { chars: cap.chars, required: +cap.required.toFixed(2), slowed: cap.slowed, pausedByUs: cap.pausedByUs, acted: cap.acted } : null, trace: trace.items() };
    }

    return { configure, update, reset, resume, onVideoPause, onVideoPlay, status, get holding() { return !!(cap && cap.pausedByUs); } };
  }

  return { create };
})();
