// Session storage survives MV3 worker suspension; no customer data is stored.
const MUSIC_KEY = 'teamMusicSession';
let musicQueue = Promise.resolve();
let musicPendingActive = 0;
const musicStateReady = chrome.storage.session.get(MUSIC_KEY).then(data =>
  data[MUSIC_KEY] || { frames: {}, paused: {} });
function musicEnqueue(action) {
  const task = musicQueue.then(async () => action(await musicStateReady));
  musicQueue = task.catch(() => {});
  return task;
}
function musicPlatform(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'open.spotify.com') return 'spotify';
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'youtube';
    if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'soundcloud';
  } catch {}
  return null;
}
function musicCallHost(url) {
  try { return /(^|\.)(smartagent\.app|acqueon\.com|crm\.ondemand\.com|hana\.ondemand\.com)$/.test(new URL(url).hostname); }
  catch { return true; }
}
async function musicSave(state) {
  await chrome.storage.session.set({ [MUSIC_KEY]: state });
}
async function musicInject(tabId, platform, resume) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: platform === 'youtube' },
    func: resume ? _resumeMediaInPage : _pauseMediaInPage,
    args: resume ? [platform, true] : [platform]
  });
}
async function musicReconcile(state) {
  const enabled = (await chrome.storage.local.get({ autoPauseMusic: true })).autoPauseMusic;
  const active = enabled && (musicPendingActive > 0 || Object.values(state.frames).some(frame => frame.active));
  const tabs = await chrome.tabs.query({});
  const live = new Map(tabs.map(tab => [tab.id, tab]));
  for (const key of Object.keys(state.frames)) {
    if (!live.has(state.frames[key].tabId)) delete state.frames[key];
  }
  // Recompute after closed call tabs are removed.
  const shouldPause = active && (musicPendingActive > 0 || Object.values(state.frames).some(frame => frame.active));
  if (shouldPause) {
    for (const tab of tabs) {
      if (!tab.audible || musicCallHost(tab.url) || state.paused[tab.id]?.method === 'mute') continue;
      const platform = musicPlatform(tab.url);
      if (platform) {
        try {
          // Write intent before injection so a worker restart cannot lose ownership.
          state.paused[tab.id] ||= { method: 'pause', platform };
          await musicSave(state);
          const results = await musicInject(tab.id, platform, false);
          if (results.some(frame => frame.result?.count > 0) || !tab.audible) continue;
          // No recognised playing control: still silence this audible tab.
        } catch { /* Page inaccessible: fall back to tab mute below. */ }
      }
      if (!tab.mutedInfo?.muted) {
        state.paused[tab.id] = { method: 'mute', platform, alsoPaused: !!platform };
        await musicSave(state);
        await chrome.tabs.update(tab.id, { muted: true });
      }
    }
  } else {
    for (const [id, record] of Object.entries(state.paused)) {
      if (enabled && musicPendingActive > 0) break; // A newly answered call wins.
      const tabId = Number(id), tab = live.get(tabId);
      if (!tab || musicCallHost(tab.url)) { delete state.paused[id]; continue; }
      try {
        if (record.method === 'mute' && tab.mutedInfo?.muted && tab.mutedInfo.extensionId === chrome.runtime.id) {
          await chrome.tabs.update(tabId, { muted: false });
        }
        if (record.method === 'pause' || record.alsoPaused) {
          // New documents have no ownership tags, so cannot be started accidentally.
          await musicInject(tabId, record.platform, true);
        }
        delete state.paused[id];
      } catch { /* Retain for retry on the next heartbeat. */ }
    }
  }
  await musicSave(state);
  return { enabled, active: shouldPause, pausedTabs: Object.keys(state.paused).length };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message.type?.startsWith('MUSIC_')) return false;
  const trustedCall = !!sender.tab && /^https:\/\/([^/]+\.)?smartagent\.app\//.test(sender.url || '');
  const pendingActive = trustedCall && message.type === 'MUSIC_CALL_STATE' && message.state === 'active';
  if (pendingActive) musicPendingActive++;
  musicEnqueue(async state => {
    if (pendingActive) musicPendingActive--;
    if (message.type === 'MUSIC_CALL_STATE') {
      if (!sender.tab || !/^(active|off|unknown)$/.test(message.state) ||
          !trustedCall) return { error: 'invalid_sender' };
      const key = sender.tab.id + ':' + sender.frameId;
      if (message.state !== 'unknown') state.frames[key] = { tabId: sender.tab.id, active: message.state === 'active' };
      if (message.state === 'off') {
        // Removed iframes must not leave a permanent active-call latch.
        const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
        if (frames) {
          const ids = new Set(frames.map(frame => sender.tab.id + ':' + frame.frameId));
          for (const [id, frame] of Object.entries(state.frames)) {
            if (frame.tabId === sender.tab.id && !ids.has(id)) delete state.frames[id];
          }
        }
      }
    } else {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return { error: 'invalid_sender' };
      if (message.type === 'MUSIC_SET_ENABLED' && typeof message.enabled === 'boolean') {
        await chrome.storage.local.set({ autoPauseMusic: message.enabled });
      } else if (message.type !== 'MUSIC_GET_STATE') return { error: 'invalid_message' };
    }
    return musicReconcile(state);
  }).then(respond).catch(() => respond({ error: 'music_control_failed' }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  musicEnqueue(async state => {
    for (const [key, frame] of Object.entries(state.frames)) if (frame.tabId === tabId) delete state.frames[key];
    delete state.paused[tabId];
    return musicReconcile(state);
  }).catch(() => {});
});
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.audible) musicEnqueue(musicReconcile).catch(() => {});
});
chrome.runtime.onInstalled.addListener(async () => {
  // Also attach to already-open SmartAgent tabs after install/update.
  const tabs = await chrome.tabs.query({ url: 'https://*.smartagent.app/*' });
  for (const tab of tabs) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/call-detector.js'] }); }
    catch { /* Reload SmartAgent if policy blocks injection. */ }
  }
});
