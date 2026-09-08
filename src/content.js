// @ts-check
/*
 * content.js — extension side (isolated world), document_start.
 *
 * Owns the playback session: when the page hook reports a manifest, pick the
 * configured track, fetch and parse its WebVTT, mount the overlay next to the
 * <video>, and drive it from the content clock on requestAnimationFrame.
 *
 * Keeps the Phase 0 instrumentation (video events, data-uia diffs, ad text,
 * native subtitle cues, URL changes), stamped with media time, because it is
 * how breakage gets diagnosed.
 */
(() => {
  if (typeof MC_UTIL === 'undefined' || typeof MC_NFLX === 'undefined' || typeof MC_BRIDGE === 'undefined') {
    console.error('[multicap] shared modules missing in content.js — dist/ is stale or mis-built; run: npm run build');
    return;
  }
  const U = MC_UTIL;
  const N = MC_NFLX;
  const bridge = MC_BRIDGE.create('ext');
  const startedAt = Date.now();

  /** @type {ReturnType<typeof U.ring<{t: number, media: number | null, kind: string, detail: string}>>} */
  const timeline = U.ring(3000);
  /** @type {ReturnType<typeof U.ring<{media: number | null, content: number, text: string}>>} */
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
    return `api.currentTime=${c.apiCurrentTime} content=${c.contentTimeMs}ms ad=${c.adPresenting}${c.adBreakIndex != null ? '#' + c.adBreakIndex : ''} api−video=${c.apiMinusVideoMs}ms`;
  }

  /** @param {HTMLVideoElement} v */
  function attachVideo(v) {
    video = v;
    const gen = ++videoGen;
    const all = document.querySelectorAll(N.SEL.video).length;
    mark('video:attach', `#${gen} (${all} video element(s) on page) ${videoDesc(v)}`);
    clock.onSeek();
    if (session) overlay.attach(v, SLOTS);
    for (const ev of VIDEO_EVENTS) {
      v.addEventListener(ev, () => {
        if (video !== v) return;
        let extra = '';
        if (ev === 'durationchange' || ev === 'loadedmetadata') extra = '  ' + durationVsManifest(v);
        else if (ev === 'seeking') { extra = `  from=${U.fmtSec(lastSeenTime)} to=${U.fmtSec(v.currentTime)}`; clock.onSeek(); }
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
      else if (video) { mark('video:gone'); video = null; overlay.detach(); }
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
      mark('uia:baseline', `${now.size} values: ${[...now].join('  ')}`, { quiet: true });
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
    mark(`uia${sign}`, v + (adLike ? '   <== AD-LIKE' : ''), { quiet: !adLike });
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
    if (el === ttEl) { applyNativeVisibility(); return; }
    ttEl = el;
    ttLast = '';
    if (!el) { mark('native:gone', `${N.SEL.timedtext} left the DOM`); return; }
    const cs = getComputedStyle(el);
    mark('native:attach', `${N.SEL.timedtext} found (opacity=${cs.opacity} display=${cs.display} visibility=${cs.visibility})`);
    applyNativeVisibility();
    const obs = new MutationObserver(() => {
      if (ttEl !== el) { obs.disconnect(); return; }
      const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (t === ttLast) return;
      ttLast = t;
      ttCount++;
      const media = video ? video.currentTime : 0;
      if (t) clock.observeNative(t, media);
      const c = clock.now();
      nativeCues.push({ media: mt(), content: c.t, text: t });
      if (ttCount <= 8) mark('native:cue', t ? `content=${c.t.toFixed(3)} "${t.slice(0, 80)}"` : '(cleared)');
      else if (ttCount === 9) mark('native:cue', '… further native cue changes recorded silently (see summary / __multicap.sync())');
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
    if (!id) { stopSession('left /watch'); return; }
    watchSince = Date.now();
    watchdog = setTimeout(() => {
      const ms = /** @type {any[]} */ (U.safe(() => bridge.call('manifests'), []) ?? []);
      if (ms.some((m) => String(m.movieId) === id)) U.log(`watchdog ok: manifest for /watch/${id} was captured`);
      else U.warn(`on /watch/${id} for ${WATCHDOG_MS / 1000}s but no manifest with movieId=${id} captured (captured: ${ms.map((m) => m.movieId).join(', ') || 'none'}). Neither the player graph (MANIFEST_PATH / findManifest) nor the JSON.parse hook produced it — see src/netflix.js.`);
    }, WATCHDOG_MS);
  }

  // ---- session: tracks → cues → overlay, driven by the content clock ------------------

  /** Two slots: top line, bottom line. Which language fills each is a persisted setting. */
  const SLOTS = 2;
  const clock = MC_CLOCK.create(bridge, () => video, () => domAd);
  const overlay = MC_OVERLAY.create();
  const picker = MC_PICKER.create({
    onSlot(slot, lang) { const langs = MC_SETTINGS.get().langs.slice(); langs[slot] = lang; MC_SETTINGS.save({ langs }); },
    onEnabled(enabled) { MC_SETTINGS.save({ enabled }); },
  });
  const settingsReady = MC_SETTINGS.load().then((st) => { picker.setState({ langs: st.langs, enabled: st.enabled }); return st; });
  let lastLangsKey = '';
  MC_SETTINGS.onChange((st) => {
    picker.setState({ langs: st.langs, enabled: st.enabled });
    mark('settings', `slots=${st.langs.map((l) => l || 'off').join(' / ')} enabled=${st.enabled}`);
    const key = st.langs.join('|');
    if (key !== lastLangsKey && session) startSession(session.movieId, 'slots changed', true);
    lastLangsKey = key;
  });
  let pauseAdPresent = false;
  let controlsVisible = false;
  /** Parsed cue lists by `${movieId}|${trackId}`, so switching a slot back and forth is instant. */
  const cueCache = new Map();

  /** @typedef {{begin: number, end: number, text: string, settings: string, norm?: string}} Cue */
  /** @typedef {{pick: any, cues: Cue[], cursor: {i: number}}} Line */
  /** @typedef {{movieId: any, lines: Array<Line | null>, raf: number, lastKey: string, stopped: boolean, startedAt: number, cueChanges: number}} Session */
  /** @type {Session | null} */
  let session = null;

  /** @param {any} movieId */
  function tracksFor(movieId) {
    return /** @type {any[]} */ (U.safe(() => bridge.call('tracks', movieId), []) ?? []);
  }

  /**
   * @param {any} movieId @param {string} why @param {boolean} [force] restart even for the same title
   */
  async function startSession(movieId, why, force) {
    if (!force && session && String(session.movieId) === String(movieId)) return;
    stopSession(why);
    await settingsReady;
    const st = MC_SETTINGS.get();
    lastLangsKey = st.langs.join('|');
    const rows = tracksFor(movieId);
    picker.setTracks(rows);
    /** @type {Session} */
    const s = { movieId, lines: [], raf: 0, lastKey: '', stopped: false, startedAt: Date.now(), cueChanges: 0 };
    session = s;
    mark('session:start', `movieId=${movieId} slots=${st.langs.map((l) => l || 'off').join(' / ')} (${why})`);
    const lines = await Promise.all(st.langs.map((lang, i) => loadLine(movieId, rows, lang, i)));
    if (session !== s) return; // superseded while fetching
    s.lines = lines;
    picker.setState({ resolved: lines.map((l) => (l ? l.pick.lang : null)) });
    if (!lines.some(Boolean)) {
      mark('session:empty', 'no usable track for any slot; overlay stays down');
      session = null;
      applyNativeVisibility();
      return;
    }
    mark('session:ready', lines.map((l, i) => (l ? `slot${i}=${l.pick.lang} "${l.pick.name}" ${l.cues.length} cues` : `slot${i}=off`)).join('; '));
    if (video) overlay.attach(video, SLOTS);
    applyNativeVisibility();
    s.raf = requestAnimationFrame(frame);
  }

  /**
   * Resolve one slot to a track and its parsed cues (cached per title + track).
   * @param {any} movieId @param {any[]} rows @param {string | null} lang @param {number} slot
   * @returns {Promise<Line | null>}
   */
  async function loadLine(movieId, rows, lang, slot) {
    if (!lang) return null;
    const pick = N.pickTrack(rows, lang);
    if (!pick) {
      U.warn(`slot ${slot}: no '${lang}' text track with WebVTT for movieId=${movieId}; available: ${rows.filter((t) => t.url).map((t) => t.lang).join(', ') || 'none'}`);
      return null;
    }
    const key = `${movieId}|${pick.id}`;
    let cues = cueCache.get(key);
    if (!cues) {
      let text = '';
      try {
        const resp = await fetch(pick.url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        text = await resp.text();
      } catch (err) {
        U.warn(`slot ${slot}: subtitle fetch failed for ${pick.lang} (${String(err).slice(0, 120)})`);
        return null;
      }
      const parsed = MC_SUBS.parseWebVTT(text);
      for (const w of parsed.warnings) U.warn(`webvtt (${pick.lang}):`, w);
      if (!parsed.cues.length) return null;
      cues = parsed.cues;
      for (const cue of cues) cue.norm = MC_SUBS.normalizeForMatch(cue.text);
      cueCache.set(key, cues);
      if (cueCache.size > 12) cueCache.delete(cueCache.keys().next().value);
    }
    return { pick, cues, cursor: { i: 0 } };
  }

  /** @param {string} why */
  function stopSession(why) {
    if (!session) return;
    session.stopped = true;
    cancelAnimationFrame(session.raf);
    mark('session:stop', `movieId=${session.movieId} (${why})`);
    session = null;
    overlay.detach();
    applyNativeVisibility();
  }

  function frame() {
    const s = session;
    if (!s || s.stopped) return;
    s.raf = requestAnimationFrame(frame);
    if (!video || !video.isConnected) return;
    if (!overlay.mounted) overlay.attach(video, SLOTS);
    const c = clock.now();
    const wrongMovie = c.movieId != null && String(c.movieId) !== String(s.movieId);
    const hidden = wrongMovie || c.inAd || !MC_SETTINGS.get().enabled || pauseAdPresent;
    const texts = s.lines.map((l) => (hidden || !l ? '' : MC_SUBS.activeCues(l.cues, c.t, l.cursor).map((x) => x.text).join('\n')));
    const key = JSON.stringify(texts) + (hidden ? '|hidden' : '');
    if (key === s.lastKey) return;
    s.lastKey = key;
    s.cueChanges++;
    overlay.render(texts, !hidden);
    if (texts.some(Boolean)) mark('cue', `content=${c.t.toFixed(3)} ${texts.map((t) => JSON.stringify(t.slice(0, 40))).join(' / ')}`, { quiet: true });
  }

  /**
   * Netflix's own subtitle layer: invisible while we render (it keeps updating, which layer C
   * needs). A constructed stylesheet with !important survives Netflix rewriting the element's
   * style attribute (observed after an ad break); the inline opacity is a belt-and-braces
   * fallback re-applied on every tick.
   */
  /** @type {CSSStyleSheet | null} */
  let nativeSheet = null;
  function applyNativeVisibility() {
    const hide = !!session;
    try {
      if (!nativeSheet) {
        nativeSheet = new CSSStyleSheet();
        nativeSheet.replaceSync(`${N.SEL.timedtext} { opacity: 0 !important; }`);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, nativeSheet];
      }
      nativeSheet.disabled = !hide;
    } catch (err) {
      if (!nativeSheetWarned) { nativeSheetWarned = true; U.warn('constructed stylesheet unavailable; relying on inline opacity for the native layer:', err); }
    }
    if (ttEl instanceof HTMLElement && ttEl.style.opacity !== (hide ? '0' : '')) ttEl.style.opacity = hide ? '0' : '';
  }
  let nativeSheetWarned = false;

  /** Mount the picker inside the player view; mirror the control bar's visibility. */
  function pickerTick() {
    const onWatch = !!N.watchIdFromUrl(location.href);
    const view = onWatch ? /** @type {HTMLElement | null} */ (document.querySelector(N.SEL.playerView)) : null;
    if (view) picker.mount(view);
    else if (picker.mounted) picker.unmount();
    const cv = !!document.querySelector(N.SEL.controls);
    if (cv !== controlsVisible) {
      controlsVisible = cv;
      picker.setControlsVisible(cv);
      overlay.setRaised(cv);
    }
  }

  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyM') { picker.toggle(); e.preventDefault(); e.stopPropagation(); }
    else if (e.code === 'KeyH') { MC_SETTINGS.save({ enabled: !MC_SETTINGS.get().enabled }); e.preventDefault(); e.stopPropagation(); }
  }, true);

  function sessionSummary() {
    const st = MC_SETTINGS.get();
    if (!session) return { active: false, clockSource: clock.source, settings: st };
    const c = clock.now();
    return {
      active: true, movieId: session.movieId,
      lines: session.lines.map((l, i) => (l ? `${i}: ${l.pick.lang} "${l.pick.name}" (${l.pick.raw}) ${l.cues.length} cues` : `${i}: off`)),
      cueChanges: session.cueChanges, overlayMounted: overlay.mounted, pickerMounted: picker.mounted, settings: st,
      clock: { contentTime: +c.t.toFixed(3), inAd: c.inAd, source: c.source, mediaTime: video ? +video.currentTime.toFixed(3) : null },
      showing: session.lines.map((l) => (l ? MC_SUBS.activeCues(l.cues, c.t, { i: l.cursor.i }).map((x) => x.text).join('\n') : '')),
      pauseAdPresent, controlsVisible, clockStatus: clock.status(),
    };
  }

  // ---- layer C matcher: native cue text → parsed cue start time ----------------------------
  // Cue text is normalized once at load (cue.norm). With an estimate, only cues within the
  // clock's window are considered and the nearest wins; without one, a unique text is required.
  clock.setMatcher((text, estimate) => {
    if (!session) return null;
    const want = MC_SUBS.normalizeForMatch(text);
    if (!want) return null;
    /** @type {number[]} */
    const hits = [];
    for (const line of session.lines) {
      if (!line) continue;
      for (const cue of line.cues) {
        if (estimate != null && Math.abs(cue.begin - estimate) > 60) continue;
        if (cue.norm === want) hits.push(cue.begin);
      }
    }
    if (!hits.length) return null;
    if (estimate == null) return { begin: hits[0], ambiguous: hits.length > 1 };
    hits.sort((a, b) => Math.abs(a - estimate) - Math.abs(b - estimate));
    return { begin: hits[0], ambiguous: hits.length > 1 && Math.abs(hits[1] - estimate) < 60 };
  });

  // ---- bridge wiring -----------------------------------------------------------------

  bridge.on('manifest', (m) => {
    mark('manifest', `movieId=${m.movieId} dur=${m.durationMs}ms tracks=${m.trackCount} adverts=${m.advertsSummary} aux=${m.auxCount}`);
    if (N.watchIdFromUrl(location.href)) startSession(m.movieId, 'new manifest');
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
    nativeCues: nativeCues.items().slice(-40),
    session: sessionSummary(),
  }));
  bridge.handle('session', sessionSummary);
  bridge.handle('overlay-set', (/** @type {{enabled?: boolean}} */ opts) => {
    if (opts && typeof opts.enabled === 'boolean') MC_SETTINGS.save({ enabled: opts.enabled });
    return { enabled: MC_SETTINGS.get().enabled };
  });
  bridge.handle('settings-get', () => MC_SETTINGS.get());
  bridge.handle('settings-set', (/** @type {any} */ patch) => {
    if (!patch || typeof patch !== 'object') return MC_SETTINGS.get();
    /** @type {{langs?: Array<string | null>, enabled?: boolean}} */
    const clean = {};
    if (Array.isArray(patch.langs)) clean.langs = patch.langs;
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    MC_SETTINGS.save(clean);
    return MC_SETTINGS.get();
  });
  bridge.handle('sync', () => clock.status());

  // ---- boot --------------------------------------------------------------------------

  // ---- manifest via the player graph + DOM ad flag (verified selectors) -----------

  let tickCount = 0;
  let domAd = false;

  function manifestTick() {
    const id = N.watchIdFromUrl(location.href);
    if (!id || tickCount % 4 !== 0) return;
    const ms = /** @type {any[]} */ (U.safe(() => bridge.call('manifests'), []) ?? []);
    if (ms.some((m) => String(m.movieId) === id)) return;
    const r = U.safe(() => bridge.call('manifest-check'), 'bridge unavailable');
    if (typeof r === 'string' && r.startsWith('captured')) mark('manifest:player', r);
  }

  function domAdTick() {
    const now = !!document.querySelector(N.SEL.adsInfo);
    if (now !== domAd) { domAd = now; mark('dom-ad', now ? `ON (${N.SEL.adsInfo} present)` : 'OFF'); }
    const pa = !!document.querySelector(N.SEL.pauseAd);
    if (pa !== pauseAdPresent) { pauseAdPresent = pa; mark('pause-ad', pa ? 'ON' : 'OFF', { quiet: true }); }
  }

  function tick() { tickCount++; videoTick(); timedTextTick(); urlTick(); manifestTick(); domAdTick(); pickerTick(); }

  function boot() {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    setInterval(tick, 500);
    setInterval(clockTick, 10000);
    const pong = U.safe(() => bridge.call('ping'), null);
    if (pong !== 'pong') U.warn('page hook (MAIN world) not reachable — JSON hooks are NOT active. Check manifest.json content_scripts and that Chrome ≥ 111.');
    else U.log('phase-0 instrumentation active; page hook reachable. In the page console: __multicap.help()');
    tick();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
