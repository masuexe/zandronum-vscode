import * as assert from 'assert';
import {
	DecorateFormatOptions,
	formatDecorateLines,
	structuralLine,
} from '../language/decorate/formattingProvider';

const defaultOpts: DecorateFormatOptions = {
	tabSize: 2,
	insertSpaces: true,
	stateLabelStyle: 'outdent',
	braceStyle: 'nextLine',
	spaceAfterComma: true,
};

function format(src: string, opts: Partial<DecorateFormatOptions> = {}): string {
	const options: DecorateFormatOptions = { ...defaultOpts, ...opts };
	return formatDecorateLines(src.split('\n'), options).join('\n');
}

function formatRange(
	src: string,
	startLine: number,
	endLine: number,
	endCharacter = 1,
	opts: Partial<DecorateFormatOptions> = {}
): string {
	const options: DecorateFormatOptions = { ...defaultOpts, ...opts };
	return formatDecorateLines(src.split('\n'), options, {
		startLine,
		endLine,
		endCharacter,
	}).join('\n');
}

suite('decorateFormat — structuralLine', () => {
	test('ignores braces inside line comments', () => {
		const r = structuralLine('Health 1 // {', false);
		assert.strictEqual(r.text.includes('{'), false);
		assert.strictEqual(r.inBlockComment, false);
	});

	test('ignores braces inside strings', () => {
		const r = structuralLine('DropItem "Foo{Bar"', false);
		assert.strictEqual(r.text.includes('{'), false);
	});

	test('tracks multi-line block comments', () => {
		const a = structuralLine('Health 1 /* {', false);
		assert.strictEqual(a.inBlockComment, true);
		assert.strictEqual(a.text.includes('{'), false);
		const b = structuralLine('  still { here', true);
		assert.strictEqual(b.inBlockComment, true);
		assert.strictEqual(b.text.includes('{'), false);
		const c = structuralLine('  */ +SOLID', true);
		assert.strictEqual(c.inBlockComment, false);
		assert.ok(c.text.includes('+SOLID'));
	});
});

suite('decorateFormat — zero-indent SLADE style', () => {
	test('formats actor to wiki-style outdent labels', () => {
		const input = [
			'Actor ZombieMan : DoomImp 3004',
			'{',
			'Health 20',
			'+SOLID',
			'States',
			'{',
			'Spawn:',
			'POSS AB 10 A_Look',
			'Loop',
			'}',
			'}',
		].join('\n');

		const expected = [
			'Actor ZombieMan : DoomImp 3004',
			'{',
			'  Health 20',
			'  +SOLID',
			'  States',
			'  {',
			'  Spawn:',
			'    POSS AB 10 A_Look',
			'    Loop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('is idempotent', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'States',
			'{',
			'Spawn:',
			'TROO A 1',
			'Stop',
			'}',
			'}',
		].join('\n');
		const once = format(input);
		assert.strictEqual(format(once), once);
	});

	test('splits States { onto the next line by default', () => {
		const input = [
			'Actor Foo',
			'{',
			'States {',
			'Spawn:',
			'TNT1 A 0',
			'Stop',
			'}',
			'}',
		].join('\n');

		const expected = [
			'Actor Foo',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0',
			'    Stop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('keeps #include at column 0', () => {
		const input = [
			'  #include "actors/common.dec"',
			'Actor Foo',
			'{',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[0], '#include "actors/common.dec"');
		assert.strictEqual(out[1], 'Actor Foo');
		assert.strictEqual(out[3], '  Health 1');
	});

	test('formats dotted and digit-leading labels', () => {
		const input = [
			'Actor Gun : Weapon',
			'{',
			'States',
			'{',
			'Flash.AnimA:',
			'PISF A 1',
			'Stop',
			'2Burn:',
			'TNT1 A 0',
			'Stop',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[4], '  Flash.AnimA:');
		assert.strictEqual(out[5], '    PISF A 1');
		assert.strictEqual(out[7], '  2Burn:');
		assert.strictEqual(out[8], '    TNT1 A 0');
	});
});

suite('decorateFormat — comments and strings', () => {
	test('braces in strings do not change depth', () => {
		const input = [
			'Actor Foo',
			'{',
			'DropItem "Clip{Special}"',
			'Health 1',
			'}',
		].join('\n');

		const expected = [
			'Actor Foo',
			'{',
			'  DropItem "Clip{Special}"',
			'  Health 1',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('braces in block comments do not change depth', () => {
		const input = [
			'Actor Foo',
			'{',
			'/*',
			'{',
			'*/',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[5], '  Health 1');
		assert.strictEqual(out[6], '}');
	});

	test('preserves trailing whitespace on code lines', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1   ',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  Health 1   ');
	});

	test('leaves blank lines unchanged', () => {
		const input = [
			'Actor Foo',
			'{',
			'',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '');
	});
});

suite('decorateFormat — stateLabelStyle', () => {
	test('indent keeps labels at frame depth', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Spawn:',
			'TROO A 1',
			'Loop',
			'}',
			'}',
		].join('\n');

		const expected = [
			'Actor Foo',
			'{',
			'  States',
			'  {',
			'    Spawn:',
			'    TROO A 1',
			'    Loop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { stateLabelStyle: 'indent' }), expected);
	});
});

suite('decorateFormat — tabs and range', () => {
	test('uses tabs when insertSpaces is false', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input, { insertSpaces: false, tabSize: 4 }).split('\n');
		assert.strictEqual(out[2], '\tHealth 1');
	});

	test('format selection only rewrites overlapping lines', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'Radius 16',
			'}',
		].join('\n');

		// Only format the Health line; Radius stays unindented.
		const out = formatRange(input, 2, 2).split('\n');
		assert.strictEqual(out[2], '  Health 1');
		assert.strictEqual(out[3], 'Radius 16');
	});

	test('exclusive end at character 0 skips the last line', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'Radius 16',
			'}',
		].join('\n');

		const out = formatRange(input, 2, 3, 0).split('\n');
		assert.strictEqual(out[2], '  Health 1');
		assert.strictEqual(out[3], 'Radius 16');
	});

	test('unmatched closing brace does not delete content', () => {
		const input = [
			'}',
			'Actor Foo',
			'{',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input);
		assert.ok(out.includes('Actor Foo'));
		assert.ok(out.includes('Health 1'));
		assert.strictEqual(out.split('\n')[0], '}');
	});

	test('formats multiple actors in one file', () => {
		const input = [
			'Actor A',
			'{',
			'Health 1',
			'}',
			'Actor B',
			'{',
			'Health 2',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[0], 'Actor A');
		assert.strictEqual(out[2], '  Health 1');
		assert.strictEqual(out[4], 'Actor B');
		assert.strictEqual(out[6], '  Health 2');
	});
});

suite('decorateFormat — braceStyle', () => {
	test('sameLine merges Actor and States braces', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'States',
			'{',
			'Spawn:',
			'TROO A 1',
			'Stop',
			'}',
			'}',
		].join('\n');

		const expected = [
			'Actor Foo {',
			'  Health 1',
			'  States {',
			'  Spawn:',
			'    TROO A 1',
			'    Stop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});

	test('sameLine is idempotent', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Spawn:',
			'TROO A 1',
			'Stop',
			'}',
			'}',
		].join('\n');
		const once = format(input, { braceStyle: 'sameLine' });
		assert.strictEqual(format(once, { braceStyle: 'sameLine' }), once);
	});

	test('nextLine is idempotent after splitting same-line braces', () => {
		const input = [
			'Actor Foo {',
			'States {',
			'Spawn:',
			'TROO A 1',
			'Stop',
			'}',
			'}',
		].join('\n');
		const once = format(input);
		assert.strictEqual(format(once), once);
	});

	test('nextLine splits empty same-line blocks', () => {
		const input = [
			'Actor Foo { }',
		].join('\n');

		const expected = [
			'Actor Foo',
			'{',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('sameLine keeps empty blocks on one line', () => {
		assert.strictEqual(format('Actor Foo { }', { braceStyle: 'sameLine' }), 'Actor Foo { }');
	});

	test('sameLine attaches a lone opening brace to the header', () => {
		const input = [
			'Actor Foo',
			'{',
			'}',
		].join('\n');

		const expected = [
			'Actor Foo {',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});

	test('skips merging when the header has a line comment', () => {
		const input = [
			'Actor Foo // note',
			'{',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input, { braceStyle: 'sameLine' }).split('\n');
		assert.strictEqual(out[0], 'Actor Foo // note');
		assert.strictEqual(out[1], '{');
		assert.strictEqual(out[2], '  Health 1');
	});

	test('does not split when code follows {', () => {
		const input = [
			'Actor Foo',
			'{',
			'States { Spawn:',
			'TROO A 1',
			'Stop',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  States { Spawn:');
	});

	test('does not restyle braces outside the selection', () => {
		const input = [
			'Actor Foo {',
			'Health 1',
			'Radius 16',
			'}',
		].join('\n');

		const out = formatRange(input, 1, 1).split('\n');
		assert.strictEqual(out[0], 'Actor Foo {');
		assert.strictEqual(out[1], '  Health 1');
		assert.strictEqual(out[2], 'Radius 16');
	});

	test('braces inside strings are not restyled', () => {
		const input = [
			'Actor Foo',
			'{',
			'DropItem "Clip{Special}"',
			'}',
		].join('\n');

		const out = format(input, { braceStyle: 'sameLine' }).split('\n');
		assert.ok(out.some((l) => l.includes('DropItem "Clip{Special}"')));
		assert.strictEqual(out[0], 'Actor Foo {');
	});
});

suite('decorateFormat — spaceAfterComma', () => {
	test('inserts one space after commas', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Spawn:',
			'TROO A 0 A_Jump(256,"See",  "Pain")',
			'Stop',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.ok(out.some((l) => l.includes('A_Jump(256, "See", "Pain")')));
	});

	test('removes spaces after commas when disabled', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Spawn:',
			'TROO A 0 A_Jump(256, "See",  "Pain")',
			'Stop',
			'}',
			'}',
		].join('\n');

		const out = format(input, { spaceAfterComma: false }).split('\n');
		assert.ok(out.some((l) => l.includes('A_Jump(256,"See","Pain")')));
	});

	test('does not change commas inside strings', () => {
		const input = [
			'Actor Foo',
			'{',
			'DropItem "Clip,Special"',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  DropItem "Clip,Special"');
	});

	test('leaves trailing commas alone', () => {
		const input = [
			'Actor Foo',
			'{',
			'A_Jump(256, ',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  A_Jump(256, ');
	});
});
