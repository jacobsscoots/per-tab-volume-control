"""Real Chromium extension test. All work/music URLs serve synthetic fixtures.

No live work sites, accounts or customer data are accessed. Playback is real;
Spotify/SoundCloud UI is simulated using CLT's supported selectors.
"""
import io
import json
import math
import os
from pathlib import Path
import struct
import tempfile
import time
import wave
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "browser-test-report.json"
checks = []

buf = io.BytesIO()
with wave.open(buf, "wb") as wav:
    wav.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
    wav.writeframes(b"".join(struct.pack("<h", int(1500 * math.sin(i * math.tau * 440 / 8000))) for i in range(16000)))
TONE = buf.getvalue()

CALL = """<!doctype html><title>Simulated SmartAgent</title>
<span id="currentStatusLabel">Available</span>
<div class="dialler-incall_container"><div class="dialler-incall">
<div class="dialler-controls"><button aria-label="End call">End call</button></div>
</div></div><audio id="call-audio" src="/tone.wav" loop></audio>
<script>
window.setCall = state => {
  document.querySelector('#currentStatusLabel').textContent = state;
  document.querySelector('.dialler-incall').classList.toggle('active', ['In Call', 'Hold', 'On Hold', 'Ringing'].includes(state));
  document.querySelector('.dialler-controls').hidden = !['In Call', 'Hold', 'On Hold', 'Ringing'].includes(state);
};
setCall('Available');
</script>"""

def media_html(platform):
    tag = "video" if platform == "youtube" else "audio"
    button = '<button data-testid="control-button-playpause" aria-label="Play">Play</button>' if platform == "spotify" else '<button class="playControls__play playControl">Play</button>'
    return f"""<!doctype html><title>Simulated {platform}</title>
<{tag} id="player" src="/tone.wav" loop controls></{tag}>{button}
<script>
const media = document.querySelector('#player'), button = document.querySelector('button');
function sync() {{
  button.setAttribute('aria-label', media.paused ? 'Play' : 'Pause');
  button.classList.toggle('playing', !media.paused);
  button.setAttribute('aria-pressed', String(!media.paused));
}}
media.addEventListener('play', sync); media.addEventListener('pause', sync);
button.addEventListener('click', () => media.paused ? media.play() : media.pause());
window.startMusic = () => media.play(); window.stopMusic = () => media.pause();
</script>"""

def wait_for(fn, label, timeout=12):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if fn():
            checks.append(label)
            print("PASS:", label, flush=True)
            return
        time.sleep(0.1)
    raise AssertionError(label)

def route_fixture(route):
    url = route.request.url
    if url.endswith("/tone.wav"):
        route.fulfill(status=200, content_type="audio/wav", body=TONE)
    elif "smartagent.app" in url:
        route.fulfill(status=200, content_type="text/html", body=CALL)
    elif "spotify.com" in url:
        route.fulfill(status=200, content_type="text/html", body=media_html("spotify"))
    elif "soundcloud.com" in url:
        route.fulfill(status=200, content_type="text/html", body=media_html("soundcloud"))
    elif "youtube.com" in url:
        route.fulfill(status=200, content_type="text/html", body=media_html("youtube"))
    else:
        route.fulfill(status=200, content_type="text/html", body=media_html("generic"))

def run():
    with sync_playwright() as playwright, tempfile.TemporaryDirectory() as profile:
        context = playwright.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, ignore_default_args=["--mute-audio"],
            args=[f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}",
                  "--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
        try:
            context.route("https://**/*", route_fixture)
            worker = context.service_workers[0] if context.service_workers else context.wait_for_event("serviceworker")
            extension_id = worker.url.split("/")[2]
            errors = []
            worker.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
            popup = context.new_page()
            popup.on("pageerror", lambda error: errors.append(str(error)))
            popup.goto(f"chrome-extension://{extension_id}/popup.html")
            popup.wait_for_load_state("networkidle")
            wait_for(lambda: popup.locator("#music-toggle").is_checked(), "Extension loads; automatic pause enabled")
            call = context.new_page()
            call.goto("https://fixture.smartagent.app/")
            call.wait_for_load_state("networkidle")
            call.evaluate("document.querySelector('#call-audio').play()")
            music = []
            for url in ["https://open.spotify.com/fixture", "https://soundcloud.com/fixture",
                        "https://www.youtube.com/fixture", "https://music.youtube.com/fixture"]:
                page = context.new_page()
                page.goto(url)
                page.wait_for_load_state("networkidle")
                page.evaluate("startMusic()")
                page.wait_for_function("!document.querySelector('#player').paused")
                music.append(page)
            wait_for(lambda: len(worker.evaluate("chrome.tabs.query({audible:true})")) >= 5,
                     "Real media audio is audible in Chromium")
            call.evaluate("setCall('In Call')")
            wait_for(lambda: all(page.evaluate("document.querySelector('#player').paused") for page in music),
                     "Call starts: Spotify/SoundCloud/YouTube/YouTube Music all paused")
            wait_for(lambda: not call.evaluate("document.querySelector('#call-audio').paused"),
                     "Call audio remains playing")
            call.evaluate("setCall('Hold')")
            time.sleep(2)
            assert all(page.evaluate("document.querySelector('#player').paused") for page in music)
            checks.append("Hold keeps all music paused")
            call.evaluate("setCall('Wrap')")
            wait_for(lambda: all(not page.evaluate("document.querySelector('#player').paused") for page in music),
                     "Off call/wrap: all owned music resumes")
            music[1].evaluate("stopMusic()")
            time.sleep(2)
            call.evaluate("setCall('Ringing')")
            wait_for(lambda: music[0].evaluate("document.querySelector('#player').paused"), "Ringing pauses music")
            call.evaluate("setCall('Available')")
            wait_for(lambda: not music[0].evaluate("document.querySelector('#player').paused"), "Available resumes music")
            assert music[1].evaluate("document.querySelector('#player').paused")
            checks.append("Pre-paused SoundCloud remains paused")
            call2 = context.new_page()
            call2.goto("https://second.smartagent.app/")
            call2.wait_for_load_state("networkidle")
            call.evaluate("setCall('In Call')")
            call2.evaluate("setCall('In Call')")
            wait_for(lambda: music[0].evaluate("document.querySelector('#player').paused"), "Overlapping calls pause music")
            call.evaluate("setCall('Available')")
            time.sleep(2)
            assert music[0].evaluate("document.querySelector('#player').paused")
            checks.append("First call ending does not resume over second call")
            call2.evaluate("setCall('Wrap')")
            wait_for(lambda: not music[0].evaluate("document.querySelector('#player').paused"), "Last call ending resumes music")
            generic = context.new_page()
            generic.goto("https://music-fixture.example/")
            generic.wait_for_load_state("networkidle")
            generic.evaluate("startMusic()")
            wait_for(lambda: generic.evaluate("!document.querySelector('#player').paused"), "Generic media playing before call")
            call.evaluate("setCall('In Call')")
            wait_for(lambda: any(t["mutedInfo"]["muted"] for t in worker.evaluate("chrome.tabs.query({})") if t.get("url") == generic.url),
                     "Unknown music site is muted")
            assert generic.evaluate("!document.querySelector('#player').paused")
            checks.append("Fallback mute does not stop the player timeline")
            music[1].evaluate("startMusic()")
            wait_for(lambda: music[1].evaluate("document.querySelector('#player').paused"),
                     "Music started during a call is paused")
            popup.reload()
            popup.wait_for_load_state("networkidle")
            popup.locator("#music-toggle").uncheck()
            wait_for(lambda: not music[0].evaluate("document.querySelector('#player').paused"),
                     "Popup disable restores owned music")
            popup.locator("#music-toggle").check()
            wait_for(lambda: music[0].evaluate("document.querySelector('#player').paused"),
                     "Popup re-enable detects continuing call")
            call.reload()
            call.wait_for_load_state("networkidle")
            call.evaluate("setCall('In Call')")
            time.sleep(2)
            assert music[0].evaluate("document.querySelector('#player').paused")
            checks.append("Call-page reload recovers active call")
            cdp = context.new_cdp_session(call)
            cdp.send("ServiceWorker.enable")
            cdp.send("ServiceWorker.stopAllWorkers")
            popup.reload()
            popup.wait_for_load_state("networkidle")
            wait_for(lambda: popup.locator("#music-status").inner_text() == "On call — music paused",
                     "Real service-worker stop/restart preserves active call")
            call.evaluate("setCall('Wrap')")
            wait_for(lambda: not music[0].evaluate("document.querySelector('#player').paused"),
                     "Worker restart: off-call still restores owned music")
            worker = context.service_workers[-1]
            wait_for(lambda: not any(t["mutedInfo"]["muted"] for t in worker.evaluate("chrome.tabs.query({})") if t.get("url") == generic.url),
                     "Fallback music tab unmuted after call")
            call.evaluate("setCall('In Call')")
            wait_for(lambda: music[0].evaluate("document.querySelector('#player').paused"), "Next call pauses again")
            music[2].close()
            call.close()
            wait_for(lambda: not music[0].evaluate("document.querySelector('#player').paused"),
                     "Closing call tab resumes remaining music; closed music tab handled")
            assert not errors, errors
            checks.append("No extension worker or popup errors")
            return {"status": "passed", "browser": context.browser.version, "checks": checks,
                    "scope": "Real Chromium extension, real audio, synthetic work/music UI. No live SmartAgent or signed-in service verification."}
        finally:
            context.close()

try:
    result = run()
except Exception as error:
    REPORT.write_text(json.dumps({"status": "failed", "passed_checks": checks, "error": str(error)}, indent=2))
    raise
else:
    REPORT.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
