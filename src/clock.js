// @ts-check
/*
 * clock.js — the one place that answers "what content time is it, and are we in an ad?"
 *
 * Sources, in order:
 *   1. player — Netflix's player API via the page hook: getSegmentTime() (content ms,
 *               frozen during ads) plus the ad manager's adPresenting flag. Verified
 *               2026-09-07 across mid-rolls, pre-rolls, seeks, and pauses.
 *   2. video  — video.currentTime with no correction. Only a stopgap: media time
 *               diverges from content time after ads and after seeks (see
 *               docs/phase0-findings.md). Phase 3 adds native-cue calibration
 *               (Layer C) on top of this source.
 */
var MC_CLOCK = (() => {
  /**
   * @param {{call: (name: string, arg?: any) => any}} bridge
   * @param {() => HTMLVideoElement | null} getVideo
   */
  function create(bridge, getVideo) {
    let failures = 0;
    let warned = false;
    let source = 'none';
    return {
      /** @returns {{t: number, inAd: boolean, source: string, movieId: any}} t is content seconds */
      now() {
        let r = null;
        try { r = bridge.call('t'); } catch { r = null; }
        if (r && typeof r[0] === 'number') {
          source = 'player';
          failures = 0;
          return { t: r[0] / 1000, inAd: !!r[1], source, movieId: r[2] };
        }
        failures++;
        if (failures === 60 && !warned) {
          warned = true;
          MC_UTIL.warn('player clock unavailable for 60 frames; falling back to video.currentTime with no ad correction. See MC_NFLX.watchPlayer / contentTimeMs.');
        }
        source = 'video';
        const v = getVideo();
        return { t: v ? v.currentTime : 0, inAd: false, source, movieId: null };
      },
      get source() { return source; },
    };
  }
  return { create };
})();
