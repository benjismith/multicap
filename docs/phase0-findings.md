# Phase 0 findings

Recorded 2026-09-07 on the ads plan. Chrome 152, Netflix web UI `shakti-v877494c4`,
player client `6.0061.856.911`. Title: *Meet Yourself* (81678236), episodes
81678253 and 81678254. Everything below was observed live through the Phase 0
instrumentation plus ad-hoc probes in the page console; nothing is inferred
from prior art.

## Summary

1. **The manifest no longer passes through main-thread `JSON.parse`.** The
   Subadub-style hook saw 138 parse calls and zero manifests while an episode
   played. The manifest *is* reachable from the player object graph:
   `player.getInternalPlayer().playback.segmentWithBoundObservables.manifest.manifestResult`.
   A generic search for an object with `movieId` + `timedtexttracks[]` finds it
   at depth 4 after visiting ~1,100 objects, so a path change is a cheap repair.
2. **The player exposes a content clock.** `player.getSegmentTime()` returns
   content time in ms. It advances with content, freezes at the break location
   during an ad, and is unaffected by how the ad was reached. `getCurrentTime()`
   tracks `video.currentTime` instead.
3. **`video.currentTime` has three regimes,** so it is not usable as a content
   clock on its own:
   - Continuous play into a break: media time keeps running through the ad, so
     after the break media = content + ad time (a 62 s mid-roll gave +62.07 s;
     a 31 s pre-roll gave +31.05 s). This is the stitched case from the brief.
   - After any seek: media time is re-based to equal content time; previously
     played ad regions disappear from the timeline (offset back to 0).
   - Seek forward across an unplayed break: the ad plays in a fresh timeline
     starting at 0; content then continues from the seek target with media
     time still counting from that 0 (offset of −1,535 s observed).
   - `video.duration` is also unreliable: 898.689 during episode 2 while the
     manifest said 2,708,720 ms.
4. **Ad state comes from `player.getAdManager()`:** `adPresenting._value`
   (boolean observable), `getPresentingAdBreak()`, `getAds()` (break list),
   `hasAds()`, `canSeek()`, `skipAd()`/`skipAdBreak()` (never call). Its event
   bus fires `adBreakComplete` at the end of a break.
5. **DOM ad UI** (`data-uia` values): `ads-info-container` with children
   `ads-info-text` ("Ad") and `ads-info-time` (countdown) exist exactly while an
   ad plays; `video-title` text becomes "*Title* resumes after ads" / "begins
   after ads"; `ad-markers` lives inside the scrubber while controls are shown;
   `pause-ad-title-display`, `pause-ad-expand-button`, … appear whenever
   playback is paused (Netflix "pause ads").
6. **Request shaping works.** Adding `webvtt-lssdh-ios8` to `params.profiles`
   makes `ttDownloadables['webvtt-lssdh-ios8']` appear with
   `urls[{cdnId, cdn_id, url}]`, `size`, `hashValue`, `isImage: false`.
   `showAllSubDubTracks: true` is accepted. The request body still goes through
   `JSON.stringify` (`{version:2, url:"licensedManifest"|"manifest", params:{…}}`).
7. **Tracks on this title:** en, es, vi, zh-Hans, zh-Hant, id, pt-BR, th plus a
   forced zh-Hant track and a "none" track. en/zh-Hans/zh-Hant are text
   (imsc1.1 + webvtt + nflx-cmisc image variant; `isImage` distinguishes). id,
   pt-BR, th were listed with no downloadables.
8. **Seeks.** `player.seek(ms)` takes content ms. Rewinding across a played
   break does not replay it. Seeking forward across an unplayed break plays the
   break first, then lands at the seek target. Pause/resume during an ad works
   normally with the content clock frozen. Keyboard arrows and Space go through
   the same player path.
9. **SPA episode change:** no page reload, a **new `<video>` element**, a new
   player session id (`watch-…`), same manifest path now holding the next
   episode, and a pre-roll with `getSegmentTime() === 0` while it plays.
10. **Native subtitle layer** `.player-timedtext` kept updating all session
    (420 cue changes); it toggles `display` per cue and showed nothing during ads.

## Design consequences

- **Clock module:** primary source is `getSegmentTime()` plus `adPresenting`.
  Layer C (native-cue self-calibration) stays as the fallback and as a
  cross-check that alarms on divergence. Layer B (DOM `ads-info-container`) is
  the fallback for `isInAd()`. Do not build an offset model on
  `video.currentTime` alone; it is only usable relative to a known anchor.
- **Manifest access:** read it from the player graph after each player session
  appears; keep the `JSON.parse` hook only as a passive extra. Keep the
  `JSON.stringify` shaping, it is what makes WebVTT available.
- **Lifecycle:** rebuild per player session, and re-attach the overlay when the
  `<video>` element is replaced (every episode change).
- **Pause ads** overlay the player while paused; hide or reposition our overlay
  when `[data-uia^="pause-ad"]` is present.

## Reference: shapes

Manifest top-level keys: audioTracks, mediaEventTracks, trackShortcuts,
bookmark, cdnResponseData, clientIpAddress, drmContextId, drmType, drmVersion,
duration, eligibleABTestMap, expiration, hasClearProfile, hasClearStreams,
hasDrmProfile, hasDrmStreams, links, locations, manifestExpirationDuration,
movieId, packageId, playbackContextId, servers, steeringAdditionalInfo,
textTracks, trickplays, type, urlExpirationDuration, viewableType,
badgingInfo, recommendedMedia, partiallyHydrated, maxRecommendedAudioRank,
maxRecommendedTextRank, dpsid, auxiliaryManifestToken, auxiliaryManifests,
adverts, streamingType, timecodeAnnotations, manifestVersion,
ignoreUserTextPreferences, resteerToken, isAd, isBranching, isSupplemental,
videoTracks, licenses, audio_tracks, timedtexttracks, video_tracks.

`adverts.adBreaks[]` (manifest): ads[], actionAdBreakEvents, adBreakToken,
auditPingUrl, segmentCategories, locationMs. `auxiliaryManifests[]` are full
manifests with `isAd: true` (the hydrated pre-roll).

`getAds()[]` (ad manager, 28 keys): ads[], adBreakToken, locationMs,
unnormalizedLocationMs, viewableAdBreakIndex, duration{ticks,timescale},
location, contentTimestamp, normalizedAdsDuration, source ("viewable"),
type ("dynamic"), embedded, canHydrate, canDehydrate, isHydrated, hasPlayed,
isSkippable, isSkippedByUI, missedOpportunity, terminatedEarly,
hasBeenHydrated, isPreroll, hasCompletedPlayback, isHiddenFromUser,
adBreakTriggerId. Breaks hydrate shortly before they play (`ads[]` filled with
`{id, startTimeMs, endTimeMs, type:"PLAYABLE_AD", timedAdEvents, actionAdEvents,
playerControlState{seekEnabled, playPauseEnabled, languageSelectionEnabled}}`)
and empty again after (`hasPlayed`, `hasCompletedPlayback` true).

Episode 1 breaks (content ms): 0, 1064920, 1558400, 1969520. Episode 2:
0 (preroll), 1032880, 1531840, 2026680.

`getTimedTextTrackList()[]`: trackId ("T:2:0;1;en;0;0;0;0;"), bcp47,
displayName, trackType, rawTrackType, isNoneTrack, isForcedNarrative,
isImageBased. `getTimedTextTrack()` is the active one; `setTimedTextTrack`,
`setTimedTextVisible` exist.

Player methods of interest: getSegmentTime, getCurrentTime, getDuration,
getMovieId, getAdManager, getPlaygraphManager, getInternalPlayer,
getTimedTextTrackList, getTimedTextTrack, getTimeCodes, seek, play, pause,
addEventListener. Video-player service: getAllPlayerSessionIds,
getVideoPlayerBySessionId, getTimecodes, getContentMarkers, getBookmarkMS.
Playgraph: segments are `<viewableId>:main` chained by `defaultNext`; ad breaks
are not playgraph segments.

Manifest request params of note: supportsAdBreakHydration, adBreakToken,
adBreakTriggerId, auxiliaryManifestToken, cachedAdBreaks, occurredAdBreaks,
liveAdsCapability ("dynamic"), uiContext.adCanvasUICapabilities
(["SlotBasedUI", …]), contentPlaygraph (["v2"]), imageSubtitleHeight, profiles.

## Known unknowns closed

1. Ad-break schema: above. 2. Seek behaviour: above. 3. zh tracks are text.
4. `opacity: 0` not yet tested (native layer updates regardless; test in Phase 1).
5. Player API content clock: yes, `getSegmentTime()`.

## Still open

- Whether `getSegmentTime()` stays correct at the very first frame after a
  pre-roll when the page is loaded cold on `/watch/…` (observed only via the SPA
  path and a resumed episode).
- Behaviour when the tab is backgrounded through a break.

## Phase 1 verification (2026-09-07, same session)

Single English track rendered from `getSegmentTime()`; native layer kept at
`opacity: 0` (it kept updating: 420+ cue changes observed). Observed:

- Cold load of `/watch/81678254`: manifest captured from the player graph ~7 s
  in (`player:path`), 725 cues parsed, overlay mounted in the picture box.
- **Timing:** native cue text matched against parsed cues after a mid-roll gave
  22/22 matches, median delta −0.105 s (min −0.238, max +0.158): Netflix paints
  its cue about a tenth of a second before the WebVTT start time on the
  player's clock. Small and consistent; a −0.1 s lead can be applied later.
- **Ads:** seeking into the first mid-roll set `adPresenting`, the overlay went
  `visibility: hidden` while the content clock sat at the break, and it came
  back in sync with media time 32 s ahead of content afterwards.
- **Episode change** via Netflix's next control: old session stopped and the
  new one (824 cues) started 0.6 s after the new `<video>` appeared; the
  pre-roll played blank; exactly one overlay in the DOM.
- **Pause:** the pause screen appeared without a pause ad this time; the
  `[data-uia^="pause-ad"]` rule remains untested.
- One Netflix load stalled on the spinner for ~45 s with no console errors from
  either world and no manifest; a page reload fixed it. Not attributed to the
  extension (nothing new runs before a manifest exists), but worth watching.

## Phase 2 verification (2026-09-07, same session)

- Both slots render: English (725 cues) over Simplified Chinese (702 cues),
  the Chinese line 15% larger. Switching the bottom slot to Traditional in the
  panel restarted the session with 781 cues within ~2 s; parsed cues are cached
  per title + track so switching back is instant.
- Picker pill and panel mount inside `.watch-video--player-view`; Netflix
  fullscreens `.watch-video`, which contains overlay, pill, and panel, and the
  overlay rescaled with the larger box.
- `Ctrl+Shift+H` hid the overlay (pill shows "(off)") and showed it again;
  `Ctrl+Shift+M` opened the panel. Keys pressed while the panel has focus stay
  in the panel (Netflix's F shortcut did nothing until the panel was closed).
- The stored slots survived a page reload.
- The lines rise above Netflix's control bar while it is showing.

## Phase 3 drills (2026-09-07, same session)

The player clock and ad manager were disabled from the page console
(`MC_NFLX.contentTimeMs = () => null; MC_NFLX.adState = () => null`) with a
mid-roll ahead.

- Fallback engaged: content time became `video.currentTime + layer C offset`,
  the in-ad flag came from the DOM badge, and the overlay blanked for the ad.
- **Bug found and fixed:** after the 62 s stitched break every native cue went
  unmatched because the matcher only searched within 60 s of the stale
  estimate, so the offset never stepped. The matcher now falls back to a
  global search and accepts a unique text as the step candidate (two agreeing
  samples still required). Covered by the Node smoke test, then verified live:
  through a 32 s break in fallback mode the offset stepped to −32.05 s, 19 of
  19 native cues matched, and our content time sat 0.02 s from the player's.
- Restoring the two functions flipped the clock back to the player source
  within a second.
- `requestAnimationFrame` does not run while the tab is hidden, so the render
  loop pauses (harmless) and per-frame state goes stale (the cross-check now
  samples the player directly per native cue).
- **Netflix holds ad breaks while the tab is hidden:** `play()` is ignored and
  the countdown stays at its start until the tab is visible.
- Resuming through the internal player API while a pause ad is showing leaves
  Netflix's UI on the pause card with the player running underneath (audio
  without picture). Clearing it needs Netflix's own play button. The extension
  never calls play/pause; test drills should use the UI (Space) instead.
- **Native layer re-styled by Netflix:** after the break Netflix rewrote
  `.player-timedtext`'s style attribute (`position: absolute; inset: 0 40px;
  display: block; …`), dropping our inline `opacity: 0`, so the native English
  line reappeared under ours. Hiding now uses an adopted stylesheet rule with
  `!important`, with the inline opacity re-checked every tick as a fallback.
- Cue-boundary note: at a pause right at a cue's end, Netflix may still show
  the cue while we have already cleared it (sub-100 ms edge; not a bug).

## Later findings (2026-09-08)

- **Stacking:** `video-canvas` and the player view carry `will-change: opacity`,
  so each is a stacking context. Anything mounted inside the video's box can
  never rise above Netflix's pause card (`[data-uia="pause-ad"]`, a full-size
  child of the player view with `z-index: 1` while shown). The overlay
  therefore mounts in the player view itself, after the card in document
  order, at `z-index: 5`; the picker pill/panel stay at 20/21.
- The pause card does not paint while the cursor keeps the controls visible;
  its elements are in the DOM regardless.
- **Pinyin:** `Intl.Segmenter` + the corpus dictionary annotate a line in well
  under a millisecond; the 1.5 MB dictionary loads once per page. Character
  fallback readings are ordered by corpus frequency with standalone particles
  pinned (地/得/的 de, 了 le, 着 zhe, 为 wèi), because sense rank orders
  meanings, not readings (好's rank-1 sense is hào).
- **Pause behaviour:** the last caption stays up while paused if it ended
  within 4 s of the pause point; seeks and new video elements clear it.
- **Frame cadence:** the isolated-world `requestAnimationFrame` loop ran at
  roughly 10 fps on Benji's machine while Netflix plays (frame gap ~100 ms),
  even with the tab visible. Anything that must happen at a precise content
  time (the reading assist's pause before a caption vanishes) is scheduled
  with a wall-clock timer and confirmed against a fresh clock sample, not
  left to the loop. Rendering itself is fine at that rate.
- **Reading assist verified live** (2026-09-08, 1 s/char, 0.3x floor): pauses
  land just before each caption would vanish, resume on time through the
  player API or Netflix's control bar, and a manual pause is never resumed by
  the extension.
