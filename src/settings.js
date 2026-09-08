// @ts-check
/*
 * settings.js — persisted preferences (chrome.storage.local, isolated world only).
 *
 * `langs` are the two slots of the overlay, top then bottom, as BCP-47 tags
 * (null = slot off). The track actually used for a slot is resolved per title
 * by MC_NFLX.pickTrack(), so a preference carries across titles.
 */
var MC_SETTINGS = (() => {
  /** @typedef {{langs: Array<string | null>, enabled: boolean}} Settings */
  const KEY = 'multicap';
  /** @type {Settings} */
  const DEFAULTS = { langs: ['en', 'zh-Hans'], enabled: true };
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
    return s;
  }

  /** @param {Partial<Settings>} patch @returns {Promise<Settings>} */
  async function save(patch) {
    cache = normalize({ ...(cache || DEFAULTS), ...patch });
    try { await chrome.storage.local.set({ [KEY]: cache }); } catch (err) { MC_UTIL.warn('settings: save failed:', err); }
    for (const fn of listeners) { try { fn(cache); } catch (err) { MC_UTIL.warn('settings listener threw:', err); } }
    return cache;
  }

  /** @returns {Settings} */
  function get() { return cache || normalize(null); }

  /** @param {(s: Settings) => void} fn */
  function onChange(fn) { listeners.push(fn); }

  return { DEFAULTS, load, save, get, onChange };
})();
