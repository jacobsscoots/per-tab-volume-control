// Per-Tab Volume Control — Popup Script
// Communicates with the background service worker via chrome.runtime.sendMessage.
// Renders a list of all tabs (audible first), and for captured tabs shows
// full volume controls. For uncaptured audible tabs shows a "Control Volume" button.

const tabListEl    = document.getElementById('tab-list');
const loadingEl    = document.getElementById('loading');
const emptyEl      = document.getElementById('empty');
const statusBar    = document.getElementById('status-bar');
const statusText   = document.getElementById('status-text');
const refreshBtn   = document.getElementById('refreshBtn');

// Local UI state — tabId → { volume (0–2), muted }
const uiState = new Map();

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  refreshBtn.addEventListener('click', () => {
    refreshBtn.querySelector('svg').classList.add('spinning');
    render().finally(() => refreshBtn.querySelector('svg').classList.remove('spinning'));
  });
  await render();
});

// Re-render when the tab's audio status changes while the popup is open
chrome.tabs.onUpdated.addListener((_id, info) => {
  if ('audible' in info || 'mutedInfo' in info || 'title' in info) render();
});
chrome.tabs.onRemoved.addListener(() => render());

// ── Main render ────────────────────────────────────────────────────────────

async function render() {
  // Fetch SW state and all tabs in parallel
  const [swResp, allTabs] = await Promise.all([
    sendToSW({ type: 'GET_STATE' }),
    chrome.tabs.query({})
  ]);

  const capturedTabs = swResp?.capturedTabs || {};

  // Sync local UI state from SW state
  for (const [tabId, info] of Object.entries(capturedTabs)) {
    const id = Number(tabId);
    if (!uiState.has(id)) {
      uiState.set(id, { volume: info.volume ?? 1.0, muted: info.muted ?? false });
    }
  }
  // Remove entries for tabs no longer captured
  for (const id of uiState.keys()) {
    if (!capturedTabs[id]) uiState.delete(id);
  }

  // Sort: captured first, then audible, then rest
  const sorted = [...allTabs].sort((a, b) => {
    const aScore = capturedTabs[a.id] ? 2 : (a.audible ? 1 : 0);
    const bScore = capturedTabs[b.id] ? 2 : (b.audible ? 1 : 0);
    return bScore - aScore;
  });

  // Filter to tabs worth showing: captured, audible, or muted-by-chrome
  const relevant = sorted.filter(t =>
    capturedTabs[t.id] || t.audible || t.mutedInfo?.muted
  );
  const rest = sorted.filter(t => !relevant.includes(t));

  loadingEl.classList.add('hidden');

  if (relevant.length === 0 && Object.keys(capturedTabs).length === 0) {
    emptyEl.classList.remove('hidden');
    tabListEl.innerHTML = '';

    // Still show all tabs below the empty state so users can pre-capture
    if (rest.length > 0) {
      emptyEl.classList.add('hidden');
      renderTabs(sorted, capturedTabs);
    }
    return;
  }

  emptyEl.classList.add('hidden');
  renderTabs(sorted, capturedTabs);
}

function renderTabs(tabs, capturedTabs) {
  // Preserve scroll position
  const scrollTop = tabListEl.scrollTop;

  const fragment = document.createDocumentFragment();

  let lastGroup = null;
  for (const tab of tabs) {
    const isCaptured = !!capturedTabs[tab.id];
    const group = isCaptured ? 'controlled' : (tab.audible ? 'audible' : 'silent');

    if (group !== lastGroup) {
      const label = document.createElement('li');
      label.className = 'section-label';
      label.textContent =
        group === 'controlled' ? 'Volume Controlled' :
        group === 'audible'    ? 'Audible Tabs' :
                                 'Other Tabs';
      fragment.appendChild(label);
      lastGroup = group;
    }

    fragment.appendChild(buildTabRow(tab, capturedTabs));
  }

  tabListEl.innerHTML = '';
  tabListEl.appendChild(fragment);
  tabListEl.scrollTop = scrollTop;
}

// ── Tab row ────────────────────────────────────────────────────────────────

function buildTabRow(tab, capturedTabs) {
  const isCaptured = !!capturedTabs[tab.id];
  const info = uiState.get(tab.id) || { volume: 1.0, muted: false };

  const li = document.createElement('li');
  li.className = 'tab-item' + (isCaptured ? ' captured' : '');
  li.dataset.tabId = tab.id;

  // ── Header row ──
  const header = document.createElement('div');
  header.className = 'tab-header';

  // Favicon
  header.appendChild(buildFavicon(tab));

  // Title + domain
  const tabInfo = document.createElement('div');
  tabInfo.className = 'tab-info';
  const titleEl = document.createElement('div');
  titleEl.className = 'tab-title';
  titleEl.title = tab.title || '(no title)';
  titleEl.textContent = tab.title || '(no title)';
  const domainEl = document.createElement('div');
  domainEl.className = 'tab-domain';
  try { domainEl.textContent = tab.url ? new URL(tab.url).hostname : ''; } catch (_) {}
  tabInfo.appendChild(titleEl);
  tabInfo.appendChild(domainEl);
  header.appendChild(tabInfo);

  // Badge
  header.appendChild(buildBadge(tab, isCaptured, info.muted));

  li.appendChild(header);

  if (isCaptured) {
    // ── Volume controls ──
    li.appendChild(buildVolumeControls(tab.id, info));
  } else if (tab.audible || tab.mutedInfo?.muted) {
    // ── Capture button ──
    const actions = document.createElement('div');
    actions.className = 'tab-actions';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary btn-capture';
    btn.textContent = 'Control Volume';
    btn.addEventListener('click', () => onStartCapture(tab.id));
    actions.appendChild(btn);
    li.appendChild(actions);
  } else {
    // Silent tab — just show note
    const actions = document.createElement('div');
    actions.className = 'tab-actions';
    const note = document.createElement('span');
    note.style.cssText = 'font-size:10px;color:var(--text2)';
    note.textContent = 'Play audio to control';
    actions.appendChild(note);
    li.appendChild(actions);
  }

  return li;
}

function buildFavicon(tab) {
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    const img = document.createElement('img');
    img.className = 'tab-favicon';
    img.src = tab.favIconUrl;
    img.alt = '';
    img.onerror = () => {
      const fallback = buildFaviconFallback();
      img.replaceWith(fallback);
    };
    return img;
  }
  return buildFaviconFallback();
}

function buildFaviconFallback() {
  const div = document.createElement('div');
  div.className = 'tab-favicon-fallback';
  div.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z"/>
  </svg>`;
  return div;
}

function buildBadge(tab, isCaptured, isMuted) {
  const badge = document.createElement('span');
  badge.className = 'tab-badge';
  if (isCaptured) {
    badge.textContent = isMuted ? 'MUTED' : 'ACTIVE';
    badge.classList.add(isMuted ? 'badge-muted' : 'badge-captured');
  } else if (tab.mutedInfo?.muted) {
    badge.textContent = 'MUTED';
    badge.classList.add('badge-muted');
  } else if (tab.audible) {
    badge.textContent = 'AUDIBLE';
    badge.classList.add('badge-audible');
  } else {
    badge.textContent = 'SILENT';
    badge.classList.add('badge-silent');
  }
  return badge;
}

function buildVolumeControls(tabId, info) {
  const wrap = document.createElement('div');
  wrap.className = 'tab-controls';

  // ── Volume slider row ──
  const volumeRow = document.createElement('div');
  volumeRow.className = 'volume-row';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = 0;
  slider.max = 200;
  slider.step = 1;
  slider.value = Math.round((info.muted ? 0 : info.volume) * 100);
  updateSliderFill(slider);

  const volLabel = document.createElement('span');
  volLabel.className = 'volume-label';
  volLabel.textContent = `${slider.value}%`;

  slider.addEventListener('input', () => {
    volLabel.textContent = `${slider.value}%`;
    updateSliderFill(slider);
  });
  slider.addEventListener('change', async () => {
    const volume = slider.valueAsNumber / 100;
    await onSetVolume(tabId, volume);
  });

  volumeRow.appendChild(slider);
  volumeRow.appendChild(volLabel);
  wrap.appendChild(volumeRow);

  // ── Quick buttons ──
  const quickBtns = document.createElement('div');
  quickBtns.className = 'quick-btns';

  // Mute toggle
  const muteBtn = document.createElement('button');
  muteBtn.className = 'btn btn-mute' + (info.muted ? ' active' : '');
  muteBtn.textContent = info.muted ? '🔇 Unmute' : '🔇 Mute';
  muteBtn.addEventListener('click', () => onToggleMute(tabId));
  quickBtns.appendChild(muteBtn);

  for (const pct of [50, 100, 150, 200]) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = `${pct}%`;
    btn.addEventListener('click', () => {
      slider.value = pct;
      volLabel.textContent = `${pct}%`;
      updateSliderFill(slider);
      onSetVolume(tabId, pct / 100);
    });
    quickBtns.appendChild(btn);
  }

  // Stop/reset
  const stopBtn = document.createElement('button');
  stopBtn.className = 'btn btn-danger';
  stopBtn.textContent = '✕ Stop';
  stopBtn.title = 'Stop volume control for this tab (restores normal audio)';
  stopBtn.addEventListener('click', () => onStopCapture(tabId));
  quickBtns.appendChild(stopBtn);

  wrap.appendChild(quickBtns);
  return wrap;
}

function updateSliderFill(slider) {
  const pct = (slider.valueAsNumber / slider.max) * 100;
  // 100% is the midpoint; accent up to 100%, red-ish above
  const midPct = 50; // 100 out of 200 = 50%
  if (pct <= midPct) {
    slider.style.background = `linear-gradient(to right, var(--accent) ${pct * 2}%, var(--bg3) ${pct * 2}%)`;
  } else {
    const overPct = (pct - midPct) * 2;
    slider.style.background =
      `linear-gradient(to right, var(--accent) 100%, var(--red) 100%)`;
    slider.style.background =
      `linear-gradient(to right, var(--accent) 50%, color-mix(in srgb, var(--red) ${overPct}%, var(--accent)) ${pct}%, var(--bg3) ${pct}%)`;
  }
}

// ── Actions ────────────────────────────────────────────────────────────────

async function onStartCapture(tabId) {
  showStatus('Capturing audio…');
  try {
    // Read any saved volume preference for this tab's origin
    const tab = await chrome.tabs.get(tabId);
    let volume = 1.0;
    try {
      const origin = new URL(tab.url).origin;
      const prefs = (await chrome.storage.local.get('volumePrefs'))['volumePrefs'] || {};
      if (origin in prefs) volume = prefs[origin];
    } catch (_) {}

    uiState.set(tabId, { volume, muted: false });
    const resp = await sendToSW({ type: 'START_CAPTURE', tabId, volume });
    if (!resp?.success) throw new Error(resp?.error || 'Unknown error');
    showStatus('Volume control active', 'success');
    await render();
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
    uiState.delete(tabId);
    console.error('[Popup] startCapture error:', err);
  }
}

async function onSetVolume(tabId, volume) {
  const info = uiState.get(tabId);
  if (info) {
    info.volume = volume;
    if (info.muted && volume > 0) info.muted = false; // unmute if slider moved up
  }
  await sendToSW({ type: 'SET_VOLUME', tabId, volume });
}

async function onToggleMute(tabId) {
  const resp = await sendToSW({ type: 'TOGGLE_MUTE', tabId });
  if (resp?.success) {
    const info = uiState.get(tabId);
    if (info) info.muted = resp.muted;
    await render();
  }
}

async function onStopCapture(tabId) {
  uiState.delete(tabId);
  await sendToSW({ type: 'STOP_CAPTURE', tabId });
  showStatus('Volume control stopped');
  await render();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sendToSW(message) {
  return chrome.runtime.sendMessage(message).catch(err => {
    console.warn('[Popup] SW message error:', err);
    return null;
  });
}

function showStatus(msg, type = '') {
  statusText.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ` ${type}` : '');
  statusBar.classList.remove('hidden');
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => statusBar.classList.add('hidden'), 3000);
}
