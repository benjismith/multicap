// @ts-check
/*
 * picker.js — the in-player track picker (isolated world, DOM only).
 *
 * A small pill in the top-right corner shows the current pair ("EN + 简") while
 * Netflix's controls are visible; clicking it (or Ctrl+Shift+M) opens a panel
 * listing the title's text tracks with a radio column per slot. Mounted inside
 * the player view so it survives fullscreen. Styles go through CSSOM.
 */
var MC_PICKER = (() => {
  const FONT = '"Netflix Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const PILL_CSS = 'position:absolute;top:11%;right:2.5%;z-index:20;pointer-events:auto;cursor:pointer;font-family:' + FONT + ';font-size:14px;font-weight:600;letter-spacing:.02em;color:#fff;background:rgba(20,20,20,.72);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 12px;line-height:1;backdrop-filter:blur(6px);transition:opacity .2s;';
  const PANEL_CSS = 'position:absolute;top:calc(11% + 40px);right:2.5%;z-index:21;pointer-events:auto;font-family:' + FONT + ';font-size:14px;color:#fff;background:rgba(18,18,18,.94);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:14px 16px 12px;min-width:340px;max-height:70%;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.6);backdrop-filter:blur(10px);';
  const ROW_CSS = 'display:grid;grid-template-columns:1fr 64px 64px;align-items:center;gap:8px;padding:5px 0;border-top:1px solid rgba(255,255,255,.07);';
  const HEAD_CSS = ROW_CSS + 'border-top:none;color:rgba(255,255,255,.55);font-size:12px;text-transform:uppercase;letter-spacing:.08em;';
  const RADIO_CSS = 'justify-self:center;width:16px;height:16px;margin:0;accent-color:#e50914;cursor:pointer;';

  /** @type {Record<string, string>} */
  const SHORT = { en: 'EN', 'zh-hans': '简', 'zh-hant': '繁', ja: '日', ko: '한', es: 'ES', fr: 'FR', de: 'DE' };
  /** @param {string | null | undefined} lang */
  function short(lang) {
    if (!lang) return '–';
    const k = lang.toLowerCase();
    return SHORT[k] || k.split('-')[0].toUpperCase();
  }

  const SLIDER_CSS = 'width:100%;margin:0;accent-color:#e50914;cursor:pointer;';
  const SLIDER_ROW_CSS = 'display:grid;grid-template-columns:110px 1fr 44px;align-items:center;gap:10px;padding:4px 0;';

  /**
   * @param {{onSlot: (slot: number, lang: string | null) => void, onEnabled: (enabled: boolean) => void, onStyle: (patch: {scale?: number, bottom?: number, slotScale?: number[], backdrop?: boolean}) => void}} handlers
   */
  function create(handlers) {
    /** @type {HTMLElement | null} */
    let host = null;
    /** @type {HTMLButtonElement | null} */
    let pill = null;
    /** @type {HTMLDivElement | null} */
    let panelEl = null;
    let open = false;
    let controlsVisible = false;
    /** @type {Array<any>} */
    let rows = [];
    /** @type {{langs: Array<string | null>, enabled: boolean, resolved: Array<string | null>, style: {scale: number, bottom: number, slotScale: number[], backdrop: boolean}}} */
    let state = { langs: [null, null], enabled: true, resolved: [null, null], style: { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false } };

    /** @param {HTMLElement} container */
    function mount(container) {
      if (host === container && pill && pill.isConnected) return;
      unmount();
      host = container;
      pill = document.createElement('button');
      pill.className = 'multicap-pill';
      pill.type = 'button';
      pill.style.cssText = PILL_CSS;
      pill.title = 'multicap: choose subtitle tracks (Ctrl+Shift+M)';
      pill.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
      panelEl = document.createElement('div');
      panelEl.className = 'multicap-panel';
      panelEl.style.cssText = PANEL_CSS + 'display:none;';
      for (const ev of ['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'pointerdown', 'pointerup']) panelEl.addEventListener(ev, (e) => e.stopPropagation());
      host.appendChild(pill);
      host.appendChild(panelEl);
      renderPill();
      renderPanel();
      updatePillVisibility();
    }

    function unmount() {
      if (pill) pill.remove();
      if (panelEl) panelEl.remove();
      pill = null; panelEl = null; host = null; open = false;
    }

    /** @param {Array<any>} trackRows rows from the page hook (describeTrack + url) */
    function setTracks(trackRows) {
      // One row per language: the variant pickTrack() would choose for that language.
      const byLang = new Map();
      for (const t of trackRows) {
        if (!t.url || t.forced || t.none) continue;
        const chosen = MC_NFLX.pickTrack(trackRows, t.lang);
        if (chosen && !byLang.has(t.lang)) byLang.set(t.lang, chosen);
      }
      rows = [...byLang.values()];
      renderPanel();
    }

    /** @param {{langs?: Array<string | null>, enabled?: boolean, resolved?: Array<string | null>, style?: any}} st */
    function setState(st) {
      state = { ...state, ...st };
      renderPill();
      if (!sliding) renderPanel();
    }
    /** True while a slider is being dragged, so live style updates don't rebuild the panel under the pointer. */
    let sliding = false;

    /** @param {boolean} v */
    function setControlsVisible(v) {
      if (v === controlsVisible) return;
      controlsVisible = v;
      updatePillVisibility();
    }

    /** @param {boolean} [force] */
    function toggle(force) {
      open = force ?? !open;
      if (panelEl) panelEl.style.display = open ? '' : 'none';
      updatePillVisibility();
    }

    function updatePillVisibility() {
      if (!pill) return;
      const show = open || controlsVisible;
      pill.style.opacity = show ? '1' : '0';
      pill.style.pointerEvents = show ? 'auto' : 'none';
    }

    function renderPill() {
      if (!pill) return;
      const a = short(state.resolved[0] ?? state.langs[0]);
      const b = short(state.resolved[1] ?? state.langs[1]);
      pill.textContent = state.enabled ? `${a} + ${b}` : `${a} + ${b}  (off)`;
      pill.style.opacity = '';
      pill.style.textDecoration = state.enabled ? '' : 'line-through';
      updatePillVisibility();
    }

    /** @param {string} text @param {string} css */
    function el(text, css) {
      const d = document.createElement('div');
      d.textContent = text;
      d.style.cssText = css;
      return d;
    }

    /** @param {number} slot @param {string | null} lang @param {boolean} checked */
    function radio(slot, lang, checked) {
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = 'multicap-slot-' + slot;
      r.checked = checked;
      r.style.cssText = RADIO_CSS;
      r.addEventListener('change', () => handlers.onSlot(slot, lang));
      return r;
    }

    function renderPanel() {
      const panel = panelEl;
      if (!panel) return;
      panel.textContent = '';
      const title = document.createElement('div');
      title.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;';
      title.appendChild(el('multicap', 'font-weight:700;font-size:15px;letter-spacing:.04em;'));
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '✕';
      close.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.6);font-size:16px;cursor:pointer;padding:2px 6px;';
      close.addEventListener('click', () => toggle(false));
      title.appendChild(close);
      panel.appendChild(title);

      const head = document.createElement('div');
      head.style.cssText = HEAD_CSS;
      head.appendChild(el('Track', ''));
      head.appendChild(el('Top', 'text-align:center;'));
      head.appendChild(el('Bottom', 'text-align:center;'));
      panel.appendChild(head);

      const resolvedOrLang = (/** @type {number} */ i) => state.resolved[i] ?? state.langs[i];
      const off = document.createElement('div');
      off.style.cssText = ROW_CSS;
      off.appendChild(el('Off', 'color:rgba(255,255,255,.7);'));
      off.appendChild(radio(0, null, !state.langs[0]));
      off.appendChild(radio(1, null, !state.langs[1]));
      panel.appendChild(off);
      if (!rows.length) panel.appendChild(el('No text tracks for this title yet.', 'padding:8px 0;color:rgba(255,255,255,.55);'));
      for (const t of rows) {
        const row = document.createElement('div');
        row.style.cssText = ROW_CSS;
        const cc = /closedcaptions|sdh/i.test(t.raw) ? '  (CC)' : '';
        row.appendChild(el(`${t.name}${cc}`, ''));
        row.appendChild(radio(0, t.lang, resolvedOrLang(0) === t.lang));
        row.appendChild(radio(1, t.lang, resolvedOrLang(1) === t.lang));
        panel.appendChild(row);
      }

      const styleHead = el('Style', HEAD_CSS.replace('grid-template-columns:1fr 64px 64px', 'grid-template-columns:1fr') + 'margin-top:10px;');
      panel.appendChild(styleHead);
      /**
       * @param {string} label @param {number} value @param {number[]} range @param {number} step
       * @param {(v: number) => string} fmt @param {(v: number) => void} onInput
       */
      const slider = (label, value, range, step, fmt, onInput) => {
        const row = document.createElement('div');
        row.style.cssText = SLIDER_ROW_CSS;
        row.appendChild(el(label, 'color:rgba(255,255,255,.85);'));
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(range[0]); input.max = String(range[1]); input.step = String(step); input.value = String(value);
        input.style.cssText = SLIDER_CSS;
        const out = el(fmt(value), 'text-align:right;color:rgba(255,255,255,.6);font-variant-numeric:tabular-nums;');
        input.addEventListener('pointerdown', () => { sliding = true; });
        input.addEventListener('pointerup', () => { sliding = false; });
        input.addEventListener('input', () => { const v = parseFloat(input.value); out.textContent = fmt(v); onInput(v); });
        input.addEventListener('change', () => { sliding = false; });
        row.appendChild(input);
        row.appendChild(out);
        panel.appendChild(row);
      };
      const pct = (/** @type {number} */ v) => Math.round(v * 100) + '%';
      const st = state.style;
      slider('Size', st.scale, MC_SETTINGS.RANGES.scale, 0.05, pct, (v) => handlers.onStyle({ scale: v }));
      slider('Height', st.bottom, MC_SETTINGS.RANGES.bottom, 1, (v) => v + '%', (v) => handlers.onStyle({ bottom: v }));
      slider('Top line', st.slotScale[0], MC_SETTINGS.RANGES.slotScale, 0.05, pct, (v) => handlers.onStyle({ slotScale: [v, state.style.slotScale[1]] }));
      slider('Bottom line', st.slotScale[1], MC_SETTINGS.RANGES.slotScale, 0.05, pct, (v) => handlers.onStyle({ slotScale: [state.style.slotScale[0], v] }));
      const bd = document.createElement('label');
      bd.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 2px;cursor:pointer;';
      const bdc = document.createElement('input');
      bdc.type = 'checkbox'; bdc.checked = st.backdrop; bdc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      bdc.addEventListener('change', () => handlers.onStyle({ backdrop: bdc.checked }));
      bd.appendChild(bdc);
      bd.appendChild(el('Backdrop behind lines', 'flex:1;'));
      panel.appendChild(bd);

      const foot = document.createElement('label');
      foot.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.12);cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.enabled;
      cb.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      cb.addEventListener('change', () => handlers.onEnabled(cb.checked));
      foot.appendChild(cb);
      foot.appendChild(el('Show subtitles', 'flex:1;'));
      foot.appendChild(el('Ctrl+Shift+H', 'color:rgba(255,255,255,.45);font-size:12px;'));
      panel.appendChild(foot);
    }

    return { mount, unmount, setTracks, setState, setControlsVisible, toggle, get open() { return open; }, get mounted() { return !!(pill && pill.isConnected); } };
  }

  return { create, short };
})();
