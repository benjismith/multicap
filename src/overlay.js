// @ts-check
/*
 * overlay.js — the subtitle layer drawn over Netflix's video. DOM only; no timing logic.
 *
 * Placement (verified 2026-09-07): the <video> is position:absolute inside a
 * position:relative box that also holds Netflix's own `.player-timedtext`; that box is
 * the visible picture (the video element itself can be taller and is clipped). We add
 * one sibling to the box. Styles go through CSSOM so the page's CSP cannot block them.
 */
var MC_OVERLAY = (() => {
  const FONT = '"Netflix Sans", "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
  const ROOT_CSS = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;padding:0 5% 7%;box-sizing:border-box;z-index:1;';
  const LINE_CSS = 'color:#fff;text-align:center;white-space:pre-line;line-height:1.3;max-width:90%;margin:0.1em 0;padding:0.05em 0.4em;font-weight:500;font-family:' + FONT + ';text-shadow:0 0 6px rgba(0,0,0,.9),0 0 2px #000,1px 1px 2px #000;';
  /** Per-line font scale relative to the base size (index 0 = first configured track). */
  const LINE_SCALE = [1, 1.15];
  /** Base font size as a fraction of the picture box height. */
  const BASE_SIZE_RATIO = 0.042;

  function create() {
    /** @type {HTMLDivElement | null} */
    let root = null;
    /** @type {HTMLDivElement[]} */
    let lines = [];
    /** @type {HTMLElement | null} */
    let host = null;
    /** @type {ResizeObserver | null} */
    let ro = null;
    /** @type {string[]} */
    let lastTexts = [];
    let lastVisible = true;

    function fit() {
      if (!root || !host) return;
      const h = host.getBoundingClientRect().height;
      if (h > 0) root.style.fontSize = Math.max(14, Math.round(h * BASE_SIZE_RATIO)) + 'px';
    }

    /**
     * Mount next to `video`. Re-entrant: a no-op when already mounted in the same box.
     * @param {HTMLVideoElement} video @param {number} lineCount
     */
    function attach(video, lineCount) {
      const parent = video.parentElement;
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
        el.style.cssText = LINE_CSS + 'font-size:' + (LINE_SCALE[i] ?? 1) + 'em;display:none;';
        root.appendChild(el);
        lines.push(el);
      }
      host.appendChild(root);
      ro = new ResizeObserver(fit);
      ro.observe(host);
      fit();
      lastTexts = [];
      lastVisible = true;
      return true;
    }

    /** Push the lines up while Netflix's control bar is showing. @param {boolean} raised */
    function setRaised(raised) {
      if (!root) return;
      root.style.paddingBottom = raised ? '17%' : '7%';
    }

    function detach() {
      if (ro) { ro.disconnect(); ro = null; }
      if (root) root.remove();
      root = null;
      host = null;
      lines = [];
      lastTexts = [];
    }

    /**
     * @param {string[]} texts one per line ('' hides that line)
     * @param {boolean} visible false blanks everything (ads, pause ads, user toggle)
     */
    function render(texts, visible) {
      if (!root) return;
      if (visible !== lastVisible) {
        lastVisible = visible;
        root.style.visibility = visible ? '' : 'hidden';
      }
      for (let i = 0; i < lines.length; i++) {
        const t = texts[i] ?? '';
        if (t === lastTexts[i]) continue;
        lastTexts[i] = t;
        lines[i].textContent = t;
        lines[i].style.display = t ? '' : 'none';
      }
    }

    return { attach, detach, render, setRaised, get mounted() { return !!(root && root.isConnected); } };
  }
  return { create };
})();
