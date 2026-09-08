// @ts-check
/*
 * settings.js — persisted preferences (chrome.storage.local, isolated world only).
 *
 * `langs` are the two slots of the overlay, top then bottom, as BCP-47 tags
 * (null = slot off). The track actually used for a slot is resolved per title
 * by MC_NFLX.pickTrack(), so a preference carries across titles.
 */
var MC_SETTINGS = (() => {
  /**
   * @typedef {{scale: number, bottom: number, slotScale: number[], backdrop: boolean, rubyUnder: boolean}} Style
   * scale: overall font size multiplier; bottom: distance from the picture's bottom edge in %;
   * slotScale: per-line multipliers (top, bottom); backdrop: translucent box behind each line;
   * rubyUnder: pinyin below the characters (true) or above them (false).
   */
  /** @typedef {{mode: 'off' | 'pause', secondsPerChar: number, autoResume: boolean, extend: boolean}} Assist */
  /** @typedef {{langs: Array<string | null>, enabled: boolean, pinyin: boolean, style: Style, assist: Assist}} Settings */
  const KEY = 'multicap';
  /** @type {Style} */
  const DEFAULT_STYLE = { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false, rubyUnder: true };
  /** Allowed ranges for the sliders; anything outside is clamped on load and save. */
  const RANGES = { scale: [0.6, 1.8], bottom: [2, 30], slotScale: [0.6, 1.8] };
  /** @type {Settings} */
  /** @type {Assist} */
  const DEFAULT_ASSIST = { mode: 'off', secondsPerChar: 0.4, autoResume: true, extend: true };
  const ASSIST_RANGES = { secondsPerChar: [0.15, 1.0] };
  const ASSIST_MODES = ['off', 'pause'];
  const DEFAULTS = { langs: ['en', 'zh-Hans'], enabled: true, pinyin: true, style: DEFAULT_STYLE, assist: DEFAULT_ASSIST };
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
    if (!Array.isArray(s.langs)) s.langs = DEFAULTS.langs.slice();
    s.langs = [0, 1].map((i) => (typeof s.langs[i] === 'string' && s.langs[i] ? s.langs[i] : null));
    s.enabled = s.enabled !== false;
    s.pinyin = s.pinyin !== false;
    const st = { ...DEFAULT_STYLE, ...(s.style && typeof s.style === 'object' ? s.style : {}) };
    const clamp = (/** @type {any} */ v, /** @type {number[]} */ r, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : d);
    st.scale = clamp(st.scale, RANGES.scale, DEFAULT_STYLE.scale);
    st.bottom = clamp(st.bottom, RANGES.bottom, DEFAULT_STYLE.bottom);
    st.slotScale = [0, 1].map((i) => clamp(Array.isArray(st.slotScale) ? st.slotScale[i] : undefined, RANGES.slotScale, DEFAULT_STYLE.slotScale[i]));
    st.backdrop = st.backdrop === true;
    st.rubyUnder = st.rubyUnder !== false;
    s.style = st;
    const a = { ...DEFAULT_ASSIST, ...(s.assist && typeof s.assist === 'object' ? s.assist : {}) };
    a.mode = a.mode === 'slow' || a.mode === 'slowpause' ? 'pause' : ASSIST_MODES.includes(a.mode) ? a.mode : 'off'; // slow modes were removed
    delete a.minRate;
    delete a.lastMode;
    a.secondsPerChar = clamp(a.secondsPerChar, ASSIST_RANGES.secondsPerChar, DEFAULT_ASSIST.secondsPerChar);
    a.autoResume = a.autoResume !== false;
    a.extend = a.extend !== false;
    s.assist = a;
    return s;
  }

  /** @param {{langs?: Array<string | null>, enabled?: boolean, pinyin?: boolean, style?: Partial<Style>, assist?: Partial<Assist>}} patch @returns {Promise<Settings>} */
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

  return { DEFAULTS, DEFAULT_STYLE, RANGES, DEFAULT_ASSIST, ASSIST_RANGES, ASSIST_MODES, load, save, get, onChange, normalize };
})();
