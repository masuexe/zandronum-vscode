import * as vscode from 'vscode';
import { SpriteOffset, SpriteImageProvider, AUTO_OFFSET_PRESETS } from './spriteImage';
import { createSpriteProvider } from './spriteProviderFactory';

class SpriteOffsetDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    provider: SpriteImageProvider;
    currentOffset: SpriteOffset;

    constructor(uri: vscode.Uri, provider: SpriteImageProvider) {
        this.uri = uri;
        this.provider = provider;
        this.currentOffset = provider.getOffset();
    }

    dispose(): void {}
}

export class SpriteOffsetEditorProvider implements vscode.CustomEditorProvider<SpriteOffsetDocument> {
    static readonly viewType = 'zandronum.spriteOffsetEditor';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
        vscode.CustomDocumentContentChangeEvent<SpriteOffsetDocument>
    >();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly documents = new Map<string, SpriteOffsetDocument>();
    private readonly webviews = new Map<string, vscode.WebviewPanel>();
    private readonly watcher: vscode.FileSystemWatcher;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.png');
        this.watcher.onDidChange(uri => this.onFileChanged(uri));
        context.subscriptions.push(this.watcher);
    }

    private async onFileChanged(uri: vscode.Uri): Promise<void> {
        const doc = this.documents.get(uri.toString());
        if (!doc) { return; }

        const data = await vscode.workspace.fs.readFile(uri);
        const provider = createSpriteProvider(data, uri);
        if (!provider) { return; }

        doc.provider = provider;
        doc.currentOffset = provider.getOffset();

        const panel = this.webviews.get(uri.toString());
        if (panel) {
            this.postInit(panel.webview, doc);
        }
    }

    async openCustomDocument(uri: vscode.Uri): Promise<SpriteOffsetDocument> {
        const data = await vscode.workspace.fs.readFile(uri);
        const provider = createSpriteProvider(data, uri);
        if (!provider) {
            throw new Error('Unsupported image format');
        }
        const doc = new SpriteOffsetDocument(uri, provider);
        this.documents.set(uri.toString(), doc);
        return doc;
    }

    async resolveCustomEditor(
        document: SpriteOffsetDocument,
        webviewPanel: vscode.WebviewPanel
    ): Promise<void> {
        this.webviews.set(document.uri.toString(), webviewPanel);

        webviewPanel.webview.options = { enableScripts: true };
        webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'ready':
                    this.postInit(webviewPanel.webview, document);
                    break;
                case 'offsetChanged':
                    document.currentOffset = { x: msg.x, y: msg.y };
                    this._onDidChangeCustomDocument.fire({ document });
                    break;
                case 'autoOffset': {
                    const preset = AUTO_OFFSET_PRESETS.find(p => p.id === msg.presetId);
                    if (preset) {
                        const info = document.provider.getInfo();
                        const offset = preset.calculate(info.width, info.height);
                        document.currentOffset = offset;
                        this._onDidChangeCustomDocument.fire({ document });
                        webviewPanel.webview.postMessage({
                            type: 'setOffset',
                            x: offset.x,
                            y: offset.y,
                            hasOffsetData: true
                        });
                    }
                    break;
                }
            }
        });

        webviewPanel.onDidDispose(() => {
            this.webviews.delete(document.uri.toString());
            this.documents.delete(document.uri.toString());
        });
    }

    async saveCustomDocument(document: SpriteOffsetDocument): Promise<void> {
        document.provider.setOffset(document.currentOffset);
        const bytes = document.provider.serialize();
        await vscode.workspace.fs.writeFile(document.uri, bytes);
    }

    async saveCustomDocumentAs(
        document: SpriteOffsetDocument,
        destination: vscode.Uri
    ): Promise<void> {
        document.provider.setOffset(document.currentOffset);
        const bytes = document.provider.serialize();
        await vscode.workspace.fs.writeFile(destination, bytes);
    }

    async revertCustomDocument(document: SpriteOffsetDocument): Promise<void> {
        const data = await vscode.workspace.fs.readFile(document.uri);
        const provider = createSpriteProvider(data, document.uri);
        if (!provider) { return; }

        document.provider = provider;
        document.currentOffset = provider.getOffset();

        const panel = this.webviews.get(document.uri.toString());
        if (panel) {
            this.postInit(panel.webview, document);
        }
    }

    async backupCustomDocument(
        document: SpriteOffsetDocument,
        context: vscode.CustomDocumentBackupContext
    ): Promise<vscode.CustomDocumentBackup> {
        return { id: context.destination.toString(), delete: () => {} };
    }

    private postInit(webview: vscode.Webview, document: SpriteOffsetDocument): void {
        const info = document.provider.getInfo();
        webview.postMessage({
            type: 'init',
            imageSource: document.provider.getImageSource(webview),
            offset: document.currentOffset,
            width: info.width,
            height: info.height,
            hasOffsetData: info.hasOffsetData,
            presets: AUTO_OFFSET_PRESETS.map(p => ({ id: p.id, displayName: p.displayName }))
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'spriteOffsetEditor.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'media', 'spriteOffsetEditor.css')
        );
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="toolbar"></div>
    <div id="info-bar"></div>
    <canvas id="canvas"></canvas>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}

export function registerSpriteOffsetEditor(context: vscode.ExtensionContext): void {
    const provider = new SpriteOffsetEditorProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            SpriteOffsetEditorProvider.viewType,
            provider,
            { supportsMultipleEditorsPerDocument: false }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('zandronum.editSpriteOffset', (uri: vscode.Uri) => {
            if (uri) {
                vscode.commands.executeCommand('vscode.openWith', uri, SpriteOffsetEditorProvider.viewType);
            }
        })
    );
}
