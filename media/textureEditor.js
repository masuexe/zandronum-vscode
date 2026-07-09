(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // HUD screen reference (SLADE Offset Type = HUD):
    // - 320×200 border is centered in the viewport
    // - texture Offset is from the screen top-left (Doom: +x left, +y up)
    // - crosshair at geometric screen center; status-bar guide at y=168
    const HUD_REF_W = 320;
    const HUD_REF_H = 200;
    const HUD_STATUS_BAR_Y = 168;

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
    let applyScale = false;
    let showOutside = true;
    let offsetType = 'none'; // none | sprite | hud

    let dragging = false;
    let panning = false;
    let draggingOffset = false;
    let dragPatchId = null;
    let dragStartMouseX = 0;
    let dragStartMouseY = 0;
    let dragStartPatchX = 0;
    let dragStartPatchY = 0;
    let dragCurrentX = 0;
    let dragCurrentY = 0;
    let dragStartOffsetX = 0;
    let dragStartOffsetY = 0;
    let dragCurrentOffsetX = 0;
    let dragCurrentOffsetY = 0;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let suppressInspectorEvents = false;

    const resourceCache = new Map();
    /** PLAYPAL as [{r,g,b}, ...] length 256, or null if unavailable. */
    let playpal = null;
    /** Cache: `${resourceId}::${translation}` → ImageBitmap */
    const translatedCache = new Map();

    const viewport = document.getElementById('viewport');
    const baseCanvas = document.getElementById('baseCanvas');
    const overlayCanvas = document.getElementById('overlayCanvas');
    const baseCtx = baseCanvas.getContext('2d');
    const overlayCtx = overlayCanvas.getContext('2d');
    const toolbar = document.getElementById('toolbar');
    const textureList = document.getElementById('texture-list');
    const patchList = document.getElementById('patch-list');
    const infoBar = document.getElementById('info-bar');

    function getProp(props, name, defaultValue) {
        if (!props) { return defaultValue; }
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(props)) {
            if (k.toLowerCase() === lower) { return v; }
        }
        return defaultValue;
    }

    function clampByte(n) {
        return Math.max(0, Math.min(255, n | 0));
    }

    /** Parse TEXTURES Translation remap ranges from a raw property value. */
    function parseTranslationRanges(raw) {
        const ranges = [];
        if (!raw) { return ranges; }
        const quoted = [...String(raw).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const parts = quoted.length > 0 ? quoted : [String(raw)];
        const rangeRe = /(\d+)\s*:\s*(\d+)\s*=\s*(\d+)\s*:\s*(\d+)/g;
        for (const part of parts) {
            if (/^(Inverse|Gold|Red|Green|Ice|Desaturate)\b/i.test(part.trim())) { continue; }
            rangeRe.lastIndex = 0;
            let m;
            while ((m = rangeRe.exec(part)) !== null) {
                ranges.push({
                    fromStart: clampByte(parseInt(m[1], 10)),
                    fromEnd: clampByte(parseInt(m[2], 10)),
                    toStart: clampByte(parseInt(m[3], 10)),
                    toEnd: clampByte(parseInt(m[4], 10))
                });
            }
        }
        return ranges;
    }

    function buildRemapTable(ranges) {
        const table = new Uint8Array(256);
        for (let i = 0; i < 256; i++) { table[i] = i; }
        for (const r of ranges) {
            const fromLo = Math.min(r.fromStart, r.fromEnd);
            const fromHi = Math.max(r.fromStart, r.fromEnd);
            const fromSpan = fromHi - fromLo;
            const toSpan = r.toEnd - r.toStart;
            for (let i = fromLo; i <= fromHi; i++) {
                if (fromSpan === 0) {
                    table[i] = r.toStart;
                } else {
                    const t = (i - fromLo) / fromSpan;
                    table[i] = clampByte(Math.round(r.toStart + t * toSpan));
                }
            }
        }
        return table;
    }

    function nearestPaletteIndex(r, g, b) {
        if (!playpal) { return 0; }
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < playpal.length; i++) {
            const dr = r - playpal[i].r;
            const dg = g - playpal[i].g;
            const db = b - playpal[i].b;
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
                if (dist === 0) { break; }
            }
        }
        return best;
    }

    /**
     * Apply palette Translation remap to an ImageBitmap.
     * Returns a new ImageBitmap, or the original if remap cannot be applied.
     */
    async function applyTranslationToBitmap(bitmap, translation) {
        if (!translation || !playpal || !bitmap) { return bitmap; }
        const ranges = parseTranslationRanges(translation);
        if (ranges.length === 0) { return bitmap; }
        const table = buildRemapTable(ranges);

        const w = bitmap.width;
        const h = bitmap.height;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, w, h);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) { continue; }
            const srcIdx = nearestPaletteIndex(data[i], data[i + 1], data[i + 2]);
            const dstIdx = table[srcIdx];
            if (dstIdx === srcIdx) { continue; }
            const c = playpal[dstIdx];
            data[i] = c.r;
            data[i + 1] = c.g;
            data[i + 2] = c.b;
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas.transferToImageBitmap();
    }

    async function getTranslatedBitmap(resourceId, bitmap, translation) {
        if (!translation || !playpal) { return bitmap; }
        const key = resourceId + '::' + translation;
        if (translatedCache.has(key)) {
            return translatedCache.get(key);
        }
        const translated = await applyTranslationToBitmap(bitmap, translation);
        translatedCache.set(key, translated);
        return translated;
    }

    function clearTranslatedCache() {
        for (const bmp of translatedCache.values()) {
            if (bmp && bmp.close) { bmp.close(); }
        }
        translatedCache.clear();
    }

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

    function getDisplaySize() {
        if (!currentTexture) { return { w: 0, h: 0 }; }
        let w = currentTexture.width;
        let h = currentTexture.height;
        if (applyScale) {
            const xs = currentTexture.xScale || 1;
            const ys = currentTexture.yScale || 1;
            w = w / xs;
            h = h / ys;
        }
        return { w, h };
    }

    /** Viewport center in canvas CSS pixels (pan applied). */
    function getViewportCenter() {
        return { x: canvasW / 2 + panX, y: canvasH / 2 + panY };
    }

    /**
     * Top-left of the texture canvas in screen space.
     * - Sprite/None: Offset relative to viewport center (sprite origin)
     * - HUD: Offset from the centered 320×200 screen top-left (SLADE)
     */
    function getOrigin() {
        const ox = currentTexture ? (draggingOffset ? dragCurrentOffsetX : currentTexture.offsetX) : 0;
        const oy = currentTexture ? (draggingOffset ? dragCurrentOffsetY : currentTexture.offsetY) : 0;
        const center = getViewportCenter();
        if (offsetType === 'hud') {
            const frame = getHudFrameRect();
            // Doom offset: positive moves graphic left/up → screen = origin - offset
            return {
                x: frame.x - ox * zoom,
                y: frame.y - oy * zoom
            };
        }
        return {
            x: center.x - ox * zoom,
            y: center.y - oy * zoom
        };
    }

    function renderBase() {
        resizeCanvases();
        baseCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        drawBackground(baseCtx);
        if (!currentTexture) { return; }

        const origin = getOrigin();
        const { w: dw, h: dh } = getDisplaySize();
        const tw = dw * zoom;
        const th = dh * zoom;

        // Guides behind patches (HUD frame)
        if (offsetType === 'hud') {
            drawHudFrame(baseCtx);
            drawHudGuides(baseCtx);
        }

        if (!showOutside) {
            baseCtx.save();
            baseCtx.beginPath();
            baseCtx.rect(origin.x, origin.y, tw, th);
            baseCtx.clip();
        }

        for (const patch of currentTexture.patches) {
            const px = patch.id === dragPatchId ? dragCurrentX : patch.x;
            const py = patch.id === dragPatchId ? dragCurrentY : patch.y;
            drawPatch(baseCtx, { ...patch, x: px, y: py }, origin, false);
        }

        if (!showOutside) {
            baseCtx.restore();
        }

        // Texture bounds (always shown — canvas size, not an Offset Type guide)
        baseCtx.strokeStyle = 'rgba(255,255,255,0.35)';
        baseCtx.lineWidth = 1;
        baseCtx.setLineDash([4, 4]);
        baseCtx.strokeRect(origin.x, origin.y, tw, th);
        baseCtx.setLineDash([]);

        // Sprite overlays on top
        if (offsetType === 'sprite') {
            const center = getViewportCenter();
            drawOriginCross(baseCtx, center);
            baseCtx.strokeStyle = 'rgba(0, 200, 0, 0.8)';
            baseCtx.lineWidth = 2;
            baseCtx.setLineDash([]);
            baseCtx.beginPath();
            baseCtx.moveTo(0, center.y);
            baseCtx.lineTo(canvasW, center.y);
            baseCtx.stroke();
        }

        updateInfoBar();
    }

    function drawOriginCross(ctx, origin) {
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, origin.y);
        ctx.lineTo(canvasW, origin.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(origin.x, 0);
        ctx.lineTo(origin.x, canvasH);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(255, 255, 0, 1)';
        ctx.lineWidth = 2;
        const armLen = 10;
        ctx.beginPath();
        ctx.moveTo(origin.x - armLen, origin.y);
        ctx.lineTo(origin.x + armLen, origin.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(origin.x, origin.y - armLen);
        ctx.lineTo(origin.x, origin.y + armLen);
        ctx.stroke();
    }

    /**
     * Centered 320×200 HUD screen in the viewport (SLADE).
     * Independent of texture Offset — Offset only moves the texture inside the screen.
     */
    function getHudFrameRect() {
        const center = getViewportCenter();
        const w = HUD_REF_W * zoom;
        const h = HUD_REF_H * zoom;
        const x = center.x - w / 2;
        const y = center.y - h / 2;
        return {
            x, y, w, h,
            cx: center.x,
            cy: center.y
        };
    }

    function drawHudFrame(ctx) {
        const frame = getHudFrameRect();
        ctx.strokeStyle = 'rgba(180, 180, 180, 0.85)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);
    }

    function drawHudGuides(ctx) {
        const frame = getHudFrameRect();
        // Full crosshair through screen center (SLADE middle-of-screen guides)
        ctx.strokeStyle = 'rgba(160, 160, 160, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(frame.x, frame.cy);
        ctx.lineTo(frame.x + frame.w, frame.cy);
        ctx.moveTo(frame.cx, frame.y);
        ctx.lineTo(frame.cx, frame.y + frame.h);
        ctx.stroke();

        // Status bar top (Doom) at y=168 from screen top
        const statusY = frame.y + HUD_STATUS_BAR_Y * zoom;
        if (statusY < frame.y + frame.h) {
            ctx.strokeStyle = 'rgba(120, 160, 220, 0.55)';
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(frame.x, statusY);
            ctx.lineTo(frame.x + frame.w, statusY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
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
            const { w: rpw, h: rph } = getResourceDimensions(res, patch);
            const scaleX = applyScale ? 1 / (currentTexture.xScale || 1) : 1;
            const scaleY = applyScale ? 1 / (currentTexture.yScale || 1) : 1;
            const pw = rpw * zoom * scaleX;
            const ph = rph * zoom * scaleY;

            overlayCtx.strokeStyle = isSelected ? 'rgba(0, 150, 255, 0.9)' : 'rgba(255, 200, 0, 0.7)';
            overlayCtx.lineWidth = isSelected ? 2 : 1;
            overlayCtx.setLineDash(isSelected ? [] : [3, 3]);
            overlayCtx.strokeRect(origin.x + px * zoom * scaleX, origin.y + py * zoom * scaleY, pw, ph);
            overlayCtx.setLineDash([]);
        }

        if (dragging && dragPatchId) {
            const patch = currentTexture.patches.find(p => p.id === dragPatchId);
            if (patch) {
                drawPatch(overlayCtx, { ...patch, x: dragCurrentX, y: dragCurrentY }, getOrigin(), true);
            }
        }
    }

    function effectivePatchXY(patch) {
        let x = patch.x;
        let y = patch.y;
        const res = resourceCache.get(patch.resourceId);
        if (getProp(patch.props, 'UseOffsets', false) && res && res.grabOffset) {
            x -= res.grabOffset.x;
            y -= res.grabOffset.y;
        }
        return { x, y };
    }

    function drawPatch(ctx, patch, origin, ghost) {
        const res = resourceCache.get(patch.resourceId);
        const scaleX = applyScale ? 1 / (currentTexture.xScale || 1) : 1;
        const scaleY = applyScale ? 1 / (currentTexture.yScale || 1) : 1;
        const { x: ex, y: ey } = effectivePatchXY(patch);
        const sx = origin.x + ex * zoom * scaleX;
        const sy = origin.y + ey * zoom * scaleY;

        if (!res || res.state === 'loading') { return; }

        if (res.state === 'missing') {
            const pw = 32 * zoom * scaleX;
            const ph = 32 * zoom * scaleY;
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
            const pw = res.width * zoom * scaleX;
            const ph = res.height * zoom * scaleY;
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

        const translation = getProp(patch.props, 'Translation', '');
        const cacheKey = patch.resourceId + '::' + (translation || '');
        let bmp = res.bitmap;
        if (translation && playpal) {
            if (translatedCache.has(cacheKey)) {
                bmp = translatedCache.get(cacheKey);
            } else if (!res._translating) {
                // Kick off async translation; redraw when ready
                res._translating = true;
                getTranslatedBitmap(patch.resourceId, res.bitmap, translation).then(() => {
                    res._translating = false;
                    renderBase();
                    renderOverlay();
                }).catch(() => { res._translating = false; });
            }
        }

        const pw = bmp.width * zoom * scaleX;
        const ph = bmp.height * zoom * scaleY;

        // Outside tint when showOutside and patch extends beyond bounds
        const outside = showOutside && (
            ex < 0 || ey < 0 || ex + bmp.width > currentTexture.width || ey + bmp.height > currentTexture.height
        );

        ctx.save();
        const rotDeg = getProp(patch.props, 'Rotate', 0);
        const swapped = Math.abs(rotDeg) % 180 === 90;
        const cx = sx + (swapped ? ph : pw) / 2;
        const cy = sy + (swapped ? pw : ph) / 2;
        ctx.translate(cx, cy);
        const rot = rotDeg * Math.PI / 180;
        if (rot) { ctx.rotate(rot); }
        const flipX = getProp(patch.props, 'FlipX', false) ? -1 : 1;
        const flipY = getProp(patch.props, 'FlipY', false) ? -1 : 1;
        if (flipX === -1 || flipY === -1) { ctx.scale(flipX, flipY); }
        ctx.globalAlpha = ghost ? 0.55 : getProp(patch.props, 'Alpha', 1);
        ctx.imageSmoothingEnabled = zoom < 1;
        ctx.drawImage(bmp, -pw / 2, -ph / 2, pw, ph);
        if (outside && !ghost) {
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = 'rgba(255, 60, 60, 0.25)';
            ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
        }
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

    function getResourceDimensions(res, patch) {
        let w, h;
        if (res && (res.state === 'ready' || res.state === 'definition')) {
            w = res.width;
            h = res.height;
        } else {
            w = 32; h = 32;
        }
        const rotDeg = getProp(patch?.props, 'Rotate', 0);
        if (Math.abs(rotDeg) % 180 === 90) {
            return { w: h, h: w };
        }
        return { w, h };
    }

    function hitTest(mouseX, mouseY) {
        if (!currentTexture) { return null; }
        const origin = getOrigin();
        const scaleX = applyScale ? 1 / (currentTexture.xScale || 1) : 1;
        const scaleY = applyScale ? 1 / (currentTexture.yScale || 1) : 1;
        for (let i = currentTexture.patches.length - 1; i >= 0; i--) {
            const p = currentTexture.patches[i];
            const res = resourceCache.get(p.resourceId);
            const { w: pw, h: ph } = getResourceDimensions(res, p);
            const { x: ex, y: ey } = effectivePatchXY(p);
            const sx = origin.x + ex * zoom * scaleX;
            const sy = origin.y + ey * zoom * scaleY;
            if (mouseX >= sx && mouseX <= sx + pw * zoom * scaleX &&
                mouseY >= sy && mouseY <= sy + ph * zoom * scaleY) {
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
        // Drop translated bitmaps for unused resources
        for (const tKey of [...translatedCache.keys()]) {
            const rid = tKey.split('::')[0];
            if (!used.has(rid)) {
                const bmp = translatedCache.get(tKey);
                if (bmp && bmp.close) { bmp.close(); }
                translatedCache.delete(tKey);
            }
        }
    }

    function fitZoom() {
        if (!currentTexture || !canvasW || !canvasH) { return; }
        const margin = 60;
        if (offsetType === 'hud') {
            // Fit the centered 320×200 HUD screen in the viewport
            zoom = Math.min(
                (canvasW - margin) / HUD_REF_W,
                (canvasH - margin) / HUD_REF_H,
                8
            );
            zoom = Math.max(zoom, 0.1);
            panX = 0;
            panY = 0;
            return;
        }
        const { w, h } = getDisplaySize();
        zoom = Math.min(
            (canvasW - margin) / Math.max(w, 1),
            (canvasH - margin) / Math.max(h, 1),
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

    function buildPatchList() {
        patchList.innerHTML = '';
        if (!currentTexture) { return; }
        for (const p of currentTexture.patches) {
            const el = document.createElement('div');
            el.className = 'item' + (p.id === selectedPatchId ? ' selected' : '');
            el.textContent = `${p.name} (${p.x}, ${p.y})`;
            el.addEventListener('click', () => {
                selectedPatchId = p.id;
                vscode.postMessage({ type: 'selectPatch', patchId: p.id });
                buildPatchList();
                syncInspector();
                renderOverlay();
                updateInfoBar();
            });
            patchList.appendChild(el);
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

        const scaleLbl = document.createElement('label');
        scaleLbl.className = 'toggle';
        const scaleCb = document.createElement('input');
        scaleCb.type = 'checkbox';
        scaleCb.checked = applyScale;
        scaleCb.addEventListener('change', () => {
            applyScale = scaleCb.checked;
            renderBase();
            renderOverlay();
        });
        scaleLbl.appendChild(scaleCb);
        scaleLbl.appendChild(document.createTextNode('Apply Scale'));

        const outLbl = document.createElement('label');
        outLbl.className = 'toggle';
        const outCb = document.createElement('input');
        outCb.type = 'checkbox';
        outCb.checked = showOutside;
        outCb.addEventListener('change', () => {
            showOutside = outCb.checked;
            renderBase();
            renderOverlay();
        });
        outLbl.appendChild(outCb);
        outLbl.appendChild(document.createTextNode('Show Outside'));

        const offsetWrap = document.createElement('label');
        offsetWrap.className = 'toggle';
        offsetWrap.appendChild(document.createTextNode('Offset Type '));
        const offsetSel = document.createElement('select');
        offsetSel.id = 'offset-type-select';
        for (const [val, label] of [['none', 'None'], ['sprite', 'Sprite'], ['hud', 'HUD']]) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (val === offsetType) { opt.selected = true; }
            offsetSel.appendChild(opt);
        }
        offsetSel.addEventListener('change', () => {
            offsetType = offsetSel.value;
            if (offsetType === 'hud') {
                fitZoom();
            }
            renderBase();
            renderOverlay();
        });
        offsetWrap.appendChild(offsetSel);

        toolbar.appendChild(bgBtn);
        toolbar.appendChild(fitBtn);
        toolbar.appendChild(oneBtn);
        toolbar.appendChild(scaleLbl);
        toolbar.appendChild(outLbl);
        toolbar.appendChild(offsetWrap);
    }

    function makeBtn(text, onclick) {
        const b = document.createElement('button');
        b.textContent = text;
        b.addEventListener('click', onclick);
        return b;
    }

    function syncInspector() {
        if (!currentTexture) { return; }
        suppressInspectorEvents = true;
        document.getElementById('tex-type').textContent = currentTexture.textureType || '—';
        document.getElementById('tex-width').value = currentTexture.width;
        document.getElementById('tex-height').value = currentTexture.height;
        document.getElementById('tex-offx').value = draggingOffset ? dragCurrentOffsetX : currentTexture.offsetX;
        document.getElementById('tex-offy').value = draggingOffset ? dragCurrentOffsetY : currentTexture.offsetY;
        document.getElementById('tex-xscale').value = currentTexture.xScale;
        document.getElementById('tex-yscale').value = currentTexture.yScale;

        const patch = selectedPatchId
            ? currentTexture.patches.find(p => p.id === selectedPatchId)
            : null;
        document.getElementById('patch-name').textContent = patch ? patch.name : '—';
        document.getElementById('patch-x').value = patch ? (patch.id === dragPatchId ? dragCurrentX : patch.x) : '';
        document.getElementById('patch-y').value = patch ? (patch.id === dragPatchId ? dragCurrentY : patch.y) : '';
        document.getElementById('patch-flipx').checked = patch ? !!getProp(patch.props, 'FlipX', false) : false;
        document.getElementById('patch-flipy').checked = patch ? !!getProp(patch.props, 'FlipY', false) : false;
        document.getElementById('patch-rotate').value = String(patch ? (getProp(patch.props, 'Rotate', 0) || 0) : 0);
        document.getElementById('patch-alpha').value = patch ? getProp(patch.props, 'Alpha', 1) : 1;
        document.getElementById('patch-useoffsets').checked = patch ? !!getProp(patch.props, 'UseOffsets', false) : false;

        const disabled = !patch;
        for (const id of ['patch-x', 'patch-y', 'patch-flipx', 'patch-flipy', 'patch-rotate', 'patch-alpha', 'patch-useoffsets']) {
            document.getElementById(id).disabled = disabled;
        }
        suppressInspectorEvents = false;
    }

    function postTextureProps(props) {
        if (!currentTexture) { return; }
        vscode.postMessage({
            type: 'updateTextureProps',
            props,
            modelVersion: currentTexture.revision
        });
    }

    function postPatchProps(props) {
        if (!currentTexture || !selectedPatchId) { return; }
        vscode.postMessage({
            type: 'updatePatchProps',
            patchId: selectedPatchId,
            props,
            modelVersion: currentTexture.revision
        });
    }

    function wireInspector() {
        const num = (id, fn) => {
            document.getElementById(id).addEventListener('change', () => {
                if (suppressInspectorEvents) { return; }
                fn(Number(document.getElementById(id).value));
            });
        };
        num('tex-width', v => postTextureProps({ width: Math.round(v) }));
        num('tex-height', v => postTextureProps({ height: Math.round(v) }));
        num('tex-offx', v => postTextureProps({ offsetX: Math.round(v) }));
        num('tex-offy', v => postTextureProps({ offsetY: Math.round(v) }));
        num('tex-xscale', v => postTextureProps({ xScale: v }));
        num('tex-yscale', v => postTextureProps({ yScale: v }));
        num('patch-x', v => postPatchProps({ x: Math.round(v) }));
        num('patch-y', v => postPatchProps({ y: Math.round(v) }));
        num('patch-alpha', v => postPatchProps({ Alpha: v }));

        document.getElementById('patch-flipx').addEventListener('change', e => {
            if (suppressInspectorEvents) { return; }
            postPatchProps({ FlipX: e.target.checked });
        });
        document.getElementById('patch-flipy').addEventListener('change', e => {
            if (suppressInspectorEvents) { return; }
            postPatchProps({ FlipY: e.target.checked });
        });
        document.getElementById('patch-useoffsets').addEventListener('change', e => {
            if (suppressInspectorEvents) { return; }
            postPatchProps({ UseOffsets: e.target.checked });
        });
        document.getElementById('patch-rotate').addEventListener('change', e => {
            if (suppressInspectorEvents) { return; }
            postPatchProps({ Rotate: Number(e.target.value) });
        });

        document.getElementById('btn-patch-add').addEventListener('click', () => {
            if (!currentTexture) { return; }
            vscode.postMessage({ type: 'addPatch', modelVersion: currentTexture.revision });
        });
        document.getElementById('btn-patch-remove').addEventListener('click', () => {
            if (!currentTexture || !selectedPatchId) { return; }
            vscode.postMessage({
                type: 'removePatch',
                patchId: selectedPatchId,
                modelVersion: currentTexture.revision
            });
            selectedPatchId = null;
        });
        document.getElementById('btn-patch-up').addEventListener('click', () => {
            if (!currentTexture || !selectedPatchId) { return; }
            vscode.postMessage({
                type: 'reorderPatch',
                patchId: selectedPatchId,
                direction: 'up',
                modelVersion: currentTexture.revision
            });
        });
        document.getElementById('btn-patch-down').addEventListener('click', () => {
            if (!currentTexture || !selectedPatchId) { return; }
            vscode.postMessage({
                type: 'reorderPatch',
                patchId: selectedPatchId,
                direction: 'down',
                modelVersion: currentTexture.revision
            });
        });
        document.getElementById('btn-patch-dup').addEventListener('click', () => {
            if (!currentTexture || !selectedPatchId) { return; }
            vscode.postMessage({
                type: 'duplicatePatch',
                patchId: selectedPatchId,
                modelVersion: currentTexture.revision
            });
        });
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
                const x = p.id === dragPatchId ? dragCurrentX : p.x;
                const y = p.id === dragPatchId ? dragCurrentY : p.y;
                patchInfo = `<span><span class="label">Patch:</span> ${p.name} (${x}, ${y}) ${w}\u00d7${h}</span>`;
            }
        }
        const ox = draggingOffset ? dragCurrentOffsetX : currentTexture.offsetX;
        const oy = draggingOffset ? dragCurrentOffsetY : currentTexture.offsetY;
        infoBar.innerHTML =
            `<span><span class="label">Texture:</span> ${currentTexture.name} ${currentTexture.width}\u00d7${currentTexture.height}</span>` +
            `<span><span class="label">Offset:</span> ${ox}, ${oy}</span>` +
            `<span><span class="label">Scale:</span> ${currentTexture.xScale}, ${currentTexture.yScale}</span>` +
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
                buildPatchList();
                syncInspector();
            } else {
                // Drag empty area → texture offset
                selectedPatchId = null;
                draggingOffset = true;
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                dragStartOffsetX = currentTexture ? currentTexture.offsetX : 0;
                dragStartOffsetY = currentTexture ? currentTexture.offsetY : 0;
                dragCurrentOffsetX = dragStartOffsetX;
                dragCurrentOffsetY = dragStartOffsetY;
                viewport.classList.add('dragging');
                buildPatchList();
                syncInspector();
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
            const scaleX = applyScale ? 1 / (currentTexture.xScale || 1) : 1;
            const scaleY = applyScale ? 1 / (currentTexture.yScale || 1) : 1;
            dragCurrentX = Math.round(dragStartPatchX + dx / (zoom * scaleX));
            dragCurrentY = Math.round(dragStartPatchY + dy / (zoom * scaleY));
            syncInspector();
            renderOverlay();
            updateInfoBar();
        } else if (draggingOffset && currentTexture) {
            // Dragging outside: SLADE moves the virtual image; offset changes opposite to mouse
            const dx = e.clientX - dragStartMouseX;
            const dy = e.clientY - dragStartMouseY;
            dragCurrentOffsetX = Math.round(dragStartOffsetX - dx / zoom);
            dragCurrentOffsetY = Math.round(dragStartOffsetY - dy / zoom);
            syncInspector();
            renderBase();
            renderOverlay();
            updateInfoBar();
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
        if (draggingOffset && currentTexture) {
            if (dragCurrentOffsetX !== dragStartOffsetX || dragCurrentOffsetY !== dragStartOffsetY) {
                vscode.postMessage({
                    type: 'moveTextureOffset',
                    offsetX: dragCurrentOffsetX,
                    offsetY: dragCurrentOffsetY,
                    modelVersion: currentTexture.revision
                });
            }
        }
        dragging = false;
        panning = false;
        draggingOffset = false;
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
            case 'palette':
                if (msg.rgb && msg.rgb.length >= 768) {
                    playpal = [];
                    for (let i = 0; i < 256; i++) {
                        playpal.push({
                            r: msg.rgb[i * 3],
                            g: msg.rgb[i * 3 + 1],
                            b: msg.rgb[i * 3 + 2]
                        });
                    }
                } else {
                    playpal = null;
                }
                clearTranslatedCache();
                // Re-resolve composites so nested Translations are applied with PLAYPAL
                for (const [key, val] of [...resourceCache.entries()]) {
                    if (val && (val.resourceType === 'composite' || val._wasComposite)) {
                        if (val.bitmap && val.bitmap.close) { val.bitmap.close(); }
                        resourceCache.delete(key);
                    }
                }
                ensureResources();
                renderBase();
                renderOverlay();
                break;
            case 'init':
                textures = msg.textures;
                currentTexture = msg.selected;
                selectedPatchId = null;
                buildTextureList();
                buildPatchList();
                buildToolbar();
                ensureResources();
                fitZoom();
                syncInspector();
                renderBase();
                renderOverlay();
                break;
            case 'updateTexture': {
                const prevSelected = selectedPatchId;
                currentTexture = msg.texture;
                if (prevSelected && !currentTexture.patches.some(p => p.id === prevSelected)) {
                    selectedPatchId = null;
                } else {
                    selectedPatchId = prevSelected;
                }
                buildTextureList();
                buildPatchList();
                ensureResources();
                retainResources();
                syncInspector();
                renderBase();
                renderOverlay();
                break;
            }
            case 'updateList':
                textures = msg.textures;
                buildTextureList();
                break;
            case 'resourceResolved':
                handleResourceResolved(msg);
                break;
            case 'highlightPatch':
                highlightedPatchId = msg.patchId;
                if (msg.patchId) {
                    selectedPatchId = msg.patchId;
                    buildPatchList();
                    syncInspector();
                }
                renderOverlay();
                break;
            case 'editResult':
                if (!msg.ok && msg.reason) {
                    console.warn('Texture edit failed:', msg.reason);
                }
                break;
        }
    });

    function subPatchesHaveTranslation(subPatches) {
        if (!subPatches) { return false; }
        for (const sp of subPatches) {
            if (sp.translation) { return true; }
            if (sp.children && subPatchesHaveTranslation(sp.children)) { return true; }
        }
        return false;
    }

    async function handleResourceResolved(msg) {
        if (msg.resourceType === 'composite' && msg.subPatches && msg.subPatches.length > 0) {
            // If translations need PLAYPAL and it isn't ready yet, keep a placeholder
            // and re-resolve when palette arrives.
            if (subPatchesHaveTranslation(msg.subPatches) && !playpal) {
                resourceCache.set(msg.resourceId, {
                    state: 'definition',
                    width: msg.width || 32,
                    height: msg.height || 32,
                    _wasComposite: true,
                    _pendingSubPatches: msg.subPatches
                });
                renderBase();
                renderOverlay();
                return;
            }
            try {
                const bitmap = await compositePatches(msg.width, msg.height, msg.subPatches);
                resourceCache.set(msg.resourceId, {
                    state: 'ready',
                    bitmap,
                    width: msg.width,
                    height: msg.height,
                    grabOffset: null,
                    _wasComposite: true
                });
            } catch {
                resourceCache.set(msg.resourceId, {
                    state: 'definition',
                    width: msg.width || 32,
                    height: msg.height || 32,
                    _wasComposite: true
                });
            }
        } else if (msg.resourceType === 'composite') {
            resourceCache.set(msg.resourceId, {
                state: 'definition',
                width: msg.width || 32,
                height: msg.height || 32,
                _wasComposite: true
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
                    height: bitmap.height,
                    grabOffset: msg.grabOffset || null
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

    /**
     * Draw one sub-patch onto a parent context.
     * Composite wrappers (children in local coords) are rasterized to an offscreen
     * of (sp.width×sp.height), then Flip/Rotate/Alpha/Translation are applied when
     * placing that bitmap — matching ZDoom/SLADE nested TEXTURES behavior.
     */
    async function drawSubPatch(octx, sp) {
        let bmp = null;
        let closeBmp = false;

        if (sp.children && sp.children.length > 0) {
            const cw = Math.max(1, sp.width | 0);
            const ch = Math.max(1, sp.height | 0);
            const nested = new OffscreenCanvas(cw, ch);
            const nctx = nested.getContext('2d');
            for (const child of sp.children) {
                await drawSubPatch(nctx, child);
            }
            bmp = nested.transferToImageBitmap();
            closeBmp = true;
        } else if (sp.uri) {
            const resp = await fetch(sp.uri);
            const blob = await resp.blob();
            bmp = await createImageBitmap(blob);
            closeBmp = true;
        } else {
            return;
        }

        if (sp.translation && playpal) {
            const translated = await applyTranslationToBitmap(bmp, sp.translation);
            if (translated !== bmp) {
                if (closeBmp) { bmp.close(); }
                bmp = translated;
                closeBmp = true;
            }
        }

        const pw = bmp.width;
        const ph = bmp.height;
        octx.save();
        const rotDeg = sp.rotate ?? 0;
        const swapped = Math.abs(rotDeg) % 180 === 90;
        const cx = sp.x + (swapped ? ph : pw) / 2;
        const cy = sp.y + (swapped ? pw : ph) / 2;
        octx.translate(cx, cy);
        if (rotDeg) { octx.rotate(rotDeg * Math.PI / 180); }
        if (sp.flipX || sp.flipY) { octx.scale(sp.flipX ? -1 : 1, sp.flipY ? -1 : 1); }
        octx.globalAlpha = sp.alpha ?? 1;
        octx.drawImage(bmp, -pw / 2, -ph / 2, pw, ph);
        octx.restore();
        if (closeBmp) { bmp.close(); }
    }

    async function compositePatches(width, height, subPatches) {
        const offscreen = new OffscreenCanvas(width, height);
        const octx = offscreen.getContext('2d');
        for (const sp of subPatches) {
            await drawSubPatch(octx, sp);
        }
        return offscreen.transferToImageBitmap();
    }

    wireInspector();
    vscode.postMessage({ type: 'ready' });
})();
