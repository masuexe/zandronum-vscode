import * as vscode from 'vscode';
import { TexturesParser, TexturesNode, TexturesNodeKind } from './texturesParser';
import { ResourceIndex } from './resourceIndex';
import { TextureDocumentModel, PatchPropUpdate, TexturePropUpdate } from './textureDocumentModel';
import { SelectionModel } from './selectionModel';
import { TextureEditorPanel, TextureViewData } from './textureEditorPanel';
import { loadPlaypal } from '../../tools/playpalReader';

function buildTextureViewData(node: TexturesNode, modelVersion: number): TextureViewData {
    const offsetX = node.texProps.OffsetX ?? 0;
    const offsetY = node.texProps.OffsetY ?? 0;
    return {
        name: node.name,
        width: node.defData?.width ?? 0,
        height: node.defData?.height ?? 0,
        textureType: node.type,
        offsetX,
        offsetY,
        xScale: node.texProps.XScale ?? 1,
        yScale: node.texProps.YScale ?? 1,
        worldPanning: !!node.texProps.WorldPanning,
        noDecals: !!node.texProps.NoDecals,
        nullTexture: !!node.texProps.NullTexture,
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
    readonly documentUri: string;

    constructor(
        document: vscode.TextDocument,
        parser: TexturesParser,
        resourceIndex: ResourceIndex,
        private readonly extensionContext: vscode.ExtensionContext
    ) {
        this.documentUri = document.uri.toString();
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
            this.selection.selectedPatchId = node.id;
            this.panel.sendHighlightPatch(node.id);
        } else {
            this.panel.sendHighlightPatch(null);
        }
    }

    private async onPanelMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.sendPalette();
                this.sendInit();
                break;
            case 'selectTexture':
                this.selection.selectedTextureName = msg.name;
                this.sendCurrentTexture();
                break;
            case 'movePatch': {
                const ok = await this.model.applyPatchMove(msg.patchId, msg.x, msg.y, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid patch');
                break;
            }
            case 'moveTextureOffset': {
                const name = this.selection.selectedTextureName;
                if (!name) { break; }
                const ok = await this.model.applyTextureOffset(name, msg.offsetX, msg.offsetY, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict');
                break;
            }
            case 'updateTextureProps': {
                const name = this.selection.selectedTextureName;
                if (!name) { break; }
                const props: TexturePropUpdate = msg.props ?? {};
                const ok = await this.model.applyTextureProps(name, props, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict');
                break;
            }
            case 'resizeTexture': {
                const name = this.selection.selectedTextureName;
                if (!name) { break; }
                const ok = await this.model.resizeTexture(name, {
                    width: msg.width,
                    height: msg.height,
                    offsetX: msg.offsetX,
                    offsetY: msg.offsetY,
                    patchDx: msg.patchDx,
                    patchDy: msg.patchDy
                }, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid resize');
                break;
            }
            case 'trimTexture': {
                const name = this.selection.selectedTextureName;
                if (!name) { break; }
                const ok = await this.model.trimTextureToPatches(name, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or nothing to trim');
                break;
            }
            case 'updatePatchProps': {
                const props: PatchPropUpdate = msg.props ?? {};
                const ok = await this.model.applyPatchProps(msg.patchId, props, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid patch');
                break;
            }
            case 'addPatch':
                await this.handleAddPatch(msg.modelVersion);
                break;
            case 'removePatch': {
                const ok = await this.model.removePatch(msg.patchId, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict');
                break;
            }
            case 'reorderPatch': {
                const ok = await this.model.reorderPatch(msg.patchId, msg.direction, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'cannot reorder');
                break;
            }
            case 'duplicatePatch': {
                const ok = await this.model.duplicatePatch(msg.patchId, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict');
                break;
            }
            case 'mirrorPatch': {
                // Back-compat: texture mid + mirror copy
                const direction = msg.axis === 'v' ? 'v' : 'h';
                const ok = await this.model.symmetryPatch(msg.patchId, {
                    direction,
                    ref: 'texture',
                    mode: 'copy',
                    offsetType: 'none'
                }, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid patch');
                break;
            }
            case 'symmetryPatch': {
                const direction = msg.direction === 'v' ? 'v' : 'h';
                const ref = msg.ref === 'screen' ? 'screen' : 'texture';
                const mode = msg.mode === 'reflect' ? 'reflect' : 'copy';
                const offsetType = msg.offsetType === 'sprite' || msg.offsetType === 'hud'
                    ? msg.offsetType
                    : 'none';
                const ok = await this.model.symmetryPatch(msg.patchId, {
                    direction, ref, mode, offsetType
                }, msg.modelVersion);
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid symmetry');
                break;
            }
            case 'reflectTexture': {
                const name = this.selection.selectedTextureName;
                if (!name) { break; }
                const direction = msg.direction === 'v' ? 'v' : 'h';
                const offsetType = msg.offsetType === 'hud' ? 'hud' : 'sprite';
                const ok = await this.model.reflectTextureAboutScreen(
                    name, direction, offsetType, msg.modelVersion
                );
                this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict or invalid reflect');
                break;
            }
            case 'resolveResource':
                await this.handleResolveResource(msg.resourceId);
                break;
            case 'selectPatch':
                // Selection stays in the visual editor only; do not jump to source.
                this.selection.selectedPatchId = msg.patchId;
                break;
            case 'revealSource':
                this.revealNode(msg.patchId, true);
                break;
            case 'requestImageNames':
                this.panel?.sendImageNames(this.model.listImageNames());
                break;
        }
    }

    private async handleAddPatch(modelVersion: number): Promise<void> {
        const name = this.selection.selectedTextureName;
        if (!name) { return; }

        const images = this.model.listImageNames();
        const items: vscode.QuickPickItem[] = [
            ...images.map(n => ({ label: n })),
            { label: '$(edit) Enter name…', description: 'Type a custom patch name' }
        ];
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select patch graphic'
        });
        if (!picked) { return; }

        let patchName = picked.label;
        if (picked.label.startsWith('$(edit)')) {
            const typed = await vscode.window.showInputBox({
                prompt: 'Patch name',
                validateInput: v => v.trim() ? undefined : 'Name required'
            });
            if (!typed) { return; }
            patchName = typed.trim();
        }

        const ok = await this.model.addPatch(name, patchName, modelVersion);
        this.panel?.sendEditResult(ok, ok ? undefined : 'version conflict');
    }

    private async sendPalette(): Promise<void> {
        if (!this.panel) { return; }
        const palette = await loadPlaypal();
        if (!palette) {
            this.panel.sendPalette(null);
            return;
        }
        const rgb: number[] = [];
        for (const c of palette) {
            rgb.push(c.r, c.g, c.b);
        }
        this.panel.sendPalette(rgb);
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
            resolved.subPatches,
            resolved.grabOffset
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
    private readonly closeDisposable: vscode.Disposable;

    constructor() {
        this.closeDisposable = vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const controller = this.controllers.get(key);
            if (controller) {
                controller.dispose();
                this.controllers.delete(key);
            }
        });
    }

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
        this.closeDisposable.dispose();
        for (const c of this.controllers.values()) {
            c.dispose();
        }
        this.controllers.clear();
    }
}
