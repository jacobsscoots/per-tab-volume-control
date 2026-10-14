// Adapted from CLT music controls; isolated ownership markers.
function _pauseMediaInPage(platform) {
  const result = { method: "none", count: 0 };
  // Resolves exactly one connected/visible/enabled candidate from the
  // existing '[data-testid="control-button-playpause"]' selector — no new
  // selectors, no page-wide scan. Spotify's SPA can leave a stale/hidden
  // control node around (same bug class documented for Acqueon/C4C in
  // content.js's isVisible() comment); a plain first-DOM-match read can
  // pick that stale node instead of the real, currently-rendered one.
  // Declared INSIDE this function (and duplicated, verbatim, inside
  // _resumeMediaInPage below) because chrome.scripting.executeScript's
  // injected `func` only serialises this one function — it cannot
  // reference an outside closure/top-level helper.
  function _findSpotifyPlayPauseControl() {
    function usable(el) {
      if (!el || el.isConnected === false) return false;
      if (el.disabled) return false;
      let node = el;
      while (node) {
        if (typeof node.getAttribute === "function" && node.getAttribute("aria-hidden") === "true") return false;
        if (node.hidden === true) return false;
        node = node.parentElement || null;
      }
      if (el.offsetParent === null) {
        try {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
        } catch { /* unreadable geometry is treated as not visible */ return false; }
      }
      return true;
    }
    const candidates = document.querySelectorAll('[data-testid="control-button-playpause"]');
    const total = candidates.length;
    const visible = [];
    for (const candidate of candidates) {
      if (usable(candidate)) visible.push(candidate);
    }
    if (visible.length === 0) return { outcome: "none_visible", total, visibleCount: 0, el: null, labelState: "none" };
    if (visible.length > 1) return { outcome: "ambiguous_visible", total, visibleCount: visible.length, el: null, labelState: "none" };
    const el = visible[0];
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    let labelState = "missing";
    if (label) {
      if (label.includes("pause")) labelState = "pause";
      else if (label.includes("play")) labelState = "play";
      else labelState = "other";
    }
    return { outcome: "unique_visible", total, visibleCount: 1, el, labelState };
  }
  // Per-platform branches, also declared inside this function for the same
  // serialisation reason as _findSpotifyPlayPauseControl above. Each fills in
  // and returns the shared `result`.
  function _pauseSpotify() {
    const control = _findSpotifyPlayPauseControl();
    result.totalCandidateCount = control.total;
    result.visibleCandidateCount = control.visibleCount;
    result.labelState = control.labelState;
    result.selectionOutcome = control.outcome;
    if (control.outcome === "none_visible") {
      result.method = control.total === 0 ? "spotify_button_not_found" : "spotify_control_not_visible";
      return result;
    }
    if (control.outcome === "ambiguous_visible") {
      result.method = "spotify_control_ambiguous";
      return result;
    }
    if (control.labelState === "pause") {
      control.el.click();
      globalThis.__teamMusicPausedSpotify = true;
      result.method = "spotify_click";
      result.count = 1;
      return result;
    }
    if (control.labelState === "play") {
      result.method = "spotify_already_paused";
      return result;
    }
    // "other" / "missing" — a unique, visible control whose label can't
    // be reliably classified (localised text, A/B-tested markup, etc.).
    // Never guess by clicking; never log the raw label.
    result.method = "spotify_label_unknown";
    return result;
  }

  // Tag each element we pause so only OUR pause is ever resumed, and drop the
  // tag the moment the user presses play themselves.
  function _pauseTaggedMedia(elements) {
    for (const el of elements) {
      el.dataset.teamMusicPaused = "1";
      const onUserPlay = () => {
        delete el.dataset.teamMusicPaused;
        el.removeEventListener("play", onUserPlay);
      };
      el.addEventListener("play", onUserPlay);
      try { el.pause(); } catch (err) { console.debug("[TeamMusic]", "best_effort_a_failure_here_must_not_break_th", err?.name || "Error"); }
    }
  }

  function _pauseYouTube() {
    const videos = Array.from(document.querySelectorAll("video")).filter(v => !v.paused && !v.ended);
    _pauseTaggedMedia(videos);
    result.method = videos.length ? "youtube_video_pause" : "youtube_no_playing_video";
    result.count = videos.length;
    return result;
  }

  function _pauseSoundcloud() {
    const btn = document.querySelector('.playControls__play, button.playControl');
    if (!btn) {
      result.method = "soundcloud_button_not_found";
      return result;
    }
    const cls = btn.className || "";
    const isPlaying = /\bplaying\b/i.test(cls) || btn.getAttribute("aria-pressed") === "true";
    if (isPlaying) {
      btn.click();
      globalThis.__teamMusicPausedSoundcloud = true;
      result.method = "soundcloud_click";
      result.count = 1;
      return result;
    }
    result.method = "soundcloud_already_paused";
    return result;
  }

  // Unknown platform — generic <audio>/<video> sweep.
  function _pauseGenericMedia() {
    const playing = Array.from(document.querySelectorAll("audio, video"))
      .filter(el => !el.paused && !el.ended);
    _pauseTaggedMedia(playing);
    result.method = playing.length ? "generic_media_pause" : "generic_no_playing_media";
    result.count = playing.length;
    return result;
  }

  try {
    if (platform === "spotify") return _pauseSpotify();
    if (platform === "youtube") return _pauseYouTube();
    if (platform === "soundcloud") return _pauseSoundcloud();
    return _pauseGenericMedia();
  } catch (e) {
    result.method = "error";
    result.error = e?.message;
    return result;
  }
}

// requireOwnership=true (the default/original contract): only ever acts on
// state pauseMusicForCall itself created (the __teamMusicPausedSpotify /
// __teamMusicPausedSoundcloud flags, the data-team-music-paused tags) —
// SmartAgent's resumeMusicForCall() call sites.
// requireOwnership=false ("blind" resume, CLT-9): no ownership flag/tag
// exists to check (Acqueon never calls pauseMusicForCall), so this instead
// reads the control's actual on-page state and only ever transitions a
// currently-PAUSED control to playing — never touches one already playing,
// so it can never pause something that's going — used by
// resumeMusicForAcqueonCallEnd(). Kept as ONE function (not two near-
// identical copies) because chrome.scripting.executeScript({func}) only
// serialises this one function — every helper it needs must be nested
// inside it, so a second copy would duplicate that nested code verbatim.
// mode: "resume" (default, omitted) performs the existing click/play
// behaviour. mode: "observe" (CLT-9) never clicks/plays anything — it only
// reports whether the resolved control currently looks like it's playing,
// so a caller can record genuine resume candidates without changing any
// page's playback state.
function _resumeMediaInPage(platform, requireOwnership, mode) {
  const result = { method: "none", count: 0 };
  const observeOnly = mode === "observe";
  // Duplicated verbatim from _pauseMediaInPage above (nested, not shared —
  // see the comment there for why: executeScript({func}) only serialises
  // this one function, it cannot reference an outside closure/helper).
  function _findSpotifyPlayPauseControl() {
    function usable(el) {
      if (!el || el.isConnected === false) return false;
      if (el.disabled) return false;
      let node = el;
      while (node) {
        if (typeof node.getAttribute === "function" && node.getAttribute("aria-hidden") === "true") return false;
        if (node.hidden === true) return false;
        node = node.parentElement || null;
      }
      if (el.offsetParent === null) {
        try {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
        } catch (err) { console.debug("[TeamMusic]", "best_effort_ignored", err?.name || "Error"); return false; }
      }
      return true;
    }
    const candidates = document.querySelectorAll('[data-testid="control-button-playpause"]');
    const total = candidates.length;
    const visible = [];
    for (const candidate of candidates) {
      if (usable(candidate)) visible.push(candidate);
    }
    if (visible.length === 0) return { outcome: "none_visible", total, visibleCount: 0, el: null, labelState: "none" };
    if (visible.length > 1) return { outcome: "ambiguous_visible", total, visibleCount: visible.length, el: null, labelState: "none" };
    const el = visible[0];
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    let labelState = "missing";
    if (label) {
      if (label.includes("pause")) labelState = "pause";
      else if (label.includes("play")) labelState = "play";
      else labelState = "other";
    }
    return { outcome: "unique_visible", total, visibleCount: 1, el, labelState };
  }

  function resolveSpotifyPlay(base) {
    // Currently paused — click resumes it.
    if (requireOwnership) delete globalThis.__teamMusicPausedSpotify;
    return { ...base, method: requireOwnership ? "spotify_click" : "spotify_click_blind", count: 1 };
  }

  function resolveSpotifyPause(base) {
    // Already playing (agent/user resumed manually, or Spotify's own
    // state changed) — do not click it and pause it back. Ownership
    // (when tracked) is still cleared: whatever state it's in now is
    // no longer ours to track.
    if (requireOwnership) delete globalThis.__teamMusicPausedSpotify;
    return { ...base, method: requireOwnership ? "spotify_state_changed" : "spotify_already_playing", count: 0 };
  }

  function resolveSpotify() {
    if (observeOnly) {
      const control = _findSpotifyPlayPauseControl();
      return { method: "observe", playing: control.labelState === "pause", count: 0 };
    }
    if (requireOwnership && !globalThis.__teamMusicPausedSpotify) {
      return { method: "spotify_not_owned", count: 0 };
    }
    const control = _findSpotifyPlayPauseControl();
    const base = {
      totalCandidateCount: control.total,
      visibleCandidateCount: control.visibleCount,
      labelState: control.labelState,
      selectionOutcome: control.outcome
    };
    if (control.outcome === "none_visible") {
      return { ...base, method: control.total === 0 ? "spotify_button_not_found" : "spotify_control_not_visible", count: 0 };
    }
    if (control.outcome === "ambiguous_visible") {
      return { ...base, method: "spotify_control_ambiguous", count: 0 };
    }
    if (control.labelState === "play") {
      control.el.click();
      return resolveSpotifyPlay(base);
    }
    if (control.labelState === "pause") return resolveSpotifyPause(base);
    // "other" / "missing" / ambiguous / none-visible: never a blind click,
    // and the ownership marker (when tracked) is deliberately left
    // untouched — an unresolved read doesn't prove the state changed, so
    // it doesn't clear ownership either. The next resume attempt (or the
    // SW's own dedup/ownership record) is the actual safety net.
    return { ...base, method: "spotify_label_unknown", count: 0 };
  }

  function resolveSoundcloud() {
    if (observeOnly) {
      const btn = document.querySelector('.playControls__play, button.playControl');
      if (!btn) return { method: "observe", playing: false, count: 0 };
      const cls = btn.className || "";
      const isPlaying = /\bplaying\b/i.test(cls) || btn.getAttribute("aria-pressed") === "true";
      return { method: "observe", playing: isPlaying, count: 0 };
    }
    if (requireOwnership && !globalThis.__teamMusicPausedSoundcloud) {
      return { method: "soundcloud_not_owned", count: 0 };
    }
    const btn = document.querySelector('.playControls__play, button.playControl');
    if (!btn) return { method: "soundcloud_button_not_found", count: 0 };
    {
      const cls = btn.className || "";
      const isPlaying = /\bplaying\b/i.test(cls) || btn.getAttribute("aria-pressed") === "true";
      if (isPlaying) return { method: "soundcloud_already_playing", count: 0 };
    }
    btn.click();
    if (requireOwnership) delete globalThis.__teamMusicPausedSoundcloud;
    return { method: requireOwnership ? "soundcloud_click" : "soundcloud_click_blind", count: 1 };
  }

  function playElement(el) {
    try {
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch((err) => console.debug("[TeamMusic]", "parked_rejection", err?.name || "Error"));
    } catch (err) { console.debug("[TeamMusic]", "best_effort_ignored", err?.name || "Error"); }
  }

  function resolveYoutubeOrUnknown() {
    if (observeOnly) {
      if (platform !== "youtube") return { method: "observe", playing: false, count: 0 };
      const videos = Array.from(document.querySelectorAll("video"));
      const playing = videos.some((v) => !v.paused && !v.ended);
      return { method: "observe", playing, count: 0 };
    }
    if (requireOwnership) {
      // resume any element pauseMusicForCall tagged.
      const tagged = Array.from(document.querySelectorAll(
        "audio[data-team-music-paused], video[data-team-music-paused]"
      ));
      for (const el of tagged) {
        delete el.dataset.teamMusicPaused;
        playElement(el);
      }
      let method = "no_tagged_media";
      if (tagged.length) method = platform === "youtube" ? "youtube_video_play" : "generic_media_play";
      return { method, count: tagged.length };
    }
    // Blind resume: no tag exists to trust, so only YouTube — a
    // recognised platform — is acted on, and only elements genuinely
    // paused right now. Unknown platforms are always skipped (never a
    // page-wide sweep without evidence).
    if (platform !== "youtube") return { method: "unknown_platform_skipped", count: 0 };
    const videos = Array.from(document.querySelectorAll("video")).filter(v => v.paused && !v.ended);
    for (const v of videos) playElement(v);
    return { method: videos.length ? "youtube_video_play_blind" : "youtube_no_paused_video", count: videos.length };
  }

  try {
    let resolved;
    if (platform === "spotify") resolved = resolveSpotify();
    else if (platform === "soundcloud") resolved = resolveSoundcloud();
    else resolved = resolveYoutubeOrUnknown();
    return Object.assign(result, resolved);
  } catch (e) {
    result.method = "error";
    result.error = e?.message;
    return result;
  }
}

