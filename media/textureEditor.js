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
    let draggingResize = false;
    /** @type {'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'|null} */
    let resizeEdge = null;
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
    let dragStartW = 0;
    let dragStartH = 0;
    let dragCurrentW = 0;
    let dragCurrentH = 0;
    /** Patch shift during left/top resize preview (and commit). */
    let dragPatchDx = 0;
    let dragPatchDy = 0;
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
        // Palette index remap only (not =[rgb] or =%[rgb])
        const rangeRe = /(\d+)\s*:\s*(\d+)\s*=\s*(?![%[])(\d+)\s*:\s*(\d+)/g;
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

    /** Direct color: fromStart:fromEnd=[r1,g1,b1]:[r2,g2,b2] (integers 0–255). */
    function parseDirectRanges(raw) {
        const ranges = [];
        if (!raw) { return ranges; }
        const quoted = [...String(raw).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const parts = quoted.length > 0 ? quoted : [String(raw)];
        // Negative lookahead: not desat (=%[)
        const directRe = /(\d+)\s*:\s*(\d+)\s*=\s*(?!%)\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
        for (const part of parts) {
            directRe.lastIndex = 0;
            let m;
            while ((m = directRe.exec(part)) !== null) {
                ranges.push({
                    fromStart: clampByte(parseInt(m[1], 10)),
                    fromEnd: clampByte(parseInt(m[2], 10)),
                    r1: clampByte(parseInt(m[3], 10)),
                    g1: clampByte(parseInt(m[4], 10)),
                    b1: clampByte(parseInt(m[5], 10)),
                    r2: clampByte(parseInt(m[6], 10)),
                    g2: clampByte(parseInt(m[7], 10)),
                    b2: clampByte(parseInt(m[8], 10))
                });
            }
        }
        return ranges;
    }

    /** Parse desaturated translations: fromStart:fromEnd=%[r1,g1,b1]:[r2,g2,b2] (floats 0–2). */
    function parseDesatRanges(raw) {
        const ranges = [];
        if (!raw) { return ranges; }
        const quoted = [...String(raw).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const parts = quoted.length > 0 ? quoted : [String(raw)];
        const desatRe = /(\d+)\s*:\s*(\d+)\s*=\s*%\s*\[\s*([^\]]+)\]\s*:\s*\[\s*([^\]]+)\]/g;
        const tripRe = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/;
        for (const part of parts) {
            desatRe.lastIndex = 0;
            let m;
            while ((m = desatRe.exec(part)) !== null) {
                const t1 = tripRe.exec(m[3]);
                const t2 = tripRe.exec(m[4]);
                if (!t1 || !t2) { continue; }
                ranges.push({
                    fromStart: clampByte(parseInt(m[1], 10)),
                    fromEnd: clampByte(parseInt(m[2], 10)),
                    r1: clampFloat2(parseFloat(t1[1])),
                    g1: clampFloat2(parseFloat(t1[2])),
                    b1: clampFloat2(parseFloat(t1[3])),
                    r2: clampFloat2(parseFloat(t2[1])),
                    g2: clampFloat2(parseFloat(t2[2])),
                    b2: clampFloat2(parseFloat(t2[3]))
                });
            }
        }
        return ranges;
    }

    function clampFloat2(n) {
        if (!Number.isFinite(n)) { return 0; }
        return Math.max(0, Math.min(2, n));
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

    /** ZDoom AddColorRange: lerp RGB by palette index across [start,end]. Writes into out (NaN = unset). */
    function applyDirectToRgbTable(out, ranges) {
        for (const r of ranges) {
            let start = r.fromStart, end = r.fromEnd;
            let rr = r.r1, gg = r.g1, bb = r.b1;
            let rs, gs, bs;
            if (start > end) {
                const ts = start; start = end; end = ts;
                rr = r.r2; gg = r.g2; bb = r.b2;
                rs = r.r1 - r.r2; gs = r.g1 - r.g2; bs = r.b1 - r.b2;
            } else {
                rs = r.r2 - r.r1; gs = r.g2 - r.g1; bs = r.b2 - r.b1;
            }
            if (start === end) {
                out[start * 3] = rr;
                out[start * 3 + 1] = gg;
                out[start * 3 + 2] = bb;
            } else {
                rs /= (end - start);
                gs /= (end - start);
                bs /= (end - start);
                for (let i = start; i <= end; i++) {
                    out[i * 3] = rr | 0;
                    out[i * 3 + 1] = gg | 0;
                    out[i * 3 + 2] = bb | 0;
                    rr += rs; gg += gs; bb += bs;
                }
            }
        }
    }

    /**
     * Build per-index RGB overrides for direct + desaturated translations.
     * Returns Float32Array length 256*3, or null if empty. NaN = no override.
     */
    function buildRgbOverrideTable(directRanges, desatRanges) {
        const hasDirect = directRanges && directRanges.length > 0;
        const hasDesat = desatRanges && desatRanges.length > 0;
        if (!playpal || (!hasDirect && !hasDesat)) { return null; }
        const out = new Float32Array(256 * 3);
        out.fill(NaN);
        if (hasDirect) {
            applyDirectToRgbTable(out, directRanges);
        }
        if (hasDesat) {
            for (const r of desatRanges) {
                let r1 = r.r1, g1 = r.g1, b1 = r.b1;
                let r2 = r.r2, g2 = r.g2, b2 = r.b2;
                let start = r.fromStart, end = r.fromEnd;
                if (start > end) {
                    const ts = start; start = end; end = ts;
                    const tr = r1; r1 = r2; r2 = tr;
                    const tg = g1; g1 = g2; g2 = tg;
                    const tb = b1; b1 = b2; b2 = tb;
                }
                r2 -= r1; g2 -= g1; b2 -= b1;
                r1 *= 255; g1 *= 255; b1 *= 255;
                for (let c = start; c <= end; c++) {
                    const pal = playpal[c];
                    const intensity = (pal.r * 77 + pal.g * 143 + pal.b * 37) / 256.0;
                    out[c * 3] = Math.min(255, (r1 + intensity * r2) | 0);
                    out[c * 3 + 1] = Math.min(255, (g1 + intensity * g2) | 0);
                    out[c * 3 + 2] = Math.min(255, (b1 + intensity * b2) | 0);
                }
            }
        }
        return out;
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
        const directRanges = parseDirectRanges(translation);
        const desatRanges = parseDesatRanges(translation);
        if (ranges.length === 0 && directRanges.length === 0 && desatRanges.length === 0) { return bitmap; }
        const table = ranges.length > 0 ? buildRemapTable(ranges) : null;
        const rgbOverride = buildRgbOverrideTable(directRanges, desatRanges);

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
            if (rgbOverride && !Number.isNaN(rgbOverride[srcIdx * 3])) {
                data[i] = rgbOverride[srcIdx * 3];
                data[i + 1] = rgbOverride[srcIdx * 3 + 1];
                data[i + 2] = rgbOverride[srcIdx * 3 + 2];
                continue;
            }
            if (!table) { continue; }
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

    function getLogicalSize() {
        if (!currentTexture) { return { w: 0, h: 0 }; }
        if (draggingResize) {
            return { w: dragCurrentW, h: dragCurrentH };
        }
        return { w: currentTexture.width, h: currentTexture.height };
    }

    function getDisplaySize() {
        if (!currentTexture) { return { w: 0, h: 0 }; }
        let { w, h } = getLogicalSize();
        if (applyScale) {
            const xs = currentTexture.xScale || 1;
            const ys = currentTexture.yScale || 1;
            w = w / xs;
            h = h / ys;
        }
        return { w, h };
    }

    /**
     * Hit-test texture border for resize (all 8 edges/corners).
     * @returns {'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'|null}
     */
    function hitTestTextureBorder(mouseX, mouseY) {
        if (!currentTexture) { return null; }
        const origin = getOrigin();
        const { w, h } = getDisplaySize();
        const tw = w * zoom;
        const th = h * zoom;
        const left = origin.x;
        const top = origin.y;
        const right = left + tw;
        const bottom = top + th;
        const tol = Math.max(4, 6);
        const nearLeft = Math.abs(mouseX - left) <= tol && mouseY >= top - tol && mouseY <= bottom + tol;
        const nearRight = Math.abs(mouseX - right) <= tol && mouseY >= top - tol && mouseY <= bottom + tol;
        const nearTop = Math.abs(mouseY - top) <= tol && mouseX >= left - tol && mouseX <= right + tol;
        const nearBottom = Math.abs(mouseY - bottom) <= tol && mouseX >= left - tol && mouseX <= right + tol;
        if (nearLeft && nearTop) { return 'nw'; }
        if (nearRight && nearTop) { return 'ne'; }
        if (nearLeft && nearBottom) { return 'sw'; }
        if (nearRight && nearBottom) { return 'se'; }
        if (nearLeft) { return 'w'; }
        if (nearRight) { return 'e'; }
        if (nearTop) { return 'n'; }
        if (nearBottom) { return 's'; }
        return null;
    }

    function resizeCursorForEdge(edge) {
        if (edge === 'e' || edge === 'w') { return 'ew-resize'; }
        if (edge === 'n' || edge === 's') { return 'ns-resize'; }
        if (edge === 'se' || edge === 'nw') { return 'nwse-resize'; }
        if (edge === 'ne' || edge === 'sw') { return 'nesw-resize'; }
        return '';
    }

    function resizeAffectsWest(edge) {
        return edge === 'w' || edge === 'nw' || edge === 'sw';
    }

    function resizeAffectsEast(edge) {
        return edge === 'e' || edge === 'ne' || edge === 'se';
    }

    function resizeAffectsNorth(edge) {
        return edge === 'n' || edge === 'ne' || edge === 'nw';
    }

    function resizeAffectsSouth(edge) {
        return edge === 's' || edge === 'se' || edge === 'sw';
    }

    /** Preview patch x/y including left/top resize shift. */
    function previewPatchXY(patch) {
        let x = patch.x;
        let y = patch.y;
        if (draggingResize) {
            x += dragPatchDx;
            y += dragPatchDy;
        }
        if (patch.id === dragPatchId) {
            x = dragCurrentX;
            y = dragCurrentY;
        }
        return { x, y };
    }

    function updateViewportCursor(mx, my) {
        if (dragging || draggingOffset || draggingResize || panning) { return; }
        if (!currentTexture) {
            viewport.style.cursor = 'grab';
            return;
        }
        // Border strip wins over patches so overflow patches don't block resize.
        const edge = hitTestTextureBorder(mx, my);
        if (edge) {
            viewport.style.cursor = resizeCursorForEdge(edge);
            return;
        }
        viewport.style.cursor = 'grab';
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
        const useDragOffset = draggingOffset || draggingResize;
        const ox = currentTexture ? (useDragOffset ? dragCurrentOffsetX : currentTexture.offsetX) : 0;
        const oy = currentTexture ? (useDragOffset ? dragCurrentOffsetY : currentTexture.offsetY) : 0;
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
            const { x: px, y: py } = previewPatchXY(patch);
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

            const { x: px, y: py } = previewPatchXY(patch);
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

        if (draggingResize) {
            const { w, h } = getDisplaySize();
            overlayCtx.strokeStyle = 'rgba(0, 180, 255, 0.95)';
            overlayCtx.lineWidth = 2;
            overlayCtx.setLineDash([6, 4]);
            overlayCtx.strokeRect(origin.x, origin.y, w * zoom, h * zoom);
            overlayCtx.setLineDash([]);
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

        // Logical texture size (Flip/Rotate pivot). Expanded composites keep ink in
        // contentOrigin-shifted bitmaps so nested OOB patches are not clipped away.
        const logicalW = (res.width || bmp.width) * zoom * scaleX;
        const logicalH = (res.height || bmp.height) * zoom * scaleY;
        const ox = (res.contentOrigin?.x ?? 0) * zoom * scaleX;
        const oy = (res.contentOrigin?.y ?? 0) * zoom * scaleY;
        const bw = bmp.width * zoom * scaleX;
        const bh = bmp.height * zoom * scaleY;

        // Outside tint when showOutside and patch extends beyond bounds
        const outside = showOutside && (
            ex < 0 || ey < 0
            || ex + (res.width || bmp.width) > currentTexture.width
            || ey + (res.height || bmp.height) > currentTexture.height
        );

        ctx.save();
        const rotDeg = getProp(patch.props, 'Rotate', 0);
        const swapped = Math.abs(rotDeg) % 180 === 90;
        const cx = sx + (swapped ? logicalH : logicalW) / 2;
        const cy = sy + (swapped ? logicalW : logicalH) / 2;
        ctx.translate(cx, cy);
        const rot = rotDeg * Math.PI / 180;
        if (rot) { ctx.rotate(rot); }
        const flipX = getProp(patch.props, 'FlipX', false) ? -1 : 1;
        const flipY = getProp(patch.props, 'FlipY', false) ? -1 : 1;
        if (flipX === -1 || flipY === -1) { ctx.scale(flipX, flipY); }
        ctx.globalAlpha = ghost ? 0.55 : getProp(patch.props, 'Alpha', 1);
        ctx.imageSmoothingEnabled = zoom < 1;
        // Bitmap TL relative to logical center (contentOrigin shifts OOB ink)
        ctx.drawImage(bmp, ox - logicalW / 2, oy - logicalH / 2, bw, bh);
        if (outside && !ghost) {
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = 'rgba(255, 60, 60, 0.25)';
            ctx.fillRect(ox - logicalW / 2, oy - logicalH / 2, bw, bh);
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
            updateSymmetryAxisUi();
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
        document.getElementById('tex-width').value = draggingResize ? dragCurrentW : currentTexture.width;
        document.getElementById('tex-height').value = draggingResize ? dragCurrentH : currentTexture.height;
        document.getElementById('tex-offx').value = (draggingOffset || draggingResize) ? dragCurrentOffsetX : currentTexture.offsetX;
        document.getElementById('tex-offy').value = (draggingOffset || draggingResize) ? dragCurrentOffsetY : currentTexture.offsetY;
        document.getElementById('tex-xscale').value = currentTexture.xScale;
        document.getElementById('tex-yscale').value = currentTexture.yScale;

        const patch = selectedPatchId
            ? currentTexture.patches.find(p => p.id === selectedPatchId)
            : null;
        document.getElementById('patch-name').textContent = patch ? patch.name : '—';
        document.getElementById('patch-x').value = patch ? previewPatchXY(patch).x : '';
        document.getElementById('patch-y').value = patch ? previewPatchXY(patch).y : '';
        document.getElementById('patch-flipx').checked = patch ? !!getProp(patch.props, 'FlipX', false) : false;
        document.getElementById('patch-flipy').checked = patch ? !!getProp(patch.props, 'FlipY', false) : false;
        document.getElementById('patch-rotate').value = String(patch ? (getProp(patch.props, 'Rotate', 0) || 0) : 0);
        document.getElementById('patch-alpha').value = patch ? getProp(patch.props, 'Alpha', 1) : 1;
        document.getElementById('patch-useoffsets').checked = patch ? !!getProp(patch.props, 'UseOffsets', false) : false;

        const disabled = !patch;
        for (const id of ['patch-x', 'patch-y', 'patch-flipx', 'patch-flipy', 'patch-rotate', 'patch-alpha', 'patch-useoffsets']) {
            document.getElementById(id).disabled = disabled;
        }
        for (const mode of ['left', 'centerx', 'right', 'top', 'centery', 'bottom']) {
            document.getElementById(`btn-align-${mode}`).disabled = disabled;
        }
        for (const id of ['btn-patch-remove', 'btn-patch-up', 'btn-patch-down', 'btn-patch-dup',
            'btn-patch-reflect-h', 'btn-patch-reflect-v', 'btn-patch-copy-h', 'btn-patch-copy-v']) {
            const el = document.getElementById(id);
            if (el) { el.disabled = disabled; }
        }
        updateSymmetryAxisUi();
        suppressInspectorEvents = false;
    }

    function screenAxisAvailable() {
        return offsetType === 'sprite' || offsetType === 'hud';
    }

    function getSymmetryRef() {
        const screen = document.getElementById('sym-axis-screen');
        if (screen && screen.checked && screenAxisAvailable()) { return 'screen'; }
        return 'texture';
    }

    function updateSymmetryAxisUi() {
        const screenRadio = document.getElementById('sym-axis-screen');
        const texRadio = document.getElementById('sym-axis-texture');
        const canScreen = screenAxisAvailable();
        if (screenRadio) {
            screenRadio.disabled = !canScreen;
            if (!canScreen && screenRadio.checked && texRadio) {
                texRadio.checked = true;
            }
        }
        const texReflectDisabled = !currentTexture || !canScreen;
        for (const id of ['btn-tex-reflect-h', 'btn-tex-reflect-v']) {
            const el = document.getElementById(id);
            if (el) { el.disabled = texReflectDisabled; }
        }
        const trimBtn = document.getElementById('btn-tex-trim');
        if (trimBtn) {
            trimBtn.disabled = !currentTexture || currentTexture.patches.length === 0;
        }
    }

    function postTrimTexture() {
        if (!currentTexture || currentTexture.patches.length === 0) { return; }
        vscode.postMessage({
            type: 'trimTexture',
            modelVersion: currentTexture.revision
        });
    }

    function postSymmetryPatch(direction, mode) {
        if (!currentTexture || !selectedPatchId) { return; }
        const ref = getSymmetryRef();
        if (ref === 'screen' && !screenAxisAvailable()) { return; }
        vscode.postMessage({
            type: 'symmetryPatch',
            patchId: selectedPatchId,
            direction,
            ref,
            mode,
            offsetType,
            modelVersion: currentTexture.revision
        });
    }

    function postReflectTexture(direction) {
        if (!currentTexture || !screenAxisAvailable()) { return; }
        vscode.postMessage({
            type: 'reflectTexture',
            direction,
            offsetType,
            modelVersion: currentTexture.revision
        });
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
        document.getElementById('btn-patch-reflect-h').addEventListener('click', () => {
            postSymmetryPatch('h', 'reflect');
        });
        document.getElementById('btn-patch-reflect-v').addEventListener('click', () => {
            postSymmetryPatch('v', 'reflect');
        });
        document.getElementById('btn-patch-copy-h').addEventListener('click', () => {
            postSymmetryPatch('h', 'copy');
        });
        document.getElementById('btn-patch-copy-v').addEventListener('click', () => {
            postSymmetryPatch('v', 'copy');
        });
        document.getElementById('btn-tex-reflect-h').addEventListener('click', () => {
            postReflectTexture('h');
        });
        document.getElementById('btn-tex-reflect-v').addEventListener('click', () => {
            postReflectTexture('v');
        });
        document.getElementById('btn-tex-trim').addEventListener('click', () => {
            postTrimTexture();
        });

        const align = (mode) => {
            document.getElementById(`btn-align-${mode}`).addEventListener('click', () => {
                alignSelectedPatch(mode);
            });
        };
        for (const mode of ['left', 'centerx', 'right', 'top', 'centery', 'bottom']) {
            align(mode);
        }
        updateSymmetryAxisUi();
    }

    /** Effective patch size in texture units (Rotate 90/270 swaps). */
    function getPatchEffectiveSize(patch) {
        const res = resourceCache.get(patch.resourceId);
        return getResourceDimensions(res, patch);
    }

    function alignSelectedPatch(mode) {
        if (!currentTexture || !selectedPatchId) { return; }
        const patch = currentTexture.patches.find(p => p.id === selectedPatchId);
        if (!patch) { return; }
        const { w: effW, h: effH } = getPatchEffectiveSize(patch);
        const texW = currentTexture.width;
        const texH = currentTexture.height;
        let x = patch.x;
        let y = patch.y;
        switch (mode) {
            case 'left': x = 0; break;
            case 'centerx': x = Math.round((texW - effW) / 2); break;
            case 'right': x = texW - effW; break;
            case 'top': y = 0; break;
            case 'centery': y = Math.round((texH - effH) / 2); break;
            case 'bottom': y = texH - effH; break;
            default: return;
        }
        if (x === patch.x && y === patch.y) { return; }
        vscode.postMessage({
            type: 'movePatch',
            patchId: selectedPatchId,
            x,
            y,
            modelVersion: currentTexture.revision
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
                const { x, y } = previewPatchXY(p);
                patchInfo = `<span><span class="label">Patch:</span> ${p.name} (${x}, ${y}) ${w}\u00d7${h}</span>`;
            }
        }
        const ox = (draggingOffset || draggingResize) ? dragCurrentOffsetX : currentTexture.offsetX;
        const oy = (draggingOffset || draggingResize) ? dragCurrentOffsetY : currentTexture.offsetY;
        const tw = draggingResize ? dragCurrentW : currentTexture.width;
        const th = draggingResize ? dragCurrentH : currentTexture.height;
        infoBar.innerHTML =
            `<span><span class="label">Texture:</span> ${currentTexture.name} ${tw}\u00d7${th}</span>` +
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
            // Priority: border resize > patch drag > empty offset drag
            const edge = hitTestTextureBorder(mx, my);
            if (edge && currentTexture) {
                selectedPatchId = null;
                draggingResize = true;
                resizeEdge = edge;
                dragStartMouseX = e.clientX;
                dragStartMouseY = e.clientY;
                dragStartW = currentTexture.width;
                dragStartH = currentTexture.height;
                dragCurrentW = dragStartW;
                dragCurrentH = dragStartH;
                dragPatchDx = 0;
                dragPatchDy = 0;
                dragStartOffsetX = currentTexture.offsetX;
                dragStartOffsetY = currentTexture.offsetY;
                dragCurrentOffsetX = dragStartOffsetX;
                dragCurrentOffsetY = dragStartOffsetY;
                viewport.style.cursor = resizeCursorForEdge(edge);
                viewport.classList.add('dragging');
                buildPatchList();
                syncInspector();
            } else {
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
            }
            renderOverlay();
            updateInfoBar();
        }
    });

    window.addEventListener('mousemove', (e) => {
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

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
        } else if (draggingResize && currentTexture && resizeEdge) {
            const dx = e.clientX - dragStartMouseX;
            const dy = e.clientY - dragStartMouseY;
            const scaleX = applyScale ? 1 / (currentTexture.xScale || 1) : 1;
            const scaleY = applyScale ? 1 / (currentTexture.yScale || 1) : 1;
            const dTexX = dx / (zoom * scaleX);
            const dTexY = dy / (zoom * scaleY);
            let w = dragStartW;
            let h = dragStartH;
            if (resizeAffectsEast(resizeEdge)) {
                w = Math.max(1, Math.round(dragStartW + dTexX));
            } else if (resizeAffectsWest(resizeEdge)) {
                w = Math.max(1, Math.round(dragStartW - dTexX));
            }
            if (resizeAffectsSouth(resizeEdge)) {
                h = Math.max(1, Math.round(dragStartH + dTexY));
            } else if (resizeAffectsNorth(resizeEdge)) {
                h = Math.max(1, Math.round(dragStartH - dTexY));
            }
            dragCurrentW = w;
            dragCurrentH = h;
            // Left/top: shift patches + offset so content stays visually fixed
            dragPatchDx = resizeAffectsWest(resizeEdge) ? (w - dragStartW) : 0;
            dragPatchDy = resizeAffectsNorth(resizeEdge) ? (h - dragStartH) : 0;
            dragCurrentOffsetX = dragStartOffsetX + dragPatchDx;
            dragCurrentOffsetY = dragStartOffsetY + dragPatchDy;
            syncInspector();
            renderBase();
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
        } else {
            updateViewportCursor(mx, my);
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
        if (draggingResize && currentTexture) {
            if (dragCurrentW !== dragStartW || dragCurrentH !== dragStartH ||
                dragPatchDx !== 0 || dragPatchDy !== 0) {
                const payload = {
                    type: 'resizeTexture',
                    width: dragCurrentW,
                    height: dragCurrentH,
                    patchDx: dragPatchDx,
                    patchDy: dragPatchDy,
                    modelVersion: currentTexture.revision
                };
                if (dragPatchDx !== 0 || dragPatchDy !== 0) {
                    payload.offsetX = dragCurrentOffsetX;
                    payload.offsetY = dragCurrentOffsetY;
                }
                vscode.postMessage(payload);
            }
        }
        dragging = false;
        panning = false;
        draggingOffset = false;
        draggingResize = false;
        resizeEdge = null;
        dragPatchId = null;
        dragPatchDx = 0;
        dragPatchDy = 0;
        viewport.classList.remove('dragging');
        viewport.style.cursor = 'grab';
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
                const composed = await compositePatches(msg.width, msg.height, msg.subPatches);
                resourceCache.set(msg.resourceId, {
                    state: 'ready',
                    bitmap: composed.bitmap,
                    width: msg.width,
                    height: msg.height,
                    contentOrigin: composed.contentOrigin,
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
     * Nested TEXTURES often place child patches outside the declared canvas
     * (e.g. Patch at -164 on a 116-wide sprite) so sprite Offsets chain correctly.
     * Rasterize into an expanded canvas and return contentOrigin so Flip/Rotate
     * still pivot on the logical width×height box.
     */
    function patchLocalBounds(sp) {
        const lw = Math.max(1, sp.width | 0);
        const lh = Math.max(1, sp.height | 0);
        let minX = 0;
        let minY = 0;
        let maxX = lw;
        let maxY = lh;
        if (sp.children && sp.children.length > 0) {
            const cb = computeCompositeBounds(lw, lh, sp.children);
            minX = cb.minX;
            minY = cb.minY;
            maxX = cb.maxX;
            maxY = cb.maxY;
        }
        // Flip about logical center remaps the ink AABB (size unchanged for own-box flips
        // of content that equals the logical box; needed when ink extends past logical).
        let x0 = minX;
        let x1 = maxX;
        let y0 = minY;
        let y1 = maxY;
        if (sp.flipX) {
            const a = lw - x1;
            const b = lw - x0;
            x0 = a;
            x1 = b;
        }
        if (sp.flipY) {
            const a = lh - y1;
            const b = lh - y0;
            y0 = a;
            y1 = b;
        }
        const rotDeg = sp.rotate ?? 0;
        if (Math.abs(rotDeg) % 180 === 90) {
            // After 90° about logical center, map corners into parent-local AABB.
            const corners = [
                [x0, y0], [x1, y0], [x0, y1], [x1, y1]
            ].map(([x, y]) => {
                const dx = x - lw / 2;
                const dy = y - lh / 2;
                // 90° CCW: (-dy, dx) — sign matches canvas rotate()
                return [lw / 2 - dy, lh / 2 + dx];
            });
            x0 = Math.min(...corners.map(c => c[0]));
            x1 = Math.max(...corners.map(c => c[0]));
            y0 = Math.min(...corners.map(c => c[1]));
            y1 = Math.max(...corners.map(c => c[1]));
        }
        return { x0, y0, x1, y1, lw, lh };
    }

    function computeCompositeBounds(width, height, subPatches) {
        let minX = 0;
        let minY = 0;
        let maxX = Math.max(1, width | 0);
        let maxY = Math.max(1, height | 0);
        for (const sp of subPatches) {
            const { x0, y0, x1, y1 } = patchLocalBounds(sp);
            minX = Math.min(minX, sp.x + x0);
            minY = Math.min(minY, sp.y + y0);
            maxX = Math.max(maxX, sp.x + x1);
            maxY = Math.max(maxY, sp.y + y1);
        }
        return { minX, minY, maxX, maxY };
    }

    async function drawSubPatch(octx, sp) {
        let bmp = null;
        let closeBmp = false;
        let contentOriginX = 0;
        let contentOriginY = 0;
        let logicalW = Math.max(1, sp.width | 0);
        let logicalH = Math.max(1, sp.height | 0);

        if (sp.children && sp.children.length > 0) {
            const composed = await rasterizeComposite(logicalW, logicalH, sp.children);
            bmp = composed.bitmap;
            closeBmp = true;
            contentOriginX = composed.contentOrigin.x;
            contentOriginY = composed.contentOrigin.y;
        } else if (sp.uri) {
            const resp = await fetch(sp.uri);
            const blob = await resp.blob();
            bmp = await createImageBitmap(blob);
            closeBmp = true;
            logicalW = bmp.width;
            logicalH = bmp.height;
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

        octx.save();
        const rotDeg = sp.rotate ?? 0;
        const swapped = Math.abs(rotDeg) % 180 === 90;
        const cx = sp.x + (swapped ? logicalH : logicalW) / 2;
        const cy = sp.y + (swapped ? logicalW : logicalH) / 2;
        octx.translate(cx, cy);
        if (rotDeg) { octx.rotate(rotDeg * Math.PI / 180); }
        if (sp.flipX || sp.flipY) { octx.scale(sp.flipX ? -1 : 1, sp.flipY ? -1 : 1); }
        octx.globalAlpha = sp.alpha ?? 1;
        octx.drawImage(
            bmp,
            contentOriginX - logicalW / 2,
            contentOriginY - logicalH / 2,
            bmp.width,
            bmp.height
        );
        octx.restore();
        if (closeBmp) { bmp.close(); }
    }

    async function rasterizeComposite(width, height, subPatches) {
        const bounds = computeCompositeBounds(width, height, subPatches);
        const bw = Math.max(1, Math.ceil(bounds.maxX - bounds.minX));
        const bh = Math.max(1, Math.ceil(bounds.maxY - bounds.minY));
        const offscreen = new OffscreenCanvas(bw, bh);
        const octx = offscreen.getContext('2d');
        octx.translate(-bounds.minX, -bounds.minY);
        for (const sp of subPatches) {
            await drawSubPatch(octx, sp);
        }
        return {
            bitmap: offscreen.transferToImageBitmap(),
            contentOrigin: { x: bounds.minX, y: bounds.minY },
            logicalW: Math.max(1, width | 0),
            logicalH: Math.max(1, height | 0)
        };
    }

    async function compositePatches(width, height, subPatches) {
        return rasterizeComposite(width, height, subPatches);
    }

    wireInspector();
    vscode.postMessage({ type: 'ready' });
})();
