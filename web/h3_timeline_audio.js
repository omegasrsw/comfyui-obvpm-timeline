// A soundtrack lane shares the video strip's frame scale and scroll offset.
// Only its JSON widget is serialized; peaks are disposable preview data.
export function mountAudioTrack({ node, api, strip, geometry, changed }) {
    const widget = node.widgets?.find(w => w.name === "audio_track");
    const el = document.createElement("div");
    if (!widget) return { el, paint() {}, dispose() {} };
    widget.hidden = true;
    (widget.options ??= {}).hidden = true;
    Object.assign(el.style, { flexShrink: "0", padding: "4px 0", font: "11px sans-serif" });
    const controls = document.createElement("div");
    Object.assign(controls.style, { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
    controls.addEventListener("pointerdown", ev => ev.stopPropagation());
    el.addEventListener("click", ev => ev.stopPropagation());
    const button = (text, title, action) => {
        const b = document.createElement("button");
        b.textContent = text; b.title = title;
        b.onclick = action; controls.append(b); return b;
    };
    const read = () => {
        try { return JSON.parse(widget.value || "null"); } catch { return null; }
    };
    let info = null, loaded = "", version = 0, disposed = false;
    const status = document.createElement("span");
    status.style.opacity = ".8";
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus";
    input.hidden = true;
    button("+ audio", "Upload a soundtrack for lip-sync generation", () => input.click());
    const listen = button("▶", "Listen to the source audio", () => {
        if (!read()) return;
        if (player.paused) {
            player.currentTime = Number(read().source_start || 0);
            player.play().catch(err => { status.textContent = err.message; });
        } else player.pause();
    });
    const remove = button("×", "Remove the custom soundtrack", () => {
        player.pause(); write(null);
    });
    const fields = {};
    for (const [key, label, title, step] of [
        ["start_frame", "place s", "Position on the original timeline (seconds); drag the waveform to move", "any"],
        ["source_start", "source s", "Source audio time at the placement point; prepends can use earlier audio", .01],
        ["duration", "length s", "Source duration from the source offset; 0 uses the rest of the file", .01],
        ["denoise", "lip sync", "Audio denoise strength during sampling; the original sound is saved", .05],
    ]) {
        const wrap = document.createElement("label");
        wrap.textContent = label + " "; wrap.title = title;
        const field = document.createElement("input");
        field.type = "number"; field.step = String(step); field.style.width = "58px";
        if (key !== "start_frame") field.min = "0";
        if (key === "denoise") field.max = "1";
        field.onchange = () => {
            const track = read(); if (!track || !field.checkValidity()) return;
            track[key] = key === "start_frame" ? Math.round(Number(field.value) * 24) : Number(field.value);
            write(track);
        };
        field.addEventListener("keydown", ev => ev.stopPropagation());
        fields[key] = field; wrap.append(field); controls.append(wrap);
    }
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "48px",
        background: "rgba(0,0,0,.18)", borderRadius: "4px", cursor: "grab", marginTop: "4px" });
    canvas.setAttribute("aria-label", "Custom audio waveform; drag to change placement");
    const player = document.createElement("audio");
    player.onplay = () => { listen.textContent = "❚❚"; };
    player.onpause = player.onended = () => { listen.textContent = "▶"; };
    el.append(controls, canvas, status, input, player);
    function write(track) {
        widget.value = track ? JSON.stringify(track) : "";
        widget.callback?.(widget.value);
        node.setDirtyCanvas?.(true, true);
        changed(); paint();
    }
    async function upload(file) {
        if (!file) return;
        status.textContent = "Uploading audio…";
        try {
            const form = new FormData();
            form.append("image", file); form.append("type", "input");
            form.append("subfolder", "timeline_audio");
            const response = await api.fetchApi("/upload/image", { method: "POST", body: form });
            if (!response.ok) throw new Error(await response.text());
            const data = await response.json();
            write({ file: [data.subfolder, data.name].filter(Boolean).join("/"),
                start_frame: 0, source_start: 0, duration: 0, denoise: .5 });
        } catch (err) { status.textContent = "Audio upload failed: " + err.message; }
    }
    input.onchange = () => { upload(input.files?.[0]); input.value = ""; };
    for (const event of ["dragenter", "dragover", "drop"]) {
        el.addEventListener(event, ev => {
            ev.preventDefault(); ev.stopPropagation();
            if (event === "drop") upload(ev.dataTransfer?.files?.[0]);
        });
    }
    function originFor(g, track) {
        for (let i = 0; i < g.entries.length; i++) {
            const e = g.entries[i];
            try {
                const saved = JSON.parse(e.meta?.timeline_audio || "null");
                if (saved && ["file", "start_frame", "source_start", "duration"].every(
                        key => saved.track?.[key] === track[key])) {
                    return saved.raw_start + Number(e.meta?.pinned_head_frames || 0)
                        + e.enter - g.starts[i];
                }
            } catch { /* old take */ }
        }
        return 0;
    }
    function paint() {
        if (disposed) return;
        const track = read();
        listen.disabled = remove.disabled = !track;
        for (const [key, field] of Object.entries(fields)) {
            field.disabled = !track;
            if (document.activeElement !== field) field.value = track
                ? String(key === "start_frame" ? +(track[key] / 24).toFixed(3) : track[key] ?? 0) : "";
        }
        const width = Math.max(1, canvas.clientWidth);
        canvas.width = width * (window.devicePixelRatio || 1);
        canvas.height = 48 * (window.devicePixelRatio || 1);
        const ctx = canvas.getContext("2d");
        ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
        if (!track) {
            loaded = ""; info = null; version++;
            ctx.fillStyle = "#999"; ctx.font = "11px sans-serif";
            ctx.fillText("Drop custom audio here · used for generation, extend, prepend and bridges", 10, 28);
            status.textContent = ""; return;
        }
        const key = JSON.stringify(track);
        if (loaded !== key) {
            const requestVersion = ++version;
            loaded = key;
            info = null;
            status.textContent = "Reading soundtrack…";
            const parts = track.file.split("/");
            player.src = api.apiURL("/view?" + new URLSearchParams({
                filename: parts.pop(), subfolder: parts.join("/"), type: "input" }));
            api.fetchApi("/obvpm/h3/audio_info", { method: "POST",
                headers: { "Content-Type": "application/json" }, body: key })
                .then(async response => {
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || "Cannot read audio");
                    if (requestVersion !== version || disposed) return;
                    info = data; paint();
                }).catch(err => {
                    if (requestVersion === version) status.textContent = err.message;
                });
        }
        const g = geometry(), origin = originFor(g, track), px = g.scale || 1;
        const frameAt = x => (x + strip.scrollLeft - 8) / px + origin;
        ctx.strokeStyle = "#48c6a6"; ctx.beginPath();
        if (info) for (let x = 0; x < width; x++) {
            const t = (frameAt(x) - track.start_frame) / 24 + track.source_start;
            if (t < 0 || t >= info.duration || (track.duration && t >= track.source_start + track.duration)) continue;
            const t2 = (frameAt(x + 1) - track.start_frame) / 24 + track.source_start;
            const from = Math.max(0, Math.floor(t / info.duration * info.peaks.length));
            const to = Math.min(info.peaks.length, Math.max(from + 1, Math.ceil(t2 / info.duration * info.peaks.length)));
            let peak = 0;
            for (let i = from; i < to; i++) peak = Math.max(peak, info.peaks[i]);
            const height = Math.max(1, Math.min(20, peak * 20));
            ctx.moveTo(x, 24 - height); ctx.lineTo(x, 24 + height);
        }
        ctx.stroke();
        if (g.landing) {
            const x = 8 + g.landing.start * px - strip.scrollLeft;
            ctx.fillStyle = "rgba(183,139,250,.16)";
            ctx.fillRect(x, 0, (g.landing.frames || 0) * px, 48);
        }
        ctx.fillStyle = getComputedStyle(el).color; ctx.font = "10px sans-serif";
        ctx.fillText(track.file.split("/").pop(), 8, 12);
        if (info && loaded === key) status.textContent =
            `${info.duration.toFixed(2)}s source · original audio saved · overlaps included automatically`;
    }
    canvas.onpointerdown = ev => {
        const track = read(); if (!track) return;
        ev.preventDefault(); ev.stopPropagation();
        const x = ev.clientX, scale = geometry().scale || 1;
        const zoom = canvas.getBoundingClientRect().width / canvas.clientWidth || 1;
        canvas.setPointerCapture(ev.pointerId);
        canvas.onpointerup = up => {
            canvas.onpointerup = null;
            const delta = Math.round((up.clientX - x) / zoom / scale);
            if (delta) write({ ...track, start_frame: track.start_frame + delta });
        };
    };
    const resize = new ResizeObserver(paint);
    resize.observe(canvas);
    strip.addEventListener("scroll", paint);
    return { el, paint, dispose() {
        disposed = true; version++; resize.disconnect();
        strip.removeEventListener("scroll", paint); player.pause(); player.removeAttribute("src");
    } };
}
