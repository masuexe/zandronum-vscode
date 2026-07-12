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

    /** @type {{ key: string, bitmap: ImageBitmap|HTMLImageElement, width: number, height: number } | null} */
    let spriteBitmap = null;
    let spriteLoadToken = 0;
    /** PLAYPAL as [{r,g,b}, ...] length 256, or null. */
    let playpal = null;
    let pendingViewData = null;

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const toolbar = document.getElementById('toolbar');
    const status = document.getElementById('status');
    const scrub = document.getElementById('scrub');

    let panning = false;
    let draggingOffset = false;
    let dragStartMouseX = 0;
    let dragStartMouseY = 0;
    let dragStartOffsetX = 0;
    let dragStartOffsetY = 0;
    let dragCurrentOffsetX = 0;
    let dragCurrentOffsetY = 0;
    /** @type {{ x: number, y: number } | null} Live offsets after mouse-up until document refresh. */
    let optimisticOffset = null;
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
        toolbar.appendChild(createButton('Fit HUD', () => { fitZoom(); render(); }));
        toolbar.appendChild(createButton('Fit Sprite', () => { fitSprite(); render(); }));
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

    /** Zoom/pan so the current weapon sprite stays visible in the viewport. */
    function fitSprite() {
        const frame = activeFrame();
        if (!frame || !spriteBitmap) {
            fitZoom();
            return;
        }
        const w = spriteBitmap.width;
        const h = spriteBitmap.height;
        const left = CENTER_X + frame.offsetX - frame.grabX;
        const top = frame.offsetY - frame.grabY;
        const right = left + w;
        const bottom = top + h;
        const pad = 24;
        const spanW = Math.max(HUD_W, right - left) + pad * 2;
        const spanH = Math.max(HUD_H, bottom - top) + pad * 2;
        const margin = 40;
        zoom = Math.max(0.25, Math.min(
            (canvasW - margin) / spanW,
            (canvasH - margin) / spanH,
            8
        ));
        // Center the HUD box, then shift so sprite midpoint is nearer viewport center
        const hudOx = canvasW / 2 - (HUD_W * zoom) / 2;
        const hudOy = canvasH / 2 - (HUD_H * zoom) / 2;
        const spriteMidX = hudOx + ((left + right) / 2) * zoom;
        const spriteMidY = hudOy + ((top + bottom) / 2) * zoom;
        panX = canvasW / 2 - spriteMidX;
        panY = canvasH / 2 - spriteMidY;
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

    /** Frame used for drawing/inspector — applies live drag offsets when dragging. */
    function displayFrame() {
        const frame = activeFrame();
        if (!frame) {
            return null;
        }
        if (draggingOffset) {
            return {
                ...frame,
                offsetX: dragCurrentOffsetX,
                offsetY: dragCurrentOffsetY,
                declaredOffsetX: dragCurrentOffsetX,
                declaredOffsetY: dragCurrentOffsetY,
                offsetIsKeep: false
            };
        }
        if (optimisticOffset) {
            return {
                ...frame,
                offsetX: optimisticOffset.x,
                offsetY: optimisticOffset.y,
                declaredOffsetX: optimisticOffset.x,
                declaredOffsetY: optimisticOffset.y,
                offsetIsKeep: false
            };
        }
        return frame;
    }

    function canEditOffset(frame) {
        return !!(frame && frame.hasOffsetKeyword && !frame.offsetIsKeep && !frame.missingResource);
    }

    function spriteScreenRect(origin, frame) {
        if (!spriteBitmap || !frame) {
            return null;
        }
        return {
            x: origin.x + (CENTER_X + frame.offsetX - frame.grabX) * zoom,
            y: origin.y + (frame.offsetY - frame.grabY) * zoom,
            w: spriteBitmap.width * zoom,
            h: spriteBitmap.height * zoom
        };
    }

    function hitTestSprite(clientX, clientY) {
        const frame = displayFrame();
        if (!canEditOffset(activeFrame()) || !spriteBitmap) {
            return false;
        }
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const origin = hudOrigin();
        const r = spriteScreenRect(origin, frame);
        if (!r) {
            return false;
        }
        return mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h;
    }

    function commitOffset(x, y) {
        vscode.postMessage({ type: 'setOffset', x: Math.round(x), y: Math.round(y) });
    }

    function nudgeOffset(dx, dy) {
        const frame = activeFrame();
        if (!canEditOffset(frame)) {
            if (frame && frame.offsetIsKeep) {
                status.textContent = 'Offset(0, 0) means keep previous — change it in DECORATE first if you want an absolute offset.';
            }
            return;
        }
        const base = displayFrame() || frame;
        const x = Math.round(base.offsetX + dx);
        const y = Math.round(base.offsetY + dy);
        optimisticOffset = { x, y };
        commitOffset(x, y);
        queueRender();
    }

    function frameCacheKey(frame) {
        if (!frame || frame.missingResource) {
            return null;
        }
        if (frame.imageUri) {
            return 'img:' + frame.imageUri;
        }
        if (frame.composite) {
            return 'cmp:' + (frame.resolvedName || '') + ':' + frame.composite.width + 'x' + frame.composite.height
                + ':' + JSON.stringify(frame.composite.subPatches);
        }
        return null;
    }

    function loadImageElement(uri) {
        return new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Failed to load ' + uri));
            image.src = uri;
        });
    }

    function clampByte(n) {
        return Math.max(0, Math.min(255, n | 0));
    }

    function clampFloat2(n) {
        if (!Number.isFinite(n)) { return 0; }
        return Math.max(0, Math.min(2, n));
    }

    /** Palette index remap: fromStart:fromEnd=toStart:toEnd */
    function parseTranslationRanges(raw) {
        const ranges = [];
        if (!raw) { return ranges; }
        const quoted = [...String(raw).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const parts = quoted.length > 0 ? quoted : [String(raw)];
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

    /** Direct color: fromStart:fromEnd=[r1,g1,b1]:[r2,g2,b2] (0–255). */
    function parseDirectRanges(raw) {
        const ranges = [];
        if (!raw) { return ranges; }
        const quoted = [...String(raw).matchAll(/"([^"]*)"/g)].map(m => m[1]);
        const parts = quoted.length > 0 ? quoted : [String(raw)];
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

    /** Desaturated: fromStart:fromEnd=%[r1,g1,b1]:[r2,g2,b2] (floats 0–2). */
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

    function translationNeedsPlaypal(raw) {
        if (!raw) { return false; }
        const ranges = parseTranslationRanges(raw);
        const direct = parseDirectRanges(raw);
        const desat = parseDesatRanges(raw);
        return ranges.length > 0 || direct.length > 0 || desat.length > 0;
    }

    function subPatchesHaveTranslation(subPatches) {
        if (!subPatches) { return false; }
        for (const sp of subPatches) {
            if (sp.translation && translationNeedsPlaypal(sp.translation)) { return true; }
            if (sp.children && subPatchesHaveTranslation(sp.children)) { return true; }
        }
        return false;
    }

    /**
     * Apply TEXTURES Translation (palette remap, Direct =[rgb], Desaturate =%[rgb]).
     * Same algorithm as the Texture Editor webview.
     */
    async function applyTranslationToBitmap(bitmap, translation) {
        if (!translation || !playpal || !bitmap) { return bitmap; }
        const ranges = parseTranslationRanges(translation);
        const directRanges = parseDirectRanges(translation);
        const desatRanges = parseDesatRanges(translation);
        if (ranges.length === 0 && directRanges.length === 0 && desatRanges.length === 0) {
            return bitmap;
        }
        const table = ranges.length > 0 ? buildRemapTable(ranges) : null;
        const rgbOverride = buildRgbOverrideTable(directRanges, desatRanges);

        const w = bitmap.width || bitmap.naturalWidth;
        const h = bitmap.height || bitmap.naturalHeight;
        const canvas = new OffscreenCanvas(w, h);
        const tctx = canvas.getContext('2d', { willReadFrequently: true });
        tctx.drawImage(bitmap, 0, 0);
        const imageData = tctx.getImageData(0, 0, w, h);
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
        tctx.putImageData(imageData, 0, 0);
        return canvas.transferToImageBitmap();
    }

    function releaseSpriteBitmap() {
        if (spriteBitmap && spriteBitmap.bitmap && spriteBitmap.bitmap.close) {
            try { spriteBitmap.bitmap.close(); } catch (_) { /* ignore */ }
        }
        spriteBitmap = null;
    }

    function namedTranslationOnly(raw) {
        if (!raw) { return false; }
        const hasNamed = /\b(Inverse|Gold|Red|Green|Ice|Desaturate)\b/i.test(String(raw));
        if (!hasNamed) { return false; }
        return !translationNeedsPlaypal(raw);
    }

    function collectTranslationWarnings(subPatches, out) {
        if (!subPatches) { return; }
        for (const sp of subPatches) {
            if (sp.translation && namedTranslationOnly(sp.translation)) {
                out.add('Named Translation (Gold/Inverse/…) not expanded — colors may be wrong');
            }
            if (sp.children) {
                collectTranslationWarnings(sp.children, out);
            }
        }
    }

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
            bmp = await loadImageElement(sp.uri);
            closeBmp = false;
        } else {
            return;
        }

        if (sp.translation && playpal && translationNeedsPlaypal(sp.translation)) {
            const translated = await applyTranslationToBitmap(bmp, sp.translation);
            if (translated !== bmp) {
                if (closeBmp && bmp.close) { bmp.close(); }
                bmp = translated;
                closeBmp = true;
            }
        }

        const pw = bmp.width || bmp.naturalWidth;
        const ph = bmp.height || bmp.naturalHeight;
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
        if (closeBmp && bmp.close) { bmp.close(); }
    }

    async function compositePatches(width, height, subPatches) {
        if (!subPatches || subPatches.length === 0) {
            throw new Error('TEXTURES definition has no drawable patches');
        }
        // Soft PLAYPAL: compose untranslated if palette missing (Texture Editor style)
        const offscreen = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
        const octx = offscreen.getContext('2d');
        for (const sp of subPatches) {
            await drawSubPatch(octx, sp);
        }
        return offscreen.transferToImageBitmap();
    }

    async function ensureSprite(frame) {
        const key = frameCacheKey(frame);
        if (!key) {
            releaseSpriteBitmap();
            return;
        }
        if (spriteBitmap && spriteBitmap.key === key) {
            return;
        }

        const token = ++spriteLoadToken;
        releaseSpriteBitmap();

        try {
            let bitmap = null;
            let width = 0;
            let height = 0;

            if (frame.imageUri) {
                const image = await loadImageElement(frame.imageUri);
                bitmap = image;
                width = image.naturalWidth;
                height = image.naturalHeight;
            } else if (frame.composite && frame.composite.subPatches && frame.composite.subPatches.length > 0) {
                bitmap = await compositePatches(
                    frame.composite.width,
                    frame.composite.height,
                    frame.composite.subPatches
                );
                width = frame.composite.width;
                height = frame.composite.height;
            } else if (frame.composite) {
                throw new Error('TEXTURES ' + (frame.resolvedName || '') + ' has no patches');
            }

            if (token !== spriteLoadToken) {
                if (bitmap && bitmap.close) { bitmap.close(); }
                return;
            }

            if (bitmap) {
                spriteBitmap = { key, bitmap, width, height };
            }
        } catch (err) {
            console.warn('Offset preview sprite load failed', err);
            if (token === spriteLoadToken) {
                releaseSpriteBitmap();
                status.textContent = String(err && err.message ? err.message : err);
            }
        }
        queueRender();
    }

    function updatePlaypalHint() {
        const node = el('info-playpal');
        if (!node) { return; }
        if (playpal) {
            node.textContent = 'PLAYPAL: loaded (' + playpal.length + ' colors)';
            node.classList.remove('warn');
        } else {
            node.textContent = 'PLAYPAL: missing — set zandronum-vscode.playpalPath or add a PLAYPAL lump (needed for Translation preview)';
            node.classList.add('warn');
        }
    }

    function updateInspector(frame) {
        const warnEl = el('info-warning');
        if (!frame) {
            el('info-label').textContent = viewData?.label || '—';
            el('info-sprite').textContent = '—';
            el('info-frame').textContent = '—';
            el('info-duration').textContent = '—';
            el('info-line').textContent = '—';
            el('info-ox').textContent = '—';
            el('info-oy').textContent = '—';
            el('info-delta').textContent = '—';
            el('info-declared').textContent = '—';
            el('info-grab').textContent = '—';
            el('info-seq').textContent = '—';
            if (warnEl) {
                if (viewData && viewData.warning) {
                    warnEl.hidden = false;
                    warnEl.textContent = viewData.warning;
                } else {
                    warnEl.hidden = true;
                    warnEl.textContent = '';
                }
            }
            updatePlaypalHint();
            status.textContent = viewData?.warning || 'No Offset frame selected';
            return;
        }

        el('info-label').textContent = viewData.label || '—';
        el('info-sprite').textContent = frame.resolvedName
            ? `${frame.sprite} ${frame.frame} → ${frame.resolvedName}`
            : `${frame.sprite} ${frame.frame}`;
        el('info-frame').textContent = frame.frame;
        el('info-duration').textContent = String(frame.duration);
        el('info-line').textContent = String(frame.line + 1);
        el('info-ox').textContent = String(frame.offsetX);
        el('info-oy').textContent = String(frame.offsetY);

        if (frame.deltaX !== null && frame.deltaY !== null) {
            const sx = frame.deltaX > 0 ? '+' : '';
            const sy = frame.deltaY > 0 ? '+' : '';
            el('info-delta').textContent = `${sx}${frame.deltaX}, ${sy}${frame.deltaY}`;
        } else {
            el('info-delta').textContent = '(first)';
        }

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

        const warnParts = [];
        if (viewData.warning) {
            warnParts.push(viewData.warning);
        }
        if (frame.composite) {
            const named = new Set();
            collectTranslationWarnings(frame.composite.subPatches, named);
            for (const w of named) { warnParts.push(w); }
            if (subPatchesHaveTranslation(frame.composite.subPatches) && !playpal) {
                warnParts.push('Translation present but PLAYPAL missing — showing untranslated colors');
            }
        }
        if (warnEl) {
            if (warnParts.length > 0) {
                warnEl.hidden = false;
                warnEl.textContent = warnParts.join(' · ');
            } else {
                warnEl.hidden = true;
                warnEl.textContent = '';
            }
        }
        updatePlaypalHint();

        if (frame.missingResource) {
            status.textContent = `Missing sprite for ${frame.sprite} ${frame.frame} (tried ${frame.sprite}${frame.frame}0, TEXTURES, …)`;
        } else if (frame.composite) {
            const hasTr = subPatchesHaveTranslation(frame.composite.subPatches);
            const trNote = hasTr
                ? (playpal ? ' + Translation' : ' (untranslated — no PLAYPAL)')
                : '';
            status.textContent = `TEXTURES ${frame.resolvedName}${trNote}  Offset(${frame.offsetX}, ${frame.offsetY})`;
        } else {
            status.textContent = `${frame.resolvedName || (frame.sprite + frame.frame)}  Offset(${frame.offsetX}, ${frame.offsetY})`;
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

        const statusY = origin.y + HUD_STATUS_BAR_Y * zoom;
        ctx.strokeStyle = 'rgba(120, 160, 220, 0.55)';
        ctx.beginPath();
        ctx.moveTo(origin.x, statusY);
        ctx.lineTo(origin.x + w, statusY);
        ctx.stroke();

        const cx = origin.x + CENTER_X * zoom;
        const restY = origin.y + 32 * zoom;
        ctx.strokeStyle = 'rgba(255, 200, 80, 0.45)';
        ctx.beginPath();
        ctx.moveTo(cx, origin.y);
        ctx.lineTo(cx, origin.y + h);
        ctx.moveTo(origin.x, restY);
        ctx.lineTo(origin.x + w, restY);
        ctx.stroke();

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
        if (!spriteBitmap || frame.missingResource) {
            return;
        }
        const r = spriteScreenRect(origin, frame);
        if (!r) {
            return;
        }

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(spriteBitmap.bitmap, r.x, r.y, r.w, r.h);

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

        const frame = displayFrame();
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
        if (draggingOffset) {
            pendingViewData = data;
            return;
        }
        optimisticOffset = null;
        viewData = data;
        pendingViewData = data;
        activeIndex = data.activeIndex || 0;
        scrub.min = '0';
        scrub.max = String(Math.max(0, (data.frames?.length || 1) - 1));
        scrub.value = String(activeIndex);

        const frame = activeFrame();
        releaseSpriteBitmap();
        void ensureSprite(frame);
        queueRender();
    }

    function setScrub(index) {
        if (draggingOffset) {
            return;
        }
        if (!viewData || !viewData.frames.length) {
            return;
        }
        activeIndex = Math.max(0, Math.min(index, viewData.frames.length - 1));
        scrub.value = String(activeIndex);
        const frame = activeFrame();
        void ensureSprite(frame);
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
        if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))) {
            panning = true;
            canvas.classList.add('panning');
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            e.preventDefault();
            return;
        }
        if (e.button !== 0) {
            return;
        }

        const frame = activeFrame();
        if (frame && frame.offsetIsKeep) {
            status.textContent = 'Offset(0, 0) means keep previous — change it in DECORATE first if you want an absolute offset.';
            return;
        }
        if (!canEditOffset(frame)) {
            return;
        }
        if (!hitTestSprite(e.clientX, e.clientY)) {
            return;
        }

        optimisticOffset = null;
        draggingOffset = true;
        dragStartMouseX = e.clientX;
        dragStartMouseY = e.clientY;
        dragStartOffsetX = frame.offsetX;
        dragStartOffsetY = frame.offsetY;
        dragCurrentOffsetX = frame.offsetX;
        dragCurrentOffsetY = frame.offsetY;
        canvas.classList.add('dragging');
        e.preventDefault();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (panning || draggingOffset) {
            return;
        }
        if (hitTestSprite(e.clientX, e.clientY)) {
            canvas.classList.add('over-sprite');
        } else {
            canvas.classList.remove('over-sprite');
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (panning) {
            panX += e.clientX - lastMouseX;
            panY += e.clientY - lastMouseY;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            queueRender();
            return;
        }
        if (draggingOffset) {
            // Drag sprite with mouse: right = +Offset X, down = +Offset Y
            const dx = (e.clientX - dragStartMouseX) / zoom;
            const dy = (e.clientY - dragStartMouseY) / zoom;
            dragCurrentOffsetX = Math.round(dragStartOffsetX + dx);
            dragCurrentOffsetY = Math.round(dragStartOffsetY + dy);
            queueRender();
        }
    });

    window.addEventListener('mouseup', () => {
        if (panning) {
            panning = false;
            canvas.classList.remove('panning');
        }
        if (draggingOffset) {
            const x = dragCurrentOffsetX;
            const y = dragCurrentOffsetY;
            const changed = x !== dragStartOffsetX || y !== dragStartOffsetY;
            draggingOffset = false;
            canvas.classList.remove('dragging');
            if (changed) {
                // Hold live position until document update arrives (avoids snap-back).
                optimisticOffset = { x, y };
                commitOffset(x, y);
                queueRender();
            } else if (pendingViewData) {
                applyView(pendingViewData);
            } else {
                queueRender();
            }
        }
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        zoom = Math.max(0.25, Math.min(16, zoom * factor));
        queueRender();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const step = e.shiftKey ? 8 : 1;
            let dx = 0;
            let dy = 0;
            if (e.key === 'ArrowLeft') { dx = -step; }
            if (e.key === 'ArrowRight') { dx = step; }
            if (e.key === 'ArrowUp') { dy = -step; }
            if (e.key === 'ArrowDown') { dy = step; }
            nudgeOffset(dx, dy);
            e.preventDefault();
        }
    });

    window.addEventListener('resize', () => queueRender());
    new ResizeObserver(() => queueRender()).observe(canvas.parentElement);

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg.type === 'update') {
            applyView(msg.data);
        } else if (msg.type === 'editResult') {
            if (!msg.ok && msg.reason) {
                optimisticOffset = null;
                status.textContent = msg.reason;
                queueRender();
            }
        } else if (msg.type === 'palette') {
            if (msg.rgb && msg.rgb.length >= 768) {
                playpal = [];
                for (let i = 0; i + 2 < msg.rgb.length; i += 3) {
                    playpal.push({
                        r: msg.rgb[i],
                        g: msg.rgb[i + 1],
                        b: msg.rgb[i + 2]
                    });
                }
            } else {
                playpal = null;
            }
            releaseSpriteBitmap();
            if (pendingViewData && !draggingOffset) {
                viewData = pendingViewData;
                void ensureSprite(activeFrame());
            }
            updatePlaypalHint();
            queueRender();
        }
    });

    buildToolbar();
    fitZoom();
    updatePlaypalHint();
    vscode.postMessage({ type: 'ready' });
})();
