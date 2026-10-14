const musicToggle = document.getElementById('music-toggle');
const musicStatus = document.getElementById('music-status');
async function refreshMusic() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'MUSIC_GET_STATE' });
    if (state.error) throw new Error(state.error);
    musicToggle.checked = state.enabled;
    musicStatus.textContent = !state.enabled ? 'Automatic pause is off' :
      state.active ? 'On call — music paused' : 'Off call — music can play';
  } catch { musicStatus.textContent = 'Could not read call status. Reload the extension.'; }
}
musicToggle.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({ type: 'MUSIC_SET_ENABLED', enabled: musicToggle.checked });
  refreshMusic();
});
refreshMusic();
setInterval(refreshMusic, 1500);
