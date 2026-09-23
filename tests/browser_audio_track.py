"""Run with `python tests/browser_audio_track.py` (requires Playwright/Chromium).

Exercise the real audio lane with a playable WAV and a local in-browser fixture.
No ComfyUI server, model, or generation is needed.
"""
import io
import json
from pathlib import Path
import wave

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
HTML = """<!doctype html><meta charset="utf-8">
<style>
body { background:#222; color:#ddd; font:12px sans-serif; padding:24px; }
#panel { width:850px; padding:12px; background:#333; }
button,input { background:#222; color:#ddd; border:1px solid #666; padding:4px; }
#strip { width:850px; overflow:auto; } #wide { width:1800px; height:45px; background:#514269; }
</style>
<div id="panel"><b>H3 MCtx Timeline · audio preview</b><div id="strip"><div id="wide">Video timeline</div></div></div>
<script type="module">
import { mountAudioTrack } from '/web/h3_timeline_audio.js';
window.widget = {name:'audio_track',value:JSON.stringify({file:'voice.wav',start_frame:0,source_start:0,duration:0,denoise:.5})};
window.g = {scale:2,entries:[],starts:[],landing:{start:0,frames:120}};
window.changes = 0;
window.lane = mountAudioTrack({node:{widgets:[widget],setDirtyCanvas(){}},
    api:{apiURL:p=>p,fetchApi:(p,o)=>fetch(p,o)},strip:document.querySelector('#strip'),
    geometry:()=>g,changed:()=>changes++});
document.querySelector('#panel').append(lane.el); lane.paint();
</script>"""


def main():
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b"\x00\x00" * (8000 * 12))
    requests = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1050, "height": 500})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        def route_request(route):
            url = route.request.url
            if "/web/" in url:
                route.fulfill(content_type="text/javascript", body=(ROOT / "web/h3_timeline_audio.js").read_text(encoding="utf-8"))
            elif "/view?" in url:
                requests.append("media")
                data = buf.getvalue()
                requested = route.request.headers.get("range")
                if requested:
                    a, b = requested.removeprefix("bytes=").split("-")
                    a, b = int(a), int(b) if b else len(data) - 1
                    route.fulfill(status=206, content_type="audio/wav", body=data[a:b + 1],
                                  headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes {a}-{b}/{len(data)}"})
                else:
                    route.fulfill(content_type="audio/wav", body=data, headers={"Accept-Ranges": "bytes"})
            elif "/audio_info" in url:
                requests.append("peaks")
                route.fulfill(json={"duration": 12, "peaks": [.2, .8, .4, .6] * 512})
            else:
                route.fulfill(content_type="text/html", body=HTML)

        page.route("http://audio.test/**", route_request)
        page.goto("http://audio.test/")
        page.wait_for_function("document.querySelector('audio')?.readyState >= 3")
        source = page.get_by_label("Full source audio waveform and selected range")
        timeline = page.get_by_label("Timeline audio waveform", exact=False)
        play = page.get_by_title("Play / pause from the audio cursor", exact=True)
        selection = page.get_by_title("Play the selected source range from start to end", exact=True)
        cursor = page.get_by_label("Audio cursor seconds")
        start = page.get_by_label("source start s", exact=True)
        duration = page.get_by_label("duration s", exact=True)

        def set_field(field, value):
            field.fill(str(value))
            field.press("Tab")

        # Cursor click and pause/resume never reset to source_start.
        source.click(position={"x": 8 + (850 - 16) * .4, "y": 32})
        page.wait_for_function("Math.abs(document.querySelector('audio').currentTime - 4.8) < .03")
        assert page.evaluate("changes") == 0, "Seeking must not change generation settings"
        play.click()
        page.wait_for_function("document.querySelector('audio').currentTime > 5")
        play.click()
        paused = page.locator("audio").evaluate("a => a.currentTime")
        play.click()
        page.wait_for_function("(t) => document.querySelector('audio').currentTime > t + .15", arg=paused)
        play.click()

        # Editing settings retains the same media/peaks; range preview ends at 4.2.
        before_requests = requests.copy()
        set_field(start, 3)
        set_field(duration, 1.2)
        set_field(page.get_by_label("lip sync", exact=True), .6)
        assert requests == before_requests, "Settings changes must not reload the media or waveform"
        selection.click()
        page.wait_for_function("!document.querySelector('audio').paused")
        page.wait_for_function("document.querySelector('audio').paused && Math.abs(document.querySelector('audio').currentTime - 4.2) < .03")
        assert abs(float(cursor.input_value()) - 4.2) < .03
        # Pausing a range preview preserves both its cursor and stop boundary.
        selection.click()
        page.wait_for_function("document.querySelector('audio').currentTime > 3.2")
        play.click()
        paused = page.locator("audio").evaluate("a => a.currentTime")
        play.click()
        page.wait_for_function("(t) => document.querySelector('audio').currentTime > t", arg=paused)
        page.wait_for_function("document.querySelector('audio').paused && Math.abs(document.querySelector('audio').currentTime - 4.2) < .03")

        # Shift-drag selects a new source range; handle drag changes its end.
        box = source.bounding_box()

        def drag_source(a, b, shift=False):
            def x(t):
                return box["x"] + 8 + t / 12 * (box["width"] - 16)
            if shift:
                page.keyboard.down("Shift")
            page.mouse.move(x(a), box["y"] + 32)
            page.mouse.down()
            page.mouse.move(x(b), box["y"] + 32, steps=5)
            page.mouse.up()
            if shift:
                page.keyboard.up("Shift")

        drag_source(6, 9, shift=True)
        track = page.evaluate("JSON.parse(widget.value)")
        assert abs(track["source_start"] - 6) < .03
        assert abs(track["duration"] - 3) < .03
        drag_source(9, 10)
        track = page.evaluate("JSON.parse(widget.value)")
        assert abs(track["source_start"] - 6) < .03
        assert abs(track["duration"] - 4) < .03

        # Timeline seeking honours scroll, saved prepend origin and CSS zoom.
        page.evaluate("""() => {
            const track = JSON.parse(widget.value);
            g.entries = [{enter:0,meta:{timeline_audio:JSON.stringify({track,raw_start:24})}}];
            g.starts = [0]; document.querySelector('#strip').scrollLeft = 48;
            document.querySelector('#panel').style.transformOrigin = 'top left';
            document.querySelector('#panel').style.transform = 'scale(.8)'; lane.paint();
        }""")
        box = timeline.bounding_box()
        page.mouse.click(box["x"] + 56 * .8, box["y"] + 24 * .8)
        page.wait_for_function("Math.abs(document.querySelector('audio').currentTime - 9) < .04")
        assert abs(page.evaluate("JSON.parse(widget.value).source_start") - 6) < .03
        # Shift-dragging still moves the track by exactly one second.
        page.keyboard.down("Shift")
        page.mouse.move(box["x"] + 150 * .8, box["y"] + 24 * .8)
        page.mouse.down()
        page.mouse.move(box["x"] + 198 * .8, box["y"] + 24 * .8, steps=4)
        page.mouse.up()
        page.keyboard.up("Shift")
        assert page.evaluate("JSON.parse(widget.value).start_frame") == 24
        screenshot = ROOT / "private/qa/audio-preview.png"
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot))
        # Duration 0 previews the remainder, stopping at the real file end.
        set_field(start, 11.7)
        set_field(duration, 0)
        selection.click()
        page.wait_for_function("document.querySelector('audio').paused && document.querySelector('audio').currentTime > 11.99")
        # Removal and disposal stop playback and clear the selection UI.
        page.get_by_title("Remove the custom soundtrack", exact=True).click()
        assert page.locator("audio").evaluate("a => a.paused && !a.getAttribute('src')")
        assert source.is_hidden()
        page.evaluate("lane.dispose()")
        assert not errors, errors
        browser.close()
    print("PASS: seeking, pause/resume, selection playback/trim, stable media, timeline offsets/zoom, removal")


if __name__ == "__main__":
    main()
