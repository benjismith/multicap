// @ts-check
/*
 * picker.js — the in-player track picker (isolated world, DOM only).
 *
 * A small pill in the top-right corner ("EN + 简") shows while Netflix's controls
 * are visible; clicking it (or Ctrl+Shift+M) opens the settings panel. The two
 * lines are fixed (English over Simplified Chinese); the pill reflects what the
 * current title actually has. Mounted inside the player view so it survives
 * fullscreen. Styles go through CSSOM.
 */
var MC_PICKER = (() => {
  const FONT = '"Netflix Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const PILL_CSS = 'position:absolute;top:11%;right:2.5%;z-index:20;pointer-events:auto;cursor:pointer;font-family:' + FONT + ';font-size:14px;font-weight:600;letter-spacing:.02em;color:#fff;background:rgba(20,20,20,.72);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:6px 12px;line-height:1;backdrop-filter:blur(6px);transition:opacity .2s;';
  const PANEL_CSS = 'position:absolute;top:calc(11% + 40px);right:2.5%;z-index:21;pointer-events:auto;font-family:' + FONT + ';font-size:14px;color:#fff;background:rgba(18,18,18,.94);border:1px solid rgba(255,255,255,.16);border-radius:12px;padding:14px 16px 12px;min-width:340px;max-height:70%;overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.6);backdrop-filter:blur(10px);';
  const HEAD_CSS = 'display:block;padding:5px 0;color:rgba(255,255,255,.55);font-size:12px;text-transform:uppercase;letter-spacing:.08em;';
  const RADIO_CSS = 'justify-self:center;width:16px;height:16px;margin:0;accent-color:#e50914;cursor:pointer;';

  /** @type {Record<string, string>} */
  const SHORT = { en: 'EN', 'zh-hans': '简', 'zh-hant': '繁' };
  /** @param {string | null | undefined} lang */
  function short(lang) {
    if (!lang) return '–';
    const k = lang.toLowerCase();
    return SHORT[k] || k.split('-')[0].toUpperCase();
  }

  const SLIDER_CSS = 'width:100%;margin:0;accent-color:#e50914;cursor:pointer;';
  const SLIDER_ROW_CSS = 'display:grid;grid-template-columns:110px 1fr 76px;align-items:center;gap:10px;padding:4px 0;';

  /**
   * @param {{onLines: (patch: {english?: boolean, chinese?: boolean}) => void, onPinyin: (mode: string) => void, onStyle: (patch: {scale?: number, bottom?: number, slotScale?: number[], backdrop?: boolean}) => void, onAssist: (patch: {pause?: string, secondsPerChar?: number, extend?: boolean}) => void}} handlers
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
    /**
     * `resolved`: the language actually used for each line on the current title
     * (null = no usable track), e.g. ['en', 'zh-Hant'] when Simplified is missing;
     * it only feeds the pill.
     * @type {{english: boolean, chinese: boolean, pinyin: string, resolved: Array<string | null>, style: {scale: number, bottom: number, slotScale: number[], backdrop: boolean}, assist: {pause: string, secondsPerChar: number, extend: boolean}}}
     */
    let state = { english: true, chinese: true, pinyin: 'below', resolved: ['en', 'zh-Hans'], style: { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false }, assist: { pause: 'off', secondsPerChar: 0.4, extend: true } };

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

    /** @param {{english?: boolean, chinese?: boolean, pinyin?: string, resolved?: Array<string | null>, style?: any, assist?: any}} st */
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
      const parts = [];
      if (state.english) parts.push(short(state.resolved[0]));
      if (state.chinese) parts.push(short(state.resolved[1]));
      pill.textContent = parts.length ? parts.join(' + ') : 'off';
      pill.style.opacity = '';
      updatePillVisibility();
    }

    /**
     * A two-or-more-state segmented control.
     * @param {Array<[string, string]>} options [value, label]
     * @param {string} value the selected value
     * @param {(value: string) => void} onChange
     */
    function segmented(options, value, onChange) {
      const box = document.createElement('div');
      box.style.cssText = 'display:inline-flex;border:1px solid rgba(255,255,255,.28);border-radius:999px;overflow:hidden;';
      for (const [v, label] of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        const on = v === value;
        b.style.cssText = 'border:none;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer;line-height:1.2;' + (on ? 'background:#e50914;color:#fff;' : 'background:transparent;color:rgba(255,255,255,.75);');
        b.addEventListener('click', () => { if (v !== value) onChange(v); });
        box.appendChild(b);
      }
      return box;
    }

    /** @param {string} text @param {string} css */
    function el(text, css) {
      const d = document.createElement('div');
      d.textContent = text;
      d.style.cssText = css;
      return d;
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

      // ---- captions ----
      const capRow = (/** @type {string} */ label, /** @type {HTMLElement} */ control) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
        r.appendChild(el(label, 'flex:1;'));
        r.appendChild(control);
        panel.appendChild(r);
      };
      capRow('English', segmented([['off', 'Off'], ['on', 'On']], state.english ? 'on' : 'off', (v) => handlers.onLines({ english: v === 'on' })));
      capRow('Chinese', segmented([['off', 'Off'], ['on', 'On']], state.chinese ? 'on' : 'off', (v) => handlers.onLines({ chinese: v === 'on' })));
      capRow('Pinyin', segmented([['none', 'None'], ['above', 'Above'], ['below', 'Below']], state.pinyin, (v) => handlers.onPinyin(v)));

      const styleHead = el('Style', HEAD_CSS + 'margin-top:10px;');
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

      capRow('Backdrop', segmented([['off', 'Off'], ['on', 'On']], st.backdrop ? 'on' : 'off', (v) => handlers.onStyle({ backdrop: v === 'on' })));

      // ---- reading assist ----
      panel.appendChild(el('Reading assist', HEAD_CSS + 'margin-top:10px;'));
      const as = state.assist;
      const row = (/** @type {string} */ label, /** @type {HTMLElement} */ control) => {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;';
        r.appendChild(el(label, 'flex:1;'));
        r.appendChild(control);
        panel.appendChild(r);
      };
      row('Extend into silence', segmented([['off', 'Off'], ['on', 'On']], as.extend ? 'on' : 'off', (v) => handlers.onAssist({ extend: v === 'on' })));
      row('Pause to read', segmented([['off', 'Off'], ['timed', 'Timed'], ['manual', 'Manual']], as.pause, (v) => handlers.onAssist({ pause: v })));
      slider('Reading time', as.secondsPerChar, MC_SETTINGS.ASSIST_RANGES.secondsPerChar, 0.05, (v) => v.toFixed(2) + ' s/char', (v) => handlers.onAssist({ secondsPerChar: v }));

    }

    return { mount, unmount, setState, setControlsVisible, toggle, get open() { return open; }, get mounted() { return !!(pill && pill.isConnected); } };
  }

  return { create, short };
})();
