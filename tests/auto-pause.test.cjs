const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function harness(saved) {
  const listeners = [], injections = [], updates = [];
  const session = saved || {}, local = {};
  const tabs = [
    { id: 1, url: 'https://tw.smartagent.app/', audible: true },
    { id: 2, url: 'https://open.spotify.com/', audible: true },
    { id: 3, url: 'https://www.youtube.com/', audible: true },
    { id: 4, url: 'https://soundcloud.com/', audible: true },
    { id: 5, url: 'https://example.org/music', audible: true, mutedInfo: { muted: false } },
    { id: 6, url: 'https://example.org/muted', audible: true, mutedInfo: { muted: true } },
    { id: 7, url: 'https://work.acqueon.com/', audible: true },
    { id: 8, url: 'https://example.org/quiet', audible: false }
  ];
  let fail = false, zero = false, frameIds = [0, 1];
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'test-extension', onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: event() },
    storage: {
      session: { get: async () => structuredClone(session), set: async obj => Object.assign(session, structuredClone(obj)) },
      local: { get: async defaults => ({ ...defaults, ...local }), set: async obj => Object.assign(local, obj) }
    },
    tabs: {
      query: async () => structuredClone(tabs),
      update: async (id, values) => {
        updates.push({ id, ...values });
        Object.assign(tabs.find(tab => tab.id === id), { mutedInfo: { muted: values.muted, extensionId: 'test-extension' } });
      },
      onRemoved: event(), onUpdated: event()
    },
    scripting: { executeScript: async options => {
      injections.push(options);
      if (fail) throw Error('blocked');
      return [{ frameId: 0, result: { count: zero ? 0 : 1 } }];
    } },
    webNavigation: { getAllFrames: async () => frameIds.map(frameId => ({ frameId })) }
  };
  const context = vm.createContext({ chrome, URL, console, _pauseMediaInPage() {}, _resumeMediaInPage() {} });
  vm.runInContext(read('background/auto-pause.js'), context);
  const sender = { id: 'test-extension', tab: { id: 1 }, frameId: 0, url: 'https://tw.smartagent.app/' };
  const message = (state, customSender = sender) => new Promise(resolve => listeners[0]({ type: 'MUSIC_CALL_STATE', state }, customSender, resolve));
  const popup = msg => new Promise(resolve => listeners[0](msg, { id: 'test-extension' }, resolve));
  return { message, popup, injections, updates, tabs, session, sender, fail: () => { fail = true; }, zero: () => { zero = true; }, frames: ids => { frameIds = ids; } };
}
test('pause all supported platforms; fallback mutes other audio; call and pre-muted tabs protected', async () => {
  const h = harness();
  const state = await h.message('active');
  assert.equal(state.active, true);
  assert.deepEqual(h.injections.map(x => x.target.tabId), [2, 3, 4]);
  assert.deepEqual(h.updates, [{ id: 5, muted: true }]);
  assert.equal(h.injections[1].target.allFrames, true);
});
test('off call resumes owned supported media and only our fallback mute', async () => {
  const h = harness(); await h.message('active'); h.injections.length = 0;
  await h.message('off');
  assert.deepEqual(h.injections.map(x => Array.from(x.args)), [['spotify', true], ['youtube', true], ['soundcloud', true]]);
  assert.deepEqual(h.updates.at(-1), { id: 5, muted: false });
  assert.equal(h.tabs.find(t => t.id === 6).mutedInfo.muted, true);
});
test('unknown call state keeps the active-call latch', async () => {
  const h = harness(); await h.message('active');
  const before = h.updates.length;
  assert.equal((await h.message('unknown')).active, true);
  assert.equal(h.updates.length, before);
});
test('multiple call frames must all finish before resuming', async () => {
  const h = harness(); await h.message('active');
  await h.message('active', { ...h.sender, frameId: 1 });
  assert.equal((await h.message('off')).active, true);
  assert.equal((await h.message('off', { ...h.sender, frameId: 1 })).active, false);
});
test('removed iframe does not keep music paused forever', async () => {
  const h = harness(); await h.message('active', { ...h.sender, frameId: 1 });
  h.frames([0]);
  assert.equal((await h.message('off')).active, false);
});
test('closed call tab releases owned media', async () => {
  const h = harness(); await h.message('active'); h.tabs.splice(0, 1);
  assert.equal((await h.popup({ type: 'MUSIC_GET_STATE' })).active, false);
});
test('disable restores music, and re-enable pauses during a continuing call', async () => {
  const h = harness(); await h.message('active');
  assert.equal((await h.popup({ type: 'MUSIC_SET_ENABLED', enabled: false })).active, false);
  assert.equal((await h.popup({ type: 'MUSIC_SET_ENABLED', enabled: true })).active, true);
});
test('reject fake call-state sender and page-driven toggle', async () => {
  const h = harness();
  assert.equal((await h.message('active', { ...h.sender, url: 'https://open.spotify.com/' })).error, 'invalid_sender');
  assert.equal(h.injections.length, 0);
});
test('inaccessible media or unknown platform controls fall back to mute', async () => {
  for (const mode of ['fail', 'zero']) {
    const h = harness(); h[mode](); await h.message('active');
    assert.deepEqual(h.updates.map(x => x.id), [2, 3, 4, 5]);
  }
});
test('worker restart restores session ownership', async () => {
  const h = harness(); await h.message('active');
  const next = harness(h.session);
  assert.equal((await next.message('unknown')).active, true);
  assert.equal((await next.message('off')).active, false);
});
test('new call queued behind off-call prevents a premature resume', async () => {
  const h = harness(); await h.message('active'); h.injections.length = 0;
  await Promise.all([h.message('off'), h.message('active')]);
  assert.ok(!h.injections.some(x => x.args[1] === true));
});
test('a music tab navigating to a call host is never resumed or unmuted', async () => {
  const h = harness(); await h.message('active');
  h.tabs.find(t => t.id === 2).url = 'https://tw.smartagent.app/';
  h.injections.length = 0; await h.message('off');
  assert.ok(!h.injections.some(x => x.target.tabId === 2));
});
function mediaContext(platform, playing = true) {
  let clicks = 0, label = playing ? 'Pause' : 'Play';
  const control = {
    isConnected: true, offsetParent: {}, parentElement: null,
    getAttribute: attr => attr === 'aria-label' ? label : null,
    get className() { return label === 'Pause' ? 'playing' : ''; },
    click() { clicks++; label = label === 'Pause' ? 'Play' : 'Pause'; }
  };
  const el = {
    paused: !playing, ended: false, dataset: {}, listeners: [],
    addEventListener(_event, fn) { this.listeners.push(fn); },
    removeEventListener() {}, pause() { this.paused = true; },
    play() { this.paused = false; this.listeners.forEach(fn => fn()); return Promise.resolve(); }
  };
  const document = {
    querySelector: () => control,
    querySelectorAll: selector => selector.includes('control-button') ? [control] :
      selector.includes('data-team-music') ? (el.dataset.teamMusicPaused ? [el] : []) : [el]
  };
  const context = vm.createContext({ document, console });
  vm.runInContext(read('background/media-control.js'), context);
  return { pause: () => context._pauseMediaInPage(platform), resume: () => context._resumeMediaInPage(platform, true),
    clicks: () => clicks, el, control };
}
for (const platform of ['spotify', 'soundcloud', 'youtube']) {
  test(platform + ': pause/resume playing media exactly once', () => {
    const h = mediaContext(platform); assert.equal(h.pause().count, 1);
    assert.equal(h.resume().count, 1); assert.equal(h.resume().count, 0);
  });
  test(platform + ': pre-paused media is never started', () => {
    const h = mediaContext(platform, false); assert.equal(h.pause().count, 0);
    assert.equal(h.resume().count, 0); assert.equal(h.clicks(), 0);
  });
}
test('SoundCloud resumed manually is not toggled back to paused', () => {
  const h = mediaContext('soundcloud'); h.pause(); h.control.click();
  assert.equal(h.resume().count, 0); assert.equal(h.clicks(), 2);
});
test('Spotify ambiguous visible controls are not clicked', () => {
  const context = vm.createContext({ console, document: {
    querySelectorAll: () => [1, 2].map(() => ({
      isConnected: true, offsetParent: {}, getAttribute: () => null
    }))
  } });
  vm.runInContext(read('background/media-control.js'), context);
  assert.equal(context._pauseMediaInPage('spotify').method, 'spotify_control_ambiguous');
});
function detector(text, buttonText = '') {
  let now = 10000, tick, selector, sent = [];
  const element = value => ({
    textContent: value, disabled: false, closest: () => null,
    getClientRects: () => [1], querySelector: () => null,
    getAttribute: () => null
  });
  const label = element(text), button = element(buttonText);
  const context = vm.createContext({
    Date: { now: () => now }, console,
    document: {
      documentElement: {},
      querySelector: query => { selector = query; return query.startsWith('#currentStatusLabel') ? label : null; },
      querySelectorAll: () => buttonText ? [button] : []
    },
    chrome: { runtime: { sendMessage: message => { sent.push(message.state); return Promise.resolve(); } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
    setTimeout() {}, clearTimeout() {}
  });
  vm.runInContext(read('content/call-detector.js'), context);
  return { sent, label, tick: ms => { now += ms; tick(); }, selector: () => selector };
}
for (const text of ['In Call', 'Ringing', 'On Hold', 'Hold']) {
  test('detector keeps ' + text + ' active', () => {
    const h = detector(text); assert.equal(h.sent.at(-1), 'active');
  });
}
test('detector confirms wrap before off-call; temporary unknown cannot emit off', () => {
  const h = detector('In Call'); h.label.textContent = 'Wrap';
  h.tick(10); assert.equal(h.sent.at(-1), 'active');
  h.tick(800); assert.equal(h.sent.at(-1), 'off');
  h.label.textContent = ''; h.tick(1000); assert.equal(h.sent.at(-1), 'unknown');
});
test('Send button does not look like a hangup; stale End panel is suppressed on load', () => {
  const h = detector('Available', 'Send'); h.tick(800); assert.equal(h.sent.at(-1), 'off');
  const stale = detector('Available', 'End'); assert.equal(stale.sent.at(-1), 'unknown');
});
