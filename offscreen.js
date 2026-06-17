// Per-Tab Volume Control — Offscreen Audio Processor
// This document lives as long as at least one tab is being volume-controlled.
// It is the ONLY place that touches Web Audio / getUserMedia.
//
// Flow per captured tab:
//   MediaStream (getUserMedia tabCapture) → MediaStreamSourceNode
//     → GainNode → AudioContext.destination (speakers)

// { [tabId]: { context: AudioContext, gain: GainNode, source: MediaStreamSourceNode, stream: MediaStream } }
const activeTabs = new Map();

// Signal to the service worker that this document is alive
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

// Messages the offscreen document owns. Everything else is for the SW — ignore it
// so the SW's onMessage listener can respond without a race.
const OFFSCREEN_MESSAGES = new Set(['CAPTURE_TAB', 'SET_VOLUME', 'STOP_CAPTURE', 'GET_OFFSCREEN_STATE']);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!OFFSCREEN_MESSAGES.has(message.type)) return false; // not for us
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // keep async channel open
});

async function handleMessage(message) {
  switch (message.type) {

    case 'CAPTURE_TAB': {
      const { tabId, streamId, volume } = message;
      await captureTab(tabId, streamId, volume ?? 1.0);
      return { success: true };
    }

    case 'SET_VOLUME': {
      const { tabId, volume } = message;
      setVolume(tabId, volume);
      return { success: true };
    }

    case 'STOP_CAPTURE': {
      const { tabId } = message;
      stopCapture(tabId);
      return { success: true };
    }

    case 'GET_OFFSCREEN_STATE':
      return { success: true, activeTabs: [...activeTabs.keys()] };

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

async function captureTab(tabId, streamId, volume) {
  // Stop any existing capture for this tab
  if (activeTabs.has(tabId)) {
    stopCapture(tabId);
  }

  // Acquire the tab's audio stream using the streamId from tabCapture
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (err) {
    // Notify the SW so it can clean up its state
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CAPTURE_ERROR',
      tabId,
      error: err.message
    }).catch(() => {});
    throw err;
  }

  // Build the Web Audio graph
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = clampVolume(volume);

  source.connect(gain);
  gain.connect(context.destination);

  activeTabs.set(tabId, { context, gain, source, stream });
}

function setVolume(tabId, volume) {
  const entry = activeTabs.get(tabId);
  if (!entry) return;
  entry.gain.gain.setTargetAtTime(clampVolume(volume), entry.context.currentTime, 0.01);
}

function stopCapture(tabId) {
  const entry = activeTabs.get(tabId);
  if (!entry) return;

  try { entry.source.disconnect(); } catch (_) {}
  try { entry.gain.disconnect(); } catch (_) {}
  entry.stream.getTracks().forEach(t => t.stop());
  try { entry.context.close(); } catch (_) {}

  activeTabs.delete(tabId);
}

function clampVolume(v) {
  // Slider is 0–200 (%), stored as 0.0–2.0 float
  return Math.max(0, Math.min(2, Number(v) || 0));
}
