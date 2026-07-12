(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // Weapon HUD: 320×200 screen. Weapon layer Offset(x,y) with default (0, 32).
    // Sprite screen position (ZDoom PSprite-style):
    //   drawX = 160 + offsetX - grabX
    //   drawY = offsetY - grabY
    const HUD_W = 320;
    const HUD_H = 200;
    const HUD_STATUS_BAR_Y = 168;
    const CENTER_X = 160;

    let zoom = 2;
    let panX = 0;
    let panY = 0;
    let background = 'dark';
    let viewData = null;
    let activeIndex = 0;
    let img = null;
    let imgUri = null;
    let imgLoaded = false;

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const toolbar = document.getElementById('toolbar');
    const status = document.getElementById('status');
    const scrub = document.getElementById('scrub');

    let panning = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let canvasW = 0;
    let canvasH = 0;
    let renderQueued = false;

    function el(id) {
        return document.getElementById(id);
    }

    function createButton(text, onclick) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.addEventListener('click', onclick);
        return btn;
    }

    function createSeparator() {
        const s = document.createElement('span');
        s.className = 'sep';
        return s;
    }

    function buildToolbar() {
        toolbar.innerHTML = '';
        const bgLabels = { checkered: 'BG: Check', dark: 'BG: Dark', light: 'BG: Light' };
        toolbar.appendChild(createButton(bgLabels[background] || 'BG', () => {
            const order = ['dark', 'checkered', 'light'];
            background = order[(order.indexOf(background) + 1) % order.length];
            buildToolbar();
            render();
        }));
        toolbar.appendChild(createSeparator());
        toolbar.appendChild(createButton('Fit', () => { fitZoom(); render(); }));
        toolbar.appendChild(createButton('1:1', () => { zoom = 1; panX = 0; panY = 0; render(); }));
        toolbar.appendChild(createButton('2×', () => { zoom = 2; panX = 0; panY = 0; render(); }));
    }

    function fitZoom() {
        const margin = 40;
        zoom = Math.max(0.25, Math.min(
            (canvasW - margin) / HUD_W,
            (canvasH - margin) / HUD_H,
            8
        ));
        panX = 0;
        panY = 0;
    }

    function hudOrigin() {
        return {
            x: canvasW / 2 - (HUD_W * zoom) / 2 + panX,
            y: canvasH / 2 - (HUD_H * zoom) / 2 + panY
        };
    }

    function activeFrame() {
        if (!viewData || !viewData.frames || viewData.frames.length === 0) {
            return null;
        }
        const i = Math.max(0, Math.min(activeIndex, viewData.frames.length - 1));
        return viewData.frames[i];
    }

    function ensureImage(uri) {
        if (!uri) {
            img = null;
            imgUri = null;
            imgLoaded = false;
            return;
        }
        if (uri === imgUri && img) {
            return;
        }
        imgUri = uri;
        imgLoaded = false;
        img = new Image();
        img.onload = () => {
            imgLoaded = true;
            queueRender();
        };
        img.onerror = () => {
            imgLoaded = false;
            queueRender();
        };
        img.src = uri;
    }

    function updateInspector(frame) {
        if (!frame) {
            el('info-label').textContent = viewData?.label || '—';
            el('info-sprite').textContent = '—';
            el('info-frame').textContent = '—';
            el('info-duration').textContent = '—';
            el('info-line').textContent = '—';
            el('info-ox').textContent = '—';
            el('info-oy').textContent = '—';
            el('info-declared').textContent = '—';
            el('info-grab').textContent = '—';
            el('info-seq').textContent = '—';
            status.textContent = 'No Offset frame selected';
            return;
        }

        el('info-label').textContent = viewData.label || '—';
        el('info-sprite').textContent = frame.sprite;
        el('info-frame').textContent = frame.frame;
        el('info-duration').textContent = String(frame.duration);
        el('info-line').textContent = String(frame.line + 1);
        el('info-ox').textContent = String(frame.offsetX);
        el('info-oy').textContent = String(frame.offsetY);

        if (frame.offsetIsKeep) {
            el('info-declared').textContent = 'Offset(0, 0) keep';
        } else if (frame.declaredOffsetX !== null && frame.declaredOffsetY !== null) {
            el('info-declared').textContent = `Offset(${frame.declaredOffsetX}, ${frame.declaredOffsetY})`;
        } else {
            el('info-declared').textContent = '(inherited)';
        }

        el('info-grab').textContent = frame.hasGrab
            ? `(${frame.grabX}, ${frame.grabY})`
            : '(none → 0, 0)';

        el('info-seq').textContent = `${activeIndex + 1} / ${viewData.frames.length}`;

        if (frame.missingResource) {
            status.textContent = `Missing sprite resource for ${frame.sprite}${frame.frame}*`;
        } else {
            status.textContent = `${frame.sprite} ${frame.frame}  Offset(${frame.offsetX}, ${frame.offsetY})`;
        }
    }

    function drawBackground() {
        if (background === 'light') {
            ctx.fillStyle = '#d0d0d0';
            ctx.fillRect(0, 0, canvasW, canvasH);
        } else if (background === 'dark') {
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, canvasW, canvasH);
        } else {
            const size = 8;
            for (let y = 0; y < canvasH; y += size) {
                for (let x = 0; x < canvasW; x += size) {
                    const on = ((x / size) + (y / size)) % 2 === 0;
                    ctx.fillStyle = on ? '#3a3a3a' : '#2a2a2a';
                    ctx.fillRect(x, y, size, size);
                }
            }
        }
    }

    function drawHudFrame(origin) {
        const w = HUD_W * zoom;
        const h = HUD_H * zoom;
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 180, 255, 0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(origin.x, origin.y, w, h);
        ctx.setLineDash([]);

        // Status bar guide at y=168
        const statusY = origin.y + HUD_STATUS_BAR_Y * zoom;
        ctx.strokeStyle = 'rgba(120, 160, 220, 0.55)';
        ctx.beginPath();
        ctx.moveTo(origin.x, statusY);
        ctx.lineTo(origin.x + w, statusY);
        ctx.stroke();

        // Center vertical + weapon rest Y=32
        const cx = origin.x + CENTER_X * zoom;
        const restY = origin.y + 32 * zoom;
        ctx.strokeStyle = 'rgba(255, 200, 80, 0.45)';
        ctx.beginPath();
        ctx.moveTo(cx, origin.y);
        ctx.lineTo(cx, origin.y + h);
        ctx.moveTo(origin.x, restY);
        ctx.lineTo(origin.x + w, restY);
        ctx.stroke();

        // Crosshair at (160, 32) — default weapon attach
        ctx.strokeStyle = 'rgba(255, 220, 100, 0.9)';
        ctx.beginPath();
        ctx.moveTo(cx - 6, restY);
        ctx.lineTo(cx + 6, restY);
        ctx.moveTo(cx, restY - 6);
        ctx.lineTo(cx, restY + 6);
        ctx.stroke();
        ctx.restore();
    }

    function drawSprite(origin, frame) {
        if (!img || !imgLoaded || frame.missingResource) {
            return;
        }
        // ZDoom weapon PSprite placement on 320×200:
        //   screenX = 160 + offsetX - grabX
        //   screenY = offsetY - grabY
        const drawX = origin.x + (CENTER_X + frame.offsetX - frame.grabX) * zoom;
        const drawY = origin.y + (frame.offsetY - frame.grabY) * zoom;
        const w = img.naturalWidth * zoom;
        const h = img.naturalHeight * zoom;

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, drawX, drawY, w, h);

        // Origin marker on sprite (grab point → HUD attach)
        const ox = origin.x + (CENTER_X + frame.offsetX) * zoom;
        const oy = origin.y + frame.offsetY * zoom;
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ox - 5, oy);
        ctx.lineTo(ox + 5, oy);
        ctx.moveTo(ox, oy - 5);
        ctx.lineTo(ox, oy + 5);
        ctx.stroke();
    }

    function render() {
        renderQueued = false;
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvasW = Math.max(1, Math.floor(rect.width));
        canvasH = Math.max(1, Math.floor(rect.height));
        canvas.width = Math.floor(canvasW * dpr);
        canvas.height = Math.floor(canvasH * dpr);
        canvas.style.width = canvasW + 'px';
        canvas.style.height = canvasH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        drawBackground();
        const origin = hudOrigin();
        drawHudFrame(origin);

        const frame = activeFrame();
        updateInspector(frame);
        if (frame) {
            drawSprite(origin, frame);
        }
    }

    function queueRender() {
        if (renderQueued) {
            return;
        }
        renderQueued = true;
        requestAnimationFrame(render);
    }

    function applyView(data) {
        viewData = data;
        activeIndex = data.activeIndex || 0;
        scrub.min = '0';
        scrub.max = String(Math.max(0, (data.frames?.length || 1) - 1));
        scrub.value = String(activeIndex);

        const frame = activeFrame();
        ensureImage(frame?.imageUri || null);
        queueRender();
    }

    function setScrub(index) {
        if (!viewData || !viewData.frames.length) {
            return;
        }
        activeIndex = Math.max(0, Math.min(index, viewData.frames.length - 1));
        scrub.value = String(activeIndex);
        const frame = activeFrame();
        ensureImage(frame?.imageUri || null);
        vscode.postMessage({ type: 'scrub', index: activeIndex });
        queueRender();
    }

    scrub.addEventListener('input', () => {
        setScrub(parseInt(scrub.value, 10) || 0);
    });

    el('btn-prev').addEventListener('click', () => setScrub(activeIndex - 1));
    el('btn-next').addEventListener('click', () => setScrub(activeIndex + 1));
    el('btn-reveal').addEventListener('click', () => {
        vscode.postMessage({ type: 'reveal' });
    });

    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || e.button === 0 && (e.ctrlKey || e.metaKey)) {
            panning = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            e.preventDefault();
        }
    });
    window.addEventListener('mousemove', (e) => {
        if (!panning) {
            return;
        }
        panX += e.clientX - lastMouseX;
        panY += e.clientY - lastMouseY;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        queueRender();
    });
    window.addEventListener('mouseup', () => {
        panning = false;
    });
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoom = Math.max(0.25, Math.min(16, zoom * factor));
        queueRender();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            setScrub(activeIndex - 1);
            e.preventDefault();
        } else if (e.key === 'ArrowRight') {
            setScrub(activeIndex + 1);
            e.preventDefault();
        }
    });

    window.addEventListener('resize', () => queueRender());
    new ResizeObserver(() => queueRender()).observe(canvas.parentElement);

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'update') {
            applyView(msg.data);
        }
    });

    buildToolbar();
    fitZoom();
    vscode.postMessage({ type: 'ready' });
})();
