// @ts-check
/*
 * pinyin.js — annotate a Simplified Chinese line with per-character pinyin (isolated world).
 *
 * Dictionary: data/pinyin.json, built by tools/build-pinyin.js from the DuiDuiDui corpus
 * (words → one syllable per character; characters → readings in sense order). Loaded once,
 * lazily, through the extension's own URL.
 *
 * Segmentation: Intl.Segmenter word boundaries first (ICU's Chinese dictionary), then the
 * longest dictionary match inside any chunk the dictionary does not know, then single
 * characters with their first reading. Word lookup is what gets heteronyms right
 * (银行 yín háng, 睡着 shuì zháo); the per-character fallback is sense-ordered so 了 → le,
 * 地 → de, 得 → de on their own.
 */
var MC_PINYIN = (() => {
  /** @typedef {{text: string, syl: string[] | null, word: boolean}} Segment  syl null = not annotated */
  const HAN = /\p{Script=Han}/u;
  const MAX_WORD = 6;

  /** @type {{words: Record<string, string>, chars: Record<string, string[]>, meta?: any} | null} */
  let dict = null;
  /** @type {Promise<any> | null} */
  let loading = null;
  /** @type {Intl.Segmenter | null} */
  let segmenter = null;
  /** @type {Map<string, Segment[]>} */
  const cache = new Map();

  /** @param {any} d */
  function use(d) {
    if (!d || typeof d !== 'object' || !d.words || !d.chars) throw new Error('pinyin: not a dictionary');
    dict = d;
    cache.clear();
    try { segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'word' }); } catch { segmenter = null; }
  }

  /** @param {string} url @returns {Promise<void>} */
  function load(url) {
    if (dict) return Promise.resolve();
    if (!loading) {
      loading = fetch(url)
        .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then((d) => { use(d); })
        .catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  function isReady() { return !!dict; }

  /** Split into runs of Han vs non-Han. @param {string} s */
  function runs(s) {
    /** @type {Array<{text: string, han: boolean}>} */
    const out = [];
    for (const ch of s) {
      const han = HAN.test(ch);
      const last = out[out.length - 1];
      if (last && last.han === han) last.text += ch; else out.push({ text: ch, han });
    }
    return out;
  }

  /** Longest dictionary match over a Han run, single characters as the fallback. @param {string} run @param {Segment[]} out */
  function matchRun(run, out) {
    if (!dict) return;
    const cps = [...run];
    let i = 0;
    while (i < cps.length) {
      let hit = null;
      for (let len = Math.min(MAX_WORD, cps.length - i); len >= 2; len--) {
        const w = cps.slice(i, i + len).join('');
        const r = dict.words[w];
        if (r) { hit = { w, syl: r.split(' '), len }; break; }
      }
      if (hit) {
        out.push({ text: hit.w, syl: hit.syl, word: true });
        i += hit.len;
      } else {
        const c = cps[i];
        const rs = dict.chars[c];
        out.push({ text: c, syl: rs && rs.length ? [rs[0]] : null, word: false });
        i++;
      }
    }
  }

  /**
   * @param {string} text
   * @returns {Segment[] | null} null when the dictionary is not loaded
   */
  function annotate(text) {
    if (!dict) return null;
    const hit = cache.get(text);
    if (hit) return hit;
    /** @type {Segment[]} */
    const out = [];
    const chunks = segmenter ? [...segmenter.segment(text)].map((s) => s.segment) : [text];
    for (const chunk of chunks) {
      for (const run of runs(chunk)) {
        if (!run.han) { out.push({ text: run.text, syl: null, word: false }); continue; }
        const r = dict.words[run.text];
        if (r && [...run.text].length >= 2) out.push({ text: run.text, syl: r.split(' '), word: true });
        else matchRun(run.text, out);
      }
    }
    // merge adjacent plain runs so the DOM stays small
    /** @type {Segment[]} */
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      if (last && !last.syl && !s.syl) last.text += s.text; else merged.push(s);
    }
    if (cache.size > 500) cache.clear();
    cache.set(text, merged);
    return merged;
  }

  /** Flat "字(zì) 字(zì)" form for logs and the console helper. @param {string} text */
  function describe(text) {
    const segs = annotate(text);
    if (!segs) return '(dictionary not loaded)';
    return segs.map((s) => (s.syl ? [...s.text].map((c, i) => `${c}(${s.syl ? s.syl[i] ?? '?' : ''})`).join('') : s.text)).join('');
  }

  return { use, load, isReady, annotate, describe, get size() { return dict ? { words: Object.keys(dict.words).length, chars: Object.keys(dict.chars).length } : null; } };
})();
