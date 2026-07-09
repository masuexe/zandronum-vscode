import * as vscode from 'vscode';
import { PatchProperties } from './texturesParser';
import { CompositeSubPatch } from './textureDocumentModel';

export interface PatchViewData {
    id: string;
    name: string;
    x: number;
    y: number;
    resourceId: string;
    props: PatchProperties;
    sourceRange: { startLine: number; endLine: number };
}

/** View DTO sent to the texture editor webview. */
export interface TextureViewData {
    name: string;
    width: number;
    height: number;
    textureType: string;
    /** TEXTURES Offset X (not a canvas origin). */
    offsetX: number;
    /** TEXTURES Offset Y (not a canvas origin). */
    offsetY: number;
    xScale: number;
    yScale: number;
    worldPanning: boolean;
    noDecals: boolean;
    nullTexture: boolean;
    revision: number;
    patches: PatchViewData[];
}

export class TextureEditorPanel {
    private readonly panel: vscode.WebviewPanel;

    constructor(
        private readonly context: vscode.ExtensionContext,
        onMessage: (msg: any) => void
    ) {
        const localRoots = [
            vscode.Uri.joinPath(context.extensionUri, 'media'),
            ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])
        ];

        this.panel = vscode.window.createWebviewPanel(
            'textureEditor',
            'Texture Editor',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: localRoots,
                retainContextWhenHidden: true
            }
        );

        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'media', 'textureEditor.js')
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'media', 'textureEditor.css')
        );

        this.panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="toolbar"></div>
    <div id="main">
        <div id="texture-list"></div>
        <div id="viewport">
            <canvas id="baseCanvas"></canvas>
            <canvas id="overlayCanvas"></canvas>
        </div>
        <div id="inspector">
            <div class="section">
                <div class="section-title">Texture</div>
                <div class="field-row"><label>Type</label><span id="tex-type">—</span></div>
                <div class="field-row"><label>Width</label><input type="number" id="tex-width" step="1"></div>
                <div class="field-row"><label>Height</label><input type="number" id="tex-height" step="1"></div>
                <div class="field-row"><label>Offset X</label><input type="number" id="tex-offx" step="1"></div>
                <div class="field-row"><label>Offset Y</label><input type="number" id="tex-offy" step="1"></div>
                <div class="field-row"><label>XScale</label><input type="number" id="tex-xscale" step="0.1" min="0.01"></div>
                <div class="field-row"><label>YScale</label><input type="number" id="tex-yscale" step="0.1" min="0.01"></div>
            </div>
            <div class="section">
                <div class="section-title">
                    Patches
                    <span class="patch-actions">
                        <button type="button" id="btn-patch-add" title="Add">+</button>
                        <button type="button" id="btn-patch-remove" title="Remove">−</button>
                        <button type="button" id="btn-patch-up" title="Move up">↑</button>
                        <button type="button" id="btn-patch-down" title="Move down">↓</button>
                        <button type="button" id="btn-patch-dup" title="Duplicate">⧉</button>
                    </span>
                </div>
                <div id="patch-list"></div>
            </div>
            <div class="section" id="patch-props-section">
                <div class="section-title">Selected Patch</div>
                <div class="field-row"><label>Name</label><span id="patch-name">—</span></div>
                <div class="field-row"><label>X</label><input type="number" id="patch-x" step="1"></div>
                <div class="field-row"><label>Y</label><input type="number" id="patch-y" step="1"></div>
                <div class="field-row"><label>Flip X</label><input type="checkbox" id="patch-flipx"></div>
                <div class="field-row"><label>Flip Y</label><input type="checkbox" id="patch-flipy"></div>
                <div class="field-row"><label>Rotate</label>
                    <select id="patch-rotate">
                        <option value="0">0</option>
                        <option value="90">90</option>
                        <option value="180">180</option>
                        <option value="270">270</option>
                    </select>
                </div>
                <div class="field-row"><label>Alpha</label><input type="number" id="patch-alpha" step="0.05" min="0" max="1"></div>
                <div class="field-row"><label>Use Offsets</label><input type="checkbox" id="patch-useoffsets"></div>
            </div>
        </div>
    </div>
    <div id="info-bar"></div>
    <script src="${scriptUri}"></script>
</body>
</html>`;

        this.panel.webview.onDidReceiveMessage(onMessage);
    }

    sendInit(textures: string[], selected: TextureViewData): void {
        this.panel.webview.postMessage({ type: 'init', textures, selected });
    }

    /** Send PLAYPAL as flat [r,g,b, r,g,b, ...] (256*3 bytes as numbers). */
    sendPalette(rgb: number[] | null): void {
        this.panel.webview.postMessage({ type: 'palette', rgb });
    }

    sendUpdateTexture(data: TextureViewData): void {
        this.panel.webview.postMessage({ type: 'updateTexture', texture: data });
    }

    sendUpdateList(textures: string[], selectedName: string): void {
        this.panel.webview.postMessage({ type: 'updateList', textures, selectedName });
    }

    sendResourceResolved(
        resourceId: string,
        uri: string | null,
        width: number,
        height: number,
        resourceType: 'image' | 'composite' | 'missing' = 'missing',
        subPatches?: CompositeSubPatch[],
        grabOffset?: { x: number; y: number } | null
    ): void {
        this.panel.webview.postMessage({
            type: 'resourceResolved',
            resourceId,
            uri,
            width,
            height,
            resourceType,
            subPatches,
            grabOffset: grabOffset ?? null
        });
    }

    sendHighlightPatch(patchId: string | null): void {
        this.panel.webview.postMessage({ type: 'highlightPatch', patchId });
    }

    sendEditResult(ok: boolean, reason?: string): void {
        this.panel.webview.postMessage({ type: 'editResult', ok, reason });
    }

    sendImageNames(names: string[]): void {
        this.panel.webview.postMessage({ type: 'imageNames', names });
    }

    setTitle(title: string): void {
        this.panel.title = title;
    }

    get webview(): vscode.Webview {
        return this.panel.webview;
    }

    get isVisible(): boolean {
        return this.panel.visible;
    }

    onDidDispose(callback: () => void): void {
        this.panel.onDidDispose(callback);
    }

    reveal(): void {
        this.panel.reveal();
    }

    dispose(): void {
        this.panel.dispose();
    }
}
