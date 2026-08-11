import * as assert from 'assert';
import { extractActorClassArgAtCursor } from '../language/acs/definitionProvider';
import { collectTranslationColorsOnLine } from '../language/shared/translationColorScan';
import { RgbColor } from '../tools/playpalReader';

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
