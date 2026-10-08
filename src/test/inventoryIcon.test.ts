import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { zipSync } from 'fflate';
import { FolderPackage, ZipPackage } from '../base/packages';
import { makeBaseResourceUri, parseBaseResourceUri } from '../base/baseResourceUri';
import { ResourceIndex, ResourceType, isTexturesFile } from '../language/textures/resourceIndex';
import { INVENTORY_ICON_COMMAND, inventoryIconAtPosition, resolveInventoryIcon, iconDefinitionLocation, openInventoryIcon } from '../language/decorate/iconResolve';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');

suite('Inventory.Icon — references', () => {
    async function hit(text: string, at: string): Promise<string | undefined> {
        const doc = await vscode.workspace.openTextDocument({ language: 'decorate', content: text });
        return inventoryIconAtPosition(doc, doc.positionAt(text.indexOf(at)));
    }

    test('recognizes quoted, unquoted and mixed-case properties, including inline actors', async () => {
        assert.strictEqual(await hit('Inventory.Icon "MYICON"', 'MYICON'), 'MYICON');
        assert.strictEqual(await hit('actor A { inventory.icon 8ICON }', '8ICON'), '8ICON');
        assert.strictEqual(await hit('Inventory.Icon\n "MYICON"', 'MYICON'), 'MYICON');
        assert.strictEqual(await hit('Inventory.Icon /* comment */ "MYICON"', 'MYICON'), 'MYICON');
    });

    test('only the icon name triggers navigation', async () => {
        assert.strictEqual(await hit('Inventory.Icon "MYICON"', 'Inventory'), undefined);
        assert.strictEqual(await hit('Inventory.Icon ""', '"'), undefined);
        assert.strictEqual(await hit('Inventory.PickupMessage "MYICON"', 'MYICON'), undefined);
        assert.strictEqual(await hit('Some.Inventory.Icon "MYICON"', 'MYICON'), undefined);
    });

    test('ignores line comments, multiline comments and property text inside strings', async () => {
        assert.strictEqual(await hit('// Inventory.Icon "MYICON"', 'MYICON'), undefined);
        assert.strictEqual(await hit('/*\nInventory.Icon "MYICON"\n*/', 'MYICON'), undefined);
        assert.strictEqual(await hit('Inventory.PickupMessage "Inventory.Icon MYICON"', 'MYICON'), undefined);
        assert.strictEqual(await hit('/* ignored */ Inventory.Icon "MYICON" // rest', 'MYICON'), 'MYICON');
    });

    test('special lump discovery strips the last extension and truncates to eight characters', () => {
        for (const name of ['TEXTURES', 'textures.txt', 'TeXtUrEs.whatever', 'TEXTURES.classes.0_19']) {
            assert.ok(isTexturesFile(vscode.Uri.file('/tmp/' + name)), name);
        }
        assert.ok(!isTexturesFile(vscode.Uri.file('/tmp/TEXTURE.txt')));
    });
});

suite('Inventory.Icon — indexed resources and editor navigation', () => {
    let dir: string;
    let index: ResourceIndex;
    let cancellation: vscode.CancellationTokenSource;

    setup(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-icon-'));
        fs.writeFileSync(path.join(dir, 'MYICON.png'), png);
        fs.writeFileSync(path.join(dir, 'ONLYPNG.png'), png);
        fs.writeFileSync(path.join(dir, 'TEXTURES.whatever'), [
            '/* Sprite COMMENTED, 8, 8 {} */',
            'Sprite "MYICON", 16, 16 { Patch ONLYPNG, 0, 0 }',
            'Graphic OTHER, 8, 8 {}',
            'Sprite DUP, 8, 8 {}',
            'Sprite DUP, 16, 16 {}'
        ].join('\n'));
        index = new ResourceIndex();
        cancellation = new vscode.CancellationTokenSource();
        await index.ingestPackages([new FolderPackage('icons', 1, dir)]);
    });

    teardown(async () => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if ((input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom)
            && (input.uri.fsPath.startsWith(dir) || parseBaseResourceUri(input.uri)?.packageId.startsWith(dir))) {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        cancellation.dispose();
        index.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('definition wins over same-name image and returns its exact name range', async () => {
        const resource = await resolveInventoryIcon('myicon', index, cancellation.token);
        assert.ok(resource);
        assert.strictEqual(resource.type, ResourceType.TextureDefinition);
        const location = iconDefinitionLocation(resource)!;
        assert.strictEqual(location.uri.fsPath, path.join(dir, 'TEXTURES.whatever'));
        assert.deepStrictEqual([location.range.start.line, location.range.start.character, location.range.end.character], [1, 8, 14]);
        assert.strictEqual(await resolveInventoryIcon('COMMENTED', index, cancellation.token), undefined);
    });

    test('image fallback and missing resources do not become text definition locations', async () => {
        const resource = await resolveInventoryIcon('ONLYPNG', index, cancellation.token);
        assert.ok(resource);
        assert.strictEqual(resource.type, ResourceType.Png);
        assert.strictEqual(resource.uri.fsPath, path.join(dir, 'ONLYPNG.png'));
        assert.strictEqual(iconDefinitionLocation(resource), undefined);
        assert.strictEqual(await resolveInventoryIcon('MISSING', index, cancellation.token), undefined);
    });

    test('last duplicate definition in one lump wins', async () => {
        const resource = await resolveInventoryIcon('DUP', index, cancellation.token);
        assert.strictEqual(resource?.definitionRange?.start.line, 4);
        assert.strictEqual(resource?.width, 16);
    });

    test('later packages override earlier definitions and reingest drops obsolete sources', async () => {
        const file = path.join(dir, 'icons.pk3');
        fs.writeFileSync(file, zipSync({
            'textures.extra.any': Buffer.from('\nSprite MYICON, 32, 32 {}'),
            'graphics/ZIPICON.png': png
        }));
        const archive = new ZipPackage('icons.pk3', 2, file);
        await index.ingestPackages([new FolderPackage('icons', 1, dir), archive]);
        const resource = await resolveInventoryIcon('MYICON', index, cancellation.token);
        assert.ok(resource);
        assert.deepStrictEqual(parseBaseResourceUri(resource.uri), { packageId: 'icons.pk3', entryPath: 'textures.extra.any' });
        assert.strictEqual(resource.definitionRange?.start.line, 1);
        assert.strictEqual(resource.width, 32);
        assert.strictEqual((await resolveInventoryIcon('ZIPICON', index, cancellation.token))?.type, ResourceType.Png);
        await index.ingestPackages([]);
        assert.strictEqual(await resolveInventoryIcon('MYICON', index, cancellation.token), undefined);
    });

    test('cancelled lookup does not navigate', async () => {
        cancellation.cancel();
        assert.strictEqual(await resolveInventoryIcon('MYICON', index, cancellation.token), undefined);
    });

    test('workspace definitions override base definitions and unsaved renames update the index', async function () {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) { this.skip(); }
        const root = fs.mkdtempSync(path.join(folder!.uri.fsPath, 'icon-workspace-'));
        const uri = vscode.Uri.file(path.join(root, 'textures.custom'));
        fs.writeFileSync(uri.fsPath, 'Sprite MYICON, 64, 64 {}');
        const workspaceIndex = new ResourceIndex(path.basename(root));
        try {
            workspaceIndex.build();
            await workspaceIndex.whenReady();
            await workspaceIndex.ingestPackages([new FolderPackage('base', 1, dir)]);
            const resource = await resolveInventoryIcon('MYICON', workspaceIndex, cancellation.token);
            assert.strictEqual(resource?.uri.toString(), uri.toString());
            assert.strictEqual(resource?.width, 64);
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            edit.replace(uri, new vscode.Range(0, 7, 0, 13), 'RENAMED');
            assert.ok(await vscode.workspace.applyEdit(edit));
            const renamed = await resolveInventoryIcon('RENAMED', workspaceIndex, cancellation.token);
            assert.strictEqual(renamed?.uri.toString(), uri.toString());
            assert.strictEqual(doc.getText(renamed!.definitionRange), 'RENAMED');
            const fallback = await resolveInventoryIcon('MYICON', workspaceIndex, cancellation.token);
            assert.strictEqual(fallback?.uri.fsPath, path.join(dir, 'TEXTURES.whatever'));
        } finally {
            workspaceIndex.dispose();
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    async function editorFor(name: string): Promise<vscode.TextEditor> {
        const doc = await vscode.workspace.openTextDocument({ language: 'decorate', content: `actor TestIcon : Inventory { Inventory.Icon "${name}" }` });
        const editor = await vscode.window.showTextDocument(doc);
        const position = doc.positionAt(doc.getText().indexOf(name) + 1);
        editor.selection = new vscode.Selection(position, position);
        return editor;
    }

    test('F12 navigation opens the TEXTURES document at the definition', async () => {
        await openInventoryIcon(await editorFor('MYICON'), index);
        const editor = vscode.window.activeTextEditor!;
        assert.strictEqual(editor.document.uri.fsPath, path.join(dir, 'TEXTURES.whatever'));
        assert.strictEqual(editor.document.getText(editor.selection), 'MYICON');
    });

    test('image navigation opens a real image editor instead of binary text', async function () {
        this.timeout(10000);
        await openInventoryIcon(await editorFor('ONLYPNG'), index);
        const uri = vscode.Uri.file(path.join(dir, 'ONLYPNG.png')).toString();
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        assert.ok(tab?.input instanceof vscode.TabInputCustom);
        assert.strictEqual(tab.input.uri.toString(), uri);
        assert.strictEqual(tab.input.viewType, 'imagePreview.previewEditor');
    });

    test('registered F12 command jumps into a base PK3 and archive images open in the image editor', async function () {
        this.timeout(15000);
        const extension = vscode.extensions.getExtension('zandronum.zandronum-vscode');
        assert.ok(extension);
        await extension.activate();
        const file = path.join(dir, 'navigation.pk3');
        fs.writeFileSync(file, zipSync({
            'TEXTURES.any': Buffer.from('Graphic ARCHIVED, 8, 8 { Patch ZIPICON, 0, 0 }'),
            'graphics/ZIPICON.png': png
        }));
        const config = vscode.workspace.getConfiguration('zandronum-vscode');
        const previous = config.inspect('baseResources')?.globalValue;
        try {
            await config.update('baseResources', [file], vscode.ConfigurationTarget.Global);
            const editor = await editorFor('ARCHIVED');
            let definitions: vscode.Location[] = [];
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeDefinitionProvider', editor.document.uri, editor.selection.active) ?? [];
                if (definitions.length > 0) { break; }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
            const definitionUri = makeBaseResourceUri(file, 'TEXTURES.any');
            assert.ok(definitions.some(location => location.uri.toString() === definitionUri.toString()));
            await vscode.commands.executeCommand(INVENTORY_ICON_COMMAND);
            assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), definitionUri.toString());
            assert.strictEqual(vscode.window.activeTextEditor?.document.getText(vscode.window.activeTextEditor.selection), 'ARCHIVED');
            await index.ingestPackages([new ZipPackage(file, 1, file)]);
            await openInventoryIcon(await editorFor('ZIPICON'), index);
            const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputCustom);
            assert.strictEqual(input.viewType, 'imagePreview.previewEditor');
            assert.strictEqual(input.uri.toString(), makeBaseResourceUri(file, 'graphics/ZIPICON.png').toString());
            assert.deepStrictEqual(Buffer.from(await vscode.workspace.fs.readFile(input.uri)), png);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        } finally {
            await config.update('baseResources', previous, vscode.ConfigurationTarget.Global);
        }
    });
});
