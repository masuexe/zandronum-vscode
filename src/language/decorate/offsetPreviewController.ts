import * as vscode from 'vscode';
import { ResourceIndex } from '../textures/resourceIndex';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    buildOffsetSequence,
    lineHasOffsetKeyword,
    OffsetSequence,
    OffsetStateFrame
} from './offsetPreviewParser';
import { OffsetPreviewPanel, OffsetPreviewFrameView, OffsetPreviewViewData } from './offsetPreviewPanel';
import { resolveDecorateSprite } from './offsetSpriteResolver';
import { applyOffsetEdit } from './offsetPreviewWriter';

class OffsetPreviewController {
    private panel: OffsetPreviewPanel | undefined;
    private readonly disposables: vscode.Disposable[] = [];
    private sequence: OffsetSequence | null = null;
    /** Index within sequence.sequenceIndices */
    private scrubIndex = 0;
    private suppressSelectionSync = false;
    private webviewReady = false;
    private pendingLine: number | null = null;
    private viewGeneration = 0;
    /** Last opened/synced line — used to refresh after edits. */
    private anchorLine = 0;
    private openWarning: string | null = null;
    /** True while applying a drag/nudge Offset edit so refresh stays on the scrubbed frame. */
    private applyingOffsetEdit = false;

    constructor(
        private document: vscode.TextDocument,
        private readonly resourceIndex: ResourceIndex,
        private readonly extensionContext: vscode.ExtensionContext
    ) {
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() !== this.document.uri.toString()) {
                    return;
                }
                this.document = e.document;
                if (!this.panel) {
                    return;
                }
                this.refreshFromDocument();
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                if (this.suppressSelectionSync) {
                    return;
                }
                if (!this.panel) {
                    return;
                }
                if (e.textEditor.document.uri.toString() !== this.document.uri.toString()) {
                    return;
                }
                const line = e.selections[0]?.active.line;
                if (line === undefined) {
                    return;
                }
                this.syncToLine(line, false);
            })
        );
    }

    get documentUri(): string {
        return this.document.uri.toString();
    }

    open(line: number): void {
        const lineText = line >= 0 && line < this.document.lineCount
            ? this.document.lineAt(line).text
            : '';
        this.openWarning = lineHasOffsetKeyword(lineText)
            ? null
            : 'Cursor is not on an Offset(...) line — showing nearest state frame. Use CodeLens on an Offset line for a full scrub sequence.';

        if (this.panel) {
            this.panel.reveal();
            this.syncToLine(line, true);
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
            this.sequence = null;
        });
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    private async onPanelMessage(msg: any): Promise<void> {
        switch (msg.type) {
            case 'ready':
                this.webviewReady = true;
                await this.sendPalette();
                if (this.pendingLine !== null) {
                    this.syncToLine(this.pendingLine, true);
                    this.pendingLine = null;
                } else {
                    await this.sendCurrentView();
                }
                break;
            case 'scrub': {
                const idx = typeof msg.index === 'number' ? msg.index : 0;
                this.scrubIndex = idx;
                const frame = this.activeFrame();
                if (frame) {
                    this.anchorLine = frame.line;
                }
                await this.sendCurrentView();
                break;
            }
            case 'reveal': {
                const frame = this.activeFrame();
                if (!frame) {
                    break;
                }
                this.suppressSelectionSync = true;
                try {
                    const editor = await vscode.window.showTextDocument(this.document, {
                        viewColumn: vscode.ViewColumn.One,
                        preserveFocus: false,
                        selection: new vscode.Range(frame.line, 0, frame.line, 0)
                    });
                    editor.revealRange(
                        new vscode.Range(frame.line, 0, frame.line, 0),
                        vscode.TextEditorRevealType.InCenter
                    );
                } finally {
                    setTimeout(() => {
                        this.suppressSelectionSync = false;
                    }, 200);
                }
                break;
            }
            case 'setOffset': {
                await this.handleSetOffset(msg.x, msg.y);
                break;
            }
        }
    }

    private async handleSetOffset(x: unknown, y: unknown): Promise<void> {
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
            return;
        }
        const frame = this.activeFrame();
        if (!frame) {
            return;
        }
        if (!frame.hasOffsetKeyword) {
            this.panel?.postMessage({
                type: 'editResult',
                ok: false,
                reason: 'This frame has no Offset(...) to edit.'
            });
            return;
        }
        if (frame.offsetIsKeep) {
            this.panel?.postMessage({
                type: 'editResult',
                ok: false,
                reason: 'Offset(0, 0) means keep previous — change it in DECORATE first if you want an absolute offset.'
            });
            return;
        }

        const xi = Math.round(x);
        const yi = Math.round(y);
        if (frame.declaredOffset && frame.declaredOffset.x === xi && frame.declaredOffset.y === yi) {
            return;
        }

        this.applyingOffsetEdit = true;
        this.suppressSelectionSync = true;
        this.anchorLine = frame.line;
        try {
            const ok = await applyOffsetEdit(this.document, frame.line, xi, yi);
            if (!ok) {
                this.panel?.postMessage({
                    type: 'editResult',
                    ok: false,
                    reason: 'Could not find Offset(...) on this line.'
                });
            }
        } finally {
            setTimeout(() => {
                this.applyingOffsetEdit = false;
                this.suppressSelectionSync = false;
            }, 150);
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

    /**
     * @param fromOpen When true, keep openWarning; otherwise clear it on normal cursor sync.
     */
    private syncToLine(line: number, fromOpen: boolean): void {
        this.anchorLine = line;
        if (!fromOpen) {
            this.openWarning = null;
        }

        const seq = buildOffsetSequence(this.document.getText(), line);
        if (!seq) {
            this.sequence = null;
            this.scrubIndex = 0;
            void this.sendEmptyView(
                'No DECORATE state frame at this location. Place the cursor on a sprite state line inside a label.'
            );
            return;
        }

        this.sequence = seq;
        const posInSeq = seq.sequenceIndices.indexOf(seq.activeFrameIndex);
        this.scrubIndex = posInSeq >= 0 ? posInSeq : 0;

        const active = seq.frames[seq.activeFrameIndex];
        if (active) {
            this.anchorLine = active.line;
        }

        void this.sendCurrentView();
    }

    private refreshFromDocument(): void {
        // During drag/nudge write-back, stay on the scrubbed frame line
        if (this.applyingOffsetEdit) {
            this.syncToLine(this.anchorLine, false);
            return;
        }
        // Prefer the active editor cursor so inserts/deletes don't use a stale line index
        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === this.document.uri.toString()
        );
        const line = editor?.selection.active.line ?? this.anchorLine;
        this.syncToLine(line, false);
    }

    private async sendPalette(): Promise<void> {
        if (!this.panel) {
            return;
        }
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

    private async sendEmptyView(warning: string): Promise<void> {
        if (!this.panel || !this.webviewReady) {
            return;
        }
        const generation = ++this.viewGeneration;
        const data: OffsetPreviewViewData = {
            label: '',
            sequenceIndex: 0,
            sequenceLength: 0,
            frames: [],
            activeIndex: 0,
            warning,
            playpalStatus: 'unknown'
        };
        if (generation !== this.viewGeneration) {
            return;
        }
        this.panel.setTitle('Offset Preview');
        this.panel.sendView(data);
    }

    private async sendCurrentView(): Promise<void> {
        if (!this.panel || !this.webviewReady) {
            return;
        }
        if (!this.sequence) {
            await this.sendEmptyView(
                this.openWarning ?? 'No Offset sequence available.'
            );
            return;
        }

        const generation = ++this.viewGeneration;
        await this.resourceIndex.whenReady();
        if (generation !== this.viewGeneration || !this.panel || !this.sequence) {
            return;
        }

        const seqFrames = this.sequence.sequenceIndices.map(i => this.sequence!.frames[i]);
        const viewFrames: OffsetPreviewFrameView[] = seqFrames.map((f, i) => {
            const resolved = resolveDecorateSprite(
                this.resourceIndex,
                this.panel!.webview,
                f.sprite,
                f.frame
            );
            const prev = i > 0 ? seqFrames[i - 1] : null;
            return {
                line: f.line,
                sprite: f.sprite,
                frame: f.frame,
                duration: f.duration,
                offsetX: f.effectiveOffset.x,
                offsetY: f.effectiveOffset.y,
                deltaX: prev ? f.effectiveOffset.x - prev.effectiveOffset.x : null,
                deltaY: prev ? f.effectiveOffset.y - prev.effectiveOffset.y : null,
                declaredOffsetX: f.declaredOffset?.x ?? null,
                declaredOffsetY: f.declaredOffset?.y ?? null,
                offsetIsKeep: f.offsetIsKeep,
                hasOffsetKeyword: f.hasOffsetKeyword,
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

        if (generation !== this.viewGeneration || !this.panel) {
            return;
        }

        let warning = this.openWarning;
        if (!warning && viewFrames.length === 1 && !viewFrames[0].hasOffsetKeyword) {
            warning = 'Single non-Offset frame in scrubber. Move to an Offset(...) line (or use CodeLens) for a consecutive Offset sequence.';
        }

        const data: OffsetPreviewViewData = {
            label: this.sequence.label,
            sequenceIndex: this.scrubIndex,
            sequenceLength: viewFrames.length,
            frames: viewFrames,
            activeIndex: Math.max(0, Math.min(this.scrubIndex, viewFrames.length - 1)),
            warning,
            playpalStatus: 'unknown'
        };

        this.panel.setTitle(`Offset: ${this.sequence.label}`);
        this.panel.sendView(data);
    }
}

export class OffsetPreviewRegistry {
    private readonly controllers = new Map<string, OffsetPreviewController>();
    private readonly closeDisposable: vscode.Disposable;

    constructor(private readonly resourceIndex: ResourceIndex) {
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
        this.closeDisposable.dispose();
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
