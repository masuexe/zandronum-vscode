import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    editTranslationColor,
    TexturesTranslationViewportPreview,
    TranslationColorEditArgs,
} from '../language/textures/translationViewportPreview';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (predicate()) { return; }
        await delay(50);
    }
    assert.ok(predicate(), 'timed out waiting for editor event');
}

suite('textures translation — extension host', function () {
    this.timeout(20000);
    let paletteDir: string;
    let oldPalette: string | undefined;
    let oldMode: string | undefined;
    const config = () => vscode.workspace.getConfiguration('zandronum-vscode');

    suiteSetup(async () => {
        const ext = vscode.extensions.all.find(e => e.packageJSON?.name === 'zandronum-vscode');
        assert.ok(ext);
        await ext.activate();
        oldPalette = config().inspect<string>('playpalPath')?.globalValue;
        oldMode = config().inspect<string>('textures.translationPreviewMode')?.globalValue;
        paletteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'textures-color-host-'));
        const palettePath = path.join(paletteDir, 'PLAYPAL.lmp');
        fs.writeFileSync(palettePath, Buffer.from(Array.from({ length: 768 }, (_, i) => i % 256)));
        await config().update('playpalPath', palettePath, vscode.ConfigurationTarget.Global);
    });

    suiteTeardown(async () => {
        await config().update('playpalPath', oldPalette, vscode.ConfigurationTarget.Global);
        await config().update('textures.translationPreviewMode', oldMode, vscode.ConfigurationTarget.Global);
        fs.rmSync(paletteDir, { recursive: true, force: true });
    });

    async function documentAndArgs() {
        const document = await vscode.workspace.openTextDocument({ language: 'textures', content: 'Translation "0:0=[10,20,30]:[40,50,60]"' });
        await vscode.window.showTextDocument(document);
        const start = document.getText().indexOf('[10');
        const args: TranslationColorEditArgs = {
            uri: document.uri.toString(), version: document.version, text: '[10,20,30]',
            start: { line: 0, character: start }, end: { line: 0, character: start + '[10,20,30]'.length },
        };
        return { document, args };
    }

    async function insertPrefix(document: vscode.TextDocument) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), '// changed\n');
        assert.ok(await vscode.workspace.applyEdit(edit));
    }

    test('actual async picker flow rejects edits made while the picker is pending', async () => {
        const { document, args } = await documentAndArgs();
        let release!: (hex: string) => void;
        let opened = false;
        const pending = editTranslationColor(args, async () => {
            opened = true;
            return new Promise<string>(resolve => { release = resolve; });
        });
        await waitFor(() => opened);
        await insertPrefix(document);
        const changed = document.getText();
        release('#ff0000');
        await pending;
        assert.strictEqual(document.getText(), changed);
    });

    test('format selection await also rejects stale text', async () => {
        const { document, args } = await documentAndArgs();
        let reachedFormat = false;
        await editTranslationColor(args, async () => '#ff0000', async items => {
            reachedFormat = true;
            await insertPrefix(document);
            return items[0];
        });
        assert.ok(reachedFormat, 'palette must offer RGB and index formats');
        assert.ok(document.getText().startsWith('// changed\n'));
        assert.ok(document.getText().includes('[10,20,30]'));
    });

    test('valid writeback uses document undo', async () => {
        const { document, args } = await documentAndArgs();
        const original = document.getText();
        await editTranslationColor(args, async () => '#ff0000', async items => items[0]);
        assert.ok(document.getText().includes('[255,0,0]'));
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
    });

    test('stale hover arguments and non-Translation positions never open a picker', async () => {
        const { document, args } = await documentAndArgs();
        let opened = false;
        const pick = async () => { opened = true; return '#ff0000'; };
        await insertPrefix(document);
        await editTranslationColor(args, pick);
        const other = await vscode.workspace.openTextDocument({ language: 'textures', content: 'Offset 10,20' });
        await editTranslationColor({ uri: other.uri.toString(), version: other.version, text: '10', start: { line: 0, character: 7 }, end: { line: 0, character: 9 } }, pick);
        assert.strictEqual(opened, false);
    });

    test('closing a document during picker await never reopens or writes it', async () => {
        const file = vscode.Uri.file(path.join(paletteDir, 'closed-TEXTURES.txt'));
        const original = 'Translation "0:0=[10,20,30]"';
        fs.writeFileSync(file.fsPath, original);
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.languages.setTextDocumentLanguage(document, 'textures');
        await vscode.window.showTextDocument(document);
        const start = original.indexOf('[10');
        const args: TranslationColorEditArgs = { uri: file.toString(), version: document.version, text: '[10,20,30]', start: { line: 0, character: start }, end: { line: 0, character: start + 10 } };
        await editTranslationColor(args, async () => {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            // VS Code may retain a closed tab's clean model; the edit must still cancel.
            await waitFor(() => !vscode.window.tabGroups.all.some(g => g.tabs.some(t =>
                t.input instanceof vscode.TabInputText && t.input.uri.toString() === file.toString())));
            return '#ff0000';
        });
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(fs.readFileSync(file.fsPath, 'utf8'), original);
    });

    test('both mode switches trigger automatic native provider queries without changing text', async () => {
        // Observe the real registered provider; do not executeDocumentColorProvider to force a query.
        const original = TexturesTranslationViewportPreview.prototype.provideNativeDocumentColors;
        const queries: { uri: string; count: number; mode: boolean }[] = [];
        TexturesTranslationViewportPreview.prototype.provideNativeDocumentColors = async function (document, palette, token) {
            const colors = await original.call(this, document, palette, token);
            queries.push({ uri: document.uri.toString(), count: colors.length, mode: this.isViewportMode(document.uri) });
            return colors;
        };
        try {
            await config().update('textures.translationPreviewMode', 'native', vscode.ConfigurationTarget.Global);
            const { document } = await documentAndArgs();
            const uri = document.uri.toString();
            const version = document.version;
            await waitFor(() => queries.some(q => q.uri === uri && !q.mode && q.count > 0));
            queries.length = 0;
            await config().update('textures.translationPreviewMode', 'viewport', vscode.ConfigurationTarget.Global);
            await waitFor(() => queries.some(q => q.uri === uri && q.mode && q.count === 0));
            queries.length = 0;
            await config().update('textures.translationPreviewMode', 'native', vscode.ConfigurationTarget.Global);
            await waitFor(() => queries.some(q => q.uri === uri && !q.mode && q.count > 0));
            assert.strictEqual(document.version, version);
        } finally {
            TexturesTranslationViewportPreview.prototype.provideNativeDocumentColors = original;
        }
    });
});
