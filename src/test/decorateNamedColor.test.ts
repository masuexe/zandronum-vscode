import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActionData } from '../shared/dataLoader';
import {
    buildColorParameterIndex,
    collectDecorateFunctionColors,
    provideNamedColorPresentations,
    resolveNamedColor,
} from '../language/decorate/namedColorScan';

interface X11Data {
    colors: Record<string, [number, number, number]>;
}

const actions: Record<string, ActionData> = {
    A_CustomRailgun: {
        params: [
            { name: 'damage', type: 'int' },
            { name: 'spawnofs_xy', type: 'int' },
            { name: 'color1', type: 'color' },
            { name: 'color2', type: 'color' },
        ],
    },
    A_SetBlend: {
        params: [
            { name: 'color1', type: 'color' },
            { name: 'alpha', type: 'float' },
            { name: 'tics', type: 'int' },
            { name: 'color2', type: 'color' },
        ],
    },
    A_RailAttack: {
        params: [
            { name: 'damage', type: 'int' },
            { name: 'spawnofs_xy', type: 'int' },
            { name: 'useammo', type: 'int' },
            { name: 'color1', type: 'color' },
            { name: 'color2', type: 'color' },
        ],
    },
};

function fakeDoc(text: string): vscode.TextDocument {
    const lineOffsets = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') {
            lineOffsets.push(i + 1);
        }
    }
    return {
        getText(range?: vscode.Range) {
            if (!range) {
                return text;
            }
            return text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
        },
        positionAt(offset: number) {
            const bounded = Math.max(0, Math.min(offset, text.length));
            let line = 0;
            while (line + 1 < lineOffsets.length && lineOffsets[line + 1] <= bounded) {
                line++;
            }
            return new vscode.Position(line, bounded - lineOffsets[line]);
        },
        offsetAt(position: vscode.Position) {
            return (lineOffsets[position.line] ?? text.length) + position.character;
        },
    } as vscode.TextDocument;
}

function loadColors(): Record<string, [number, number, number]> {
    const file = path.join(__dirname, '../../data/decorate/x11Colors.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as X11Data).colors;
}

suite('DECORATE function color preview', () => {
    const colors = loadColors();
    const colorParameterIndex = buildColorParameterIndex(actions);

    test('bundles the complete Zandronum X11 table', () => {
        assert.strictEqual(Object.keys(colors).length, 752);
        assert.deepStrictEqual(resolveNamedColor('SlateGray1', colors), [198, 226, 255]);
        assert.deepStrictEqual(resolveNamedColor('ghost white', colors), [248, 248, 255]);
        assert.deepStrictEqual(resolveNamedColor('GHOSTWHITE', colors), [248, 248, 255]);
    });

    test('collects only metadata-declared color arguments', () => {
        const document = fakeDoc([
            'A_CustomRailgun(10, 0, "SlateGray1", "ghost white");',
            'a_setblend(red, 1.0, 10, "00 ff 00");',
            'A_RailAttack(1, 0, 1,',
            '    "#00f", "abcdef");',
            'SomeOtherFunction("Red");',
            'A_SetBlend("unknown", 1.0, 1);',
            '// A_SetBlend("Blue", 1.0, 1);',
            '/* A_SetBlend("Green", 1.0, 1); */',
        ].join('\n'));

        const found = collectDecorateFunctionColors(document, colorParameterIndex, colors);
        assert.strictEqual(found.length, 6);
        const texts = found.map(item => document.getText(item.range));
        assert.deepStrictEqual(texts, [
            'SlateGray1', 'ghost white', 'red', '00 ff 00', '#00f', 'abcdef',
        ]);
    });

    test('color presentation preserves quotes and quotes bare names', () => {
        const quoted = fakeDoc('A_SetBlend("Red", 1.0, 1);');
        const quotedStart = quoted.getText().indexOf('Red');
        const quotedRange = new vscode.Range(
            quoted.positionAt(quotedStart),
            quoted.positionAt(quotedStart + 3)
        );
        const quotedPresentation = provideNamedColorPresentations(
            new vscode.Color(0, 1, 0, 1),
            { document: quoted, range: quotedRange }
        )[0];
        assert.strictEqual(quotedPresentation.textEdit?.newText, '#00ff00');

        const bare = fakeDoc('A_SetBlend(Red, 1.0, 1);');
        const bareStart = bare.getText().indexOf('Red');
        const bareRange = new vscode.Range(bare.positionAt(bareStart), bare.positionAt(bareStart + 3));
        const barePresentation = provideNamedColorPresentations(
            new vscode.Color(0, 1, 0, 1),
            { document: bare, range: bareRange }
        )[0];
        assert.strictEqual(barePresentation.textEdit?.newText, '"#00ff00"');
    });
});
