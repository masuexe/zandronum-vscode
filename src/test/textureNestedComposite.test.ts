import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { zlibSync } from 'fflate';
import { buildChunkBytes, PNG_SIGNATURE } from '../tools/png/pngChunkReader';
import { FolderPackage } from '../base/packages';
import { ResourceIndex } from '../language/textures/resourceIndex';
import { TexturesParser, TexturesNode } from '../language/textures/texturesParser';
import { TextureDocumentModel } from '../language/textures/textureDocumentModel';

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) { total += p.length; }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

function writeUint32BE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >>> 24) & 0xff;
    data[offset + 1] = (value >>> 16) & 0xff;
    data[offset + 2] = (value >>> 8) & 0xff;
    data[offset + 3] = value & 0xff;
}

/** Minimal valid RGBA8 PNG (filter-0 rows); size is what ResourceIndex reads. */
function buildRgbaPng(width: number, height: number): Uint8Array {
    const rowBytes = width * 4;
    const scanlines = new Uint8Array(height * (rowBytes + 1));
    for (let y = 0; y < height; y++) {
        const row = y * (rowBytes + 1);
        for (let x = 0; x < width; x++) {
            const o = row + 1 + x * 4;
            scanlines[o] = (x * 8) & 0xff;
            scanlines[o + 1] = (y * 8) & 0xff;
            scanlines[o + 2] = 128;
            scanlines[o + 3] = 255;
        }
    }
    const ihdr = new Uint8Array(13);
    writeUint32BE(ihdr, 0, width);
    writeUint32BE(ihdr, 4, height);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return concat([
        PNG_SIGNATURE,
        buildChunkBytes('IHDR', ihdr),
        buildChunkBytes('IDAT', zlibSync(scanlines)),
        buildChunkBytes('IEND', new Uint8Array(0))
    ]);
}

function fakeDocument(text: string): vscode.TextDocument {
    const lines = text.split(/\r?\n/);
    return {
        uri: vscode.Uri.file(path.join(os.tmpdir(), 'fake', 'TEXTURES.txt')),
        version: 1,
        lineCount: lines.length,
        lineAt(n: number) {
            return {
                text: lines[n] ?? '',
                lineNumber: n,
                range: new vscode.Range(n, 0, n, (lines[n] ?? '').length),
                rangeIncludingLineBreak: new vscode.Range(n, 0, n, (lines[n] ?? '').length),
                firstNonWhitespaceCharacterIndex: 0,
                isEmptyOrWhitespace: !(lines[n] ?? '').trim()
            };
        },
        getText(range?: vscode.Range) {
            if (!range) { return text; }
            return (lines[range.start.line] ?? '').slice(range.start.character, range.end.character);
        }
    } as unknown as vscode.TextDocument;
}

const fakeWebview = { asWebviewUri: (uri: vscode.Uri) => uri } as unknown as vscode.Webview;

function patchChildren(node: TexturesNode | undefined): TexturesNode[] {
    return node ? node.children.filter(c => c.patchData) : [];
}

// FlightUnit-shaped chain (unholyrazon4 TEXTURES.classes.0_19): the texture
// editor previously left these as blue placeholders without PLAYPAL.
const NESTED_SRC = [
    'sprite 6G18D0, 124, 108 {Patch 6G18A0, 0, 0 {Translation "192:192=193:193", "198:198=240:240"}}',
    'sprite 6G18E0, 144, 116 {Patch 6G18B0, 0, 0 {Translation "192:192=193:193"}}',
    'sprite 6H18D0, 420, 180 {Offset 50, -64 Patch 6G18D0, 46, 22 {FlipX}Patch 6G18E0, 250, 30}',
    'sprite 6H18G0, 420, 180 {Offset 50, -64 Patch 6H18D0, 0, 0 {FlipX}}'
].join('\n');

// Verbatim compact one-line definitions (6H18A0..F0) from the reproducer.
const COMPACT_SRC = [
    'sprite 6H18A0, 420, 180 {Offset 50, -64 Patch 6G18D0, 46, 22 {FlipX}Patch 6G18D0, 250, 22}',
    'sprite 6H18B0, 420, 180 {Offset 50, -64 Patch 6G18E0, 26, 30 {FlipX}Patch 6G18E0, 250, 30}',
    'sprite 6H18C0, 420, 180 {Offset 50, -64 Patch 6G18F0, 26, 30 {FlipX}Patch 6G18F0, 254, 30}',
    'sprite 6H18D0, 420, 180 {Offset 50, -64 Patch 6G18D0, 46, 22 {FlipX}Patch 6G18E0, 250, 30}',
    'sprite 6H18E0, 420, 180 {Offset 50, -64 Patch 6G18D0, 46, 22 {FlipX}Patch 6G18F0, 254, 30}',
    'sprite 6H18F0, 420, 180 {Offset 50, -64 Patch 6G18E0, 26, 30 {FlipX}Patch 6G18F0, 254, 30}'
].join('\n');

suite('texture model — nested composites with Translation', () => {
    let model: TextureDocumentModel;

    suiteSetup(async function () {
        this.timeout(10000);
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-flightunit-'));
        try {
            fs.writeFileSync(path.join(tmpDir, '6G18A0.png'), buildRgbaPng(124, 108));
            fs.writeFileSync(path.join(tmpDir, '6G18B0.png'), buildRgbaPng(144, 116));
            const index = new ResourceIndex('src');
            await index.ingestPackages([new FolderPackage('flightunit.pk3', 1, tmpDir)]);

            const parser = new TexturesParser();
            const doc = fakeDocument(NESTED_SRC);
            parser.update(doc);
            model = new TextureDocumentModel(doc, parser, index);
            model.update();
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('one-level composite with translated PNG resolves fully without a palette', () => {
        const resolved = model.resolveResourceFull('patch:6G18D0', fakeWebview);
        assert.strictEqual(resolved.resourceType, 'composite');
        assert.strictEqual(resolved.width, 124);
        assert.strictEqual(resolved.height, 108);
        assert.strictEqual(resolved.subPatches?.length, 1);
        const sp = resolved.subPatches![0];
        // Leaf must be a real image URI — a missing resource here is what turned
        // the preview into a blue definition-sized placeholder before the fix.
        assert.ok(sp.uri, 'leaf PNG must resolve');
        assert.strictEqual(sp.width, 124);
        assert.strictEqual(sp.height, 108);
        assert.ok(sp.translation, 'Translation reaches the webview');
    });

    test('two-level nested composite resolves without a palette', () => {
        const resolved = model.resolveResourceFull('patch:6H18G0', fakeWebview);
        assert.strictEqual(resolved.resourceType, 'composite');
        assert.strictEqual(resolved.width, 420);
        assert.strictEqual(resolved.height, 180);
        assert.strictEqual(resolved.subPatches?.length, 1);

        const level1 = resolved.subPatches![0]; // 6H18D0 wrapper
        assert.strictEqual(level1.uri, null);
        assert.strictEqual(level1.flipX, true);
        assert.strictEqual(level1.children?.length, 2);

        const level2 = level1.children![0]; // 6G18D0 wrapper
        assert.strictEqual(level2.uri, null);
        assert.strictEqual(level2.flipX, true);
        assert.strictEqual(level2.children?.length, 1);
        assert.ok(level2.children![0].uri, 'leaf PNG must resolve');
        assert.ok(level2.children![0].translation, 'Translation survives two nesting levels');
    });
});

suite('textures parser — compact one-line FlightUnit definitions', () => {
    let symbols: TexturesNode[];

    suiteSetup(() => {
        const parser = new TexturesParser();
        parser.update(fakeDocument(COMPACT_SRC));
        symbols = parser.getSymbols();
    });

    function byName(name: string): TexturesNode | undefined {
        return symbols.find(n => n.name.toLowerCase() === name.toLowerCase());
    }

    test('parses both adjacent patches in each of 6H18A0..F0', () => {
        const expected: Record<string, Array<[string, number, number, boolean]>> = {
            '6h18a0': [['6g18d0', 46, 22, true], ['6g18d0', 250, 22, false]],
            '6h18b0': [['6g18e0', 26, 30, true], ['6g18e0', 250, 30, false]],
            '6h18c0': [['6g18f0', 26, 30, true], ['6g18f0', 254, 30, false]],
            '6h18d0': [['6g18d0', 46, 22, true], ['6g18e0', 250, 30, false]],
            '6h18e0': [['6g18d0', 46, 22, true], ['6g18f0', 254, 30, false]],
            '6h18f0': [['6g18e0', 26, 30, true], ['6g18f0', 254, 30, false]]
        };
        for (const [name, patches] of Object.entries(expected)) {
            const node = byName(name);
            assert.ok(node, `${name} parsed`);
            assert.deepStrictEqual(
                node!.defData, { width: 420, height: 180 }, `${name} size`
            );
            const children = patchChildren(node);
            assert.strictEqual(children.length, 2, `${name} patch count`);
            children.forEach((child, i) => {
                assert.strictEqual(child.name.toLowerCase(), patches[i][0], `${name} patch ${i} name`);
                assert.strictEqual(child.patchData!.x, patches[i][1], `${name} patch ${i} x`);
                assert.strictEqual(child.patchData!.y, patches[i][2], `${name} patch ${i} y`);
                assert.strictEqual(!!child.patchProps.FlipX, patches[i][3], `${name} patch ${i} FlipX`);
            });
        }
    });

    test('parses Offset from the same compact line', () => {
        const node = byName('6H18A0');
        assert.ok(node);
        assert.strictEqual(node!.texProps.OffsetX, 50);
        assert.strictEqual(node!.texProps.OffsetY, -64);
    });
});

suite('texture model — compact graphic patch FlipX', () => {
    const GRAPHIC_SRC =
        'graphic C_I_49AW, 71, 61 {Offset 25, 22 Patch 6N49A0, 0, 0 Patch 6N49B0, 26, 25}';

    test('parser starts the second patch at Patch, not the Graphic definition', () => {
        const parser = new TexturesParser();
        parser.update(fakeDocument(GRAPHIC_SRC));
        const patches = patchChildren(parser.getSymbols()[0]);
        assert.strictEqual(patches.length, 2);
        assert.ok(patches[1].range.start.character > 0);
        assert.ok(
            GRAPHIC_SRC.substring(patches[1].range.start.character).startsWith('Patch 6N49B0')
        );
    });

    test('FlipX rewrites only the patch, not the whole graphic body', async function () {
        this.timeout(10000);
        const doc = await vscode.workspace.openTextDocument({
            content: GRAPHIC_SRC,
            language: 'textures'
        });
        const parser = new TexturesParser();
        const model = new TextureDocumentModel(doc, parser, new ResourceIndex('src'));
        model.update();
        const patches = patchChildren(parser.getSymbols()[0]);
        assert.strictEqual(patches.length, 2);
        const ok = await model.applyPatchProps(patches[1].id, { FlipX: true }, doc.version);
        assert.ok(ok, 'applyPatchProps should succeed');
        const text = doc.getText();
        assert.ok(
            /Offset\s+25\s*,\s*22/i.test(text),
            `Offset must remain, got: ${text}`
        );
        assert.ok(
            /Patch\s+6N49A0\s*,\s*0\s*,\s*0/i.test(text),
            `first patch must remain, got: ${text}`
        );
        assert.ok(
            /Patch\s+6N49B0\s*,\s*26\s*,\s*25\s*\{FlipX\}/i.test(text),
            `FlipX must attach to 6N49B0, got: ${text}`
        );
        assert.ok(
            !/graphic\s+C_I_49AW,\s*71,\s*61\s*\{FlipX\}\s*$/i.test(text.trim()),
            `must not collapse the graphic to {FlipX}, got: ${text}`
        );
    });
});
