// @ts-check
/*
 * content.js — extension side (isolated world), document_start.
 *
 * Phase 0: instrumentation only. Watches the <video> element, the player DOM
 * (for ad UI appearing / disappearing, via data-uia diffs and ad-word text),
 * Netflix's native subtitle layer, and the URL, and stamps every observation
 * with video.currentTime (media time). Also asks the page hook for the player
 * API clock so the two can be compared over time.
 *
 * Nothing here renders anything yet.
 */
(() => {
  if (typeof MC_UTIL === 'undefined' || typeof MC_NFLX === 'undefined' || typeof MC_BRIDGE === 'undefined') {
    console.error('[multicap] shared modules (netflix.js / util.js / bridge.js) did not load before content.js — check the js order in manifest.json', 'content.js');
    return;
  }
  const U = MC_UTIL;
  const N = MC_NFLX;
  const bridge = MC_BRIDGE.create('ext');
  const startedAt = Date.now();

  /** @type {ReturnType<typeof U.ring<{t: number, media: number | null, kind: string, detail: string}>>} */
  const timeline = U.ring(3000);
  /** @type {ReturnType<typeof U.ring<{media: number | null, text: string}>>} */
  const nativeCues = U.ring(300);
  /** @type {Map<string, {first: number | null, adds: number, removes: number, muted: boolean}>} */
  const uiaStats = new Map();

  /** @type {HTMLVideoElement | null} */
  let video = null;
  let videoGen = 0;
  let lastSeenTime = 0;

  const mt = () => (video && Number.isFinite(video.currentTime) ? +video.currentTime.toFixed(3) : null);

  /**
   * Record one observation, stamped with media time.
   * @param {string} kind @param {string} [detail] @param {{quiet?: boolean}} [opts]
   */
  function mark(kind, detail = '', opts = {}) {
    const e = { t: Date.now(), media: mt(), kind, detail };
    timeline.push(e);
    if (!opts.quiet) U.log(`@${e.media == null ? '--' : e.media.toFixed(3)}s  ${kind}`, detail);
    return e;
  }

  // ---- video element --------------------------------------------------------------

  const VIDEO_EVENTS = ['loadstart', 'loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'stalled', 'emptied', 'abort', 'error', 'ended', 'ratechange'];

  /** @param {HTMLVideoElement} v */
  function videoDesc(v) {
    const src = v.currentSrc || v.src || '';
    return `dur=${U.fmtSec(v.duration)} paused=${v.paused} rate=${v.playbackRate} ready=${v.readyState} src=${src ? src.slice(0, 50) : '(none)'}`;
  }

  /** Compare the element's duration (media time) with the manifest's (assumed content time). @param {HTMLVideoElement} v */
  function durationVsManifest(v) {
    const ms = /** @type {any[]} */ (U.safe(() => bridge.call('manifests'), []) ?? []);
    const m = ms[ms.length - 1];
    if (!m || typeof m.durationMs !== 'number' || !Number.isFinite(v.duration)) return 'manifest duration: n/a';
    const videoMs = Math.round(v.duration * 1000);
    return `manifest.duration=${m.durationMs}ms video.duration=${videoMs}ms diff=${videoMs - m.durationMs >= 0 ? '+' : ''}${videoMs - m.durationMs}ms (stitched-ad total?)`;
  }

  function clockLine() {
    const c = U.safe(() => bridge.call('clock'), null);
    if (!c) return 'api clock: bridge unavailable';
    if (c.api) return `api clock: ${c.api}`;
    return `api.currentTime=${c.apiCurrentTime} api.duration=${c.apiDuration} api−video=${c.apiMinusVideoMs}ms`;
  }

  /** @param {HTMLVideoElement} v */
  function attachVideo(v) {
    video = v;
    const gen = ++videoGen;
    const all = document.querySelectorAll(N.SEL.video).length;
    mark('video:attach', `#${gen} (${all} video element(s) on page) ${videoDesc(v)}`);
    for (const ev of VIDEO_EVENTS) {
      v.addEventListener(ev, () => {
        if (video !== v) return;
        let extra = '';
        if (ev === 'durationchange' || ev === 'loadedmetadata') extra = '  ' + durationVsManifest(v);
        else if (ev === 'seeking') extra = `  from=${U.fmtSec(lastSeenTime)} to=${U.fmtSec(v.currentTime)}`;
        else if (ev === 'seeked') extra = '  ' + clockLine();
        mark('video:' + ev, videoDesc(v) + extra);
      });
    }
  }

  function videoTick() {
    const v = /** @type {HTMLVideoElement | null} */ (document.querySelector(N.SEL.video));
    if (v !== video) {
      if (video && !video.isConnected) mark('video:detached', `#${videoGen}`);
      if (v) attachVideo(v);
      else if (video) { mark('video:gone'); video = null; }
    }
    if (video) lastSeenTime = video.currentTime;
  }

  function clockTick() {
    if (!video || video.paused || !video.isConnected) return;
    U.muted(`@${U.fmtSec(mt())} clock  ${videoDesc(video)}  ${clockLine()}`);
    mark('clock', `${videoDesc(video)}  ${clockLine()}`, { quiet: true });
  }

  // ---- DOM discovery: data-uia diffs + ad-word text ---------------------------------

  let uiaPrev = new Set();
  let uiaScheduled = false;
  let warnedNoRoot = false;
  let watchSince = Date.now();

  /** Scope for data-uia diffs: the player shell. Falls back to <body> only after the player has had time to mount. */
  function discoveryRoot() {
    const root = document.querySelector(N.SEL.playerRoot);
    if (root) return root;
    if (!N.watchIdFromUrl(location.href) || Date.now() - watchSince < 10000) return null;
    if (!warnedNoRoot) {
      warnedNoRoot = true;
      U.warn(`on /watch for 10s but no '${N.SEL.playerRoot}' element found; scanning document.body instead (fix SEL.playerRoot in netflix.js)`);
    }
    return document.body;
  }

  function sampleUia() {
    uiaScheduled = false;
    const root = discoveryRoot();
    if (!root) { uiaPrev = new Set(); return; }
    const now = new Set();
    for (const el of root.querySelectorAll('[data-uia]')) now.add(el.getAttribute('data-uia') ?? '');
    if (!uiaPrev.size && now.size) {
      mark('uia:baseline', `${now.size} values: ${[...now].join('  ')}`);
      for (const v of now) uiaStats.set(v, { first: mt(), adds: 1, removes: 0, muted: false });
      uiaPrev = now;
      return;
    }
    for (const v of now) if (!uiaPrev.has(v)) noteUia(v, '+');
    for (const v of uiaPrev) if (!now.has(v)) noteUia(v, '-');
    uiaPrev = now;
  }

  /** @param {string} v @param {'+' | '-'} sign */
  function noteUia(v, sign) {
    let s = uiaStats.get(v);
    if (!s) uiaStats.set(v, (s = { first: mt(), adds: 0, removes: 0, muted: false }));
    if (sign === '+') s.adds++; else s.removes++;
    if (s.muted) return;
    const adLike = N.AD_TOKEN_RE.test(v);
    const flips = s.adds + s.removes;
    if (flips > 16 && !adLike) {
      s.muted = true;
      mark('uia:mute', `${v} flips too often; muting`, { quiet: true });
      return;
    }
    mark(`uia${sign}`, v + (adLike ? '   <== AD-LIKE' : ''), { quiet: !adLike && flips > 6 });
  }

  /** @type {Map<string, number>} */
  const recentAdText = new Map();

  /** @param {Element | null} el @param {string} how */
  function reportAdText(el, how) {
    if (!el) return;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    if (!text || !N.AD_TEXT_RE.test(text)) return;
    const last = recentAdText.get(text);
    if (last && Date.now() - last < 3000) return;
    recentAdText.set(text, Date.now());
    mark('ad-text:' + how, `"${text}"  <${el.tagName.toLowerCase()} data-uia=${el.getAttribute('data-uia') ?? '-'} class=${(el.getAttribute('class') || '-').slice(0, 60)}>`);
  }

  /** Smallest elements in an added subtree whose text mentions ads. @param {Element} el */
  function scanAdTextTree(el) {
    const whole = el.textContent || '';
    if (!whole || whole.length > 2000 || !N.AD_TEXT_RE.test(whole)) return;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (N.AD_TEXT_RE.test(n.nodeValue || '')) reportAdText(n.parentElement, 'added');
  }

  const observer = new MutationObserver((muts) => {
    if (!uiaScheduled) { uiaScheduled = true; setTimeout(sampleUia, 150); }
    for (const m of muts) {
      if (m.type === 'characterData') reportAdText(m.target.parentElement, 'changed');
      else for (const n of m.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE) scanAdTextTree(/** @type {Element} */ (n));
        else if (n.nodeType === Node.TEXT_NODE) reportAdText(n.parentElement, 'added');
      }
    }
  });

  // ---- native subtitle layer (does Netflix keep updating it? what does it show during ads?) ----

  /** @type {Element | null} */
  let ttEl = null;
  let ttLast = '';
  let ttCount = 0;

  function timedTextTick() {
    const el = document.querySelector(N.SEL.timedtext);
    if (el === ttEl) return;
    ttEl = el;
    ttLast = '';
    if (!el) { mark('native:gone', `${N.SEL.timedtext} left the DOM`); return; }
    const cs = getComputedStyle(el);
    mark('native:attach', `${N.SEL.timedtext} found (opacity=${cs.opacity} display=${cs.display} visibility=${cs.visibility})`);
    const obs = new MutationObserver(() => {
      if (ttEl !== el) { obs.disconnect(); return; }
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t === ttLast) return;
      ttLast = t;
      ttCount++;
      nativeCues.push({ media: mt(), text: t });
      if (ttCount <= 25) mark('native:cue', t ? `"${t.slice(0, 80)}"` : '(cleared)');
      else if (ttCount === 26) mark('native:cue', '… further native cue changes recorded silently (see summary)');
    });
    obs.observe(el, { subtree: true, childList: true, characterData: true });
  }

  // ---- URL + manifest watchdog -------------------------------------------------------

  let lastHref = '';
  let watchdog = 0;
  const WATCHDOG_MS = 25000;

  function urlTick() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    mark('url', lastHref);
    clearTimeout(watchdog);
    const id = N.watchIdFromUrl(lastHref);
    if (!id) return;
    watchSince = Date.now();
    watchdog = setTimeout(() => {
      const ms = /** @type {any[]} */ (U.safe(() => bridge.call('manifests'), []) ?? []);
      if (ms.some((m) => String(m.movieId) === id)) U.log(`watchdog ok: manifest for /watch/${id} was captured`);
      else U.warn(`on /watch/${id} for ${WATCHDOG_MS / 1000}s but no manifest with movieId=${id} captured (captured: ${ms.map((m) => m.movieId).join(', ') || 'none'}). The JSON.parse hook may be stale — see src/netflix.js manifestFromParsed().`);
    }, WATCHDOG_MS);
  }

  // ---- bridge wiring -----------------------------------------------------------------

  bridge.on('manifest', (m) => {
    mark('manifest', `movieId=${m.movieId} dur=${m.durationMs}ms tracks=${m.trackCount} adverts=${m.advertsSummary} aux=${m.auxCount}`);
    setTimeout(() => {
      const p = U.safe(() => bridge.call('probe'), null);
      if (!p) mark('probe', 'bridge call failed');
      else mark('probe', p.ok ? `ok session=${p.session} getters=${Object.keys(p.getters).length} clock=${U.summarize(p.clock)}` : `FAILED: ${p.error}`);
    }, 4000);
  });
  bridge.on('request', (r) => mark('request', `manifest request ${r.changes.length ? r.changes.join('; ') : 'seen, unchanged'} (params: ${r.paramKeys.join(', ')})`));
  bridge.handle('ping', () => 'pong');
  bridge.handle('report', () => ({
    startedAt,
    video: video ? videoDesc(video) : null,
    timeline: timeline.items(),
    uia: [...uiaStats].map(([v, s]) => ({ v, ...s })),
    nativeCueCount: ttCount,
    nativeCues: nativeCues.items().slice(0, 40),
  }));

  // ---- boot --------------------------------------------------------------------------

  function tick() { videoTick(); timedTextTick(); urlTick(); }

  function boot() {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setInterval(tick, 500);
    setInterval(clockTick, 5000);
    const pong = U.safe(() => bridge.call('ping'), null);
    if (pong !== 'pong') U.warn('page hook (MAIN world) not reachable — JSON hooks are NOT active. Check manifest.json content_scripts and that Chrome ≥ 111.');
    else U.log('phase-0 instrumentation active; page hook reachable. In the page console: __multicap.help()');
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
