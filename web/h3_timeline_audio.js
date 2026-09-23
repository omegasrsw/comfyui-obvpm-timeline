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
    let cursor = 0, selectionEnd = null, raf = 0, draft = null;
    const status = document.createElement("span");
    status.style.opacity = ".8";
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.opus";
    input.hidden = true;
    button("+ audio", "Upload a soundtrack for lip-sync generation", () => input.click());
    const listen = button("▶", "Play / pause from the audio cursor", () => {
        if (!read()) return;
        if (player.paused) play();
        else player.pause();
    });
    const playSelection = button("▶ selection", "Play the selected source range from start to end", () => {
        const track = read(); if (!track || !info) return;
        const [start, end] = sourceRange(track);
        if (end <= start) return;
        seek(start);
        selectionEnd = end;
        play();
    });
    const remove = button("×", "Remove the custom soundtrack", () => {
        player.pause(); write(null);
    });
    const fields = {};
    for (const [key, label, title, step] of [
        ["start_frame", "place s", "Position on the original timeline (seconds); Shift-drag the timeline waveform to move", "any"],
        ["source_start", "source start s", "Source audio time at the placement point; prepends can use earlier audio", .01],
        ["duration", "duration s", "Source duration from the source offset; 0 uses the rest of the file", .01],
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
            if (key === "source_start" || key === "duration") {
                player.pause(); selectionEnd = null;
                if (key === "source_start") seek(track.source_start);
            }
            write(track);
        };
        field.addEventListener("keydown", ev => ev.stopPropagation());
        fields[key] = field; wrap.append(field); controls.append(wrap);
    }
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { display: "block", width: "100%", height: "48px",
        background: "rgba(0,0,0,.18)", borderRadius: "4px", cursor: "crosshair", marginTop: "4px", touchAction: "none" });
    canvas.setAttribute("aria-label", "Timeline audio waveform; click or drag to seek, Shift-drag to move track");
    const sourceRow = document.createElement("div");
    Object.assign(sourceRow.style, { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginTop: "4px" });
    const hint = document.createElement("span");
    hint.textContent = "Source · click/drag to seek · drag edges or Shift-drag to select";
    const cursorLabel = document.createElement("label");
    cursorLabel.textContent = "cursor s ";
    const cursorInput = document.createElement("input");
    cursorInput.type = "number"; cursorInput.min = "0"; cursorInput.step = ".01";
    cursorInput.style.width = "72px";
    cursorInput.setAttribute("aria-label", "Audio cursor seconds");
    cursorInput.onchange = () => { if (cursorInput.checkValidity()) seek(Number(cursorInput.value)); };
    cursorInput.addEventListener("keydown", ev => ev.stopPropagation());
    sourceRow.addEventListener("pointerdown", ev => ev.stopPropagation());
    cursorLabel.append(cursorInput); sourceRow.append(hint, cursorLabel);
    const sourceCanvas = document.createElement("canvas");
    Object.assign(sourceCanvas.style, { display: "block", width: "100%", height: "58px",
        background: "rgba(0,0,0,.18)", borderRadius: "4px", cursor: "crosshair", touchAction: "none" });
    sourceCanvas.setAttribute("aria-label", "Full source audio waveform and selected range");
    const player = document.createElement("audio");
    player.preload = "metadata";
    player.onloadedmetadata = () => { player.currentTime = Math.min(cursor, player.duration || cursor); };
    player.onplay = () => { listen.textContent = "❚❚"; cancelAnimationFrame(raf); tick(); };
    player.onpause = player.onended = () => { listen.textContent = "▶"; cancelAnimationFrame(raf); updateCursor(); };
    player.ontimeupdate = updateCursor;
    player.onseeked = () => { cursor = player.currentTime; paint(); };
    player.onerror = () => { status.textContent = "Audio preview unavailable: the browser could not decode this file."; };
    el.append(controls, canvas, sourceRow, sourceCanvas, status, input, player);
    function sourceRange(track) {
        const start = Number(track.source_start || 0);
        return [start, Math.min(info?.duration ?? Infinity,
            track.duration > 0 ? start + track.duration : Infinity)];
    }
    function seek(seconds) {
        cursor = Math.max(0, Math.min(info?.duration ?? Infinity, seconds));
        selectionEnd = null;
        if (player.readyState) player.currentTime = cursor;
        paint();
    }
    function play() {
        if (selectionEnd !== null && cursor >= selectionEnd) {
            seek(Number(read()?.source_start || 0));
            selectionEnd = sourceRange(read())[1];
        }
        if (player.readyState) player.currentTime = cursor;
        player.play().catch(err => { if (!disposed) status.textContent = err.message; });
    }
    function updateCursor() {
        if (disposed) return;
        if (selectionEnd !== null && player.currentTime >= selectionEnd) {
            const end = selectionEnd;
            selectionEnd = null;
            player.pause(); player.currentTime = end; cursor = end;
        } else cursor = player.currentTime;
        paint();
    }
    function tick() {
        updateCursor();
        if (!player.paused && !disposed) raf = requestAnimationFrame(tick);
    }
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
        const track = draft || read();
        listen.disabled = remove.disabled = !track;
        playSelection.disabled = !track || !info || sourceRange(track)[1] <= sourceRange(track)[0];
        cursorInput.disabled = !track;
        if (document.activeElement !== cursorInput) cursorInput.value = cursor.toFixed(2);
        if (info) cursorInput.max = String(info.duration);
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
            if (loaded) {
                loaded = ""; info = null; version++; selectionEnd = null;
                player.pause(); player.removeAttribute("src"); player.load(); cursor = 0;
            }
            sourceRow.style.display = sourceCanvas.style.display = "none";
            ctx.fillStyle = "#999"; ctx.font = "11px sans-serif";
            ctx.fillText("Drop custom audio here · used for generation, extend, prepend and bridges", 10, 28);
            status.textContent = ""; return;
        }
        sourceRow.style.display = "flex"; sourceCanvas.style.display = "block";
        // Placement/range edits do not change the media file. Reloading it
        // here would reset playback and decode all the peaks on every edit.
        const key = track.file;
        if (loaded !== key) {
            const requestVersion = ++version;
            loaded = key;
            info = null;
            player.pause(); selectionEnd = null; cursor = Number(track.source_start || 0);
            status.textContent = "Reading soundtrack…";
            const parts = track.file.split("/");
            player.src = api.apiURL("/view?" + new URLSearchParams({
                filename: parts.pop(), subfolder: parts.join("/"), type: "input" }));
            api.fetchApi("/obvpm/h3/audio_info", { method: "POST",
                headers: { "Content-Type": "application/json" }, body: JSON.stringify(track) })
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
        const cursorFrame = (cursor - track.source_start) * 24 + track.start_frame;
        drawCursor(ctx, 8 + (cursorFrame - origin) * px - strip.scrollLeft, 48);
        ctx.fillStyle = getComputedStyle(el).color; ctx.font = "10px sans-serif";
        ctx.fillText(track.file.split("/").pop(), 8, 12);
        if (info && loaded === key) status.textContent =
            `${info.duration.toFixed(2)}s source · selected ${sourceRange(track).map(t => t.toFixed(2)).join("–")}s · timeline: Shift-drag to move track`;
        paintSource(track);
    }
    function drawCursor(ctx, x, height) {
        ctx.strokeStyle = "#ffcf66"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
        ctx.fillStyle = "#ffcf66";
        ctx.beginPath(); ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 6); ctx.fill();
    }
    function paintSource(track) {
        const width = Math.max(1, sourceCanvas.clientWidth), dpr = window.devicePixelRatio || 1;
        sourceCanvas.width = width * dpr; sourceCanvas.height = 58 * dpr;
        const ctx = sourceCanvas.getContext("2d"); ctx.scale(dpr, dpr);
        if (!info?.duration) return;
        const xAt = t => 8 + t / info.duration * (width - 16);
        const [start, end] = sourceRange(track);
        const left = xAt(Math.min(info.duration, start)), right = xAt(end);
        ctx.fillStyle = "rgba(72,198,166,.2)"; ctx.fillRect(left, 0, right - left, 58);
        ctx.strokeStyle = "#48c6a6"; ctx.beginPath();
        for (let x = 8; x < width - 8; x++) {
            const from = Math.floor((x - 8) / (width - 16) * info.peaks.length);
            const to = Math.min(info.peaks.length, Math.max(from + 1,
                Math.ceil((x - 7) / (width - 16) * info.peaks.length)));
            let peak = 0;
            for (let i = from; i < to; i++) peak = Math.max(peak, info.peaks[i]);
            const h = Math.max(1, peak * 15); ctx.moveTo(x, 32 - h); ctx.lineTo(x, 32 + h);
        }
        ctx.stroke();
        ctx.fillStyle = "#48c6a6";
        for (const x of [left, right]) { ctx.fillRect(x - 2, 0, 4, 58); ctx.fillRect(x - 5, 20, 10, 20); }
        drawCursor(ctx, xAt(cursor), 58);
        ctx.fillStyle = getComputedStyle(el).color; ctx.font = "10px sans-serif";
        ctx.fillText("0s", 10, 11); ctx.textAlign = "right";
        ctx.fillText(`${info.duration.toFixed(2)}s`, width - 10, 11);
    }
    function localX(surface, ev) {
        const rect = surface.getBoundingClientRect();
        return (ev.clientX - rect.left) * surface.clientWidth / rect.width;
    }
    function drag(surface, ev, move, finish = () => {}) {
        ev.preventDefault(); ev.stopPropagation();
        surface.setPointerCapture(ev.pointerId);
        surface.onpointermove = e => { e.stopPropagation(); move(e); };
        const end = (e, cancelled) => {
            e.stopPropagation();
            surface.onpointermove = surface.onpointerup = surface.onpointercancel = surface.onlostpointercapture = null;
            if (!cancelled) move(e);
            finish(cancelled);
            if (surface.hasPointerCapture(e.pointerId)) surface.releasePointerCapture(e.pointerId);
        };
        surface.onpointerup = e => end(e, false);
        surface.onpointercancel = surface.onlostpointercapture = e => end(e, true);
    }
    canvas.onpointerdown = ev => {
        const track = read(); if (!track || ev.button !== 0) return;
        const g = geometry(), x = localX(canvas, ev), scale = g.scale || 1;
        if (ev.shiftKey) {
            drag(canvas, ev, e => {
                draft = { ...track, start_frame: track.start_frame + Math.round((localX(canvas, e) - x) / scale) };
                paint();
            }, cancelled => {
                const next = draft; draft = null;
                if (!cancelled && next) write(next); else paint();
            });
        } else {
            const move = e => seek(((localX(canvas, e) + strip.scrollLeft - 8) / scale
                + originFor(g, track) - track.start_frame) / 24 + track.source_start);
            move(ev); drag(canvas, ev, move);
        }
    };
    sourceCanvas.onpointerdown = ev => {
        const track = read(); if (!track || !info?.duration || ev.button !== 0) return;
        const width = sourceCanvas.clientWidth - 16;
        const time = e => Math.max(0, Math.min(info.duration, (localX(sourceCanvas, e) - 8) / width * info.duration));
        const [start, end] = sourceRange(track), x = localX(sourceCanvas, ev);
        const startX = 8 + Math.min(start, info.duration) / info.duration * width;
        const endX = 8 + end / info.duration * width;
        const edge = Math.min(Math.abs(x - startX), Math.abs(x - endX)) <= 8
            ? (Math.abs(x - startX) < Math.abs(x - endX) ? "start" : "end") : null;
        if (edge || ev.shiftKey) {
            player.pause(); selectionEnd = null;
            const anchor = time(ev);
            drag(sourceCanvas, ev, e => {
                const t = time(e);
                const a = ev.shiftKey ? Math.min(anchor, t) : edge === "start" ? Math.min(t, end - .01) : start;
                const b = ev.shiftKey ? Math.max(anchor, t) : edge === "end" ? Math.max(t, start + .01) : end;
                if (b <= a || a < 0 || b > info.duration) return;
                draft = { ...track, source_start: a, duration: b - a }; paint();
            }, cancelled => {
                const next = draft; draft = null;
                if (!cancelled && next) { seek(next.source_start); write(next); } else paint();
            });
        } else {
            const move = e => seek(time(e));
            move(ev); drag(sourceCanvas, ev, move);
        }
    };
    const resize = new ResizeObserver(paint);
    resize.observe(canvas);
    strip.addEventListener("scroll", paint);
    return { el, paint, dispose() {
        disposed = true; version++; resize.disconnect(); cancelAnimationFrame(raf);
        strip.removeEventListener("scroll", paint); player.pause(); player.removeAttribute("src");
    } };
}
