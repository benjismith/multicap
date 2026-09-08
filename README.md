# multicap

Dual-language (English + Chinese) subtitles on Netflix, for one person, loaded
unpacked. Built to survive an **ad-supported plan** with server-side-stitched
ads, which shift `video.currentTime` away from subtitle time.

**Status: Phases 0–4 done, pinyin ruby added.** English over Simplified
Chinese by default, rendered from the player's own content clock (with
native-cue calibration as the fallback clock and the DOM ad badge as the
fallback ad flag), blanked during ads, rebuilt on every episode change. The
picker (pill in the top-right while the controls show, or `Ctrl+Shift+M`)
persists the two slots, size/height/per-line/backdrop styling, and the pinyin
toggle across titles. `Ctrl+Shift+H` hides/shows the overlay. Verified live on
the ads plan 2026-09-07 (see `docs/phase0-findings.md`).

**Pinyin.** The Simplified line gets per-character ruby with tone marks, from
`data/pinyin.json`: 80k words/phrases and 5.1k characters built by
`npm run build:pinyin` from the DuiDuiDui records corpus (word readings are
cross-validated against the sentences that contain them; `data/pinyin-suspects.txt`
lists corpus records that disagree). Segmentation is `Intl.Segmenter` word
boundaries, then longest dictionary match, then single characters in sense
order. Traditional lines are not annotated.

## Layout

| File | World | Purpose |
| --- | --- | --- |
| `manifest.json` | | MV3 manifest. Two content scripts on `*.netflix.com`, both at `document_start`, one generated file each. |
| `build.js` | | Concatenates `src/` into `dist/page.js` (MAIN) and `dist/ext.js` (isolated). No dependencies. |
| `src/netflix.js` | both | **Every Netflix-specific assumption**: schema predicates, selectors, profile names, player-API path. When Netflix changes, fix it here. |
| `src/util.js` | both | Logging, ring buffers, object-shape dumps. Captures pristine `JSON.*` before the hooks go in. |
| `src/bridge.js` | both | Synchronous MAIN ⇄ isolated-world messaging over `CustomEvent`s with JSON-string payloads. |
| `src/page-hook.js` | MAIN | `JSON.parse` hook (capture manifest), `JSON.stringify` hook (ask for WebVTT + all tracks), player-API probe, `__multicap` console helpers. |
| `src/subtitles.js` | isolated | WebVTT parser for Netflix's files, cursor-based active-cue lookup, text normalization for cue matching. |
| `src/clock.js` | isolated | Content time + in-ad flag from the player (via the bridge), `video.currentTime` as a warned fallback. |
| `src/overlay.js` | isolated | The subtitle layer: mounted next to `<video>`, CSSOM-styled, sized from the picture box. |
| `src/settings.js` | isolated | Two language slots + enabled flag in `chrome.storage.local`. |
| `src/pinyin.js` | isolated | Dictionary loader and annotator (word → syllables per character). |
| `src/picker.js` | isolated | The pill and the track/style panel, mounted inside the player view (survives fullscreen). |
| `tools/build-pinyin.js` | | Builds `data/pinyin.json` from the DuiDuiDui records directory. |
| `src/content.js` | isolated | Session per manifest (resolve slots → fetch → parse → render on rAF), picker wiring, shortcuts, plus the Phase 0 instrumentation: `<video>` events, `data-uia` diffs, ad text, native cues, URL changes. |

Chrome injects a file listed in two `content_scripts` entries only once per
frame (de-duplicated by path, ignoring the world), so shared files cannot be
listed in both worlds. `npm run build` therefore concatenates `src/` into one
file per world under `dist/`, which is what the manifest loads. `npm run watch`
rebuilds on every change; `npm run typecheck` runs `tsc` in check-only mode over
the `// @ts-check` JSDoc'd sources. `dist/` is committed so a fresh clone loads
without building. Edit `src/`, never `dist/`.

## Install

1. `npm install && npm run build` (once; `dist/` is also committed).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder. After any edit: `npm run build`, then the reload icon on the multicap card, **then reload the Netflix tab**: an extension reload does not re-inject content scripts into tabs that are already open, so the old code keeps running there until the page reloads.
3. Open DevTools on a Netflix tab **before** starting playback (the hooks run at
   `document_start`, but the console only keeps what it saw while open). Turn on
   **Preserve log** in the console settings.
4. You should see `[multicap] page hook installed` and `[multicap] phase-0
   instrumentation active`. If the second one instead says the page hook is not
   reachable, the MAIN-world script didn't run.

## Phase 0 results

See [`docs/phase0-findings.md`](docs/phase0-findings.md): the ad-break schema, the
player's content clock (`getSegmentTime()`), the three regimes of `video.currentTime`,
verified DOM selectors, and where the manifest actually lives now that it no longer
passes through `JSON.parse`.

## Phase 0 protocol

Pick a title that has both English and a Chinese subtitle track and is long
enough to get a mid-roll. Turn Netflix's own subtitles **on** (English) so the
native subtitle layer has something to show.

1. Start playback from the beginning. Let the pre-roll (if any) play.
2. Watch the console: a collapsed `MANIFEST captured` group appears when the
   manifest arrives, then `uia+/uia-` and `ad-text` lines as the player UI
   changes. Lines tagged `<== AD-LIKE` are the interesting ones.
3. Let at least one mid-roll play through.
4. Seek backward to before that mid-roll and let it play again (does the break
   replay? does the timeline offset change?).
5. Skip to the next episode (autoplay or manually) so the SPA-lifecycle path is exercised.
6. In the console run:

```js
__multicap.summary()        // prints a text report
copy(__multicap.text())     // same text → clipboard; paste this back
```

If something is missing from the summary, `__multicap.help()` lists the finer-grained
helpers (`manifest()` returns the raw manifest object for poking at in the console;
`probe()` re-introspects the player API; `clock()` compares `video.currentTime` with
the player API's `getCurrentTime()`).

### What the summary is meant to answer

- The shape of `adverts`, `auxiliaryManifests`, and any other ad-related key in the manifest.
- Whether `video.duration` exceeds the manifest `duration` by the stitched ad total.
- Which `data-uia` values / text appear and disappear exactly at ad boundaries, with media times.
- Whether the player API exposes a content-relative clock (`api−video` drifting by the ad total after a break says yes).
- Whether the zh track is offered as text (`text=yes` in the track table) and which formats exist.
- Whether Netflix keeps updating `.player-timedtext` (the `native:cue` count).
- Whether ad breaks replay after seeking back.

## When Netflix changes something

Look for `[multicap] EXPECTATION` warnings in the console. Each names the
assumption that failed and the function in `src/netflix.js` to fix. The request
shaping hook can be disabled outright with `SHAPE_MANIFEST_REQUESTS = false` there.
