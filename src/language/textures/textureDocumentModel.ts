import * as vscode from 'vscode';
import { TexturesParser, TexturesNode, TexturesContext, TexturesParseDiagnostic } from './texturesParser';
import { ResourceIndex, ResourceType } from './resourceIndex';

export interface CompositeSubPatch {
    uri: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    flipX: boolean;
    flipY: boolean;
    rotate: number;
    alpha: number;
}

export interface ResolvedResource {
    uri: string | null;
    width: number;
    height: number;
    resourceType: 'image' | 'composite' | 'missing';
    subPatches?: CompositeSubPatch[];
}

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
        const resolved = this.resolveResourceFull(resourceId, webview);
        return resolved.uri;
    }

    getResourceSize(resourceId: string): { width: number; height: number } | null {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return null; }
        const name = parts[1].toLowerCase();
        const localDef = this.parser.getSymbols().find(
            n => n.name.toLowerCase() === name
        );
        if (localDef && localDef.defData) {
            return { width: localDef.defData.width, height: localDef.defData.height };
        }
        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta || meta.width === undefined || meta.height === undefined) { return null; }
        return { width: meta.width, height: meta.height };
    }

    resolveResourceFull(resourceId: string, webview: vscode.Webview, visited?: Set<string>): ResolvedResource {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }
        const name = parts[1].toLowerCase();

        const v = visited ?? new Set<string>();
        if (v.has(name)) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }

        const localDef = this.parser.getSymbols().find(
            n => n.name.toLowerCase() === name
        );
        if (localDef && localDef.defData && localDef.children.length > 0) {
            v.add(name);
            const subPatches = this.resolveSubPatches(localDef, webview, v);
            return {
                uri: null,
                width: localDef.defData.width,
                height: localDef.defData.height,
                resourceType: 'composite',
                subPatches
            };
        }

        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }

        if (meta.type === ResourceType.TextureDefinition) {
            return {
                uri: null,
                width: meta.width ?? 0,
                height: meta.height ?? 0,
                resourceType: 'composite',
                subPatches: []
            };
        }

        return {
            uri: webview.asWebviewUri(meta.uri).toString(),
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            resourceType: 'image'
        };
    }

    private resolveSubPatches(
        def: TexturesNode,
        webview: vscode.Webview,
        visited: Set<string>
    ): CompositeSubPatch[] {
        const results: CompositeSubPatch[] = [];
        for (const child of def.children) {
            const childResource = this.resolveResourceFull(`patch:${child.name}`, webview, visited);
            if (childResource.resourceType === 'image' && childResource.uri) {
                results.push({
                    uri: childResource.uri,
                    x: child.patchData?.x ?? 0,
                    y: child.patchData?.y ?? 0,
                    width: childResource.width,
                    height: childResource.height,
                    flipX: !!child.patchProps.FlipX,
                    flipY: !!child.patchProps.FlipY,
                    rotate: (child.patchProps.Rotate as number) ?? 0,
                    alpha: (child.patchProps.Alpha as number) ?? 1
                });
            } else if (childResource.resourceType === 'composite' && childResource.subPatches) {
                results.push({
                    uri: null,
                    x: child.patchData?.x ?? 0,
                    y: child.patchData?.y ?? 0,
                    width: childResource.width,
                    height: childResource.height,
                    flipX: !!child.patchProps.FlipX,
                    flipY: !!child.patchProps.FlipY,
                    rotate: (child.patchProps.Rotate as number) ?? 0,
                    alpha: (child.patchProps.Alpha as number) ?? 1
                });
            }
        }
        return results;
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
