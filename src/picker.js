// @ts-check
/*
 * picker.js — the in-player track picker (isolated world, DOM only).
 *
 * A small pill in the top-right corner ("EN + 简") shows while Netflix's controls
 * are visible; clicking it (or Ctrl+Shift+M) opens the settings panel. The two
 * lines are fixed (English over Simplified Chinese); the panel reports whether
 * the current title has them. Mounted inside the player view so it survives
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
  const SLIDER_ROW_CSS = 'display:grid;grid-template-columns:110px 1fr 44px;align-items:center;gap:10px;padding:4px 0;';

  /**
   * @param {{onEnabled: (enabled: boolean) => void, onPinyin: (on: boolean) => void, onStyle: (patch: {scale?: number, bottom?: number, slotScale?: number[], backdrop?: boolean, rubyUnder?: boolean}) => void, onAssist: (patch: {mode?: string, secondsPerChar?: number, autoResume?: boolean, extend?: boolean}) => void}} handlers
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
     * (null = no usable track), e.g. ['en', 'zh-Hant'] when Simplified is missing.
     * @type {{enabled: boolean, pinyin: boolean, resolved: Array<string | null>, style: {scale: number, bottom: number, slotScale: number[], backdrop: boolean, rubyUnder: boolean}, assist: {mode: string, secondsPerChar: number, autoResume: boolean, extend: boolean}}}
     */
    let state = { enabled: true, pinyin: true, resolved: ['en', 'zh-Hans'], style: { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false, rubyUnder: true }, assist: { mode: 'off', secondsPerChar: 0.4, autoResume: true, extend: true } };

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

    /** @param {{enabled?: boolean, pinyin?: boolean, resolved?: Array<string | null>, style?: any, assist?: any}} st */
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
      const a = short(state.resolved[0]);
      const b = short(state.resolved[1]);
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

      // ---- the fixed pair, and whether this title has it ----
      const pair = document.createElement('div');
      pair.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:4px 0 8px;';
      const lineStatus = (/** @type {string} */ label, /** @type {string} */ want, /** @type {string | null} */ got) => {
        const ok = got != null;
        const exact = ok && got.toLowerCase() === want.toLowerCase();
        const text = !ok ? `${label}: no track on this title` : exact ? `${label}: ${got}` : `${label}: ${got} (no ${want} track; showing ${short(got)})`;
        return el(`${ok ? '●' : '○'}  ${text}`, `color:${ok ? 'rgba(255,255,255,.9)' : 'rgba(255,120,120,.9)'};`);
      };
      pair.appendChild(lineStatus('Top line, English', 'en', state.resolved[0]));
      pair.appendChild(lineStatus('Bottom line, Simplified Chinese', 'zh-Hans', state.resolved[1]));
      panel.appendChild(pair);

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
      const py = document.createElement('label');
      py.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 2px;cursor:pointer;';
      const pyc = document.createElement('input');
      pyc.type = 'checkbox'; pyc.checked = state.pinyin; pyc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      pyc.addEventListener('change', () => handlers.onPinyin(pyc.checked));
      py.appendChild(pyc);
      py.appendChild(el('Pinyin on the Simplified Chinese line', 'flex:1;'));
      panel.appendChild(py);
      const ru = document.createElement('label');
      ru.style.cssText = 'display:flex;align-items:center;gap:8px;padding:2px 0 2px 24px;cursor:pointer;';
      const ruc = document.createElement('input');
      ruc.type = 'checkbox'; ruc.checked = st.rubyUnder; ruc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      ruc.addEventListener('change', () => handlers.onStyle({ rubyUnder: ruc.checked }));
      ru.appendChild(ruc);
      ru.appendChild(el('Pinyin below the characters', 'flex:1;color:rgba(255,255,255,.85);'));
      panel.appendChild(ru);

      const bd = document.createElement('label');
      bd.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 2px;cursor:pointer;';
      const bdc = document.createElement('input');
      bdc.type = 'checkbox'; bdc.checked = st.backdrop; bdc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      bdc.addEventListener('change', () => handlers.onStyle({ backdrop: bdc.checked }));
      bd.appendChild(bdc);
      bd.appendChild(el('Backdrop behind lines', 'flex:1;'));
      panel.appendChild(bd);

      // ---- reading assist ----
      panel.appendChild(el('Reading assist', HEAD_CSS + 'margin-top:10px;'));
      const as = state.assist;
      const modes = [['off', 'Off'], ['pause', 'Pause before the caption vanishes']];
      for (const [value, label] of modes) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;';
        const r = document.createElement('input');
        r.type = 'radio'; r.name = 'multicap-assist-mode'; r.checked = as.mode === value; r.style.cssText = RADIO_CSS + 'justify-self:start;';
        r.addEventListener('change', () => handlers.onAssist({ mode: value }));
        row.appendChild(r);
        row.appendChild(el(label, 'flex:1;'));
        panel.appendChild(row);
      }
      slider('Per character', as.secondsPerChar, MC_SETTINGS.ASSIST_RANGES.secondsPerChar, 0.05, (v) => v.toFixed(2) + 's', (v) => handlers.onAssist({ secondsPerChar: v }));
      const ex = document.createElement('label');
      ex.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 2px;cursor:pointer;';
      const exc = document.createElement('input');
      exc.type = 'checkbox'; exc.checked = as.extend; exc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      exc.addEventListener('change', () => handlers.onAssist({ extend: exc.checked }));
      ex.appendChild(exc);
      ex.appendChild(el('Keep captions up into silence (any mode)', 'flex:1;'));
      panel.appendChild(ex);
      const ar = document.createElement('label');
      ar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0 2px;cursor:pointer;';
      const arc = document.createElement('input');
      arc.type = 'checkbox'; arc.checked = as.autoResume; arc.style.cssText = 'accent-color:#e50914;width:16px;height:16px;margin:0;';
      arc.addEventListener('change', () => handlers.onAssist({ autoResume: arc.checked }));
      ar.appendChild(arc);
      ar.appendChild(el('Resume automatically after the reading time', 'flex:1;'));
      ar.appendChild(el('Ctrl+Shift+P', 'color:rgba(255,255,255,.45);font-size:12px;'));
      panel.appendChild(ar);

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

    return { mount, unmount, setState, setControlsVisible, toggle, get open() { return open; }, get mounted() { return !!(pill && pill.isConnected); } };
  }

  return { create, short };
})();
