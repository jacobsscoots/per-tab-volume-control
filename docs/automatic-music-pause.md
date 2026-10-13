# Automatic music pause

Enabled by default. The popup toggle turns it off and restores owned music.
No CLT installation, account or server is required.

## Install for the agent

1. Download this branch from GitHub using Code → Download ZIP, then extract it.
2. Generate the icons with `node icons/generate.js` if PNG icons are missing.
3. Open `chrome://extensions`, enable Developer mode and choose Load unpacked.
4. Select the extracted extension folder and reload SmartAgent and music tabs.
5. Keep SmartAgent open in the same browser profile as the music.

Existing volume sliders still work. Automatic pausing requires no Control Volume
click or audio capture. Chrome may request approval for the new site permissions.
Use Chrome 116 or newer, or a compatible Chromium browser.

## Behaviour

- Uses CLT's agent-status selectors, visible hangup controls and platform-specific
  playback controls. It is a small standalone detector, not the full CLT tracker.
- SmartAgent ringing, in-call and hold states pause browser music automatically.
- Wrap/after-call work and other known off-call statuses resume owned music after
  a short confirmation. Missing/unknown status retains the previous call state.
- Multiple SmartAgent tabs/frames share one gate; all detected calls must end.
- Spotify Web Player and SoundCloud use their playback buttons. YouTube and
  YouTube Music use their video elements. Already-paused media is never started.
- Other audible tabs are muted and later unmuted if this extension owns that mute.
  These players continue advancing while muted. Call/work systems are excluded.
- Media started during a call is checked again on call-state heartbeats.
- Pause records survive extension service-worker suspension. Closing the call
  tab releases music. Reloaded music documents have no ownership tags and are
  never blindly started.
- No customer details, call logs or raw page text are stored or transmitted.
  Storage contains only tab/frame IDs, call booleans and media-control ownership.

Spotify desktop and other desktop/phone apps are outside Chrome's control.
Automatic call detection covers SmartAgent; Acqueon-only calls are not detected.
This follows CLT's automatic SmartAgent route. In this standalone extension,
SmartAgent tethered calls also pause music, avoiding CLT's personal manual-music
exception for Acqueon. It never clicks call controls or changes agent status.

## Verify on the agent's work PC

1. Play music separately in Spotify Web, SoundCloud, YouTube and YouTube Music.
   Take a call; confirm each pauses and call audio remains audible.
2. Put the call on hold; confirm music stays paused.
3. End the call and enter wrap; confirm only previously playing media resumes.
4. Start with a paused player and a manually muted tab; confirm they stay that way.
5. Repeat with auto-answer, customer hangup and two overlapping call tabs.
6. Start another music tab mid-call; confirm it is silenced.
7. Reload SmartAgent during a call and verify detection recovers without early
   resume. Close a music tab while paused and check there are no errors.
8. Check the existing volume controls still work, then turn automatic pause off
   and on using the popup.

If a UI change prevents a reliable off-call reading, music remains paused.
Once safely off call, disable automatic pause to restore it, reload SmartAgent,
and re-enable. Browser autoplay policy or site UI changes can prevent resume;
press Play manually if needed. Live work-page verification is required before
rolling this out to the team.

## Developer checks

`npm run check` and `npm test` use only Node.js; there are no dependencies.
The tests cover call gating, session recovery, platform playback ownership,
fallback muting, detector status/hold/wrap and sender validation.

Reference: CLT main commit
`722cf32e01d21d9d912ab6fae4b0183cb68f7f1b`,
`service_worker.js` music helpers and `smartagent-tracker.js` status/controls.
Chrome API references:
- https://developer.chrome.com/docs/extensions/reference/api/scripting
- https://developer.chrome.com/docs/extensions/reference/api/webNavigation
