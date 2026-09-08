// @ts-check
/*
 * subtitles.js — WebVTT parsing and cue lookup. No DOM, no Netflix specifics.
 *
 * Netflix's `webvtt-lssdh-ios8` files (verified 2026-09-07): a WEBVTT header, NOTE
 * blocks (including a SegmentIndex and a whitespace-only block), numbered cues with
 * settings such as `position:50.00%,middle align:middle size:80.00% line:84.67%`,
 * and text wrapped in `<c.bg_transparent>…</c.bg_transparent>`. Timestamps are
 * content time, which is what the player's content clock reports.
 */
var MC_SUBS = (() => {
  /** @typedef {{begin: number, end: number, text: string, settings: string}} Cue */

  /** "hh:mm:ss.mmm" or "mm:ss.mmm" → seconds (NaN if malformed). @param {string} s */
  function parseTimestamp(s) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(s.trim());
    if (!m) return NaN;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
  }

  /** @type {Record<string, string>} */
  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };

  /** @param {string} t */
  function decodeEntities(t) {
    return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? all : v;
    });
  }

  /** Drop WebVTT/HTML-style tags (<c.x>, </c>, <i>, <v Name>, <00:00:01.000>) but keep line breaks. @param {string} t */
  function stripTags(t) {
    return t.replace(/<\/?[^>]*>/g, '');
  }

  /**
   * @param {string} text
   * @returns {{cues: Cue[], warnings: string[]}}
   */
  function parseWebVTT(text) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {Cue[]} */
    const cues = [];
    const norm = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (!/^WEBVTT/.test(norm)) warnings.push('missing WEBVTT header (starts with ' + JSON.stringify(norm.slice(0, 20)) + ')');

    // HLS-style header mapping; Netflix files have not carried one so far, but apply it if present.
    let offset = 0;
    const map = /X-TIMESTAMP-MAP=([^\n]+)/.exec(norm.split(/\n[ \t]*\n/)[0] || '');
    if (map) {
      const mp = /MPEGTS:(\d+)/.exec(map[1]);
      const lc = /LOCAL:([\d:.]+)/.exec(map[1]);
      if (mp && lc) {
        offset = (+mp[1]) / 90000 - parseTimestamp(lc[1]);
        if (Math.abs(offset) > 0.001) warnings.push(`X-TIMESTAMP-MAP offset of ${offset.toFixed(3)}s applied`);
      }
    }

    for (const block of norm.split(/\n[ \t]*\n+/)) {
      const lines = block.split('\n');
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) continue; // header, NOTE, STYLE, REGION, or junk
      const [from, rest] = lines[ti].split('-->');
      const [to, ...settings] = (rest || '').trim().split(/\s+/);
      const begin = parseTimestamp(from) + offset;
      const end = parseTimestamp(to || '') + offset;
      if (!Number.isFinite(begin) || !Number.isFinite(end)) {
        warnings.push('unparseable timing line: ' + lines[ti].slice(0, 60));
        continue;
      }
      const body = decodeEntities(stripTags(lines.slice(ti + 1).join('\n'))).trim();
      if (!body) continue;
      cues.push({ begin, end, text: body, settings: settings.filter(Boolean).join(' ') });
    }
    cues.sort((a, b) => a.begin - b.begin);
    if (!cues.length) warnings.push('no cues parsed');
    return { cues, warnings };
  }

  /**
   * Cues active at time t (seconds). `state.i` is a cursor that makes forward playback
   * O(1) per frame; a backward jump falls back to a binary search.
   * @param {Cue[]} cues sorted by begin
   * @param {number} t
   * @param {{i: number}} state
   * @returns {Cue[]}
   */
  function activeCues(cues, t, state) {
    if (state.i > cues.length) state.i = cues.length;
    if (state.i > 0 && cues[state.i - 1].begin > t) {
      let lo = 0;
      let hi = state.i;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cues[mid].begin <= t) lo = mid + 1; else hi = mid;
      }
      state.i = lo;
    }
    while (state.i < cues.length && cues[state.i].begin <= t) state.i++;
    /** @type {Cue[]} */
    const out = [];
    for (let k = state.i - 1, n = 0; k >= 0 && n < 12; k--, n++) if (cues[k].end > t) out.unshift(cues[k]);
    return out;
  }

  /** Text form used to match a native cue against parsed cues: no whitespace, no punctuation, lower case. @param {string} t */
  function normalizeForMatch(t) {
    return t.toLowerCase().replace(/[\s ‎‏]+/g, '').replace(/[.,!?;:'"“”‘’\-–—…()\[\]♪]/g, '');
  }

  return { parseTimestamp, parseWebVTT, activeCues, stripTags, decodeEntities, normalizeForMatch };
})();
