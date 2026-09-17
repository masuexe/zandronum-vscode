import * as vscode from 'vscode';
import { getPlaypalGeneration, loadPlaypal, RgbColor } from '../../tools/playpalReader';
import {
    TranslationPropertySpan,
    collectKeywordPropertyTranslationColors,
    collectKeywordPropertyTranslationSpans,
    stripLineComment,
    visitTranslationColorMatches,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';
import {
    BoundedColorCache,
    PRELOAD_FLUSH_MS,
    PRELOAD_SCREEN_COUNT,
    VIEWPORT_RENDER_COLOR_BUDGET,
    VISIBLE_FLUSH_MS,
    ViewportPreviewStats,
    collectColorsForWindows,
    colorToCssRgba,
    colorToHex,
    expandRangesWithPad,
    hexToColor,
    isAsyncResultCurrent,
    median,
    mergeLineWindows,
    percentile,
    preloadLinePad,
    selectColorsForDisplay,
    translationPreviewMode,
} from './translationViewportCore';

const TRANSLATION_RE = /\bTranslation\b/i;
export const EDIT_TRANSLATION_COLOR_COMMAND = 'textures.editTranslationColor';
export const TRANSLATION_PREVIEW_MODE_SETTING = 'zandronum-vscode.textures.translationPreviewMode';

interface DocumentPreviewState {
    version: number;
    paletteGeneration: number;
    spans: TranslationPropertySpan[];
}

interface EditorPreviewState {
    requestId: number;
    visibleTimer: ReturnType<typeof setTimeout> | undefined;
    preloadTimer: ReturnType<typeof setTimeout> | undefined;
    lastVisibleKey: string;
}

export class TexturesTranslationViewportPreview implements vscode.Disposable {
    private readonly cache = new BoundedColorCache();
    private readonly documents = new Map<string, DocumentPreviewState>();
    private readonly editors = new Map<vscode.TextEditor, EditorPreviewState>();
    private readonly decorationType: vscode.TextEditorDecorationType;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly stats: ViewportPreviewStats = {
        visibleUpdateMs: [],
        cacheHits: 0,
        cacheMisses: 0,
        lastJumpMs: undefined,
    };
    private lastPalette: RgbColor[] | null = null;
    private disposed = false;

    constructor() {
        this.decorationType = vscode.window.createTextEditorDecorationType({
            rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
        this.disposables.push(this.decorationType);
        this.disposables.push(
            vscode.window.onDidChangeTextEditorVisibleRanges(e => {
                if (e.textEditor.document.languageId === 'textures') {
                    this.scheduleVisible(e.textEditor, false);
                }
            }),
            vscode.window.onDidChangeVisibleTextEditors(() => {
                this.syncEditors();
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.languageId === 'textures') {
                    this.invalidateDocument(e.document.uri);
                    this.refreshOpenEditors(e.document.uri);
                }
            }),
            vscode.workspace.onDidCloseTextDocument(doc => {
                if (doc.languageId === 'textures') {
                    this.invalidateDocument(doc.uri);
                    this.clearDecorationsForDocument(doc.uri);
                }
            }),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration(TRANSLATION_PREVIEW_MODE_SETTING)
                    || e.affectsConfiguration('editor.colorDecorators')
                    || e.affectsConfiguration('zandronum-vscode.playpalPath')
                    || e.affectsConfiguration('zandronum-vscode.baseResources')
                ) {
                    for (const [editor, state] of this.editors) {
                        this.cancelTasks(state);
                        editor.setDecorations(this.decorationType, []);
                    }
                    this.cache.clear();
                    this.documents.clear();
                    this.syncEditors();
                }
            }),
            vscode.languages.registerHoverProvider(
                [{ language: 'textures' }],
                {
                    provideHover: (document, position) => this.provideViewportHover(document, position),
                }
            ),
            vscode.commands.registerCommand(
                EDIT_TRANSLATION_COLOR_COMMAND,
                (args?: TranslationColorEditArgs) => editTranslationColor(args)
            )
        );
        this.syncEditors();
    }

    dispose(): void {
        this.disposed = true;
        for (const state of this.editors.values()) {
            if (state.visibleTimer) {
                clearTimeout(state.visibleTimer);
            }
            if (state.preloadTimer) {
                clearTimeout(state.preloadTimer);
            }
        }
        this.editors.clear();
        this.documents.clear();
        this.cache.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    getPreviewStats(): ViewportPreviewStats & { cache: { entries: number; colors: number }; medianMs?: number; p95Ms?: number } {
        return {
            ...this.stats,
            cache: this.cache.stats(),
            medianMs: median(this.stats.visibleUpdateMs),
            p95Ms: percentile(this.stats.visibleUpdateMs, 95),
        };
    }

    isViewportMode(uri: vscode.Uri): boolean {
        return translationPreviewMode(vscode.workspace.getConfiguration('zandronum-vscode', uri)
            .get('textures.translationPreviewMode')) === 'viewport';
    }

    async provideNativeDocumentColors(
        document: vscode.TextDocument,
        palette: RgbColor[] | null,
        token?: vscode.CancellationToken
    ): Promise<vscode.ColorInformation[]> {
        if (!this.colorDecoratorsEnabled(document) || token?.isCancellationRequested) { return []; }
        if (this.isViewportMode(document.uri)) {
            this.refreshOpenEditors(document.uri);
            return [];
        }
        this.clearDecorationsForDocument(document.uri);
        return collectKeywordPropertyTranslationColors(document, TRANSLATION_RE, palette, token);
    }

    private ensureDocumentState(
        document: vscode.TextDocument,
        token?: vscode.CancellationToken
    ): DocumentPreviewState {
        const uri = document.uri.toString();
        const paletteGeneration = getPlaypalGeneration();
        const existing = this.documents.get(uri);
        if (
            existing
            && existing.version === document.version
            && existing.paletteGeneration === paletteGeneration
        ) {
            return existing;
        }

        const spans = collectKeywordPropertyTranslationSpans(document, TRANSLATION_RE, token);
        const state: DocumentPreviewState = {
            version: document.version,
            paletteGeneration,
            spans,
        };
        this.documents.set(uri, state);
        this.cache.invalidateUri(uri);
        return state;
    }

    private colorDecoratorsEnabled(document: vscode.TextDocument): boolean {
        return vscode.workspace.getConfiguration('editor', {
            languageId: 'textures',
            uri: document.uri,
        }).get<boolean>('colorDecorators', true) !== false;
    }

    private syncEditors(): void {
        const visible = new Set(vscode.window.visibleTextEditors.filter(e => e.document.languageId === 'textures'));
        for (const editor of [...this.editors.keys()]) {
            if (!visible.has(editor)) {
                const state = this.editors.get(editor);
                if (state) { this.cancelTasks(state); }
                editor.setDecorations(this.decorationType, []);
                this.editors.delete(editor);
            }
        }
        for (const editor of visible) {
            if (!this.editors.has(editor)) {
                this.editors.set(editor, { requestId: 0, visibleTimer: undefined, preloadTimer: undefined, lastVisibleKey: '' });
            }
            this.scheduleVisible(editor, true);
        }
    }

    private refreshOpenEditors(uri: vscode.Uri): void {
        const key = uri.toString();
        for (const editor of this.editors.keys()) {
            if (editor.document.uri.toString() === key) {
                this.scheduleVisible(editor, true);
            }
        }
    }

    private invalidateDocument(uri: vscode.Uri): void {
        const key = uri.toString();
        this.documents.delete(key);
        this.cache.invalidateUri(key);
    }

    private clearDecorationsForDocument(uri: vscode.Uri): void {
        const key = uri.toString();
        for (const editor of this.editors.keys()) {
            if (editor.document.uri.toString() === key) {
                this.cancelTasks(this.editors.get(editor)!);
                editor.setDecorations(this.decorationType, []);
            }
        }
    }

    private cancelTasks(state: EditorPreviewState): void {
        state.requestId++;
        if (state.visibleTimer) { clearTimeout(state.visibleTimer); }
        if (state.preloadTimer) { clearTimeout(state.preloadTimer); }
        state.visibleTimer = undefined;
        state.preloadTimer = undefined;
    }

    private scheduleVisible(editor: vscode.TextEditor, immediate: boolean): void {
        if (this.disposed) {
            return;
        }
        let state = this.editors.get(editor);
        if (!state) {
            state = { requestId: 0, visibleTimer: undefined, preloadTimer: undefined, lastVisibleKey: '' };
            this.editors.set(editor, state);
        }
        this.cancelTasks(state);
        if (!this.isViewportMode(editor.document.uri) || !this.colorDecoratorsEnabled(editor.document)) {
            editor.setDecorations(this.decorationType, []);
            return;
        }
        const requestId = state.requestId;
        const delay = immediate ? 0 : VISIBLE_FLUSH_MS;
        state.visibleTimer = setTimeout(() => {
            void this.flushVisible(editor, requestId, false);
        }, delay);

        if (state.preloadTimer) {
            clearTimeout(state.preloadTimer);
        }
        state.preloadTimer = setTimeout(() => {
            void this.flushVisible(editor, requestId, true);
        }, PRELOAD_FLUSH_MS);
    }

    private async flushVisible(editor: vscode.TextEditor, requestId: number, preload: boolean): Promise<void> {
        if (this.disposed) {
            return;
        }
        const editorState = this.editors.get(editor);
        if (!editorState || editorState.requestId !== requestId) {
            return;
        }
        const document = editor.document;
        if (document.languageId !== 'textures') {
            return;
        }
        if (!this.isViewportMode(document.uri) || !this.colorDecoratorsEnabled(document)) {
            editor.setDecorations(this.decorationType, []);
            return;
        }

        const started = Date.now();
        const documentVersion = document.version;
        const palette = await loadPlaypal();
        if (this.disposed || document.isClosed || this.editors.get(editor) !== editorState) { return; }
        this.lastPalette = palette;
        const paletteGeneration = getPlaypalGeneration();
        if (!isAsyncResultCurrent({
            requestId,
            currentRequestId: editorState.requestId,
            documentVersion,
            currentVersion: editor.document.version,
            paletteGeneration,
            currentPaletteGeneration: getPlaypalGeneration(),
        })) {
            return;
        }

        const docState = this.ensureDocumentState(editor.document);

        const visibleKey = editor.visibleRanges.map(r => `${r.start.line}:${r.end.line}`).join(',');
        const jumped = editorState.lastVisibleKey !== '' && !adjacentVisible(editorState.lastVisibleKey, visibleKey);
        editorState.lastVisibleKey = visibleKey;

        const screenHeight = Math.max(
            1,
            ...editor.visibleRanges.map(r => r.end.line - r.start.line + 1)
        );
        const pad = preloadLinePad(screenHeight, PRELOAD_SCREEN_COUNT);
        const displayWindows = mergeLineWindows(editor.visibleRanges);
        const parseWindows = preload
            ? mergeLineWindows(expandRangesWithPad(editor.visibleRanges, pad, document.lineCount))
            : displayWindows;

        const parsed = collectColorsForWindows(
            document,
            docState.spans,
            palette,
            parseWindows,
            this.cache,
            paletteGeneration,
            undefined,
            { preload }
        );
        this.stats.cacheHits += parsed.cacheHits;
        this.stats.cacheMisses += parsed.cacheMisses;

        if (!isAsyncResultCurrent({
            requestId,
            currentRequestId: editorState.requestId,
            documentVersion,
            currentVersion: editor.document.version,
            paletteGeneration,
            currentPaletteGeneration: getPlaypalGeneration(),
        })) {
            return;
        }

        if (!preload) {
            const display = selectColorsForDisplay(parsed.colors, editor.visibleRanges, VIEWPORT_RENDER_COLOR_BUDGET);
            editor.setDecorations(this.decorationType, display.map(info => ({
                range: info.range,
                renderOptions: {
                    before: {
                        contentText: '■',
                        color: colorToCssRgba(info.color),
                        margin: '0 0.12em 0 0',
                    },
                },
            })));
            const elapsed = Date.now() - started;
            this.stats.visibleUpdateMs.push(elapsed);
            if (this.stats.visibleUpdateMs.length > 200) {
                this.stats.visibleUpdateMs.shift();
            }
            if (jumped) {
                this.stats.lastJumpMs = elapsed;
            }
        }
    }

    private provideViewportHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | undefined {
        const state = this.documents.get(document.uri.toString());
        if (!state || state.version !== document.version || !this.isViewportMode(document.uri)
            || !this.colorDecoratorsEnabled(document)) {
            return undefined;
        }
        const color = colorAtPosition(document, position, state.spans, this.lastPalette);
        if (!color) {
            return undefined;
        }
        const md = new vscode.MarkdownString();
        md.isTrusted = { enabledCommands: [EDIT_TRANSLATION_COLOR_COMMAND] };
        md.supportHtml = false;
        const args = {
            uri: document.uri.toString(),
            version: document.version,
            text: document.getText(color.range),
            start: { line: color.range.start.line, character: color.range.start.character },
            end: { line: color.range.end.line, character: color.range.end.character },
        };
        const encoded = encodeURIComponent(JSON.stringify(args));
        md.appendMarkdown(`Translation color \`${colorToHex(color.color)}\`\n\n`);
        md.appendMarkdown(`Viewport preview: use [Edit color](command:${EDIT_TRANSLATION_COLOR_COMMAND}?${encoded}) to open the custom color picker.`);
        return new vscode.Hover(md, color.range);
    }

}

export interface TranslationColorEditArgs {
    uri: string;
    version: number;
    text: string;
    start: { line: number; character: number };
    end: { line: number; character: number };
}

/** UI callbacks also let host tests pause the actual edit flow at each await. */
export async function editTranslationColor(
    args?: TranslationColorEditArgs,
    pickColor = pickColorWithWebview,
    chooseFormat: (items: vscode.ColorPresentation[], currentText: string) => Promise<vscode.ColorPresentation | undefined> = async (items, currentText) => {
        const item = await vscode.window.showQuickPick(
            items.map(p => ({ label: p.label, description: p.label === currentText ? 'current format' : undefined, pres: p })),
            { placeHolder: 'Write color as' }
        );
        return item?.pres;
    }
): Promise<void> {
    const cancel = () => {
        void vscode.window.showWarningMessage('Translation color changed or closed. Reopen Edit color from the current color location.');
    };
    if (!args || typeof args.uri !== 'string' || typeof args.text !== 'string'
        || !Number.isInteger(args.version) || !args.start || !args.end
        || ![args.start.line, args.start.character, args.end.line, args.end.character]
            .every(n => Number.isSafeInteger(n) && n >= 0)
        || args.start.line !== args.end.line || args.start.character >= args.end.character) {
        return;
    }
    const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === args.uri);
    const range = new vscode.Range(args.start.line, args.start.character, args.end.line, args.end.character);
    const version = args.version;
    const currentText = args.text;
    const hasOpenTab = () => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === args.uri));
    // A closed editor's clean model can remain loaded in VS Code for some time.
    const startedWithOpenTab = hasOpenTab();
    const validate = (): boolean => {
        if (!document || document.isClosed || (startedWithOpenTab && !hasOpenTab()) || document.languageId !== 'textures'
            || !vscode.workspace.textDocuments.includes(document)
            || document.version !== version || !document.validateRange(range).isEqual(range)
            || document.getText(range) !== currentText) {
            cancel();
            return false;
        }
        return true;
    };
    if (!validate() || !document) { return; }
    const palette = await loadPlaypal();
    if (!validate()) { return; }
    const spans = collectKeywordPropertyTranslationSpans(document, TRANSLATION_RE);
    const current = colorAtPosition(document, range.start, spans, palette);
    if (!current?.range.isEqual(range)) {
        cancel();
        return;
    }
    const pickedHex = await pickColor(current.color);
    if (!validate() || !pickedHex) { return; }
    const picked = hexToColor(pickedHex);
    if (!picked) { return; }
    const presentations = await provideTranslationColorPresentations(picked, { document, range }, palette);
    if (!validate() || presentations.length === 0) { return; }
    const chosen = presentations.length === 1 ? presentations[0] : await chooseFormat(presentations, currentText);
    if (!validate() || !chosen) { return; }
    const editRange = chosen.textEdit?.range ?? range;
    if (!editRange.isEqual(range)) { return; }
    const we = new vscode.WorkspaceEdit();
    we.replace(document.uri, range, chosen.textEdit?.newText ?? chosen.label);
    // No await between the final validation and dispatch; VS Code owns document undo.
    if (!validate()) { return; }
    await vscode.workspace.applyEdit(we);
}

function adjacentVisible(prev: string, next: string): boolean {
    if (prev === next) {
        return true;
    }
    const parse = (key: string) => key.split(',').map(part => {
        const [a, b] = part.split(':').map(Number);
        return { a, b };
    });
    const a = parse(prev);
    const b = parse(next);
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (Math.abs(a[i].a - b[i].a) > 80 || Math.abs(a[i].b - b[i].b) > 80) {
            return false;
        }
    }
    return true;
}

function colorAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    spans: readonly TranslationPropertySpan[],
    palette: RgbColor[] | null
): vscode.ColorInformation | undefined {
    const span = spans.find(s => position.line >= s.startLine && position.line <= s.endLine);
    if (!span) {
        return undefined;
    }
    const fromCol = position.line === span.startLine ? span.keywordColumn : 0;
    let found: vscode.ColorInformation | undefined;
    visitTranslationColorMatches(stripLineComment(document.lineAt(position.line).text), fromCol, palette, visit => {
        if (visit.startColumn > position.character) { return false; }
        if (position.character < visit.endColumn) {
            found = new vscode.ColorInformation(
                new vscode.Range(position.line, visit.startColumn, position.line, visit.endColumn), visit.color
            );
            return false;
        }
    });
    return found;
}

async function pickColorWithWebview(initial: vscode.Color): Promise<string | undefined> {
    const hex = colorToHex(initial);
    const panel = vscode.window.createWebviewPanel(
        'texturesTranslationColorPicker',
        'Edit Translation Color',
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );
    panel.webview.html = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;padding:12px">
<label>Color <input id="c" type="color" value="${hex}"></label>
<p><button id="ok">Apply</button> <button id="cancel">Cancel</button></p>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('ok').onclick = () => vscode.postMessage({ hex: document.getElementById('c').value });
document.getElementById('cancel').onclick = () => vscode.postMessage({ hex: null });
</script>
</body></html>`;
    return new Promise(resolve => {
        let settled = false;
        const finish = (value: string | undefined) => {
            if (settled) {
                return;
            }
            settled = true;
            sub.dispose();
            panel.dispose();
            resolve(value);
        };
        const sub = panel.webview.onDidReceiveMessage((msg: { hex?: string | null }) => {
            finish(msg.hex || undefined);
        });
        panel.onDidDispose(() => {
            finish(undefined);
        });
    });
}
