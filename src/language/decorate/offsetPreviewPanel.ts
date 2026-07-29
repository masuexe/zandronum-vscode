import * as vscode from 'vscode';
import { BASE_RESOURCE_SCHEME } from '../../base/baseResourceUri';

/** View DTO sent to the Offset preview webview. */
export interface OffsetPreviewFrameView {
    line: number;
    sprite: string;
    frame: string;
    duration: string;
    offsetX: number;
    offsetY: number;
    /** Delta vs previous frame in the scrub sequence (null for first). */
    deltaX: number | null;
    deltaY: number | null;
    declaredOffsetX: number | null;
    declaredOffsetY: number | null;
    keepX: boolean;
    keepY: boolean;
    offsetIsKeep: boolean;
    resetsToWeaponReady: boolean;
    hasOffsetKeyword: boolean;
    imageUri: string | null;
    /** TEXTURES composite (patches already resolved to webview URIs). */
    composite: {
        width: number;
        height: number;
        subPatches: unknown[];
    } | null;
    grabX: number;
    grabY: number;
    /** Original texture origin (same as grabX/Y at resolve time; webview may preview a different grab). */
    grabOrigX: number;
    grabOrigY: number;
    hasGrab: boolean;
    missingResource: boolean;
    resolvedName: string | null;
}

export interface OffsetPreviewViewData {
    label: string;
    sequenceIndex: number;
    sequenceLength: number;
    frames: OffsetPreviewFrameView[];
    /** Index into `frames` (sequence-local). */
    activeIndex: number;
    /** User-facing warning (wrong-line open, missing context, etc.). */
    warning?: string | null;
    /** PLAYPAL load hint for the webview status strip. */
    playpalStatus?: 'unknown' | 'loaded' | 'missing';
}

export class OffsetPreviewPanel {
    private readonly panel: vscode.WebviewPanel;

    constructor(
        private readonly context: vscode.ExtensionContext,
        onMessage: (msg: any) => void
    ) {
        // Include zandronum-base: so asWebviewUri PNG loads from ZipPackage hit the FSP.
        const localRoots = [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
            vscode.Uri.from({ scheme: BASE_RESOURCE_SCHEME, path: '/' })
        ];

        this.panel = vscode.window.createWebviewPanel(
            'decorateOffsetPreview',
            'Offset Preview',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: localRoots,
                retainContextWhenHidden: true
            }
        );

        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'media', 'offsetPreview.js')
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'media', 'offsetPreview.css')
        );

        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; script-src ${this.panel.webview.cspSource}; img-src ${this.panel.webview.cspSource} data: blob:; connect-src ${this.panel.webview.cspSource};">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="toolbar"></div>
    <div id="main">
        <div id="viewport">
            <canvas id="canvas"></canvas>
        </div>
        <div id="inspector">
            <div class="section">
                <div class="section-title">Frame</div>
                <div class="field-row"><label>Label</label><span id="info-label">—</span></div>
                <div class="field-row"><label>Sprite</label><span id="info-sprite">—</span></div>
                <div class="field-row"><label>Frame</label><span id="info-frame">—</span></div>
                <div class="field-row"><label>Duration</label><span id="info-duration">—</span></div>
                <div class="field-row"><label>Line</label><span id="info-line">—</span></div>
            </div>
            <div class="section">
                <div class="section-title">Offset</div>
                <div class="field-row"><label id="label-coord-x">HUD TL X</label><input type="number" id="input-coord-x" step="1"></div>
                <div class="field-row"><label id="label-coord-y">HUD TL Y (−32)</label><input type="number" id="input-coord-y" step="1"></div>
                <div class="field-row"><label>Offset (PSprite)</label><span id="info-effective">—</span></div>
                <div class="field-row texture-only"><label>HUD TL (Y−32)</label><span id="info-hud-tl">—</span></div>
                <div class="field-row"><label>Δ vs prev</label><span id="info-delta">—</span></div>
                <div class="field-row"><label>Declared</label><span id="info-declared">—</span></div>
                <div class="field-row"><label>Origin (original)</label><span id="info-grab">—</span></div>
                <div class="field-row texture-only"><label>Δ texture</label><span id="info-grab-delta">—</span></div>
                <div class="field-row texture-only"><label>→ Offset</label><span id="info-computed-offset">—</span></div>
                <div class="texture-actions texture-only">
                    <button type="button" id="btn-apply-texture" title="Write computed Offset to DECORATE">Apply to Offset</button>
                    <button type="button" id="btn-reset-texture" title="Discard preview grab">Reset</button>
                </div>
                <div class="hint" id="info-hint">HUD TL = sprite corner; Y minus 32 (weapon rest). Offset (PSprite) = DECORATE / red crosshair.</div>
                <div class="hint" id="info-playpal">PLAYPAL: —</div>
                <div class="hint warn" id="info-warning" hidden></div>
            </div>
            <div class="section">
                <div class="section-title">Sequence</div>
                <div class="field-row"><label>Index</label><span id="info-seq">—</span></div>
                <input type="range" id="scrub" min="0" max="0" value="0" step="1">
                <div class="scrub-actions">
                    <button type="button" id="btn-play" title="Play / Pause (Space)">▶ Play</button>
                    <button type="button" id="btn-prev" title="Previous">◀</button>
                    <button type="button" id="btn-next" title="Next">▶</button>
                    <button type="button" id="btn-reveal" title="Reveal in editor">Reveal</button>
                </div>
            </div>
        </div>
    </div>
    <div id="status"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;

        this.panel.webview.onDidReceiveMessage(onMessage);
    }

    get webview(): vscode.Webview {
        return this.panel.webview;
    }

    setTitle(title: string): void {
        this.panel.title = title;
    }

    reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Beside);
    }

    onDidDispose(cb: () => void): void {
        this.panel.onDidDispose(cb);
    }

    dispose(): void {
        this.panel.dispose();
    }

    postMessage(msg: unknown): void {
        void this.panel.webview.postMessage(msg);
    }

    sendView(data: OffsetPreviewViewData): void {
        this.postMessage({ type: 'update', data });
    }

    sendPalette(rgb: number[] | null): void {
        this.postMessage({ type: 'palette', rgb });
    }
}
