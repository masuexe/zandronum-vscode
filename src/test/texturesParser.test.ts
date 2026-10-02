import * as assert from 'assert';
import * as vscode from 'vscode';
import { TexturesParser } from '../language/textures/texturesParser';
import { buildRemapTable, parseTranslationValue } from '../tools/translation';

const translation = '"4:4=80:80","67:67=82:82","45:45=120:120","188:188=121:121"';

async function parse(content: string) {
    const document = await vscode.workspace.openTextDocument({ language: 'textures', content });
    return new TexturesParser().parse(document);
}

suite('TEXTURES parser — multiline Translation', () => {
    test('compact sprite with a wrapped Translation applies all four remaps', async () => {
        const result = await parse('sprite 8H60A0, 172, 272 {Offset 0, 0 Patch MGCHA0, 0, 0 {Translation "4:4=80:80", "67:67=82:82",\n' +
            '                                                                     "45:45=120:120", "188:188=121:121"}}\n' +
            'sprite NEXT, 16, 16 { Patch OTHER, 0, 0 }');
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.rootNodes.length, 2);
        const sprite = result.rootNodes[0];
        assert.strictEqual(sprite.children.length, 1);
        const patch = sprite.children[0];
        assert.strictEqual(patch.patchProps.Translation, translation);
        assert.strictEqual(patch.range.end.line, 1);
        assert.strictEqual(sprite.range.end.line, 1);
        assert.strictEqual(patch.patchPropRanges.propBlock?.end.line, 1);
        const table = buildRemapTable(parseTranslationValue(patch.patchProps.Translation!));
        assert.deepStrictEqual([table[4], table[67], table[45], table[188]], [80, 82, 120, 121]);
        assert.strictEqual(table[5], 5);
    });

    for (const opening of ['Patch MGCHA0, 0, 0 {Translation', 'Patch MGCHA0, 0, 0\n{Translation', 'Patch MGCHA0, 0, 0\n{\nTranslation']) {
        test(`collects continuation strings and comments after ${JSON.stringify(opening)}`, async () => {
            const result = await parse(`sprite 8H60A0, 172, 272\n{\n${opening} "4:4=80:80", "67:67=82:82", // remaps\n` +
                '/* } Translation "0:0=1:1" */\n"45:45=120:120",\n"188:188=121:121" FlipX }\n' +
                'Patch OTHER, 1, 2 {Translation "0:0=3:3"}\n}');
            assert.deepStrictEqual(result.diagnostics, []);
            const patches = result.rootNodes[0].children;
            assert.strictEqual(patches.length, 2);
            assert.strictEqual(patches[0].patchProps.Translation, translation);
            assert.strictEqual(patches[0].patchProps.FlipX, true);
            assert.strictEqual(patches[1].patchProps.Translation, '"0:0=3:3"');
        });
    }

    test('preserves compact single-line Translation and named Translation', async () => {
        const result = await parse(`sprite TEST, 16, 16 {Patch FIRST, 0, 0 {Translation ${translation}} Patch SECOND, 0, 0 {Translation Gold}}`);
        assert.deepStrictEqual(result.diagnostics, []);
        const patches = result.rootNodes[0].children;
        assert.strictEqual(patches[0].patchProps.Translation, translation);
        assert.strictEqual(patches[1].patchProps.Translation, 'Gold');
    });

    test('does not close a definition when only an inline patch block closes', async () => {
        const result = await parse('sprite TEST, 16, 16 {Patch FIRST, 0, 0 {Translation "0:0=1:1"}\nPatch SECOND, 0, 0\n}');
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.rootNodes[0].children.length, 2);
    });

    test('tracks a wrapped patch on a separate definition opening line', async () => {
        const result = await parse('sprite TEST, 16, 16\n{Patch FIRST, 0, 0 {Translation "4:4=80:80",\n"67:67=82:82"}}');
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.rootNodes[0].children[0].patchProps.Translation, '"4:4=80:80","67:67=82:82"');
    });

    test('keeps a named Translation separate from closing braces', async () => {
        const result = await parse('sprite TEST, 16, 16 {Patch FIRST, 0, 0 {\nTranslation Gold\n}}');
        assert.deepStrictEqual(result.diagnostics, []);
        assert.strictEqual(result.rootNodes[0].children[0].patchProps.Translation, 'Gold');
    });
});
