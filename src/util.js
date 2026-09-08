// @ts-check
/*
 * util.js — logging, ring buffers, object-shape dumps. Loaded by BOTH worlds.
 *
 * Captures the pristine JSON functions at load time: page-hook.js patches
 * JSON.parse / JSON.stringify afterwards, and nothing in here must re-enter
 * those hooks.
 */
const MC_UTIL = (() => {
  const jsonStringify = JSON.stringify.bind(JSON);
  const jsonParse = JSON.parse.bind(JSON);

  const TAG = '%c[multicap]%c';
  const TAG_STYLE = 'color:#ffb86c;font-weight:bold';

  /** @param {...any} args */
  function log(...args) { console.log(TAG, TAG_STYLE, '', ...args); }
  /** @param {...any} args */
  function warn(...args) { console.warn(TAG + ' %cEXPECTATION', TAG_STYLE, '', 'color:#ff5555;font-weight:bold', ...args); }
  /** @param {...any} args */
  function muted(...args) { console.log(TAG + '%c', TAG_STYLE, '', 'color:#888', ...args); }
  /**
   * @param {string} label
   * @param {() => void} fn
   */
  function group(label, fn) {
    console.groupCollapsed(TAG + ' ' + label, TAG_STYLE, '');
    try { fn(); } finally { console.groupEnd(); }
  }

  /**
   * @template T
   * @param {() => T} fn
   * @param {T} [fallback]
   * @returns {T | undefined}
   */
  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  /**
   * Fixed-capacity append log.
   * @template T
   * @param {number} cap
   */
  function ring(cap) {
    /** @type {T[]} */
    const items = [];
    return {
      /** @param {T} x */
      push(x) { items.push(x); if (items.length > cap) items.splice(0, items.length - cap); return x; },
      items: () => items.slice(),
      get length() { return items.length; },
    };
  }

  /** @param {any} v */
  function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

  /**
   * Short printable form of a primitive. URLs are shortened (they carry tokens and are long).
   * @param {any} v
   * @param {number} [max]
   */
  function sample(v, max = 80) {
    if (typeof v === 'string') {
      if (/^https?:\/\//.test(v)) {
        try { const u = new URL(v); return `"${u.origin}${u.pathname.slice(0, 24)}… (${v.length} chars)"`; } catch { /* fall through */ }
      }
      return jsonStringify(v.length > max ? v.slice(0, max) + '…' : v);
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    if (v === undefined) return 'undefined';
    return typeof v;
  }

  /**
   * @param {any} v
   * @param {number} [cap]
   */
  function safeJson(v, cap = 20000) {
    let s;
    try { s = jsonStringify(v, null, 1); } catch (err) { return `(unserializable: ${err})`; }
    if (s === undefined) return 'undefined';
    return s.length > cap ? s.slice(0, cap) + `\n… (truncated, ${s.length} chars total)` : s;
  }

  /**
   * One-line summary of any value: primitives inline, arrays by length + first element,
   * small objects as JSON, large objects as a key list.
   * @param {any} v
   */
  function summarize(v) {
    const t = typeOf(v);
    if (t === 'array') return `array[${v.length}]${v.length ? ' of ' + summarize(v[0]) : ''}`;
    if (t === 'object') {
      const j = safe(() => jsonStringify(v), undefined);
      if (j && j.length <= 220) return j;
      const keys = Object.keys(v);
      return `object {${keys.slice(0, 14).join(', ')}${keys.length > 14 ? ', …' : ''}}`;
    }
    return sample(v);
  }

  /**
   * Flat "path: type = sample" lines describing an object's shape. Arrays are described
   * by length and by the shape of their FIRST element ("[]" in the path). Subtrees whose
   * last path segment is in `prune` get their first element's key list only.
   * @param {any} root
   * @param {{maxDepth?: number, maxLines?: number, prune?: Set<string>, rootName?: string}} [opts]
   * @returns {string[]}
   */
  function skeleton(root, opts = {}) {
    const maxDepth = opts.maxDepth ?? 12;
    const maxLines = opts.maxLines ?? 600;
    const prune = opts.prune ?? new Set();
    /** @type {string[]} */
    const lines = [];
    const seen = new WeakSet();
    let truncated = false;

    /** @param {any} v @param {string} path @param {string} key @param {number} depth */
    const walk = (v, path, key, depth) => {
      if (lines.length >= maxLines) { truncated = true; return; }
      const t = typeOf(v);
      const pruned = prune.has(key);
      if (t === 'array') {
        lines.push(`${path}: array[${v.length}]${pruned ? ' (pruned)' : ''}`);
        if (!v.length) return;
        if (pruned || depth >= maxDepth) {
          if (typeOf(v[0]) === 'object') lines.push(`${path}[].keys: ${Object.keys(v[0]).join(', ')}`);
          else lines.push(`${path}[]: ${summarize(v[0])}`);
        } else {
          walk(v[0], path + '[]', key, depth + 1);
        }
      } else if (t === 'object') {
        if (seen.has(v)) { lines.push(`${path}: (circular)`); return; }
        seen.add(v);
        const keys = Object.keys(v);
        lines.push(`${path}: object {${keys.length} keys}${pruned ? ' (pruned)' : ''}`);
        if (pruned || depth >= maxDepth) { lines.push(`${path}.keys: ${keys.join(', ')}`); return; }
        for (const k of keys) walk(v[k], `${path}.${k}`, k, depth + 1);
      } else {
        lines.push(`${path}: ${t} = ${sample(v)}`);
      }
    };
    walk(root, opts.rootName ?? '$', '', 0);
    if (truncated) lines.push(`… (truncated at ${maxLines} lines)`);
    return lines;
  }

  /**
   * Find every key anywhere in `root` whose name matches `keyRe`; report the distinct
   * values seen per path. Unlike skeleton(), walks ALL array elements (bounded).
   * @param {any} root
   * @param {RegExp} keyRe
   * @param {{maxPerArray?: number, maxLines?: number}} [opts]
   * @returns {string[]}
   */
  function interest(root, keyRe, opts = {}) {
    const maxPerArray = opts.maxPerArray ?? 200;
    const maxLines = opts.maxLines ?? 200;
    /** @type {Map<string, Set<string>>} */
    const found = new Map();
    const seen = new WeakSet();
    /** @param {any} v @param {string} path @param {number} depth */
    const walk = (v, path, depth) => {
      if (depth > 16) return;
      if (Array.isArray(v)) {
        const n = Math.min(v.length, maxPerArray);
        for (let i = 0; i < n; i++) walk(v[i], path + '[]', depth + 1);
        return;
      }
      if (!v || typeof v !== 'object') return;
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) {
        const child = v[k];
        const p = path ? `${path}.${k}` : k;
        if (keyRe.test(k)) {
          let s = found.get(p);
          if (!s) found.set(p, (s = new Set()));
          if (s.size < 6) s.add(summarize(child));
        }
        walk(child, p, depth + 1);
      }
    };
    walk(root, '', 0);
    /** @type {string[]} */
    const lines = [];
    for (const [p, s] of found) {
      lines.push(`${p}: ${[...s].join('  |  ')}`);
      if (lines.length >= maxLines) { lines.push('… (truncated)'); break; }
    }
    return lines;
  }

  /**
   * Plain-text table (for pasteable summaries).
   * @param {Array<Record<string, any>>} rows
   */
  function table(rows) {
    if (!rows.length) return '(none)';
    const cols = Object.keys(rows[0]);
    const cell = (/** @type {any} */ v) => String(v ?? '');
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => cell(r[c]).length)));
    const line = (/** @type {string[]} */ cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
    return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
  }

  /** @param {number | null | undefined} sec */
  function fmtSec(sec) { return sec == null || !Number.isFinite(sec) ? '--' : sec.toFixed(3) + 's'; }

  return { jsonStringify, jsonParse, log, warn, muted, group, safe, ring, typeOf, sample, safeJson, summarize, skeleton, interest, table, fmtSec };
})();
