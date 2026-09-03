import * as assert from 'assert';
import {
	DecorateFormatOptions,
	buildFormattedDocumentText,
	formatDecorateLines,
	structuralLine,
	trimTrailingBlankLines,
} from '../language/decorate/formattingProvider';

const defaultOpts: DecorateFormatOptions = {
	tabSize: 2,
	insertSpaces: true,
	stateLabelIndent: 0,
	stateFrameIndent: null,
	braceStyle: 'nextLine',
	spaceInEmptyBraces: false,
	spaceAfterComma: true,
	removeBlankLinesBeforeCloseBrace: true,
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
		assert.ok(r.code.includes('"Foo{Bar"'));
	});

	test('keeps strings in code so a mid-line comma is not a continuation', () => {
		const r = structuralLine(
			'Translation "192:192=172:172", "198:198=42:42"',
			false
		);
		assert.strictEqual(r.text.trim().endsWith(','), true);
		assert.strictEqual(r.code.trim().endsWith(','), false);
		assert.ok(r.code.trim().endsWith('"'));
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

	test('preserves multiple spaces after //', () => {
		const input = [
			'Actor Foo',
			'{',
			'//      aligned note',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  //      aligned note');
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

	test('preserves Translation continuation alignment', () => {
		const input = [
			'Actor Foo',
			'{',
			'  Translation "4:4=[168,54,72]:[168,54,72]",',
			'              "202:202=[147,40,56]:[147,40,56]",',
			'              "0:0=[37,0,3]:[37,0,3]"',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  Translation "4:4=[168,54,72]:[168,54,72]",');
		assert.strictEqual(out[3], '              "202:202=[147,40,56]:[147,40,56]",');
		assert.strictEqual(out[4], '              "0:0=[37,0,3]:[37,0,3]"');
	});

	test('indents the property after a same-line Translation string list', () => {
		const input = [
			'actor KyorownBulletDmg : KyorownBulletU {',
			'Translation "192:192=172:172", "198:198=42:42"',
			'Damage (200) //160',
			'States {',
			'Death:',
			'TNT1 A 0 A_PlaySoundEx("weapon/napalm", "Weapon")',
			'stop',
			'}',
			'}',
		].join('\n');

		const expected = [
			'actor KyorownBulletDmg : KyorownBulletU {',
			'  Translation "192:192=172:172", "198:198=42:42"',
			'  Damage (200)  // 160',
			'  States {',
			'  Death:',
			'    TNT1 A 0 A_PlaySoundEx("weapon/napalm", "Weapon")',
			'    stop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});
});

suite('decorateFormat — state indent spaces', () => {
	test('custom extras add spaces after States { indent', () => {
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
			'   Spawn:',
			'     TROO A 1',
			'     Loop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { stateLabelIndent: 1, stateFrameIndent: 3 }), expected);
	});

	test('stateFrameIndent 0 keeps frames aligned with States {', () => {
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
			'  Spawn:',
			'  TROO A 1',
			'  Loop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { stateLabelIndent: 0, stateFrameIndent: 0 }), expected);
	});

	test('matches one-space labels and two-space frames', () => {
		const input = [
			'actor myactor {',
			'States {',
			'Spawn:',
			'MEGM A 0',
			'MEGM B 1',
			'MEGM A 1',
			'Goto Spawn+2',
			'}',
			'}',
		].join('\n');

		const expected = [
			'actor myactor {',
			'  States {',
			'   Spawn:',
			'    MEGM A 0',
			'    MEGM B 1',
			'    MEGM A 1',
			'    Goto Spawn+2',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(
			format(input, {
				braceStyle: 'sameLine',
				stateLabelIndent: 1,
				stateFrameIndent: 2,
			}),
			expected
		);
	});

	test('preserves multi-line action argument alignment', () => {
		const input = [
			'actor myactor {',
			'  States {',
			'   Spawn:',
			'    1SPP AA 0 A_SpawnItemEx("RedPoopGibFX",',
			'                            0,',
			'                            0,',
			'                            random(2, 6),',
			'                            0)',
			'    Goto Spawn+2',
			'  }',
			'}',
		].join('\n');

		const out = format(input, {
			braceStyle: 'sameLine',
			stateLabelIndent: 1,
			stateFrameIndent: 2,
		}).split('\n');

		assert.strictEqual(out[3], '    1SPP AA 0 A_SpawnItemEx("RedPoopGibFX",');
		assert.strictEqual(out[4], '                            0,');
		assert.strictEqual(out[5], '                            0,');
		assert.strictEqual(out[6], '                            random(2, 6),');
		assert.strictEqual(out[7], '                            0)');
		assert.strictEqual(out[8], '    Goto Spawn+2');
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

	test('nextLine splits empty same-line blocks when enabled', () => {
		const input = [
			'Actor Foo { }',
		].join('\n');

		const expected = [
			'Actor Foo',
			'{',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { spaceInEmptyBraces: true }), expected);
	});

	test('leaves compact empty braces alone by default', () => {
		const input = 'actor IsAHorse : UOnce {}';
		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), input);
		assert.strictEqual(format(input), input);
	});

	test('sameLine can insert spaces inside empty braces', () => {
		assert.strictEqual(
			format('actor IsAHorse : UOnce {}', {
				braceStyle: 'sameLine',
				spaceInEmptyBraces: true,
			}),
			'actor IsAHorse : UOnce { }'
		);
	});

	test('sameLine keeps spaced empty blocks on one line when enabled', () => {
		assert.strictEqual(
			format('Actor Foo { }', { braceStyle: 'sameLine', spaceInEmptyBraces: true }),
			'Actor Foo { }'
		);
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
		assert.strictEqual(out[0], 'Actor Foo  // note');
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

suite('decorateFormat — Damage paren spacing', () => {
	test('inserts a space between Damage and (', () => {
		const input = [
			'Actor Foo',
			'{',
			'Damage(200)',
			'Damage(random(1, 8))',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  Damage (200)');
		assert.strictEqual(out[3], '  Damage (random(1, 8))');
	});

	test('does not touch DamageType or action calls', () => {
		const input = [
			'Actor Foo',
			'{',
			'DamageType "Fire"',
			'TNT1 A 0 A_Jump(256, "See")',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  DamageType "Fire"');
		assert.strictEqual(out[3], '  TNT1 A 0 A_Jump(256, "See")');
	});
});

suite('decorateFormat — spaceAfterColon', () => {
	test('inserts one space after colons between same-line labels', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Pain.Buster:Pain.ProtoBuster:Pain.ProtoBuster2:Pain.MegaArm:',
			'TNT1 A 0',
			'Stop',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(
			out[4],
			'  Pain.Buster: Pain.ProtoBuster: Pain.ProtoBuster2: Pain.MegaArm:'
		);
		assert.strictEqual(out[5], '    TNT1 A 0');
	});

	test('is idempotent and does not split labels onto new lines', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'Pain.Buster: Pain.ProtoBuster: Pain.MegaArm:',
			'TNT1 A 0',
			'Stop',
			'}',
			'}',
		].join('\n');

		const once = format(input);
		assert.strictEqual(format(once), once);
		assert.ok(once.split('\n').some((l) => l.includes('Pain.Buster: Pain.ProtoBuster: Pain.MegaArm:')));
		assert.ok(!once.includes('Pain.Buster:\n'));
	});

	test('does not insert spaces inside class-scoped goto', () => {
		const input = [
			'Actor Foo',
			'{',
			'States',
			'{',
			'See:',
			'Goto Super::See',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[5], '    Goto Super::See');
	});

	test('does not change colons inside strings', () => {
		const input = [
			'Actor Foo',
			'{',
			'Obituary "%o: %k"',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  Obituary "%o: %k"');
	});

	test('leaves a trailing label colon alone', () => {
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

		const out = format(input).split('\n');
		assert.strictEqual(out[4], '  Spawn:');
	});
});

suite('decorateFormat — blank lines before close brace', () => {
	test('removes blanks before } but keeps blanks between labels', () => {
		const input = [
			'actor EdenFire_Wiz_P : CustomInventory {',
			'  States {',
			'   Pickup:',
			'    TNT1 A 0 A_JumpIfInventory("C678Flag", 1, "CSection")',
			'    Goto Tears',
			'',
			'   Tears:',
			'    TNT1 A 0 A_PlaySoundEx("Isaac/tearfire", "Weapon")',
			'    TNT1 A 0 A_FireCustomMissile("EdenSpectralTear", -45, 0, 16, 16)',
			'    TNT1 A 0 A_FireCustomMissile("EdenSpectralTear", 45, 0, -16, 16)',
			'    stop',
			'',
			'',
			'',
			'  }',
			'}',
		].join('\n');

		const expected = [
			'actor EdenFire_Wiz_P : CustomInventory {',
			'  States {',
			'  Pickup:',
			'    TNT1 A 0 A_JumpIfInventory("C678Flag", 1, "CSection")',
			'    Goto Tears',
			'',
			'  Tears:',
			'    TNT1 A 0 A_PlaySoundEx("Isaac/tearfire", "Weapon")',
			'    TNT1 A 0 A_FireCustomMissile("EdenSpectralTear", -45, 0, 16, 16)',
			'    TNT1 A 0 A_FireCustomMissile("EdenSpectralTear", 45, 0, -16, 16)',
			'    stop',
			'  }',
			'}',
		].join('\n');

		assert.strictEqual(
			format(input, {
				braceStyle: 'sameLine',
				stateLabelIndent: 0,
				stateFrameIndent: 2,
			}),
			expected
		);
	});

	test('keeps blanks before } when setting is false', () => {
		const input = [
			'Actor Foo',
			'{',
			'Health 1',
			'',
			'',
			'}',
		].join('\n');

		const out = format(input, { removeBlankLinesBeforeCloseBrace: false }).split('\n');
		assert.strictEqual(out[2], '  Health 1');
		assert.strictEqual(out[3], '');
		assert.strictEqual(out[4], '');
		assert.strictEqual(out[5], '}');
	});

	test('is idempotent after stripping blanks before }', () => {
		const input = [
			'Actor Foo {',
			'  Health 1',
			'',
			'',
			'}',
		].join('\n');
		const once = format(input, { braceStyle: 'sameLine' });
		assert.strictEqual(format(once, { braceStyle: 'sameLine' }), once);
		assert.ok(!once.includes('\n\n}'));
	});

	test('does not treat } inside strings as a close brace', () => {
		const input = [
			'Actor Foo',
			'{',
			'DropItem "Clip}"',
			'',
			'',
			'Health 1',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '  DropItem "Clip}"');
		assert.strictEqual(out[3], '');
		assert.strictEqual(out[4], '');
		assert.strictEqual(out[5], '  Health 1');
		assert.strictEqual(out[6], '}');
	});
});

suite('decorateFormat — document trailing newline', () => {
	test('trimTrailingBlankLines removes EOF blank lines', () => {
		assert.deepStrictEqual(
			trimTrailingBlankLines(['Actor Foo', '', '  ', '']),
			['Actor Foo']
		);
	});

	test('buildFormattedDocumentText ends with exactly one newline', () => {
		assert.strictEqual(
			buildFormattedDocumentText(['Actor Foo', ''], '\n'),
			'Actor Foo\n'
		);
		assert.strictEqual(
			buildFormattedDocumentText(['Actor Foo', '', ''], '\n'),
			'Actor Foo\n'
		);
	});

	test('buildFormattedDocumentText adds one newline when input had none', () => {
		assert.strictEqual(buildFormattedDocumentText(['Actor Foo'], '\n'), 'Actor Foo\n');
	});

	test('simulated full-document format normalizes multiple EOF newlines', () => {
		const lines = ['actor IsAHorse : UOnce {}', '', ''];
		const formatted = formatDecorateLines(lines, defaultOpts);
		const text = buildFormattedDocumentText(formatted, '\n');
		assert.strictEqual(text, 'actor IsAHorse : UOnce {}\n');
		assert.strictEqual(text.match(/\n/g)?.length, 1);
	});
});
