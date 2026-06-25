import * as vscode from 'vscode';
import { TexturesParser, TexturesNode, TexturesNodeKind } from './texturesParser';
import { ResourceIndex } from './resourceIndex';
import { TextureDocumentModel } from './textureDocumentModel';
import { SelectionModel } from './selectionModel';
import { TextureEditorPanel, TextureViewData, PatchViewData } from './textureEditorPanel';

function buildTextureViewData(node: TexturesNode, modelVersion: number): TextureViewData {
    return {
        name: node.name,
        width: node.defData?.width ?? 0,
        height: node.defData?.height ?? 0,
        textureType: node.type,
        originX: 0,
        originY: 0,
        revision: modelVersion,
        patches: node.children.map(child => ({
            id: child.id,
            name: child.name,
            x: child.patchData?.x ?? 0,
            y: child.patchData?.y ?? 0,
            resourceId: `patch:${child.name}`,
            props: { ...child.patchProps },
            sourceRange: {
                startLine: child.range.start.line,
                endLine: child.range.end.line
            }
        }))
    };
}

export class TextureDocumentController {
    private readonly model: TextureDocumentModel;
    private readonly resourceIndex: ResourceIndex;
    readonly selection: SelectionModel;
    private panel: TextureEditorPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        document: vscode.TextDocument,
        parser: TexturesParser,
        resourceIndex: ResourceIndex,
        private readonly extensionContext: vscode.ExtensionContext
    ) {
        this.resourceIndex = resourceIndex;
        this.model = new TextureDocumentModel(document, parser, resourceIndex);
        this.selection = new SelectionModel();
        this.model.update();

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document === this.model.document) {
                    this.onDocumentChanged();
                }
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (e.textEditor.document === this.model.document) {
                    this.onSelectionChanged(e);
                }
            })
        );
    }

    openEditor(textureName: string): void {
        this.selection.selectedTextureName = textureName;

        if (this.panel) {
            this.panel.reveal();
            this.sendCurrentTexture();
            return;
        }

        this.panel = new TextureEditorPanel(
            this.extensionContext,
            msg => this.onPanelMessage(msg)
        );

        this.panel.setTitle(`Texture: ${textureName}`);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    dispose(): void {
        this.panel?.dispose();
        this.selection.dispose();
        for (const d of this.disposables) { d.dispose(); }
    }

    private onDocumentChanged(): void {
        this.model.update();
        if (!this.panel) { return; }

        const textures = this.model.getTextures().map(n => n.name);
        const selected = this.selection.selectedTextureName;

        if (selected && this.model.getTextureByName(selected)) {
            this.sendCurrentTexture();
        } else {
            this.panel.sendUpdateList(textures, selected ?? '');
        }
    }

    private onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
        if (!this.panel) { return; }
        const pos = e.selections[0]?.active;
        if (!pos) { return; }

        const node = this.model.getNodeAtPosition(pos);
        if (node && node.kind === TexturesNodeKind.Patch) {
            this.panel.sendHighlightPatch(node.id);
        } else {
            this.panel.sendHighlightPatch(null);
        }
    }

    private onPanelMessage(msg: any): void {
        switch (msg.type) {
            case 'ready':
                this.sendInit();
                break;
            case 'selectTexture':
                this.selection.selectedTextureName = msg.name;
                this.sendCurrentTexture();
                break;
            case 'movePatch':
                this.model.applyPatchMove(msg.patchId, msg.x, msg.y, msg.modelVersion);
                break;
            case 'resolveResource':
                this.handleResolveResource(msg.resourceId);
                break;
            case 'selectPatch':
                this.selection.selectedPatchId = msg.patchId;
                this.revealNode(msg.patchId, false);
                break;
            case 'revealSource':
                this.revealNode(msg.patchId, true);
                break;
        }
    }

    private sendInit(): void {
        if (!this.panel) { return; }
        const textures = this.model.getTextures().map(n => n.name);
        const name = this.selection.selectedTextureName;
        const node = name ? this.model.getTextureByName(name) : undefined;
        if (node) {
            this.panel.sendInit(textures, buildTextureViewData(node, this.model.version));
        }
    }

    private sendCurrentTexture(): void {
        if (!this.panel) { return; }
        const name = this.selection.selectedTextureName;
        if (!name) { return; }
        const node = this.model.getTextureByName(name);
        if (!node) { return; }
        this.panel.setTitle(`Texture: ${name}`);
        this.panel.sendUpdateTexture(buildTextureViewData(node, this.model.version));
    }

    private async handleResolveResource(resourceId: string): Promise<void> {
        if (!this.panel) { return; }
        await this.resourceIndex.whenReady();
        const resolved = this.model.resolveResourceFull(resourceId, this.panel.webview);
        this.panel.sendResourceResolved(
            resourceId,
            resolved.uri,
            resolved.width,
            resolved.height,
            resolved.resourceType,
            resolved.subPatches
        );
    }

    private revealNode(patchId: string, select: boolean): void {
        const node = this.model.getNodeById(patchId);
        if (!node) { return; }
        vscode.window.showTextDocument(this.model.document, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: !select
        }).then(editor => {
            const range = select ? node.range : new vscode.Range(node.range.start, node.range.start);
            editor.revealRange(node.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            if (select) {
                editor.selection = new vscode.Selection(range.start, range.start);
            }
        });
    }
}

export class TextureEditorRegistry {
    private readonly controllers = new Map<string, TextureDocumentController>();

    open(
        document: vscode.TextDocument,
        textureName: string,
        parser: TexturesParser,
        resourceIndex: ResourceIndex,
        context: vscode.ExtensionContext
    ): void {
        const key = document.uri.toString();
        let controller = this.controllers.get(key);
        if (!controller) {
            controller = new TextureDocumentController(document, parser, resourceIndex, context);
            this.controllers.set(key, controller);
        }
        controller.openEditor(textureName);
    }

    get(document: vscode.TextDocument): TextureDocumentController | undefined {
        return this.controllers.get(document.uri.toString());
    }

    dispose(): void {
        for (const c of this.controllers.values()) {
            c.dispose();
        }
        this.controllers.clear();
    }
}
