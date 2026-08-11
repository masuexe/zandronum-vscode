import * as assert from 'assert';
import * as vscode from 'vscode';
import { extractActorClassArgAtCursor } from '../language/acs/definitionProvider';
import {
	collectCreateTranslationColors,
	collectKeywordPropertyTranslationColors,
	collectTranslationColorsOnLine,
} from '../language/shared/translationColorScan';
import { RgbColor } from '../tools/playpalReader';

function fakeDoc(lines: string[]): vscode.TextDocument {
	return {
		lineCount: lines.length,
		lineAt(line: number) {
			return { text: lines[line], lineNumber: line } as vscode.TextLine;
		},
	} as vscode.TextDocument;
}

suite('extractActorClassArgAtCursor', () => {
	test('hits GiveInventory class string', () => {
		const line = 'GiveInventory("MyCoolItem", 1);';
		const col = line.indexOf('Cool') + 1;
		const hit = extractActorClassArgAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'MyCoolItem');
		assert.strictEqual(hit!.calleeName, 'GiveInventory');
	});

	test('hits Spawn classname', () => {
		const line = 'Spawn("DoomImp", x, y, z, tid, angle);';
		const col = line.indexOf('Imp') + 1;
		const hit = extractActorClassArgAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'DoomImp');
		assert.strictEqual(hit!.calleeName, 'Spawn');
	});

	test('ignores later args and unquoted first arg', () => {
		const line = 'GiveInventory("Clip", amount);';
		assert.strictEqual(extractActorClassArgAtCursor(line, line.indexOf('amount') + 1), null);
		assert.strictEqual(extractActorClassArgAtCursor('Spawn(SomeVar, 0, 0, 0);', 7), null);
	});

	test('ignores unrelated callables', () => {
		const line = 'Print(s:"Clip");';
		assert.strictEqual(extractActorClassArgAtCursor(line, line.indexOf('Clip') + 1), null);
	});
});

suite('collectTranslationColorsOnLine — CreateTranslation shapes', () => {
	const palette: RgbColor[] = Array.from({ length: 256 }, (_, i) => ({
		r: i, g: 0, b: 255 - (i % 256),
	}));

	test('collects RGB brackets and palette indices', () => {
		const line = 'CreateTranslation(1, 16:47=[255,0,0]:[0,0,255]);';
		const colors = collectTranslationColorsOnLine(line, 0, palette);
		assert.ok(colors.length >= 4);
		const rgb = colors.filter(c => {
			const text = line.slice(c.range.start.character, c.range.end.character);
			return text.startsWith('[');
		});
		assert.strictEqual(rgb.length, 2);
		assert.ok(Math.abs(rgb[0].color.red - 1) < 0.01);
		assert.ok(Math.abs(rgb[1].color.blue - 1) < 0.01);
	});

	test('desat floats map through /2', () => {
		const line = 'CreateTranslation(1, 112:127=%[0,0,0]:[2,2,2]);';
		const colors = collectTranslationColorsOnLine(line, 0, palette);
		const brackets = colors.filter(c => {
			const text = line.slice(c.range.start.character, c.range.end.character);
			return text.startsWith('[');
		});
		assert.strictEqual(brackets.length, 2);
		assert.ok(brackets[0].color.red < 0.01);
		assert.ok(Math.abs(brackets[1].color.red - 1) < 0.01);
	});
});

suite('multi-line translation color spans', () => {
	const palette: RgbColor[] = Array.from({ length: 256 }, (_, i) => ({
		r: i, g: i, b: i,
	}));

	test('DECORATE Translation continuation after trailing comma', () => {
		const doc = fakeDoc([
			'Translation "192:192=215:215","198:198=102:102","202:202=218:218","199:199=116:116",',
			'"215:215=208:208","174:174=17:17","186:186=145:145","0:0=119:119"//trim',
			'}',
		]);
		const colors = collectKeywordPropertyTranslationColors(doc, /\bTranslation\b/i, palette);
		const onCont = colors.filter(c => c.range.start.line === 1);
		assert.ok(onCont.length >= 8, `expected continuation-line palette swatches, got ${onCont.length}`);
		assert.ok(colors.some(c => c.range.start.line === 0));
		assert.ok(!colors.some(c => c.range.start.line === 2));
	});

	test('ACS CreateTranslation continues until closing paren', () => {
		const doc = fakeDoc([
			'CreateTranslation(1,',
			'	16:47=[255,0,0]:[0,0,255],',
			'	112:127=%[0,0,0]:[2,2,2]);',
			'GiveInventory("Clip", 1);',
		]);
		const colors = collectCreateTranslationColors(doc, palette);
		assert.ok(colors.some(c => c.range.start.line === 1));
		assert.ok(colors.some(c => c.range.start.line === 2));
		const line1Rgb = colors.filter(c => {
			if (c.range.start.line !== 1) { return false; }
			const text = doc.lineAt(1).text.slice(c.range.start.character, c.range.end.character);
			return text.startsWith('[');
		});
		assert.strictEqual(line1Rgb.length, 2);
	});

	test('TEXTURES Translation keyword-only then quoted remaps', () => {
		const doc = fakeDoc([
			'texture BRSLT193,8, 56{offset -16,-8 patch B_4BARSX,0,0 {Translation',
			'    "192:192=138:138", "198:198=89:89",',
			'	"202:202=112:112", "199:199=95:95",',
			'	"204:204=160:160", "195:195=3:3",',
			'	"118:118=218:218", "119:119=5:5"',
			'}}',
		]);
		const colors = collectKeywordPropertyTranslationColors(doc, /\bTranslation\b/i, palette);
		assert.ok(colors.some(c => c.range.start.line === 1));
		assert.ok(colors.some(c => c.range.start.line === 4));
		// patch x,y before Translation must not become swatches
		assert.ok(!colors.some(c => c.range.start.line === 0 && c.range.start.character < doc.lineAt(0).text.search(/\bTranslation\b/i)));
		assert.ok(!colors.some(c => c.range.start.line === 5));
	});
});
