importScripts('media-control.js', 'auto-pause.js');

// Per-Tab Volume Control — Background Service Worker
// Responsibilities:
//  • Maintain state of which tabs are captured and their volume/mute settings
//  • Orchestrate chrome.tabCapture.getMediaStreamId() calls
//  • Ensure the offscreen document is alive when audio is being processed
//  • Relay volume/capture commands to the offscreen document
//  • Update the toolbar badge to reflect active captures
//  • Persist volume settings across popup open/close via chrome.storage

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const SESSION_KEY = 'capturedTabs';   // chrome.storage.session key
const PREFS_KEY   = 'volumePrefs';    // chrome.storage.local key (per-origin defaults)

// In-memory state — rebuilt from storage on SW wake-up
let capturedTabs = {};  // { [tabId]: { volume, muted, status } }
let offscreenReady = false;

// ── Startup / wake-up ──────────────────────────────────────────────────────

async function init() {
  try {
    const session = await chrome.storage.session.get(SESSION_KEY);
    capturedTabs = session[SESSION_KEY] || {};

    // If there are tabs supposedly captured but the offscreen document was
    // killed (e.g. SW restarted), mark them as needing reconnect.
    if (Object.keys(capturedTabs).length > 0) {
      const hasOffscreen = await checkOffscreenExists();
      if (!hasOffscreen) {
        // Offscreen died — clear orphaned captures
        capturedTabs = {};
        await chrome.storage.session.set({ [SESSION_KEY]: {} });
      } else {
        offscreenReady = true;
      }
    }

    updateBadge();
  } catch (e) {
    console.error('[SW] init error:', e);
  }
}

init();

// ── Message handling ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type?.startsWith('MUSIC_')) return false;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // keep channel open for async responses
});

async function handleMessage(message) {
  switch (message.type) {

    case 'GET_STATE':
      return { success: true, capturedTabs: serializeState() };

    case 'START_CAPTURE': {
      const { tabId, volume = 1.0 } = message;
      await startCapture(tabId, volume);
      return { success: true };
    }

    case 'SET_VOLUME': {
      const { tabId, volume } = message;
      await setVolume(tabId, volume);
      return { success: true };
    }

    case 'TOGGLE_MUTE': {
      const { tabId } = message;
      await toggleMute(tabId);
      return { success: true, muted: capturedTabs[tabId]?.muted };
    }

    case 'STOP_CAPTURE': {
      const { tabId } = message;
      await stopCapture(tabId);
      return { success: true };
    }

    case 'OFFSCREEN_READY':
      offscreenReady = true;
      return { success: true };

    case 'OFFSCREEN_CAPTURE_ERROR': {
      const { tabId, error } = message;
      console.error(`[SW] offscreen capture error for tab ${tabId}:`, error);
      delete capturedTabs[tabId];
      await persistState();
      updateBadge();
      return { success: true };
    }

    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ── Core operations ────────────────────────────────────────────────────────

async function startCapture(tabId, volume) {
  // Safety guard (defense-in-depth): never capture call system tabs.
  // Primary block is in the popup; this catches any direct SW calls.
  let tabInfo;
  try { tabInfo = await chrome.tabs.get(tabId); } catch (_) {}
  if (tabInfo?.url) {
    const host = new URL(tabInfo.url).hostname.toLowerCase();
    if (host === 'tw.smartagent.app' || host.includes('smartagent') || host.includes('acqueon')) {
      throw new Error('Call system tabs cannot be volume-controlled.');
    }
  }

  // getMediaStreamId must be called while the SW is still active (no async gap)
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreenDocument();

  let origin = null;
  try { const t = await chrome.tabs.get(tabId); origin = t?.url ? new URL(t.url).origin : null; } catch (_) {}
  capturedTabs[tabId] = { volume, muted: false, status: 'capturing', origin };
  await persistState();

  // Send to offscreen — it will call getUserMedia with streamId
  const result = await sendToOffscreen({
    type: 'CAPTURE_TAB',
    tabId,
    streamId,
    volume
  });

  if (!result?.success) {
    delete capturedTabs[tabId];
    await persistState();
    updateBadge();
    throw new Error(result?.error || 'Capture failed in offscreen document');
  }

  capturedTabs[tabId].status = 'active';
  await persistState();
  updateBadge();

  // Optionally save volume to per-origin prefs
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) {
      const origin = new URL(tab.url).origin;
      const prefs = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] || {};
      prefs[origin] = volume;
      await chrome.storage.local.set({ [PREFS_KEY]: prefs });
    }
  } catch (_) {}
}

async function setVolume(tabId, volume) {
  if (!capturedTabs[tabId]) return;
  capturedTabs[tabId].volume = volume;
  if (!capturedTabs[tabId].muted) {
    await sendToOffscreen({ type: 'SET_VOLUME', tabId, volume });
  }
  await persistState();
}

async function toggleMute(tabId) {
  if (!capturedTabs[tabId]) return;
  capturedTabs[tabId].muted = !capturedTabs[tabId].muted;
  const effectiveVolume = capturedTabs[tabId].muted ? 0 : capturedTabs[tabId].volume;
  await sendToOffscreen({ type: 'SET_VOLUME', tabId, volume: effectiveVolume });
  await persistState();
}

async function stopCapture(tabId) {
  if (!capturedTabs[tabId]) return;
  await sendToOffscreen({ type: 'STOP_CAPTURE', tabId });
  delete capturedTabs[tabId];
  await persistState();
  updateBadge();
  await maybeCloseOffscreen();
}

// ── Offscreen document management ─────────────────────────────────────────

async function checkOffscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.some(c => c.documentUrl === OFFSCREEN_URL);
}

async function ensureOffscreenDocument() {
  if (await checkOffscreenExists()) return;
  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [
      chrome.offscreen.Reason.USER_MEDIA,
      chrome.offscreen.Reason.AUDIO_PLAYBACK
    ],
    justification: 'Route captured tab audio through GainNode for per-tab volume control'
  });
  // Wait for offscreen to signal it's ready
  await waitForOffscreenReady();
}

function waitForOffscreenReady(timeoutMs = 5000) {
  if (offscreenReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (offscreenReady) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Offscreen timed out'));
      setTimeout(check, 50);
    };
    check();
  });
}

async function maybeCloseOffscreen() {
  if (Object.keys(capturedTabs).length > 0) return;
  if (!(await checkOffscreenExists())) return;
  try {
    await chrome.offscreen.closeDocument();
    offscreenReady = false;
  } catch (_) {}
}

async function sendToOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    console.error('[SW] sendToOffscreen error:', e);
    return { success: false, error: e.message };
  }
}

// ── Storage ────────────────────────────────────────────────────────────────

async function persistState() {
  await chrome.storage.session.set({ [SESSION_KEY]: capturedTabs });
}

function serializeState() {
  return JSON.parse(JSON.stringify(capturedTabs));
}

// ── Badge ──────────────────────────────────────────────────────────────────

function updateBadge() {
  const count = Object.keys(capturedTabs).length;
  if (count === 0) {
    chrome.action.setBadgeText({ text: '' });
  } else {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#6c63ff' });
  }
}

// ── Tab lifecycle events ───────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (capturedTabs[tabId]) {
    await stopCapture(tabId);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!capturedTabs[tabId] || !changeInfo.url) return;

  const oldOrigin = capturedTabs[tabId].origin;
  let newOrigin;
  try { newOrigin = new URL(changeInfo.url).origin; } catch (_) { newOrigin = null; }

  if (!oldOrigin || !newOrigin || oldOrigin !== newOrigin) {
    // True cross-origin navigation — the tab's audio stream is gone
    await stopCapture(tabId);
  }
  // Same-origin SPA navigation (e.g. Instagram Reels) — stream stays alive, keep state
});

