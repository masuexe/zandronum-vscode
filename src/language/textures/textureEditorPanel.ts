import * as vscode from 'vscode';
import { PatchProperties } from './texturesParser';

export interface PatchViewData {
    id: string;
    name: string;
    x: number;
    y: number;
    resourceId: string;
    props: PatchProperties;
    sourceRange: { startLine: number; endLine: number };
}

export interface TextureViewData {
    name: string;
    width: number;
    height: number;
    textureType: string;
    originX: number;
    originY: number;
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
                localResourceRoots: localRoots
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
        height: number
    ): void {
        this.panel.webview.postMessage({
            type: 'resourceResolved', resourceId, uri, width, height
        });
    }

    sendHighlightPatch(patchId: string | null): void {
        this.panel.webview.postMessage({ type: 'highlightPatch', patchId });
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
