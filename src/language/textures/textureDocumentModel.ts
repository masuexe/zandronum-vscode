import * as vscode from 'vscode';
import { TexturesParser, TexturesNode, TexturesContext, TexturesParseDiagnostic } from './texturesParser';
import { ResourceIndex } from './resourceIndex';

export class TextureDocumentModel {
    readonly document: vscode.TextDocument;
    private readonly parser: TexturesParser;
    private readonly resourceIndex: ResourceIndex;

    constructor(
        document: vscode.TextDocument,
        parser: TexturesParser,
        resourceIndex: ResourceIndex
    ) {
        this.document = document;
        this.parser = parser;
        this.resourceIndex = resourceIndex;
    }

    get version(): number {
        return this.document.version;
    }

    update(): void {
        this.parser.update(this.document);
    }

    getTextures(): TexturesNode[] {
        return this.parser.getSymbols();
    }

    getTextureByName(name: string): TexturesNode | undefined {
        const lower = name.toLowerCase();
        return this.parser.getSymbols().find(n => n.name.toLowerCase() === lower);
    }

    getNodeById(id: string): TexturesNode | undefined {
        return this.parser.getNodeById(id);
    }

    getNodeAtPosition(position: vscode.Position): TexturesNode | undefined {
        return this.parser.getNodeAtPosition(position);
    }

    getContext(position: vscode.Position): TexturesContext {
        return this.parser.getContextAtPosition(position);
    }

    resolveResource(resourceId: string, webview: vscode.Webview): string | null {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return null; }
        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta) { return null; }
        return webview.asWebviewUri(meta.uri).toString();
    }

    getResourceSize(resourceId: string): { width: number; height: number } | null {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return null; }
        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta || meta.width === undefined || meta.height === undefined) { return null; }
        return { width: meta.width, height: meta.height };
    }

    async applyPatchMove(
        patchId: string,
        x: number,
        y: number,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }

        const node = this.parser.getNodeById(patchId);
        if (!node || !node.xRange || !node.yRange) { return false; }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, node.xRange, String(x));
        edit.replace(this.document.uri, node.yRange, String(y));
        return vscode.workspace.applyEdit(edit);
    }

    validate(): TexturesParseDiagnostic[] {
        return this.parser.getDiagnostics();
    }
}
