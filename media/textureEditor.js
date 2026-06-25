(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    let textures = [];
    let currentTexture = null;
    let selectedPatchId = null;
    let highlightedPatchId = null;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let background = 'checkered';
    let canvasW = 0;
    let canvasH = 0;

    let dragging = false;
    let panning = false;
    let dragPatchId = null;
    let dragStartMouseX = 0;
    let dragStartMouseY = 0;
    let dragStartPatchX = 0;
    let dragStartPatchY = 0;
    let dragCurrentX = 0;
    let dragCurrentY = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;

    const resourceCache = new Map();

    const viewport = document.getElementById('viewport');
    const baseCanvas = document.getElementById('baseCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');
    const baseCtx = baseCanvas.getContext('2d');
    const overlayCtx = overlayCanvas.getContext('2d');
    const toolbar = document.getElementById('toolbar');
    const textureList = document.getElementById('texture-list');
    const infoBar = document.getElementById('info-bar');

    function resizeCanvases() {
        const rect = viewport.getBoundingClientRect();
        const w = rect.width * devicePixelRatio;
        const h = rect.height * devicePixelRatio;
        for (const c of [baseCanvas, overlayCanvas]) {
            if (c.width !== w || c.height !== h) {
                c.width = w;
                c.height = h;
            }
        }
        canvasW = rect.width;
        canvasH = rect.height;
    }

    function getOrigin() {
        return { x: canvasW / 2 + panX, y: canvasH / 2 + panY };
    }

    function renderBase() {
        resizeCanvases();
        baseCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        drawBackground(baseCtx);
        if (!currentTexture) { return; }

        const origin = getOrigin();
        const tw = currentTexture.width * zoom;
        const th = currentTexture.height * zoom;
        baseCtx.strokeStyle = 'rgba(255,255,255,0.3)';
        baseCtx.lineWidth = 1;
        baseCtx.setLineDash([4, 4]);
        baseCtx.strokeRect(origin.x, origin.y, tw, th);
        baseCtx.setLineDash([]);

        for (const patch of currentTexture.patches) {
            drawPatch(baseCtx, patch, origin);
        }
        updateInfoBar();
    }

    function renderOverlay() {
        overlayCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        overlayCtx.clearRect(0, 0, canvasW, canvasH);
        if (!currentTexture) { return; }

        const origin = getOrigin();

        for (const patch of currentTexture.patches) {
            const isSelected = patch.id === selectedPatchId;
            const isHighlighted = patch.id === highlightedPatchId;
            if (!isSelected && !isHighlighted) { continue; }

            const px = patch.id === dragPatchId ? dragCurrentX : patch.x;
            const py = patch.id === dragPatchId ? dragCurrentY : patch.y;
            const res = resourceCache.get(patch.resourceId);
            const { w: rpw, h: rph } = getResourceDimensions(res);
            const pw = rpw * zoom;
            const ph = rph * zoom;

            overlayCtx.strokeStyle = isSelected ? 'rgba(0, 150, 255, 0.9)' : 'rgba(255, 200, 0, 0.7)';
            overlayCtx.lineWidth = isSelected ? 2 : 1;
            overlayCtx.setLineDash(isSelected ? [] : [3, 3]);
            overlayCtx.strokeRect(origin.x + px * zoom, origin.y + py * zoom, pw, ph);
            overlayCtx.setLineDash([]);
        }

        if (dragging && dragPatchId) {
            const patch = currentTexture.patches.find(p => p.id === dragPatchId);
            if (patch) {
                drawPatch(overlayCtx, { ...patch, x: dragCurrentX, y: dragCurrentY }, getOrigin());
            }
        }
    }

    function drawPatch(ctx, patch, origin) {
        const res = resourceCache.get(patch.resourceId);
        const sx = origin.x + patch.x * zoom;
        const sy = origin.y + patch.y * zoom;

        if (!res || res.state === 'loading') { return; }

        if (res.state === 'missing') {
            const pw = 32 * zoom;
            const ph = 32 * zoom;
            ctx.strokeStyle = 'rgba(255, 60, 60, 0.8)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(sx, sy, pw, ph);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(255, 60, 60, 0.6)';
            ctx.font = `${Math.max(9, 11 * zoom)}px monospace`;
            ctx.fillText('Missing:', sx + 2, sy + 12 * zoom);
            ctx.fillText(patch.name, sx + 2, sy + 24 * zoom);
            return;
        }

        if (res.state === 'definition') {
            const pw = res.width * zoom;
            const ph = res.height * zoom;
            ctx.strokeStyle = 'rgba(80, 160, 255, 0.8)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(sx, sy, pw, ph);
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(80, 160, 255, 0.15)';
            ctx.fillRect(sx, sy, pw, ph);
            ctx.fillStyle = 'rgba(80, 160, 255, 0.8)';
            ctx.font = `${Math.max(9, 11 * zoom)}px monospace`;
            ctx.fillText(patch.name, sx + 2, sy + 12 * zoom);
            ctx.fillText(`${res.width}\u00d7${res.height}`, sx + 2, sy + 24 * zoom);
            return;
        }

        const bmp = res.bitmap;
        const pw = bmp.width * zoom;
        const ph = bmp.height * zoom;

        ctx.save();
        ctx.translate(sx + pw / 2, sy + ph / 2);
        const rot = (patch.props?.Rotate ?? 0) * Math.PI / 180;
        if (rot) { ctx.rotate(rot); }
        const flipX = patch.props?.FlipX ? -1 : 1;
        const flipY = patch.props?.FlipY ? -1 : 1;
        if (flipX === -1 || flipY === -1) { ctx.scale(flipX, flipY); }
        ctx.globalAlpha = patch.props?.Alpha ?? 1;
        ctx.imageSmoothingEnabled = zoom < 1;
        ctx.drawImage(bmp, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
    }

    function drawBackground(ctx) {
        if (background === 'dark') {
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, canvasW, canvasH);
        } else if (background === 'light') {
            ctx.fillStyle = '#c0c0c0';
            ctx.fillRect(0, 0, canvasW, canvasH);
        } else {
            const size = 8;
            for (let y = 0; y < canvasH; y += size) {
                for (let x = 0; x < canvasW; x += size) {
                    ctx.fillStyle = ((Math.floor(x / size) + Math.floor(y / size)) % 2) === 0 ? '#3c3c3c' : '#2c2c2c';
                    ctx.fillRect(x, y, size, size);
                }
            }
        }
    }

    function getResourceDimensions(res) {
        if (res && (res.state === 'ready' || res.state === 'definition')) {
            return { w: res.width, h: res.height };
        }
        return { w: 32, h: 32 };
    }

    function hitTest(mouseX, mouseY) {
        if (!currentTexture) { return null; }
        const origin = getOrigin();
        for (let i = currentTexture.patches.length - 1; i >= 0; i--) {
            const p = currentTexture.patches[i];
            const res = resourceCache.get(p.resourceId);
            const { w: pw, h: ph } = getResourceDimensions(res);
            const sx = origin.x + p.x * zoom;
            const sy = origin.y + p.y * zoom;
            if (mouseX >= sx && mouseX <= sx + pw * zoom &&
                mouseY >= sy && mouseY <= sy + ph * zoom) {
                return p;
            }
        }
        return null;
    }

    function ensureResources() {
        if (!currentTexture) { return; }
        for (const patch of currentTexture.patches) {
            if (!resourceCache.has(patch.resourceId)) {
                resourceCache.set(patch.resourceId, { state: 'loading' });
                vscode.postMessage({ type: 'resolveResource', resourceId: patch.resourceId });
            }
        }
    }

    function retainResources() {
        if (!currentTexture) { return; }
        const used = new Set(currentTexture.patches.map(p => p.resourceId));
        for (const [key, val] of resourceCache.entries()) {
            if (!used.has(key)) {
                if (val.state === 'ready' && val.bitmap) { val.bitmap.close(); }
                resourceCache.delete(key);
            }
        }
    }

    function fitZoom() {
        if (!currentTexture || !canvasW || !canvasH) { return; }
        const margin = 60;
        zoom = Math.min(
            (canvasW - margin) / currentTexture.width,
            (canvasH - margin) / currentTexture.height,
            8
        );
        zoom = Math.max(zoom, 0.1);
        panX = 0;
        panY = 0;
    }

    function buildTextureList() {
        textureList.innerHTML = '';
        for (const name of textures) {
            const el = document.createElement('div');
            el.className = 'item' + (currentTexture && currentTexture.name === name ? ' selected' : '');
            el.textContent = name;
            el.addEventListener('click', () => {
                vscode.postMessage({ type: 'selectTexture', name });
            });
            textureList.appendChild(el);
        }
    }

    function buildToolbar() {
        toolbar.innerHTML = '';
        const bgLabels = { checkered: 'BG: Check', dark: 'BG: Dark', light: 'BG: Light' };
        const bgBtn = makeBtn(bgLabels[background] || 'BG: Check', () => {
            const order = ['checkered', 'dark', 'light'];
            background = order[(order.indexOf(background) + 1) % order.length];
            buildToolbar();
            renderBase();
        });
        const fitBtn = makeBtn('Fit', () => { fitZoom(); renderBase(); renderOverlay(); });
        const oneBtn = makeBtn('1:1', () => { zoom = 1; panX = 0; panY = 0; renderBase(); renderOverlay(); });
        toolbar.appendChild(bgBtn);
        toolbar.appendChild(fitBtn);
        toolbar.appendChild(oneBtn);
    }

    function makeBtn(text, onclick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.addEventListener('click', onclick);
        return b;
    }

    function updateInfoBar() {
        if (!currentTexture) { infoBar.innerHTML = ''; return; }
        let patchInfo = '';
        if (selectedPatchId) {
            const p = currentTexture.patches.find(p => p.id === selectedPatchId);
            if (p) {
                const res = resourceCache.get(p.resourceId);
                const w = res?.state === 'ready' ? res.width : '?';
                const h = res?.state === 'ready' ? res.height : '?';
                patchInfo = `<span><span class="label">Patch:</span> ${p.name} (${p.x}, ${p.y}) ${w}\u00d7${h}</span>`;
            }
        }
        infoBar.innerHTML =
            `<span><span class="label">Texture:</span> ${currentTexture.name} ${currentTexture.width}\u00d7${currentTexture.height}</span>` +
            `<span><span class="label">Zoom:</span> ${Math.round(zoom * 100)}%</span>` +
            patchInfo;
    }

    viewport.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
            panning = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            viewport.classList.add('dragging');
            e.preventDefault();
        } else if (e.button === 0) {
            const rect = viewport.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const hit = hitTest(mx, my);
            if (hit) {
                selectedPatchId = hit.id;
                dragging = true;
                dragPatchId = hit.id;
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                dragStartPatchX = hit.x;
                dragStartPatchY = hit.y;
                dragCurrentX = hit.x;
                dragCurrentY = hit.y;
                viewport.classList.add('dragging');
                vscode.postMessage({ type: 'selectPatch', patchId: hit.id });
            } else {
                selectedPatchId = null;
            }
            renderOverlay();
            updateInfoBar();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (panning) {
            panX += e.clientX - lastMouseX;
            panY += e.clientY - lastMouseY;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            renderBase();
            renderOverlay();
        } else if (dragging && dragPatchId) {
            const dx = e.clientX - dragStartMouseX;
            const dy = e.clientY - dragStartMouseY;
            dragCurrentX = Math.round(dragStartPatchX + dx / zoom);
            dragCurrentY = Math.round(dragStartPatchY + dy / zoom);
            renderOverlay();
        }
    });

    window.addEventListener('mouseup', () => {
        if (dragging && dragPatchId && currentTexture) {
            if (dragCurrentX !== dragStartPatchX || dragCurrentY !== dragStartPatchY) {
                vscode.postMessage({
                    type: 'movePatch',
                    patchId: dragPatchId,
                    x: dragCurrentX,
                    y: dragCurrentY,
                    modelVersion: currentTexture.revision
                });
            }
        }
        dragging = false;
        panning = false;
        dragPatchId = null;
        viewport.classList.remove('dragging');
    });

    viewport.addEventListener('dblclick', (e) => {
        const rect = viewport.getBoundingClientRect();
        const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) {
            vscode.postMessage({ type: 'revealSource', patchId: hit.id });
        }
    });

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldZoom = zoom;
        zoom *= e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoom = Math.min(Math.max(zoom, 0.1), 64);
        const origin = getOrigin();
        panX += (mx - origin.x) * (1 - zoom / oldZoom);
        panY += (my - origin.y) * (1 - zoom / oldZoom);
        renderBase();
        renderOverlay();
    }, { passive: false });

    window.addEventListener('resize', () => { renderBase(); renderOverlay(); });

    window.addEventListener('message', (e) => {
        const msg = e.data;
        switch (msg.type) {
            case 'init':
                textures = msg.textures;
                currentTexture = msg.selected;
                selectedPatchId = null;
                buildTextureList();
                buildToolbar();
                ensureResources();
                fitZoom();
                renderBase();
                renderOverlay();
                break;
            case 'updateTexture':
                currentTexture = msg.texture;
                buildTextureList();
                ensureResources();
                retainResources();
                renderBase();
                renderOverlay();
                break;
            case 'updateList':
                textures = msg.textures;
                buildTextureList();
                break;
            case 'resourceResolved':
                handleResourceResolved(msg);
                break;
            case 'highlightPatch':
                highlightedPatchId = msg.patchId;
                renderOverlay();
                break;
        }
    });

    async function handleResourceResolved(msg) {
        if (msg.resourceType === 'composite' && msg.subPatches && msg.subPatches.length > 0) {
            try {
                const bitmap = await compositePatches(msg.width, msg.height, msg.subPatches);
                resourceCache.set(msg.resourceId, {
                    state: 'ready',
                    bitmap,
                    width: msg.width,
                    height: msg.height
                });
            } catch {
                resourceCache.set(msg.resourceId, {
                    state: 'definition',
                    width: msg.width || 32,
                    height: msg.height || 32
                });
            }
        } else if (msg.resourceType === 'composite') {
            resourceCache.set(msg.resourceId, {
                state: 'definition',
                width: msg.width || 32,
                height: msg.height || 32
            });
        } else if (msg.uri) {
            try {
                const resp = await fetch(msg.uri);
                const blob = await resp.blob();
                const bitmap = await createImageBitmap(blob);
                resourceCache.set(msg.resourceId, {
                    state: 'ready',
                    bitmap,
                    width: bitmap.width,
                    height: bitmap.height
                });
            } catch {
                resourceCache.set(msg.resourceId, { state: 'missing' });
            }
        } else {
            resourceCache.set(msg.resourceId, { state: 'missing' });
        }
        renderBase();
        renderOverlay();
    }

    async function compositePatches(width, height, subPatches) {
        const offscreen = new OffscreenCanvas(width, height);
        const octx = offscreen.getContext('2d');
        for (const sp of subPatches) {
            if (!sp.uri) { continue; }
            const resp = await fetch(sp.uri);
            const blob = await resp.blob();
            const bmp = await createImageBitmap(blob);
            const pw = bmp.width;
            const ph = bmp.height;
            octx.save();
            octx.translate(sp.x + pw / 2, sp.y + ph / 2);
            if (sp.rotate) { octx.rotate(sp.rotate * Math.PI / 180); }
            if (sp.flipX || sp.flipY) { octx.scale(sp.flipX ? -1 : 1, sp.flipY ? -1 : 1); }
            octx.globalAlpha = sp.alpha ?? 1;
            octx.drawImage(bmp, -pw / 2, -ph / 2, pw, ph);
            octx.restore();
            bmp.close();
        }
        return offscreen.transferToImageBitmap();
    }

    vscode.postMessage({ type: 'ready' });
})();
