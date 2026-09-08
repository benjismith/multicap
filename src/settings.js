// @ts-check
/*
 * settings.js — persisted preferences (chrome.storage.local, isolated world only).
 *
 * The two lines are fixed: English on top, Simplified Chinese below (see
 * content.js). Only presentation and the reading assist are configurable.
 */
var MC_SETTINGS = (() => {
  /**
   * @typedef {{scale: number, bottom: number, slotScale: number[], backdrop: boolean}} Style
   * scale: overall font size multiplier; bottom: distance from the picture's bottom edge in %;
   * slotScale: per-line multipliers (top, bottom); backdrop: translucent box behind each line.
   */
  /** @typedef {'none' | 'above' | 'below'} Pinyin */
  /**
   * @typedef {{pause: 'off' | 'timed' | 'manual', secondsPerChar: number, extend: boolean}} Assist
   * pause: hold the caption before it vanishes and resume after the reading time (timed) or
   * wait for the viewer (manual); extend: let captions linger into silence.
   */
  /** @typedef {{enabled: boolean, pinyin: Pinyin, style: Style, assist: Assist}} Settings */
  const KEY = 'multicap';
  /** @type {Style} */
  const DEFAULT_STYLE = { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false };
  const PINYIN_MODES = ['none', 'above', 'below'];
  /** Allowed ranges for the sliders; anything outside is clamped on load and save. */
  const RANGES = { scale: [0.6, 1.8], bottom: [2, 30], slotScale: [0.6, 1.8] };
  /** @type {Settings} */
  /** @type {Assist} */
  const DEFAULT_ASSIST = { pause: 'off', secondsPerChar: 0.4, extend: true };
  const ASSIST_RANGES = { secondsPerChar: [0.15, 1.0] };
  const PAUSE_MODES = ['off', 'timed', 'manual'];
  const DEFAULTS = { enabled: true, pinyin: 'below', style: DEFAULT_STYLE, assist: DEFAULT_ASSIST };
  /** @type {Settings | null} */
  let cache = null;
  /** @type {Array<(s: Settings) => void>} */
  const listeners = [];

  /** @returns {Promise<Settings>} */
  async function load() {
    try {
      const r = await chrome.storage.local.get(KEY);
      cache = normalize(r && r[KEY]);
    } catch (err) {
      MC_UTIL.warn('settings: chrome.storage.local unavailable, using defaults:', err);
      cache = normalize(null);
    }
    return cache;
  }

  /** @param {any} raw @returns {Settings} */
  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    delete s.langs; // language slots existed in earlier builds
    s.enabled = s.enabled !== false;
    const st = { ...DEFAULT_STYLE, ...(s.style && typeof s.style === 'object' ? s.style : {}) };
    // pinyin was a boolean plus style.rubyUnder in earlier builds
    if (typeof s.pinyin === 'boolean') s.pinyin = s.pinyin ? (st.rubyUnder === false ? 'above' : 'below') : 'none';
    if (!PINYIN_MODES.includes(s.pinyin)) s.pinyin = DEFAULTS.pinyin;
    delete st.rubyUnder;
    const clamp = (/** @type {any} */ v, /** @type {number[]} */ r, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : d);
    st.scale = clamp(st.scale, RANGES.scale, DEFAULT_STYLE.scale);
    st.bottom = clamp(st.bottom, RANGES.bottom, DEFAULT_STYLE.bottom);
    st.slotScale = [0, 1].map((i) => clamp(Array.isArray(st.slotScale) ? st.slotScale[i] : undefined, RANGES.slotScale, DEFAULT_STYLE.slotScale[i]));
    st.backdrop = st.backdrop === true;
    s.style = st;
    const a = { ...DEFAULT_ASSIST, ...(s.assist && typeof s.assist === 'object' ? s.assist : {}) };
    // earlier builds stored mode ('off' | 'pause' | 'slow' | 'slowpause') + autoResume
    if (typeof a.mode === 'string') { a.pause = a.mode === 'off' ? 'off' : a.autoResume === false ? 'manual' : 'timed'; }
    if (!PAUSE_MODES.includes(a.pause)) a.pause = 'off';
    delete a.mode; delete a.autoResume; delete a.minRate; delete a.lastMode;
    a.secondsPerChar = clamp(a.secondsPerChar, ASSIST_RANGES.secondsPerChar, DEFAULT_ASSIST.secondsPerChar);
    a.extend = a.extend !== false;
    s.assist = a;
    return s;
  }

  /** @param {{enabled?: boolean, pinyin?: Pinyin, style?: Partial<Style>, assist?: Partial<Assist>}} patch @returns {Promise<Settings>} */
  async function save(patch) {
    const cur = cache || DEFAULTS;
    cache = normalize({ ...cur, ...patch, style: { ...cur.style, ...(patch.style || {}) }, assist: { ...cur.assist, ...(patch.assist || {}) } });
    try { await chrome.storage.local.set({ [KEY]: cache }); } catch (err) { MC_UTIL.warn('settings: save failed:', err); }
    for (const fn of listeners) { try { fn(cache); } catch (err) { MC_UTIL.warn('settings listener threw:', err); } }
    return cache;
  }

  /** @returns {Settings} */
  function get() { return cache || normalize(null); }

  /** @param {(s: Settings) => void} fn */
  function onChange(fn) { listeners.push(fn); }

  return { DEFAULTS, DEFAULT_STYLE, RANGES, PINYIN_MODES, DEFAULT_ASSIST, ASSIST_RANGES, PAUSE_MODES, load, save, get, onChange, normalize };
})();
