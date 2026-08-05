(function () {
    // @ts-ignore
    const vscode = acquireVsCodeApi();

    // Weapon HUD (Zandronum PSprite — matches r_things.cpp R_DrawPSprite):
    //   grAb column at screen x = sx; grAb row at screen y = sy
    //   (sprite left edge = sx - grabX, top edge = sy - grabY)
    // Default resting weapon position: sx=0, sy=WEAPONTOP=32.375
    //   (p_pspr.h: WEAPONTOP = 32*FRACUNIT+0x6000, set by A_WeaponReady each tic).
    const WEAPON_REF_W = 320;
    const WEAPON_REF_H = 200;
    const WEAPON_ANCHOR_X = 0;
    const WEAPON_ANCHOR_Y = 32.375;
    const WEAPON_STATUS_BAR_Y = 168;
    // Mirror axis = screen center (160, 100). These are the frame-coordinate distances
    // from the grAb anchor (0, WEAPONTOP) to the screen center; mirroring in weapon mode
    // shifts the offset by -2*CX / -2*CY so the mirrored image lands mirrored about the
    // screen center while its grAb stays anchored at (0, WEAPONTOP).
    const WEAPON_MIRROR_CX = WEAPON_REF_W / 2 - WEAPON_ANCHOR_X;  // 160
    const WEAPON_MIRROR_CY = WEAPON_REF_H / 2 - WEAPON_ANCHOR_Y;  // 67.625

    let state = vscode.getState() || {
        background: 'checkered',
        viewMode: 'sprite'
    };

    let imageSource = '';
    let imageWidth = 0;
    let imageHeight = 0;
    let offsetX = 0;
    let offsetY = 0;
    let hasOffsetData = false;
    let presets = [];
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let img = null;
    let imgLoaded = false;
    let flipH = false;
    let flipV = false;

    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const toolbar = document.getElementById('toolbar');
    const infoBar = document.getElementById('info-bar');

    let dragging = false;
    let panning = false;
    let lastMouseX = 0;
    let lastMouseY = 0;
    let dragStartOffsetX = 0;
    let dragStartOffsetY = 0;
    let dragStartMouseX = 0;
    let dragStartMouseY = 0;
    let renderQueued = false;
    let canvasW = 0;
    let canvasH = 0;

    function saveState() {
        vscode.setState({ background: state.background, viewMode: state.viewMode });
    }

    function buildToolbar() {
        toolbar.innerHTML = '';

        const modeBtn = createButton(
            state.viewMode === 'sprite' ? 'Sprite' : 'Weapon',
            () => {
                state.viewMode = state.viewMode === 'sprite' ? 'weapon' : 'sprite';
                saveState();
                buildToolbar();
                fitZoom();
                render();
            }
        );
        toolbar.appendChild(modeBtn);

        toolbar.appendChild(createSeparator());

        const bgLabels = { checkered: 'BG: Check', dark: 'BG: Dark', light: 'BG: Light' };
        const bgBtn = createButton(bgLabels[state.background] || 'BG: Check', () => {
            const order = ['checkered', 'dark', 'light'];
            const idx = order.indexOf(state.background);
            state.background = order[(idx + 1) % order.length];
            saveState();
            buildToolbar();
            render();
        });
        toolbar.appendChild(bgBtn);

        toolbar.appendChild(createSeparator());

        const fitBtn = createButton('Fit', () => { fitZoom(); render(); });
        toolbar.appendChild(fitBtn);

        const oneBtn = createButton('1:1', () => { zoom = 1; panX = 0; panY = 0; render(); });
        toolbar.appendChild(oneBtn);

        toolbar.appendChild(createSeparator());

        for (const preset of presets) {
            const btn = createButton(preset.displayName, () => {
                vscode.postMessage({ type: 'autoOffset', presetId: preset.id });
            });
            toolbar.appendChild(btn);
        }

        toolbar.appendChild(createSeparator());

        toolbar.appendChild(createButton('Mirror H', () => { mirrorImage('h'); }));
        toolbar.appendChild(createButton('Mirror V', () => { mirrorImage('v'); }));
    }

    function mirrorImage(axis) {
        if (axis === 'h') {
            flipH = !flipH;
            if (state.viewMode === 'weapon') {
                // Mirror about the screen (320x200 frame) vertical center, not the image
                // box: the image lands on the opposite side of the screen while its grAb
                // stays anchored at (0, WEAPONTOP). offsetX' = W - 1 - 2*CX - offsetX.
                offsetX = Math.round(imageWidth - 1 - 2 * WEAPON_MIRROR_CX - offsetX);
            }
        } else {
            flipV = !flipV;
            if (state.viewMode === 'weapon') {
                offsetY = Math.round(imageHeight - 1 - 2 * WEAPON_MIRROR_CY - offsetY);
            }
        }
        vscode.postMessage({ type: 'mirrorImage', axis, x: offsetX, y: offsetY });
        render();
    }

    function createButton(text, onclick) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.addEventListener('click', onclick);
        return btn;
    }

    function createSeparator() {
        const sep = document.createElement('div');
        sep.className = 'separator';
        return sep;
    }

    function updateInfoBar() {
        const stored = hasOffsetData ? 'Stored' : 'Generated';
        infoBar.innerHTML =
            `<span><span class="label">Offset:</span> (${offsetX}, ${offsetY}) [${stored}]</span>` +
            `<span><span class="label">Zoom:</span> ${Math.round(zoom * 100)}%</span>` +
            `<span><span class="label">Image:</span> ${imageWidth}\u00d7${imageHeight}</span>` +
            `<span><span class="label">Mode:</span> ${state.viewMode === 'sprite' ? 'Sprite' : 'Weapon'}</span>`;
    }

    function fitZoom() {
        if (!imageWidth || !imageHeight) { return; }
        if (!canvasW || !canvasH) {
            const rect = canvas.getBoundingClientRect();
            canvasW = rect.width;
            canvasH = rect.height;
        }
        const margin = 60;
        const fitW = state.viewMode === 'weapon' ? WEAPON_REF_W : imageWidth;
        const fitH = state.viewMode === 'weapon' ? WEAPON_REF_H : imageHeight;
        zoom = Math.min((canvasW - margin) / fitW, (canvasH - margin) / fitH, 8);
        zoom = Math.max(zoom, 0.1);
        panX = 0;
        panY = 0;
    }

    function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        const w = rect.width * devicePixelRatio;
        const h = rect.height * devicePixelRatio;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            canvasW = rect.width;
            canvasH = rect.height;
        }
        ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    function scheduleRender() {
        if (!renderQueued) {
            renderQueued = true;
            requestAnimationFrame(() => {
                renderQueued = false;
                render();
            });
        }
    }

    function getOriginScreen() {
        return { x: canvasW / 2 + panX, y: canvasH / 2 + panY };
    }

    function render() {
        resizeCanvas();
        const cw = canvasW;
        const ch = canvasH;

        drawBackground(cw, ch);

        const origin = getOriginScreen();

        if (state.viewMode === 'weapon') {
            drawWeaponFrame(origin);
        }

        if (imgLoaded && img) {
            const imgX = (state.viewMode === 'weapon'
                ? origin.x - (WEAPON_REF_W / 2) * zoom + WEAPON_ANCHOR_X * zoom - offsetX * zoom
                : origin.x - offsetX * zoom);
            const imgY = (state.viewMode === 'weapon'
                ? origin.y - (WEAPON_REF_H / 2) * zoom + WEAPON_ANCHOR_Y * zoom - offsetY * zoom
                : origin.y - offsetY * zoom);
            ctx.imageSmoothingEnabled = zoom < 1;
            ctx.save();
            ctx.translate(
                imgX + (flipH ? imageWidth * zoom : 0),
                imgY + (flipV ? imageHeight * zoom : 0)
            );
            if (flipH) { ctx.scale(-1, 1); }
            if (flipV) { ctx.scale(1, -1); }
            ctx.drawImage(img, 0, 0, imageWidth * zoom, imageHeight * zoom);
            ctx.restore();
        }

        drawOriginCross(origin, cw, ch);

        if (state.viewMode === 'sprite') {
            drawFloorLine(origin, cw);
        }

        updateInfoBar();
    }

    function drawBackground(cw, ch) {
        if (state.background === 'dark') {
            ctx.fillStyle = '#1e1e1e';
            ctx.fillRect(0, 0, cw, ch);
        } else if (state.background === 'light') {
            ctx.fillStyle = '#c0c0c0';
            ctx.fillRect(0, 0, cw, ch);
        } else {
            const size = 8;
            for (let y = 0; y < ch; y += size) {
                for (let x = 0; x < cw; x += size) {
                    const even = ((Math.floor(x / size) + Math.floor(y / size)) % 2) === 0;
                    ctx.fillStyle = even ? '#3c3c3c' : '#2c2c2c';
                    ctx.fillRect(x, y, size, size);
                }
            }
        }
    }

    function drawOriginCross(origin, cw, ch) {
        ctx.strokeStyle = 'rgba(255, 255, 0, 0.7)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        ctx.moveTo(0, origin.y);
        ctx.lineTo(cw, origin.y);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(origin.x, 0);
        ctx.lineTo(origin.x, ch);
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

    function drawFloorLine(origin, cw) {
        ctx.strokeStyle = 'rgba(0, 200, 0, 0.8)';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, origin.y);
        ctx.lineTo(cw, origin.y);
        ctx.stroke();
    }

    // 320x200 screen frame centered on the canvas (screen center = (160,100) at origin).
    function drawWeaponFrame(origin) {
        const w = WEAPON_REF_W * zoom;
        const h = WEAPON_REF_H * zoom;
        const fx = origin.x - (WEAPON_REF_W / 2) * zoom;
        const fy = origin.y - (WEAPON_REF_H / 2) * zoom;

        // Screen outline
        ctx.strokeStyle = 'rgba(100, 150, 255, 0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(fx, fy, w, h);
        ctx.setLineDash([]);

        // Status bar top (y=168; the view is cut off there in fullscreen)
        ctx.strokeStyle = 'rgba(120, 160, 220, 0.5)';
        ctx.beginPath();
        ctx.moveTo(fx, fy + WEAPON_STATUS_BAR_Y * zoom);
        ctx.lineTo(fx + w, fy + WEAPON_STATUS_BAR_Y * zoom);
        ctx.stroke();

        // grAb anchor column (x=0) and resting weapon line (y=WEAPONTOP)
        const anchorX = fx + WEAPON_ANCHOR_X * zoom;
        const restY = fy + WEAPON_ANCHOR_Y * zoom;
        ctx.strokeStyle = 'rgba(255, 200, 80, 0.45)';
        ctx.beginPath();
        ctx.moveTo(anchorX, fy);
        ctx.lineTo(anchorX, fy + h);
        ctx.moveTo(fx, restY);
        ctx.lineTo(fx + w, restY);
        ctx.stroke();

        // Marker where the sprite's offset pixel lands
        ctx.strokeStyle = 'rgba(255, 220, 100, 0.9)';
        ctx.beginPath();
        ctx.moveTo(anchorX - 6, restY);
        ctx.lineTo(anchorX + 6, restY);
        ctx.moveTo(anchorX, restY - 6);
        ctx.lineTo(anchorX, restY + 6);
        ctx.stroke();
    }

    function notifyOffsetChanged() {
        hasOffsetData = true;
        vscode.postMessage({ type: 'offsetChanged', x: offsetX, y: offsetY });
    }

    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
            panning = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            canvas.classList.add('dragging');
            e.preventDefault();
        } else if (e.button === 0) {
            dragging = true;
            dragStartMouseX = e.clientX;
            dragStartMouseY = e.clientY;
            dragStartOffsetX = offsetX;
            dragStartOffsetY = offsetY;
            canvas.classList.add('dragging');
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (panning) {
            panX += e.clientX - lastMouseX;
            panY += e.clientY - lastMouseY;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
            scheduleRender();
        } else if (dragging) {
            const totalDx = e.clientX - dragStartMouseX;
            const totalDy = e.clientY - dragStartMouseY;
            const newX = Math.round(dragStartOffsetX - totalDx / zoom);
            const newY = Math.round(dragStartOffsetY - totalDy / zoom);
            if (newX !== offsetX || newY !== offsetY) {
                offsetX = newX;
                offsetY = newY;
                notifyOffsetChanged();
            }
            scheduleRender();
        }
    });

    window.addEventListener('mouseup', () => {
        dragging = false;
        panning = false;
        canvas.classList.remove('dragging');
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const oldZoom = zoom;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        zoom = Math.min(Math.max(zoom * factor, 0.1), 64);

        const origin = getOriginScreen();
        panX += (mouseX - origin.x) * (1 - zoom / oldZoom);
        panY += (mouseY - origin.y) * (1 - zoom / oldZoom);

        scheduleRender();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 8 : 1;
        let handled = true;
        switch (e.key) {
            case 'ArrowLeft': offsetX += step; break;
            case 'ArrowRight': offsetX -= step; break;
            case 'ArrowUp': offsetY += step; break;
            case 'ArrowDown': offsetY -= step; break;
            default: handled = false;
        }
        if (handled) {
            e.preventDefault();
            notifyOffsetChanged();
            render();
        }
    });

    window.addEventListener('message', (e) => {
        const msg = e.data;
        switch (msg.type) {
            case 'init':
                imageSource = msg.imageSource;
                offsetX = msg.offset.x;
                offsetY = msg.offset.y;
                imageWidth = msg.width;
                imageHeight = msg.height;
                hasOffsetData = msg.hasOffsetData;
                flipH = !!(msg.flipped && msg.flipped.h);
                flipV = !!(msg.flipped && msg.flipped.v);
                presets = msg.presets || [];
                loadImage();
                buildToolbar();
                break;
            case 'setOffset':
                offsetX = msg.x;
                offsetY = msg.y;
                if (msg.hasOffsetData !== undefined) { hasOffsetData = msg.hasOffsetData; }
                render();
                break;
        }
    });

    function loadImage() {
        img = new Image();
        img.onload = () => {
            imgLoaded = true;
            fitZoom();
            render();
        };
        img.onerror = () => {
            imgLoaded = false;
            render();
        };
        img.src = imageSource;
    }

    window.addEventListener('resize', () => { scheduleRender(); });

    vscode.postMessage({ type: 'ready' });
})();
