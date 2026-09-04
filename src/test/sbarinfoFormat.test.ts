import * as assert from 'assert';
import {
	SbarinfoFormatOptions,
	formatSbarinfoLines,
} from '../language/sbarinfo/formattingProvider';

const defaultOpts: SbarinfoFormatOptions = {
	tabSize: 2,
	insertSpaces: true,
	braceStyle: 'nextLine',
};

function format(src: string, opts: Partial<SbarinfoFormatOptions> = {}): string {
	const options: SbarinfoFormatOptions = { ...defaultOpts, ...opts };
	return formatSbarinfoLines(src.split('\n'), options).join('\n');
}

suite('sbarinfoFormat — space after comma', () => {
	test('inserts one space after commas', () => {
		const out = format('drawnumber 3,HEALTH,-20,-4').split('\n');
		assert.strictEqual(out[0], 'drawnumber 3, HEALTH, -20, -4');
	});

	test('does not change commas inside strings', () => {
		const out = format('drawstring 0, "a,b", 0, 0').split('\n');
		assert.strictEqual(out[0], 'drawstring 0, "a,b", 0, 0');
	});

	test('leaves trailing commas alone', () => {
		const out = format('drawnumber 3, HEALTH,').split('\n');
		assert.strictEqual(out[0], 'drawnumber 3, HEALTH,');
	});
});

suite('sbarinfoFormat — brace style and indent', () => {
	test('keeps Allman braces and indents the body', () => {
		const input = [
			'InInventory GammaPlayerPowerHP, 1',
			'{',
			'DrawImage "GAMA2FHX", 18, -1;',
			'DrawBar "GAMA2PH0", "NOBAR", GammaPlayerHealth, vertical, 24, 8;',
			'}',
			'else',
			'{',
			'DrawBar "BARHEALT", "GAMA2ECX", GammaPlayerHealth, vertical, 24, 8;',
			'}',
		].join('\n');

		const expected = [
			'InInventory GammaPlayerPowerHP, 1',
			'{',
			'  DrawImage "GAMA2FHX", 18, -1;',
			'  DrawBar "GAMA2PH0", "NOBAR", GammaPlayerHealth, vertical, 24, 8;',
			'}',
			'else',
			'{',
			'  DrawBar "BARHEALT", "GAMA2ECX", GammaPlayerHealth, vertical, 24, 8;',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
		assert.strictEqual(format(expected), expected);
	});

	test('splits same-line braces to nextLine by default', () => {
		const out = format('StatusBar Fullscreen{').split('\n');
		assert.strictEqual(out[0], 'StatusBar Fullscreen');
		assert.strictEqual(out[1], '{');
	});

	test('sameLine merges Allman braces onto the header', () => {
		const input = [
			'InInventory GammaPlayerPowerHP, 1',
			'{',
			'DrawImage "GAMA2FHX", 18, -1;',
			'}',
			'else',
			'{',
			'DrawBar "BARHEALT", "GAMA2ECX", GammaPlayerHealth, vertical, 24, 8;',
			'}',
		].join('\n');

		const expected = [
			'InInventory GammaPlayerPowerHP, 1 {',
			'  DrawImage "GAMA2FHX", 18, -1;',
			'}',
			'else {',
			'  DrawBar "BARHEALT", "GAMA2ECX", GammaPlayerHealth, vertical, 24, 8;',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});

	test('does not change { inside strings', () => {
		const out = format('drawimage "foo{", 0, 0').split('\n');
		assert.strictEqual(out[0], 'drawimage "foo{", 0, 0');
	});
});

suite('sbarinfoFormat — comments', () => {
	test('spaces full-line comments after // only', () => {
		const out = format('//note').split('\n');
		assert.strictEqual(out[0], '// note');
	});

	test('preserves multiple spaces after //', () => {
		const out = format('//      aligned').split('\n');
		assert.strictEqual(out[0], '//      aligned');
	});

	test('spaces trailing line comments Google-style', () => {
		const out = format('height 32//hud').split('\n');
		assert.strictEqual(out[0], 'height 32  // hud');
	});

	test('keeps block comment header aligned and idempotent', () => {
		const input = ['/*', ' * MIT License', ' *', ' * Copyright (c)', ' */'].join('\n');

		const once = format(input);
		assert.strictEqual(once, input);
		assert.strictEqual(format(once), input);
	});

	test('aligns block comments inside a block with the opening line', () => {
		const input = [
			'InInventory GammaPlayerPowerHP, 1',
			'{',
			'/*',
			'* note',
			'*/',
			'DrawImage "GAMA2FHX", 18, -1;',
			'}',
		].join('\n');

		const expected = [
			'InInventory GammaPlayerPowerHP, 1',
			'{',
			'  /*',
			'   * note',
			'   */',
			'  DrawImage "GAMA2FHX", 18, -1;',
			'}',
		].join('\n');
		assert.strictEqual(format(input), expected);
	});

	test('does not rewrite slashes inside strings', () => {
		const out = format('drawimage "//not a comment", 0, 0').split('\n');
		assert.strictEqual(out[0], 'drawimage "//not a comment", 0, 0');
	});
});
