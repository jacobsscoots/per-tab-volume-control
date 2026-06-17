# Per-Tab Volume Control

A Chrome Manifest V3 extension that lets you control the audio volume for each browser tab individually, using real Web Audio routing — not just UI-only sliders.

---

## How to Install (Unpacked)

1. Clone or download this repository.
2. Generate the extension icons (one-time, requires Node.js):
   ```bash
   node icons/generate.js
   ```
3. Open Chrome and navigate to `chrome://extensions`.
4. Enable **Developer mode** (toggle in the top-right corner).
5. Click **Load unpacked** and select the root folder of this repo.
6. The extension icon appears in the Chrome toolbar. Pin it for easy access.

---

## How It Works — Architecture

```
Popup (popup.html / popup.js)
  │  chrome.runtime.sendMessage
  ▼
Background Service Worker (background/service_worker.js)
  │  chrome.tabCapture.getMediaStreamId()  →  streamId
  │  chrome.runtime.sendMessage
  ▼
Offscreen Document (offscreen.html / offscreen.js)
  │  navigator.mediaDevices.getUserMedia({ chromeMediaSource: 'tab', ... })
  │
  ▼
  MediaStream → MediaStreamSourceNode → GainNode → AudioContext.destination
                                            ▲
                                  volume slider value (0.0 – 2.0)
```

### Step-by-step

1. User opens the popup and clicks **Control Volume** on an audible tab.
2. The popup asks the service worker to start capturing.
3. The service worker calls `chrome.tabCapture.getMediaStreamId({ targetTabId })`, which returns a short-lived `streamId`.
4. The service worker ensures an **offscreen document** is alive (creates one if not).
5. The service worker sends the `streamId` and desired volume to the offscreen document.
6. The offscreen document calls `getUserMedia` with `chromeMediaSource: 'tab'` and the `streamId` to obtain the tab's audio stream.
7. It builds a Web Audio graph: `MediaStreamSourceNode → GainNode → AudioContext.destination` (your speakers).
8. All volume changes from the popup flow as messages to the offscreen document, which adjusts `GainNode.gain.value` in real time.
9. The offscreen document persists independently of the popup, so audio control continues when the popup closes.
10. When the user clicks **Stop** (or the tab closes/navigates), the stream is released and the offscreen document is closed if no other tabs are controlled.

---

## Permissions

| Permission    | Why it's needed |
|---------------|-----------------|
| `tabs`        | List all open tabs, get title/favicon/URL/audio status, listen for tab lifecycle events (open, close, navigate, audible). |
| `tabCapture`  | Call `chrome.tabCapture.getMediaStreamId()` to obtain a stream ID for routing a tab's audio through Web Audio. Without this, there is no way to intercept and modify per-tab audio. |
| `storage`     | Persist volume preferences per-origin (`chrome.storage.local`) and track which tabs are currently captured across service-worker restarts (`chrome.storage.session`). |
| `offscreen`   | Create an offscreen document that stays alive when the popup closes, so Web Audio processing (GainNode) continues and users keep hearing audio. Service workers cannot run Web Audio or `getUserMedia` directly. |

No host permissions (`<all_urls>`) are used. The extension does not read or modify web page content.

---

## Testing

### Setup
- Open several tabs: YouTube, Spotify Web Player, any HTML5 video/audio page.
- Start audio playing in multiple tabs.

### Manual test checklist

- [ ] **Popup UI**: Click the extension icon. Audible tabs appear with an `AUDIBLE` badge.
- [ ] **Start control**: Click **Control Volume** on a YouTube tab. The badge changes to `ACTIVE`. A green status message appears.
- [ ] **Volume slider**: Drag the slider left (lower) and right (higher). Audio volume changes immediately.
- [ ] **0%**: Set slider to 0% — audio is silent.
- [ ] **100%**: Click the **100%** button — audio returns to normal.
- [ ] **150% / 200%**: Audio is louder than the tab's native volume.
- [ ] **Mute**: Click **🔇 Mute**. Audio stops. Badge changes to `MUTED`. Click again to unmute.
- [ ] **Multiple tabs**: Control two tabs simultaneously. Verify independent volume control for each.
- [ ] **Popup close/reopen**: Close the popup and reopen it. Controlled tabs still show `ACTIVE` and the correct volume.
- [ ] **Audio keeps playing**: After closing the popup, audio from controlled tabs continues at the set volume.
- [ ] **Close controlled tab**: Close a tab under control. It disappears from the popup and resources are cleaned up.
- [ ] **Navigate captured tab**: Navigate a captured tab to a new URL. The capture stops cleanly.
- [ ] **Stop control**: Click **✕ Stop** for a tab. Volume control ends; the tab's audio resumes normally.
- [ ] **Badge**: The toolbar icon badge shows the count of actively controlled tabs.
- [ ] **No console errors**: Check DevTools for the popup, service worker (`chrome://extensions` → Inspect views), and offscreen document.
- [ ] **Dark mode**: Enable dark mode in your OS settings and verify the popup adapts.
- [ ] **Empty state**: When no audible tabs exist, the popup shows "No audible tabs right now."

---

## Known Limitations

### `tabCapture` and the recording indicator
When a tab's audio is captured, Chrome shows a recording indicator (the red dot in the tab strip and the toolbar). This is a browser-level UI requirement and cannot be suppressed. Users will always see that a tab is being recorded.

### One capture per tab
Chrome's `tabCapture` API allows only one active capture per tab. If another extension or Chrome itself is already capturing the tab, starting a new capture will fail.

### Service worker restarts
Chrome's MV3 service workers are ephemeral — they can be suspended after a period of inactivity. The offscreen document persists independently (as long as it has a live audio context), but if the service worker is killed and restarted while no audio is playing (e.g., a 0% gain), Chrome may close the offscreen document. On restart, the extension re-checks for an existing offscreen document and clears orphaned state if it is gone.

### No true "always-on" background capture
Chrome does not currently provide a way to capture tab audio without an explicit user gesture or without showing the recording indicator. The extension requires the user to click "Control Volume" per tab.

### Video tabs with DRM content
Tabs playing DRM-protected audio (e.g., some Netflix streams) may not be capturable via `tabCapture`. The capture will fail with a browser-level error.

### `getMediaStreamId` timing
The stream ID returned by `chrome.tabCapture.getMediaStreamId()` is short-lived (a few seconds). The extension passes it to the offscreen document immediately, so under normal conditions this is not an issue. Slow systems under heavy load could theoretically hit this window.

---

## Next Improvement Ideas

- **Per-tab volume memory by hostname**: Already partially implemented via `chrome.storage.local`; could add a dedicated settings page to view/edit saved per-origin volumes.
- **Auto-capture audible tabs**: Add a setting to automatically start volume control whenever a tab becomes audible.
- **Keyboard shortcuts**: Add `chrome.commands` shortcuts to mute/unmute the active tab without opening the popup.
- **EQ / compressor**: The Web Audio pipeline could easily be extended with a `DynamicsCompressorNode` or `BiquadFilterNode`.
- **Visual audio meter**: Add a live `AnalyserNode` to the pipeline and draw a small VU meter in the popup.
- **True PNG icon with alpha**: Replace the generated icon with a proper design with transparency.
