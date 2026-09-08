// @ts-check
/*
 * overlay.js — the subtitle layer drawn over Netflix's video. DOM only; no timing logic.
 *
 * Placement (verified 2026-09-08): mounted in the player view (`.watch-video--player-view`),
 * which is also where Netflix puts its pause card. The video's own box sits under
 * `video-canvas`, whose `will-change: opacity` creates a stacking context, so an overlay
 * inside it can never rise above the pause card; a sibling in the player view with
 * z-index 5 can (the card is z-index 1). The player view is the visible picture size.
 * Falls back to the video's parent box when the player view is missing. Styles go
 * through CSSOM so the page's CSP cannot block them.
 */
var MC_OVERLAY = (() => {
  const FONT = '"Netflix Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  // z-index 5: above Netflix's pause card (z-index 1, same parent), below the picker pill/panel (20/21).
  const ROOT_CSS = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding:0 5% 7%;box-sizing:border-box;z-index:5;transition:padding-bottom .25s ease;';
  // The lines are the one interactive part of the overlay: selectable text with a text cursor.
  const LINE_CSS = 'color:#fff;text-align:center;white-space:pre-line;line-height:1.3;max-width:90%;margin:0.1em 0;padding:0.05em 0.4em;font-weight:500;font-family:' + FONT + ';text-shadow:0 0 6px rgba(0,0,0,.9),0 0 2px #000,1px 1px 2px #000;pointer-events:auto;user-select:text;-webkit-user-select:text;cursor:text;';
  /** Base font size as a fraction of the picture box height, before the user's scale. */
  const BASE_SIZE_RATIO = 0.042;
  const BACKDROP_CSS = 'background:rgba(0,0,0,.55);border-radius:0.25em;padding:0.08em 0.5em;';
  const WORD_CSS = 'display:inline-block;margin:0 0.12em;white-space:nowrap;';
  const RUBY_CSS = 'ruby-align:center;';
  const CHIP_CSS = 'display:none;align-items:center;gap:0.5em;margin-top:0.35em;padding:0.18em 0.7em;border-radius:999px;background:rgba(0,0,0,.55);color:rgba(255,255,255,.85);font-size:0.42em;font-weight:600;letter-spacing:.04em;font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;text-shadow:none;backdrop-filter:blur(4px);';
  const TRACK_CSS = 'display:none;width:9em;height:0.32em;border-radius:999px;background:rgba(255,255,255,.22);overflow:hidden;';
  const FILL_CSS = 'height:100%;width:100%;border-radius:999px;background:rgba(255,255,255,.9);transition:none;';
  // Pinyin is excluded from selection so a copy yields the hanzi alone.
  const RT_CSS = 'font-size:0.42em;line-height:1.1;font-weight:400;letter-spacing:0;color:rgba(255,255,255,.9);font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;text-shadow:0 0 4px rgba(0,0,0,.9),0 0 2px #000;user-select:none;-webkit-user-select:none;';

  function create() {
    /** @type {HTMLDivElement | null} */
    let root = null;
    /** @type {HTMLDivElement[]} */
    let lines = [];
    /** @type {{chip: HTMLDivElement, label: HTMLSpanElement, track: HTMLDivElement, fill: HTMLDivElement} | null} */
    let chip = null;
    /** @type {HTMLElement | null} */
    let host = null;
    /** @type {ResizeObserver | null} */
    let ro = null;
    /** @type {string[]} */
    let lastTexts = [];
    let lastVisible = true;
    let raised = false;
    /** @type {{scale: number, bottom: number, slotScale: number[], backdrop: boolean, rubyUnder: boolean}} */
    let style = { scale: 1, bottom: 7, slotScale: [1, 1.15], backdrop: false, rubyUnder: true };

    function fit() {
      if (!root || !host) return;
      const h = host.getBoundingClientRect().height;
      if (h > 0) root.style.fontSize = Math.max(10, Math.round(h * BASE_SIZE_RATIO * style.scale)) + 'px';
    }

    function applyStyle() {
      if (!root) return;
      fit();
      root.style.paddingBottom = (style.bottom + (raised ? 10 : 0)) + '%';
      lines.forEach((el, i) => {
        el.style.fontSize = (style.slotScale[i] ?? 1) + 'em';
        el.style.cssText = LINE_CSS + 'font-size:' + (style.slotScale[i] ?? 1) + 'em;' + (style.backdrop ? BACKDROP_CSS : '') + (el.style.display === 'none' ? 'display:none;' : '');
      });
    }

    /** @param {{scale: number, bottom: number, slotScale: number[], backdrop: boolean, rubyUnder: boolean}} st */
    function setStyle(st) {
      style = { ...style, ...st };
      applyStyle();
      lastTexts = []; // ruby position lives in the line DOM, so the next render refills
    }

    /**
     * Mount into `hostEl` (the player view) or, failing that, next to `video`.
     * Re-entrant: a no-op when already mounted in the same box.
     * @param {HTMLVideoElement} video @param {number} lineCount @param {HTMLElement | null} [hostEl]
     */
    function attach(video, lineCount, hostEl) {
      const parent = hostEl || video.parentElement;
      if (!parent) return false;
      if (root && host === parent && root.isConnected && lines.length === lineCount) return true;
      detach();
      host = parent;
      root = document.createElement('div');
      root.className = 'multicap-overlay';
      root.style.cssText = ROOT_CSS;
      for (let i = 0; i < lineCount; i++) {
        const el = document.createElement('div');
        el.className = 'multicap-line multicap-line-' + i;
        el.style.cssText = LINE_CSS + 'display:none;';
        // Selecting text must not reach Netflix's handlers (click = play/pause, double-click = fullscreen).
        for (const ev of ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
        root.appendChild(el);
        lines.push(el);
      }
      const c = document.createElement('div');
      c.className = 'multicap-chip';
      c.style.cssText = CHIP_CSS;
      const label = document.createElement('span');
      const track = document.createElement('div');
      track.style.cssText = TRACK_CSS;
      const fill = document.createElement('div');
      fill.style.cssText = FILL_CSS;
      track.appendChild(fill);
      c.appendChild(label);
      c.appendChild(track);
      root.appendChild(c);
      chip = { chip: c, label, track, fill };
      host.appendChild(root);
      ro = new ResizeObserver(fit);
      ro.observe(host);
      applyStyle();
      lastTexts = [];
      lastVisible = true;
      return true;
    }

    /** Push the lines up while Netflix's control bar is showing. @param {boolean} r */
    function setRaised(r) {
      raised = r;
      if (root) root.style.paddingBottom = (style.bottom + (raised ? 10 : 0)) + '%';
    }

    function detach() {
      if (ro) { ro.disconnect(); ro = null; }
      if (root) root.remove();
      root = null;
      host = null;
      lines = [];
      chip = null;
      lastTexts = [];
    }

    /**
     * What the reading assist is doing right now, shown as a chip under the lines:
     * a bar that drains over `ms` (auto-resume) or sits full (manual resume).
     * No words or icons: they distract.
     * @param {{holding: boolean, ms?: number, autoResume?: boolean}} st
     */
    function setIndicator(st) {
      if (!chip) return;
      const { chip: c, label, track, fill } = chip;
      if (st.holding) {
        // Just the bar: it drains over the remaining reading time, or sits full when the
        // resume is manual.
        label.textContent = '';
        c.style.display = 'inline-flex';
        track.style.display = 'block';
        fill.style.transition = 'none';
        fill.style.width = '100%';
        if (st.autoResume && st.ms && st.ms > 0) {
          void fill.offsetWidth; // commit the full width before animating
          fill.style.transition = `width ${Math.round(st.ms)}ms linear`;
          fill.style.width = '0%';
        }
        return;
      }
      c.style.display = 'none';
      track.style.display = 'none';
      fill.style.transition = 'none';
      fill.style.width = '100%';
    }

    /**
     * Fill a line: plain text, or ruby per character when annotation segments are given.
     * @param {HTMLElement} el @param {string} text
     * @param {Array<{text: string, syl: string[] | null, word: boolean}> | null} segs
     */
    function fill(el, text, segs) {
      el.textContent = '';
      if (!segs) { el.textContent = text; return; }
      for (const s of segs) {
        if (!s.syl) { el.appendChild(document.createTextNode(s.text)); continue; }
        const w = document.createElement('span');
        w.className = 'multicap-word';
        w.style.cssText = WORD_CSS;
        [...s.text].forEach((c, i) => {
          const ruby = document.createElement('ruby');
          ruby.style.cssText = RUBY_CSS + 'ruby-position:' + (style.rubyUnder ? 'under' : 'over') + ';';
          ruby.appendChild(document.createTextNode(c));
          const rt = document.createElement('rt');
          rt.style.cssText = RT_CSS;
          rt.textContent = (s.syl && s.syl[i]) || '';
          ruby.appendChild(rt);
          w.appendChild(ruby);
        });
        el.appendChild(w);
      }
    }

    /**
     * @param {string[]} texts one per line ('' hides that line)
     * @param {boolean} visible false blanks everything (ads, pause ads, user toggle)
     * @param {Array<Array<{text: string, syl: string[] | null, word: boolean}> | null>} [annos] per-line ruby segments
     */
    function render(texts, visible, annos = []) {
      if (!root) return;
      if (visible !== lastVisible) {
        lastVisible = visible;
        root.style.visibility = visible ? '' : 'hidden';
      }
      for (let i = 0; i < lines.length; i++) {
        const t = texts[i] ?? '';
        const key = t + (annos[i] ? '\u0001ruby' : '');
        if (key === lastTexts[i]) continue;
        lastTexts[i] = key;
        fill(lines[i], t, annos[i] || null);
        lines[i].style.display = t ? '' : 'none';
      }
    }

    return { attach, detach, render, setRaised, setStyle, setIndicator, get mounted() { return !!(root && root.isConnected); } };
  }
  return { create };
})();
