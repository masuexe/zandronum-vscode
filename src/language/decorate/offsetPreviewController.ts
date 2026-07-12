import * as vscode from 'vscode';
import { ResourceIndex } from '../textures/resourceIndex';
import {
    buildOffsetSequence,
    lineHasOffsetKeyword,
    OffsetSequence,
    OffsetStateFrame
} from './offsetPreviewParser';
import { OffsetPreviewPanel, OffsetPreviewFrameView, OffsetPreviewViewData } from './offsetPreviewPanel';
import { resolveDecorateSprite } from './offsetSpriteResolver';

class OffsetPreviewController {
    private panel: OffsetPreviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private sequence: OffsetSequence | null = null;
    /** Index within sequence.sequenceIndices */
    private scrubIndex = 0;
    private suppressSelectionSync = false;
    private webviewReady = false;
    private pendingLine: number | null = null;

    constructor(
        private document: vscode.TextDocument,
        private readonly resourceIndex: ResourceIndex,
        private readonly extensionContext: vscode.ExtensionContext
    ) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === this.document.uri.toString()) {
                    this.document = e.document;
                    this.refreshFromDocument();
                }
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (this.suppressSelectionSync) {
                    return;
                }
                if (e.textEditor.document.uri.toString() !== this.document.uri.toString()) {
                    return;
                }
                if (!this.panel) {
                    return;
                }
                const line = e.selections[0]?.active.line;
                if (line === undefined) {
                    return;
                }
                this.syncToLine(line);
            })
        );
    }

    get documentUri(): string {
        return this.document.uri.toString();
    }

    open(line: number): void {
        if (this.panel) {
            this.panel.reveal();
            this.syncToLine(line);
            return;
        }

        this.webviewReady = false;
        this.pendingLine = line;
        this.panel = new OffsetPreviewPanel(this.extensionContext, msg => {
            void this.onPanelMessage(msg);
        });
        this.panel.setTitle('Offset Preview');
        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.webviewReady = false;
        });
    }

    dispose(): void {
        this.panel?.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async onPanelMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.webviewReady = true;
                if (this.pendingLine !== null) {
                    this.syncToLine(this.pendingLine);
                    this.pendingLine = null;
                } else {
                    await this.sendCurrentView();
                }
                break;
            case 'scrub': {
                const idx = typeof msg.index === 'number' ? msg.index : 0;
                this.scrubIndex = idx;
                await this.sendCurrentView();
                break;
            }
            case 'reveal': {
                const frame = this.activeFrame();
                if (!frame) {
                    break;
                }
                this.suppressSelectionSync = true;
                const editor = await vscode.window.showTextDocument(this.document, {
                    viewColumn: vscode.ViewColumn.One,
                    preserveFocus: false,
                    selection: new vscode.Range(frame.line, 0, frame.line, 0)
                });
                editor.revealRange(
                    new vscode.Range(frame.line, 0, frame.line, 0),
                    vscode.TextEditorRevealType.InCenter
                );
                setTimeout(() => {
                    this.suppressSelectionSync = false;
                }, 100);
                break;
            }
        }
    }

    private activeFrame(): OffsetStateFrame | null {
        if (!this.sequence || this.sequence.sequenceIndices.length === 0) {
            return null;
        }
        const clamped = Math.max(0, Math.min(this.scrubIndex, this.sequence.sequenceIndices.length - 1));
        const frameIdx = this.sequence.sequenceIndices[clamped];
        return this.sequence.frames[frameIdx] ?? null;
    }

    private syncToLine(line: number): void {
        const seq = buildOffsetSequence(this.document.getText(), line);
        if (!seq) {
            return;
        }
        this.sequence = seq;
        const posInSeq = seq.sequenceIndices.indexOf(seq.activeFrameIndex);
        this.scrubIndex = posInSeq >= 0 ? posInSeq : 0;
        void this.sendCurrentView();
    }

    private refreshFromDocument(): void {
        if (!this.sequence) {
            return;
        }
        const frame = this.activeFrame();
        const line = frame?.line ?? this.sequence.frames[this.sequence.activeFrameIndex]?.line ?? 0;
        this.syncToLine(line);
    }

    private async sendCurrentView(): Promise<void> {
        if (!this.panel || !this.sequence || !this.webviewReady) {
            return;
        }
        await this.resourceIndex.whenReady();

        const seqFrames = this.sequence.sequenceIndices.map(i => this.sequence!.frames[i]);
        const viewFrames: OffsetPreviewFrameView[] = seqFrames.map(f => {
            const resolved = resolveDecorateSprite(
                this.resourceIndex,
                this.panel!.webview,
                f.sprite,
                f.frame
            );
            return {
                line: f.line,
                sprite: f.sprite,
                frame: f.frame,
                duration: f.duration,
                offsetX: f.effectiveOffset.x,
                offsetY: f.effectiveOffset.y,
                declaredOffsetX: f.declaredOffset?.x ?? null,
                declaredOffsetY: f.declaredOffset?.y ?? null,
                offsetIsKeep: f.offsetIsKeep,
                imageUri: resolved?.imageUri ?? null,
                composite: resolved?.resourceType === 'composite'
                    ? {
                        width: resolved.width,
                        height: resolved.height,
                        subPatches: resolved.subPatches ?? []
                    }
                    : null,
                grabX: resolved?.grabX ?? 0,
                grabY: resolved?.grabY ?? 0,
                hasGrab: resolved?.hasGrab ?? false,
                missingResource: !resolved,
                resolvedName: resolved?.resolvedName ?? null
            };
        });

        const data: OffsetPreviewViewData = {
            label: this.sequence.label,
            sequenceIndex: this.scrubIndex,
            sequenceLength: viewFrames.length,
            frames: viewFrames,
            activeIndex: Math.max(0, Math.min(this.scrubIndex, viewFrames.length - 1))
        };

        this.panel.setTitle(`Offset: ${this.sequence.label}`);
        this.panel.sendView(data);
    }
}

export class OffsetPreviewRegistry {
    private readonly controllers = new Map<string, OffsetPreviewController>();

    constructor(private readonly resourceIndex: ResourceIndex) {}

    open(
        document: vscode.TextDocument,
        line: number,
        context: vscode.ExtensionContext
    ): void {
        const key = document.uri.toString();
        let controller = this.controllers.get(key);
        if (!controller) {
            controller = new OffsetPreviewController(document, this.resourceIndex, context);
            this.controllers.set(key, controller);
        }
        controller.open(line);
    }

    dispose(): void {
        for (const c of this.controllers.values()) {
            c.dispose();
        }
        this.controllers.clear();
    }
}

export function registerOffsetPreview(
    context: vscode.ExtensionContext,
    resourceIndex: ResourceIndex
): OffsetPreviewRegistry {
    const registry = new OffsetPreviewRegistry(resourceIndex);

    context.subscriptions.push(
        vscode.commands.registerCommand('decorate.previewOffset', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active text editor.');
                return;
            }
            if (editor.document.languageId !== 'decorate') {
                vscode.window.showWarningMessage(
                    `Current file language is "${editor.document.languageId}", expected "decorate".`
                );
                return;
            }
            registry.open(editor.document, editor.selection.active.line, context);
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            [{ language: 'decorate' }],
            {
                provideCodeLenses(document) {
                    const lenses: vscode.CodeLens[] = [];
                    for (let i = 0; i < document.lineCount; i++) {
                        const text = document.lineAt(i).text;
                        if (!lineHasOffsetKeyword(text)) {
                            continue;
                        }
                        const range = new vscode.Range(i, 0, i, text.length);
                        lenses.push(
                            new vscode.CodeLens(range, {
                                title: 'Preview Offset',
                                command: 'decorate.previewOffsetAtLine',
                                arguments: [document.uri, i]
                            })
                        );
                    }
                    return lenses;
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'decorate.previewOffsetAtLine',
            async (uri?: vscode.Uri, line?: number) => {
                if (!uri || typeof line !== 'number') {
                    await vscode.commands.executeCommand('decorate.previewOffset');
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(uri);
                registry.open(doc, line, context);
            }
        )
    );

    context.subscriptions.push({ dispose: () => registry.dispose() });
    return registry;
}
