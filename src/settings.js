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
   * @typedef {{scale: number, bottom: number, slotScale: number[], backdrop: boolean}} Style
   * scale: overall font size multiplier; bottom: distance from the picture's bottom edge in %;
   * slotScale: per-line multipliers (top, bottom); backdrop: translucent box behind each line.
   */
  /** @typedef {{langs: Array<string | null>, enabled: boolean, style: Style}} Settings */
  const KEY = 'multicap';
  /** @type {Style} */
  const DEFAULT_STYLE = { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false };
  /** Allowed ranges for the sliders; anything outside is clamped on load and save. */
  const RANGES = { scale: [0.6, 1.8], bottom: [2, 30], slotScale: [0.6, 1.8] };
  /** @type {Settings} */
  const DEFAULTS = { langs: ['en', 'zh-Hans'], enabled: true, style: DEFAULT_STYLE };
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
    const st = { ...DEFAULT_STYLE, ...(s.style && typeof s.style === 'object' ? s.style : {}) };
    const clamp = (/** @type {any} */ v, /** @type {number[]} */ r, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(r[1], Math.max(r[0], v)) : d);
    st.scale = clamp(st.scale, RANGES.scale, DEFAULT_STYLE.scale);
    st.bottom = clamp(st.bottom, RANGES.bottom, DEFAULT_STYLE.bottom);
    st.slotScale = [0, 1].map((i) => clamp(Array.isArray(st.slotScale) ? st.slotScale[i] : undefined, RANGES.slotScale, DEFAULT_STYLE.slotScale[i]));
    st.backdrop = st.backdrop === true;
    s.style = st;
    return s;
  }

  /** @param {{langs?: Array<string | null>, enabled?: boolean, style?: Partial<Style>}} patch @returns {Promise<Settings>} */
  async function save(patch) {
    const cur = cache || DEFAULTS;
    cache = normalize({ ...cur, ...patch, style: { ...cur.style, ...(patch.style || {}) } });
    try { await chrome.storage.local.set({ [KEY]: cache }); } catch (err) { MC_UTIL.warn('settings: save failed:', err); }
    for (const fn of listeners) { try { fn(cache); } catch (err) { MC_UTIL.warn('settings listener threw:', err); } }
    return cache;
  }

  /** @returns {Settings} */
  function get() { return cache || normalize(null); }

  /** @param {(s: Settings) => void} fn */
  function onChange(fn) { listeners.push(fn); }

  return { DEFAULTS, DEFAULT_STYLE, RANGES, load, save, get, onChange, normalize };
})();
