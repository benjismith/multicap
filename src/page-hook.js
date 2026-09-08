// @ts-check
/*
 * page-hook.js — MAIN world, document_start. Runs before any Netflix script.
 *
 * Responsibilities (kept deliberately thin):
 *   1. Patch JSON.parse to capture the playback manifest (Subadub lineage).
 *   2. Patch JSON.stringify to see the manifest *request* and (optionally) shape it:
 *      ask for WebVTT and for all sub/dub tracks.
 *   3. Introspect the undocumented player API on request (known unknown #5).
 *   4. Expose `__multicap` in the page console for pasteable Phase 0 findings.
 *
 * Everything Netflix-specific comes from netflix.js. This file only wires it up.
 */
(() => {
  if (typeof MC_UTIL === 'undefined' || typeof MC_NFLX === 'undefined' || typeof MC_BRIDGE === 'undefined') {
    console.error('[multicap] shared modules missing in page-hook.js — dist/ is stale or mis-built; run: npm run build');
    return;
  }
  const U = MC_UTIL;
  const N = MC_NFLX;
  const bridge = MC_BRIDGE.create('page');
  const origParse = JSON.parse;
  const origStringify = JSON.stringify;
  const VERSION = 'phase-0';

  const state = {
    installedAt: Date.now(),
    parseCalls: 0,
    stringifyCalls: 0,
    nearMisses: 0,
    /** @type {Array<{at: number, href: string, movieId: any, manifest: any, source: string, info?: any}>} */
    manifests: [],
    /** @type {Array<{at: number, href: string, changes: string[], paramKeys: string[], profiles: string[], shape: string[]}>} */
    requests: [],
    /** @type {any} */
    lastProbe: null,
  };

  // ---- 1. JSON.parse: capture the manifest -----------------------------------

  JSON.parse = function (text, reviver) {
    const value = origParse.apply(JSON, /** @type {any} */ (arguments));
    state.parseCalls++;
    try {
      const m = N.manifestFromParsed(value);
      if (m) onManifest(m);
      else {
        const why = N.nearMissReason(value);
        if (why && state.nearMisses++ < 5) {
          U.warn(`JSON.parse near-miss (schema drift?): ${why}. top-level keys:`, Object.keys(value.result ?? value).slice(0, 40).join(', '));
        }
      }
    } catch (err) {
      U.warn('manifest capture hook threw (ignored):', err);
    }
    return value;
  };

  // ---- 2. JSON.stringify: see and shape the manifest request -----------------

  JSON.stringify = function (value) {
    state.stringifyCalls++;
    try {
      const p = N.manifestRequestParams(value);
      if (p) onManifestRequest(value, p);
    } catch (err) {
      U.warn('manifest request hook threw (ignored):', err);
    }
    return origStringify.apply(JSON, /** @type {any} */ (arguments));
  };

  /** @param {any} body @param {any} params */
  function onManifestRequest(body, params) {
    const changes = N.SHAPE_MANIFEST_REQUESTS ? N.shapeManifestRequest(params) : [];
    const rec = {
      at: Date.now(),
      href: location.href,
      changes,
      paramKeys: Object.keys(params),
      profiles: params.profiles.slice(),
      shape: U.skeleton(body, { maxDepth: 4, maxLines: 100, rootName: 'request' }),
    };
    state.requests.push(rec);
    if (state.requests.length > 10) state.requests.shift();
    U.group(`manifest request seen — ${changes.length ? changes.join('; ') : 'left unchanged'}`, () => {
      U.log('params keys:', rec.paramKeys.join(', '));
      U.log('profiles (after shaping):', rec.profiles.join(', '));
      U.log('request shape:\n' + rec.shape.join('\n'));
    });
    bridge.emit('request', { changes, paramKeys: rec.paramKeys });
  }

  // ---- manifest handling --------------------------------------------------------

  /**
   * Primary manifest source: the player object graph. Records it once per movieId.
   * Returns a short status string for the caller's log.
   */
  function captureFromPlayer() {
    const player = N.watchPlayer();
    if (!player) return 'no watch player';
    const hit = N.manifestFromPlayer(player);
    if (!hit) return 'player has no manifest yet';
    const m = hit.manifest;
    if (state.manifests.some((r) => r.manifest === m)) return 'already captured';
    if (hit.via !== 'path') U.warn(`manifest found by search, not at MANIFEST_PATH (${hit.via}); update src/netflix.js`);
    onManifest(m, 'player:' + hit.via);
    return 'captured movieId=' + m.movieId;
  }

  /** @param {any} m @param {string} [source] */
  function onManifest(m, source = 'JSON.parse') {
    const rec = { at: Date.now(), href: location.href, movieId: m.movieId, manifest: m, source };
    state.manifests.push(rec);
    if (state.manifests.length > 6) state.manifests.shift();
    const info = manifestInfo(rec);
    U.group(`MANIFEST captured (${source}): movieId=${m.movieId} dur=${info.durationMs}ms tracks=${info.tracks.length} adverts=${info.advertsSummary} auxiliaryManifests=${info.auxCount}`, () => {
      U.log('page url:', rec.href, ' source:', source);
      U.log('top-level keys:', info.topKeys.join(', '));
      console.table(info.tracks);
      U.log('ttDownloadables entry keys (union across tracks):', info.downloadableKeys.join(', ') || '(none)');
      U.log('adverts (raw object):', m.adverts);
      U.log('auxiliaryManifests (raw):', m.auxiliaryManifests);
      U.log('ad-related keys anywhere in the manifest:\n' + (info.interest.join('\n') || '(none matched)'));
      U.log('manifest shape (big track arrays pruned):\n' + info.skeleton.join('\n'));
    });
    bridge.emit('manifest', {
      movieId: m.movieId, href: rec.href, durationMs: info.durationMs,
      trackCount: info.tracks.length, advertsSummary: info.advertsSummary, auxCount: info.auxCount,
    });
  }

  /** Derived, cached view of one captured manifest. @param {any} rec */
  function manifestInfo(rec) {
    if (rec.info) return rec.info;
    const m = rec.manifest;
    const tracks = m.timedtexttracks.map(N.describeTrack);
    const dlKeys = new Set();
    for (const t of m.timedtexttracks) {
      if (t && t.ttDownloadables && typeof t.ttDownloadables === 'object') {
        for (const d of Object.values(t.ttDownloadables)) if (d && typeof d === 'object') for (const k of Object.keys(d)) dlKeys.add(k);
      }
    }
    const adv = m.adverts;
    let advertsSummary;
    if (adv === undefined) advertsSummary = 'ABSENT';
    else if (adv === null) advertsSummary = 'null';
    else if (typeof adv !== 'object') advertsSummary = `${typeof adv}:${adv}`;
    else if (Array.isArray(adv)) advertsSummary = `array[${adv.length}]`;
    else advertsSummary = `{${Object.keys(adv).map((k) => `${k}:${U.summarize(adv[k]).slice(0, 40)}`).join(', ')}}`;
    const aux = m.auxiliaryManifests;
    const auxList = Array.isArray(aux) ? aux : [];
    rec.info = {
      movieId: m.movieId,
      durationMs: m.duration,
      topKeys: Object.keys(m),
      tracks,
      downloadableKeys: [...dlKeys],
      advertsSummary,
      auxCount: aux === undefined ? 'ABSENT' : Array.isArray(aux) ? aux.length : `(${typeof aux})`,
      auxShapes: auxList.slice(0, 8).map((a, i) => U.skeleton(a, { maxDepth: 6, maxLines: 60, prune: N.PRUNE_KEYS, rootName: `aux[${i}]` })),
      interest: U.interest(m, N.INTEREST_KEY_RE),
      skeleton: U.skeleton(m, { prune: N.PRUNE_KEYS, rootName: 'manifest' }),
    };
    return rec.info;
  }

  const manifestSummaries = () => state.manifests.map((r) => {
    const i = manifestInfo(r);
    return { at: new Date(r.at).toISOString(), href: r.href, movieId: r.movieId, source: r.source, durationMs: i.durationMs, trackCount: i.tracks.length, advertsSummary: i.advertsSummary, auxCount: i.auxCount };
  });

  // ---- 3. player API probe ------------------------------------------------------

  /** Own + inherited function-valued property names, without triggering getters. @param {any} obj */
  function listMethods(obj) {
    const names = new Set();
    for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) {
        const d = Object.getOwnPropertyDescriptor(o, n);
        if (d && typeof d.value === 'function' && n !== 'constructor') names.add(n);
      }
    }
    return [...names].sort();
  }

  const UNSAFE_NAME_RE = /reset|clear|remove|set|seek|play|pause|load|unload|destroy|dispose|create|open|close|start|stop|toggle|update|register|add|delete|send|request|fetch|report|flush|mute|volume|skip|next|prev/i;
  /** Zero-arg getters only; never anything that could change playback. @param {any} obj @param {string} name */
  function isSafeGetter(obj, name) {
    if (!/^(get|is|has|can|current|available)[A-Z]/.test(name)) return false;
    if (UNSAFE_NAME_RE.test(name)) return false;
    const fn = obj[name];
    return typeof fn === 'function' && fn.length === 0;
  }

  /** @param {any} obj @param {string} name */
  function callSummary(obj, name) {
    try {
      const v = obj[name]();
      if (v && typeof v.then === 'function') return '(promise)';
      return U.summarize(v);
    } catch (err) {
      return `!${String(err).slice(0, 80)}`;
    }
  }

  /** @param {any} [player] */
  function clockSample(player) {
    const video = /** @type {HTMLVideoElement | null} */ (document.querySelector(N.SEL.video));
    /** @type {any} */
    const out = { videoCurrentTime: video ? video.currentTime : null, videoDuration: video ? video.duration : null };
    try {
      let p = player;
      if (!p) {
        const vp = N.playerApi();
        const sid = vp && typeof vp.getAllPlayerSessionIds === 'function' ? N.pickWatchSession(vp.getAllPlayerSessionIds()) : null;
        p = sid != null && vp ? vp.getVideoPlayerBySessionId(sid) : null;
        out.session = sid;
      }
      if (!p) { out.api = 'unavailable'; return out; }
      out.apiCurrentTime = typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : 'no getCurrentTime';
      out.apiDuration = typeof p.getDuration === 'function' ? p.getDuration() : 'no getDuration';
      out.contentTimeMs = N.contentTimeMs(p);
      const ad = N.adState(p);
      out.adPresenting = ad ? ad.presenting : 'no ad manager';
      out.adBreakIndex = ad ? ad.breakIndex : null;
      if (typeof out.apiCurrentTime === 'number' && video) {
        // Belief: the API reports milliseconds. If not, this diff will be absurd and the raw values show why.
        out.apiMinusVideoMs = Math.round(out.apiCurrentTime - video.currentTime * 1000);
      }
    } catch (err) {
      out.api = `error: ${String(err).slice(0, 120)}`;
    }
    return out;
  }

  /** @param {boolean} verbose */
  function probe(verbose) {
    /** @type {any} */
    const out = { at: new Date().toISOString(), ok: false, error: null, sessionIds: null, session: null, videoPlayerMethods: [], playerMethods: [], getters: {}, clock: null };
    try {
      const vp = N.playerApi();
      if (!vp) {
        out.error = 'netflix.appContext.state.playerApp.getAPI().videoPlayer not found';
      } else {
        out.videoPlayerMethods = listMethods(vp);
        const ids = typeof vp.getAllPlayerSessionIds === 'function' ? vp.getAllPlayerSessionIds() : null;
        out.sessionIds = ids;
        const sid = N.pickWatchSession(ids);
        if (sid == null) out.error = 'no player sessions (getAllPlayerSessionIds empty/missing)';
        else {
          out.session = sid;
          const p = typeof vp.getVideoPlayerBySessionId === 'function' ? vp.getVideoPlayerBySessionId(sid) : null;
          if (!p) out.error = 'getVideoPlayerBySessionId returned nothing';
          else {
            out.playerMethods = listMethods(p);
            for (const name of out.playerMethods) if (isSafeGetter(p, name)) out.getters[name] = callSummary(p, name);
            out.clock = clockSample(p);
            out.ok = true;
          }
        }
      }
    } catch (err) {
      out.error = String((err && /** @type {any} */ (err).stack) || err);
    }
    state.lastProbe = out;
    if (verbose) {
      U.group(`player API probe: ${out.ok ? 'ok' : 'FAILED — ' + out.error}`, () => {
        U.log('sessions:', out.sessionIds, '→ using', out.session);
        U.log('videoPlayer methods:', out.videoPlayerMethods.join(', '));
        U.log('player methods:', out.playerMethods.join(', '));
        U.log('zero-arg getters:', out.getters);
        U.log('clock:', out.clock);
      });
    }
    return out;
  }

  // ---- bridge handlers (answered synchronously for the extension side) ----------

  // Per-frame clock for the extension side: [contentMs, adPresenting, movieId] or null.
  // The player lookup walks the session list, so cache it for a second at a time.
  let cachedPlayer = { p: /** @type {any} */ (null), at: 0 };
  function currentPlayer() {
    const now = Date.now();
    if (cachedPlayer.p && now - cachedPlayer.at < 1000) return cachedPlayer.p;
    const p = N.watchPlayer();
    cachedPlayer = { p, at: now };
    return p;
  }
  bridge.handle('t', () => {
    const p = currentPlayer();
    if (!p) return null;
    try {
      const ad = N.adState(p);
      return [N.contentTimeMs(p), ad ? ad.presenting : null, typeof p.getMovieId === 'function' ? p.getMovieId() : null];
    } catch {
      cachedPlayer = { p: null, at: 0 };
      return null;
    }
  });
  /** Track rows (describeTrack + WebVTT url) for a captured manifest, latest if movieId is omitted. */
  function trackRows(/** @type {any} */ movieId) {
    const rec = movieId == null ? state.manifests[state.manifests.length - 1] : state.manifests.find((r) => String(r.movieId) === String(movieId));
    if (!rec) return [];
    return rec.manifest.timedtexttracks.map((/** @type {any} */ t) => ({ ...N.describeTrack(t), url: N.trackDownloadUrl(t, N.WEBVTT_PROFILE) }));
  }
  bridge.handle('tracks', trackRows);
  // Playback actions for the reading assist. Resume prefers Netflix's own UI (see content.js);
  // these are the API fallbacks.
  bridge.handle('pause', () => { const p = currentPlayer(); if (p) p.pause(); return !!p; });
  bridge.handle('play', () => { const p = currentPlayer(); if (p) p.play(); return !!p; });

  bridge.handle('ping', () => 'pong');
  bridge.handle('manifests', manifestSummaries);
  bridge.handle('manifest-check', captureFromPlayer);
  bridge.handle('ad-breaks', () => { const p = N.watchPlayer(); return p ? N.adBreaks(p) : []; });
  bridge.handle('probe', () => probe(true));
  bridge.handle('clock', () => clockSample());

  // ---- 4. console helpers --------------------------------------------------------

  function text() {
    const L = [];
    L.push(`== multicap ${VERSION} summary ==`);
    L.push(`generated: ${new Date().toISOString()}  url: ${location.href}`);
    L.push(`hook installed: ${new Date(state.installedAt).toISOString()}  JSON.parse calls: ${state.parseCalls}  JSON.stringify calls: ${state.stringifyCalls}  near-misses: ${state.nearMisses}`);
    L.push('');
    L.push(`-- manifests captured (${state.manifests.length}) --`);
    for (const s of manifestSummaries()) L.push(`${s.at}  movieId=${s.movieId}  via=${s.source}  dur=${s.durationMs}ms  tracks=${s.trackCount}  adverts=${s.advertsSummary}  aux=${s.auxCount}  ${s.href}`);
    const last = state.manifests[state.manifests.length - 1];
    if (last) {
      const i = manifestInfo(last);
      const m = last.manifest;
      L.push('');
      L.push(`-- latest manifest: movieId=${i.movieId} --`);
      L.push(`top-level keys: ${i.topKeys.join(', ')}`);
      L.push(`duration: ${i.durationMs} (assumed ms)`);
      L.push('');
      L.push(`timedtexttracks (${i.tracks.length}):`);
      L.push(U.table(i.tracks));
      L.push(`ttDownloadables entry keys (union): ${i.downloadableKeys.join(', ') || '(none)'}`);
      L.push('');
      L.push(`adverts (raw): ${m.adverts === undefined ? 'ABSENT' : ''}`);
      if (m.adverts !== undefined) L.push(U.safeJson(m.adverts, 20000));
      L.push('');
      L.push(`auxiliaryManifests: ${i.auxCount}`);
      for (const s of i.auxShapes) L.push(s.join('\n'));
      L.push('');
      L.push('ad-related keys anywhere in the manifest:');
      L.push(i.interest.join('\n') || '(none matched)');
      L.push('');
      L.push('manifest shape (track arrays pruned):');
      L.push(i.skeleton.join('\n'));
    }
    L.push('');
    L.push(`-- manifest requests seen (${state.requests.length}) --`);
    const rq = state.requests[state.requests.length - 1];
    if (rq) {
      L.push(`last: ${new Date(rq.at).toISOString()}  changes: ${rq.changes.join('; ') || 'none'}`);
      L.push(`params keys: ${rq.paramKeys.join(', ')}`);
      L.push(`profiles: ${rq.profiles.join(', ')}`);
      L.push(rq.shape.join('\n'));
    }
    L.push('');
    L.push('-- player API probe --');
    const p = state.lastProbe ?? probe(false);
    L.push(`ok=${p.ok} ${p.error ? 'error=' + p.error : ''} session=${p.session} sessions=${U.summarize(p.sessionIds)}`);
    L.push(`videoPlayer methods: ${p.videoPlayerMethods.join(', ')}`);
    L.push(`player methods: ${p.playerMethods.join(', ')}`);
    L.push('zero-arg getters:');
    for (const [k, v] of Object.entries(p.getters)) L.push(`  ${k}() → ${v}`);
    L.push(`clock: ${U.summarize(p.clock)}`);
    L.push('');
    L.push('-- extension side (isolated world) --');
    try {
      const e = bridge.call('report');
      L.push(`video: ${e.video ?? '(none)'}`);
      L.push(`timeline (${e.timeline.length} entries, last ${Math.min(e.timeline.length, 400)} shown):`);
      for (const t of e.timeline.slice(-400)) L.push(`  +${((t.t - e.startedAt) / 1000).toFixed(1)}s @${t.media == null ? '--' : t.media.toFixed(3)}s  ${t.kind}  ${t.detail}`);
      L.push(`data-uia values seen in the player (${e.uia.length}):`);
      for (const u of e.uia) L.push(`  ${u.v}  first@${u.first == null ? '--' : u.first.toFixed(3)}s adds=${u.adds} removes=${u.removes}${u.muted ? ' (muted)' : ''}`);
      L.push(`native subtitle cue changes: ${e.nativeCueCount}`);
      for (const c of e.nativeCues) L.push(`  @${c.media == null ? '--' : c.media.toFixed(3)}s  ${c.text ? JSON.stringify(c.text) : '(cleared)'}`);
    } catch (err) {
      L.push(`unavailable: ${err}`);
    }
    return L.join('\n');
  }

  const api = {
    help() {
      console.log([
        'multicap console helpers:',
        '  __multicap.summary()    print the Phase-0 findings as text',
        '  copy(__multicap.text()) same text → clipboard (paste this back)',
        '  __multicap.report()     full structured report (copy(__multicap.report()) → JSON)',
        '  __multicap.manifest()   last raw manifest object; .manifest(-2) for the previous one',
        '  __multicap.capture()    read the manifest from the player object graph now',
        '  __multicap.adBreaks()   ad breaks (content-time locations) from the ad manager',
        '  __multicap.tracks()     subtitle tracks of the current manifest (with WebVTT availability)',
        '  __multicap.session()    what the overlay is rendering right now',
        '  __multicap.overlay({enabled:false})  hide/show the overlay',
        '  __multicap.sync()       native-cue vs parsed-cue timing agreement (Layer C measurement)',
        '  __multicap.settings()   persisted preferences (presentation + reading assist; the language pair is fixed)',
        '  __multicap.setStyle({scale:1.2, bottom:10, slotScale:[1,1.2], backdrop:true})  overlay styling',
        '  __multicap.setPinyin(\'none\'|\'above\'|\'below\')',
        '  __multicap.pinyin(\'你好世界\')  how a line would be annotated (needs the dictionary loaded)',
        '  __multicap.assist()     reading-assist state; __multicap.setAssist({mode:\'pause\', secondsPerChar:0.4})',
        '  keyboard: Ctrl+Shift+M track picker, Ctrl+Shift+H hide/show, Ctrl+Shift+P reading assist on/off',
        '  __multicap.manifests()  list of captured manifests',
        '  __multicap.requests()   manifest request bodies seen (shape only)',
        '  __multicap.probe()      introspect the player API now',
        '  __multicap.clock()      video.currentTime vs player API getCurrentTime()',
        '  __multicap.ext()        extension-side log (timeline, data-uia, native cues)',
      ].join('\n'));
    },
    summary() { console.log(text()); },
    text,
    report() {
      return {
        version: VERSION,
        generated: new Date().toISOString(),
        href: location.href,
        parseCalls: state.parseCalls,
        stringifyCalls: state.stringifyCalls,
        nearMisses: state.nearMisses,
        manifests: state.manifests.map((r, idx) => ({ ...manifestSummaries()[idx], ...manifestInfo(r), adverts: r.manifest.adverts, auxiliaryManifests: r.manifest.auxiliaryManifests })),
        requests: state.requests,
        probe: state.lastProbe ?? probe(false),
        ext: U.safe(() => bridge.call('report'), null),
      };
    },
    /** @param {number} [i] */
    manifest(i = -1) { if (!state.manifests.length) captureFromPlayer(); return state.manifests.at(i)?.manifest ?? null; },
    capture: captureFromPlayer,
    adBreaks() { const p = N.watchPlayer(); return p ? N.adBreaks(p) : []; },
    /** @param {any} [movieId] */
    tracks(movieId) { return trackRows(movieId).map((t) => ({ ...t, url: t.url ? '(url)' : null })); },
    session: () => bridge.call('session'),
    /** @param {{enabled?: boolean}} opts */
    overlay: (opts) => bridge.call('overlay-set', opts),
    sync: () => bridge.call('sync'),
    settings: () => bridge.call('settings-get'),
    /** @param {{scale?: number, bottom?: number, slotScale?: number[], backdrop?: boolean}} style */
    setStyle: (style) => bridge.call('settings-set', { style }),
    /** @param {string} text */
    pinyin: (text) => bridge.call('pinyin', text),
    /** @param {'none' | 'above' | 'below'} mode */
    setPinyin: (mode) => bridge.call('settings-set', { pinyin: mode }),
    assist: () => bridge.call('assist'),
    /** @param {{mode?: string, secondsPerChar?: number, autoResume?: boolean, extend?: boolean}} assist */
    setAssist: (assist) => bridge.call('settings-set', { assist }),
    manifests: manifestSummaries,
    requests: () => state.requests,
    probe: () => probe(true),
    clock: () => clockSample(),
    ext: () => bridge.call('report'),
  };
  Object.defineProperty(window, '__multicap', { value: api, configurable: true, writable: false });

  U.log(`page hook installed (${VERSION}); JSON.parse/JSON.stringify patched. Try __multicap.help()`);
})();
