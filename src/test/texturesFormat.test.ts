import * as assert from 'assert';
import { formatTexturesLines } from '../language/textures/formattingProvider';

function format(src: string): string {
	return formatTexturesLines(src.split('\n')).join('\n');
}

suite('texturesFormat — space after comma', () => {
	test('inserts one space after commas', () => {
		const out = format('Texture "FOO",64,64').split('\n');
		assert.strictEqual(out[0], 'Texture "FOO", 64, 64');
	});

	test('does not change commas inside strings', () => {
		const out = format('Translation "192:192=248:248","198:198=102:102"').split('\n');
		assert.strictEqual(out[0], 'Translation "192:192=248:248", "198:198=102:102"');
	});

	test('leaves trailing commas alone', () => {
		const out = format('Texture "FOO", 64,').split('\n');
		assert.strictEqual(out[0], 'Texture "FOO", 64,');
	});
});

suite('texturesFormat — space before string', () => {
	test('inserts a space between Translation and a quoted remap', () => {
		const out = format('Translation"192:192=4:4"').split('\n');
		assert.strictEqual(out[0], 'Translation "192:192=4:4"');
	});
});

suite('texturesFormat — space before open brace', () => {
	test('inserts a space before same-line {', () => {
		const out = format('Patch "BAR", 0, 0{ FlipX }').split('\n');
		assert.strictEqual(out[0], 'Patch "BAR", 0, 0 { FlipX }');
	});

	test('leaves a standalone open brace unchanged', () => {
		const input = ['Texture "FOO", 64, 64', '{', '}'].join('\n');
		const out = format(input).split('\n');
		assert.strictEqual(out[1], '{');
	});

	test('does not change { inside strings', () => {
		const out = format('Patch "foo{", 0, 0').split('\n');
		assert.strictEqual(out[0], 'Patch "foo{", 0, 0');
	});
});

suite('texturesFormat — comments', () => {
	test('spaces full-line comments after // only', () => {
		const out = format('//note').split('\n');
		assert.strictEqual(out[0], '// note');
	});

	test('preserves multiple spaces after //', () => {
		const out = format('//      aligned').split('\n');
		assert.strictEqual(out[0], '//      aligned');
	});

	test('spaces trailing line comments Google-style', () => {
		const out = format('XScale 2.0//scale').split('\n');
		assert.strictEqual(out[0], 'XScale 2.0  // scale');
	});

	test('does not rewrite slashes inside strings', () => {
		const out = format('Patch "//not a comment", 0, 0').split('\n');
		assert.strictEqual(out[0], 'Patch "//not a comment", 0, 0');
	});
});
