import * as assert from 'assert';
import { formatSbarinfoLines } from '../language/sbarinfo/formattingProvider';

function format(src: string): string {
	return formatSbarinfoLines(src.split('\n')).join('\n');
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

suite('sbarinfoFormat — space before open brace', () => {
	test('inserts a space before same-line {', () => {
		const out = format('StatusBar Fullscreen{').split('\n');
		assert.strictEqual(out[0], 'StatusBar Fullscreen {');
	});

	test('leaves a standalone open brace unchanged', () => {
		const input = ['StatusBar Fullscreen', '{', '}'].join('\n');
		const out = format(input).split('\n');
		assert.strictEqual(out[1], '{');
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

	test('does not rewrite slashes inside strings', () => {
		const out = format('drawimage "//not a comment", 0, 0').split('\n');
		assert.strictEqual(out[0], 'drawimage "//not a comment", 0, 0');
	});
});
