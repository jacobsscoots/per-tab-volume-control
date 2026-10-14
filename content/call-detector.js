// Read only the agent's own status and call controls, as in CLT.
(() => {
  globalThis.__teamMusicDetectorCleanup?.();
  let timer, stopped = false, pending = null, pendingAt = 0;
  const loadedAt = Date.now();
  const visible = el => !!el && !el.disabled && !el.closest('[hidden], [aria-hidden="true"]') && el.getClientRects().length > 0;
  function observe() {
    const label = document.querySelector('#currentStatusLabel, #status .sa-status-name, .sa-status-button .sa-status-name');
    const text = visible(label) ? (label.textContent || '').trim().toLowerCase() : '';
    const statusActive = /\b(on\s*call|in\s*call|talking|connected|ringing|on\s*hold|hold)\b/.test(text);
    const statusOff = /\b(available|un\s*available|not\s*ready|ready|idle|wrap|acw|after\s*call|lunch|break|personal|admin|busy|offline|training)\b/.test(text);
    const container = document.querySelector('.dialler-incall_container');
    const panel = container?.querySelector('.dialler-incall.active');
    const controls = panel || document.querySelector('section[aria-label="dialler"], .panel-call');
    const hangup = Array.from((controls || document).querySelectorAll('button, [role="button"]')).some(btn => {
      if (!visible(btn)) return false;
      const image = btn.querySelector('img[alt]');
      return [image?.getAttribute('alt'), btn.getAttribute('aria-label'), btn.getAttribute('title'), (btn.textContent || '').trim().slice(0, 32)]
        .some(value => /\b(end|hang)\b/i.test(value || ''));
    });
    // Avoid stale call panels on initial page load. Hold remains a call.
    if (statusActive || (hangup && Date.now() - loadedAt > 2500)) return 'active';
    if (!hangup && statusOff) return 'off';
    return 'unknown';
  }
  function tick() {
    if (stopped) return;
    const state = observe();
    if (state !== pending) { pending = state; pendingAt = Date.now(); }
    if (state === 'off' && Date.now() - pendingAt < 750) return;
    chrome.runtime.sendMessage({ type: 'MUSIC_CALL_STATE', state }).catch(() => {});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(tick, 100); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden', 'aria-label', 'disabled'] });
  const interval = setInterval(tick, 1000);
  globalThis.__teamMusicDetectorCleanup = () => { stopped = true; clearTimeout(timer); clearInterval(interval); observer.disconnect(); };
  tick();
})();
