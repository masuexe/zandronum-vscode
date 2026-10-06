import * as assert from 'assert';
import * as vscode from 'vscode';
import { TextureDocumentController } from '../language/textures/textureDocumentController';
import { TextureViewData } from '../language/textures/textureEditorPanel';
import { TexturesParser } from '../language/textures/texturesParser';
import { ResourceIndex } from '../language/textures/resourceIndex';

suite('Texture editor — follow renamed definitions', () => {
    let controller: TextureDocumentController;
    let document: vscode.TextDocument;
    let updates: { texture: TextureViewData; textures: string[] }[];
    let title: string;

    setup(async () => {
        document = await vscode.workspace.openTextDocument({ language: 'textures', content:
            'sprite OTHER, 16, 16 {Patch OTHERPATCH, 0, 0}\n' +
            'sprite 8h60a0, 172, 272 {Offset 0, 0 Patch MGCHA0, 0, 0 {Translation "4:4=80:80"}}\n' +
            'sprite LAST, 16, 16 {Patch LASTPATCH, 0, 0}' });
        updates = [];
        title = '';
        controller = new TextureDocumentController(document, new TexturesParser(), {} as ResourceIndex, {} as vscode.ExtensionContext);
        // Exercise real document events and controller synchronization without opening a webview.
        Object.assign(controller, {
            webviewReady: true,
            panel: {
                reveal() {},
                dispose() {},
                setTitle(value: string) { title = value; },
                sendUpdateTexture(texture: TextureViewData, textures: string[]) { updates.push({ texture, textures }); },
                sendUpdateList() {},
                sendHighlightPatch() {}
            }
        });
        controller.openEditor('8h60a0');
        updates.length = 0;
    });

    teardown(() => controller.dispose());

    async function replace(before: string, after: string): Promise<void> {
        const offset = document.getText().indexOf(before);
        assert.ok(offset >= 0, `missing text: ${before}`);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + before.length)), after);
        assert.ok(await vscode.workspace.applyEdit(edit));
    }

    function assertSelected(name: string): void {
        assert.strictEqual(controller.selection.selectedTextureName, name);
        assert.strictEqual(title, `Texture: ${name}`);
        const update = updates.at(-1)!;
        assert.ok(update);
        assert.strictEqual(update.texture.name, name);
        assert.deepStrictEqual(update.textures, ['OTHER', name, 'LAST']);
        assert.strictEqual(update.texture.patches[0].props.Translation, '"4:4=80:80"');
    }

    test('rename updates selection, title, list and translated patch data', async () => {
        await replace('8h60a0', '8h60b0');
        assertSelected('8h60b0');
    });

    test('case-only rename uses the current spelling', async () => {
        await replace('8h60a0', '8H60A0');
        assertSelected('8H60A0');
    });

    test('tracks edits before the selected definition and simultaneous rename', async () => {
        const source = document.getText();
        const start = source.indexOf('8h60a0');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), '// new header\n');
        edit.replace(document.uri, new vscode.Range(document.positionAt(start), document.positionAt(start + 6)), '8h60b0');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assertSelected('8h60b0');
        await replace('8h60b0', '8h60c0');
        assertSelected('8h60c0');
    });

    test('follows a name deleted and retyped over separate events', async () => {
        const offset = document.getText().indexOf('8h60a0');
        await replace('8h60a0', '');
        assert.strictEqual(updates.length, 0);
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(offset), '8h60b0');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assertSelected('8h60b0');
    });

    test('deleting the selected definition does not select its neighbour', async () => {
        const line = document.lineAt(1);
        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, line.rangeIncludingLineBreak);
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.strictEqual(updates.length, 0);
        assert.strictEqual(controller.selection.selectedTextureName, '8h60a0');
    });

    test('refreshes the list when another definition is renamed', async () => {
        await replace('OTHER,', 'RENAMED,');
        assert.strictEqual(controller.selection.selectedTextureName, '8h60a0');
        assert.deepStrictEqual(updates.at(-1)!.textures, ['RENAMED', '8h60a0', 'LAST']);
    });

    test('follows undo and redo of the rename', async () => {
        await vscode.window.showTextDocument(document);
        await replace('8h60a0', '8h60b0');
        assertSelected('8h60b0');
        await vscode.commands.executeCommand('undo');
        assertSelected('8h60a0');
        await vscode.commands.executeCommand('redo');
        assertSelected('8h60b0');
    });
});
