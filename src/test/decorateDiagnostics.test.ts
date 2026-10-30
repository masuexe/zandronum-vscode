import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	DecorateLintSourceData,
	buildLintMeta,
	lintDecorateLines,
} from '../language/decorate/diagnosticsProvider';

const sourceData: DecorateLintSourceData = {
	actions: {
		A_Look: { params: [] },
		A_Chase: {
			params: [
				{ name: 'melee', type: 'state', optional: true },
				{ name: 'missile', type: 'state', optional: true },
				{ name: 'flags', type: 'int', optional: true },
			],
		},
		A_FireBullets: {
			params: [
				{ name: 'hspread', type: 'float' },
				{ name: 'vspread', type: 'float' },
				{ name: 'numbullets', type: 'int' },
				{ name: 'damage', type: 'int' },
				{ name: 'pufftype', type: 'string' },
			],
		},
		A_TestShot: {
			params: [
				{ name: 'a', type: 'int' },
				{ name: 'b', type: 'int' },
				{ name: 'c', type: 'int', optional: true },
			],
		},
		A_Jump: {
			params: [
				{ name: 'chance', type: 'int', optional: true },
				{ name: 'label', type: 'string' },
				{ name: '...', type: 'state', optional: true, variadic: true },
			],
		},
		ExpressionOnly: { params: [], usage: ['expression'] },
		A_OldPlay: { params: [], deprecated: true, deprecatedBy: 'A_Look' },
		A_OldBare: { params: [], deprecated: true },
	},
	properties: {
		Health: { type: 'int' },
		Speed: { type: 'int' },
		Radius: { type: 'int' },
		Height: { type: 'int' },
		SeeSound: { type: 'string' },
	},
	flags: {
		SOLID: { type: 'bool' },
		NOCLIP: { type: 'bool' },
		'INVENTORY.INVBAR': { type: 'bool' },
	},
	flagCombos: {
		Monster: {},
	},
	stateKeywords: {
		Offset: {},
		Bright: {},
	},
};

const meta = buildLintMeta(sourceData);

function lint(lines: string[], options?: { deprecationWarnings?: boolean }) {
	return lintDecorateLines(lines, meta, options);
}

suite('decorateDiagnostics — actor body', () => {
	test('accepts a valid actor without diagnostics', () => {
		const diagnostics = lint([
			'actor TestThing : Actor',
			'{',
			'  Health 100',
			'  Speed 8',
			'  Radius 20',
			'  Height 56',
			'  +SOLID',
			'  -NOCLIP',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_Look',
			'    POSS A 4 A_Chase',
			'    goto Spawn',
			'  Death:',
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('reports unknown actor property', () => {
		const diagnostics = lint([
			'actor BadProperty',
			'{',
			'  Health 100',
			'  FakeProperty 123',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown actor property 'FakeProperty'.");
		assert.strictEqual(diagnostics[0].severity, 'warning');
		assert.strictEqual(diagnostics[0].line, 3);
	});

	test('reports unknown actor flag', () => {
		const diagnostics = lint([
			'actor BadFlag',
			'{',
			'  +FAKESOLID',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown actor flag 'FAKESOLID'.");
	});

	test('accepts flag combos and ignores var declarations', () => {
		const diagnostics = lint([
			'actor ComboUser',
			'{',
			'  +Monster',
			'  var int user_counter;',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('accepts class-scoped flags written as bare names', () => {
		const diagnostics = lint([
			'actor InventoryFlags',
			'{',
			'  +INVBAR',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('checks content after the opening brace on the header line', () => {
		const diagnostics = lint([
			'actor SingleLine : ParentActor { FakeProperty 1',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown actor property 'FakeProperty'.");
	});

	test('accepts compact actors with States on the header line', () => {
		const diagnostics = lint([
			'actor Compact : ParentActor { States { Spawn: TNT1 A 1',
			'stop }}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('finds States after a property on the same line', () => {
		const diagnostics = lint([
			'actor CompactStates : BasicGraphicEffect {Scale 3.5 States {SpawnFrame: CLOF BCDEFA 2',
			'    stop}}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('accepts a label and its first frame on the same line', () => {
		const diagnostics = lint([
			'actor CompactSelf {States {Spawn: TNT1 A 0',
			'    goto Spawn}}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('validates frames that share the line with a label', () => {
		const diagnostics = lint([
			'actor CompactBadSprite {States {Spawn: POSSX A 0',
			'    stop}}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Invalid sprite name 'POSSX'. DECORATE sprite names must be exactly 4 characters."
		);
	});

	test('ignores commented-out lines', () => {
		const diagnostics = lint([
			'actor Commented',
			'{',
			'  // FakeProperty 123',
			'  /* +FAKEFLAG */',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('reports ZScript class declarations', () => {
		const diagnostics = lint([
			'class MyMonster : Actor',
			'{',
			'  Health 100',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"ZScript is not supported in Zandronum. Use DECORATE 'actor <Name> [: <Parent>]' instead."
		);
		assert.strictEqual(diagnostics[0].severity, 'warning');
	});
});

suite('decorateDiagnostics — states', () => {
	test('reports invalid state label characters', () => {
		const diagnostics = lint([
			'actor BadLabel',
			'{',
			'  States',
			'  {',
			'  Bad-Label:',
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Invalid state label name 'Bad-Label'. In Zandronum CMode, unquoted labels may only contain A-Z, a-z, 0-9, underscore, and apostrophe."
		);
		assert.strictEqual(diagnostics[0].severity, 'error');
	});

	test('accepts apostrophes in state labels', () => {
		const diagnostics = lint([
			'actor Apostrophe',
			'{',
			'  States',
			'  {',
			"  Bob'sLabel:",
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('accepts dotted state labels', () => {
		const diagnostics = lint([
			'actor DottedLabel',
			'{',
			'  States',
			'  {',
			'  Flash.AnimA:',
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('reports invalid sprite names', () => {
		const diagnostics = lint([
			'actor BadSprite',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    POSSX A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Invalid sprite name 'POSSX'. DECORATE sprite names must be exactly 4 characters."
		);
	});

	test('reports unknown action functions', () => {
		const diagnostics = lint([
			'actor BadAction',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_FakeAction',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(diagnostics[0].message, "Unknown action function 'A_FakeAction'.");
	});

	test('reports too few action arguments', () => {
		const diagnostics = lint([
			'actor FewArgs',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_TestShot(1)',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Action 'A_TestShot' expects at least 2 argument(s), got 1."
		);
	});

	test('reports too many action arguments', () => {
		const diagnostics = lint([
			'actor ManyArgs',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_TestShot(1, 2, 3, 4)',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Action 'A_TestShot' expects at most 3 argument(s), got 4."
		);
	});

	test('reports expression-only actions used as state actions', () => {
		const diagnostics = lint([
			'actor WrongUsage',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 ExpressionOnly',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"Action function 'ExpressionOnly' is only valid in expressions, not as a state action."
		);
	});

	test('reports deprecated engine actions', () => {
		const withReplacement = lint([
			'actor DeprecatedAction',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_OldPlay',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(withReplacement.length, 1);
		assert.strictEqual(
			withReplacement[0].message,
			"Action function 'A_OldPlay' is deprecated. Use 'A_Look' instead."
		);
		assert.strictEqual(withReplacement[0].severity, 'warning');

		const bare = lint([
			'actor DeprecatedBare',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_OldBare',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(bare.map(d => d.message), ["Action function 'A_OldBare' is deprecated."]);
	});

	test('can disable deprecation warnings', () => {
		const diagnostics = lint([
			'actor DeprecatedOff',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_OldPlay',
			'    stop',
			'  }',
			'}',
		], { deprecationWarnings: false });
		assert.deepStrictEqual(diagnostics, []);
	});

	test('accepts state modifiers and nested expression calls', () => {
		const diagnostics = lint([
			'actor Modifiers',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 Bright A_FireBullets(5.6, 0, 7, 5, "BulletPuff")',
			'    TNT1 A 0 Offset(0, 32)',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});
});

suite('decorateDiagnostics — jump targets', () => {
	test('reports a missing goto target', () => {
		const diagnostics = lint([
			'actor MissingGoto',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0',
			'    goto Missing',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"State label 'Missing' not found in current actor."
		);
	});

	test('accepts goto targets with an offset', () => {
		const diagnostics = lint([
			'actor GotoOffset',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0',
			'  See:',
			'    TNT1 A 0',
			'    goto See+2',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('reports a missing A_Jump target', () => {
		const diagnostics = lint([
			'actor MissingJump',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_Jump(128, "Nowhere")',
			'    stop',
			'  }',
			'}',
		]);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"State label 'Nowhere' not found in current actor."
		);
	});

	test('accepts A_Jump targets that exist', () => {
		const diagnostics = lint([
			'actor GoodJump',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0 A_Jump(128, "See")',
			'    stop',
			'  See:',
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('resolves labels inherited from a parent actor in the same document', () => {
		const diagnostics = lint([
			'actor ParentActor',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TNT1 A 0',
			'    stop',
			'  }',
			'}',
			'',
			'actor ChildActor : ParentActor',
			'{',
			'  States',
			'  {',
			'  See:',
			'    TNT1 A 0',
			'    goto Spawn',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('does not report targets inherited from an external parent class', () => {
		const diagnostics = lint([
			'actor ExternalChild : SomeExternalMonster',
			'{',
			'  States',
			'  {',
			'  See:',
			'    TNT1 A 0',
			'    goto See',
			'  }',
			'}',
		]);
		assert.deepStrictEqual(diagnostics, []);
	});
});

suite('decorateDiagnostics — shipped metadata', () => {
	const dataDir = path.join(__dirname, '..', '..', 'data', 'decorate');
	const properties: Record<string, unknown> = JSON.parse(
		fs.readFileSync(path.join(dataDir, 'properties.json'), 'utf8')
	);
	const flags: Record<string, unknown> = JSON.parse(
		fs.readFileSync(path.join(dataDir, 'flags.json'), 'utf8')
	);
	const actions: Record<string, { deprecated?: boolean; deprecatedBy?: string }> = JSON.parse(
		fs.readFileSync(path.join(dataDir, 'actions.json'), 'utf8')
	);

	test('covers Zandronum morph properties', () => {
		for (const name of [
			'Player.MorphWeapon',
			'MorphProjectile.PlayerClass',
			'MorphProjectile.MorphFlash',
			'MorphProjectile.UnMorphFlash',
			'PowerMorph.MorphStyle',
			'PowerMorph.PlayerClass',
		]) {
			assert.ok(properties[name], `properties.json is missing ${name}`);
		}
	});

	test('covers player, armor and weapon properties', () => {
		for (const name of [
			'Player.MaxSkinSizeFactor',
			'Player.DamageScreenColor',
			'Armor.MaxBonus',
			'Armor.MaxAbsorb',
			'Weapon.SlotPriority',
			'SpawnID',
			'ConversationID',
		]) {
			assert.ok(properties[name], `properties.json is missing ${name}`);
		}
	});

	test('keeps class-scoped flag spellings', () => {
		assert.ok(flags['INVENTORY.INVBAR'], 'flags.json is missing INVENTORY.INVBAR');
		assert.ok(flags['WEAPON.AMMO_OPTIONAL'], 'flags.json is missing WEAPON.AMMO_OPTIONAL');
	});

	test('marks engine-deprecated sound actions', () => {
		for (const [name, replacement] of [
			['A_PlaySoundEx', 'A_PlaySound'],
			['A_StopSoundEx', 'A_StopSound'],
			['A_PlayWeaponSound', 'A_PlaySound'],
		] as const) {
			assert.strictEqual(actions[name]?.deprecated, true, `${name} should be deprecated`);
			assert.strictEqual(actions[name]?.deprecatedBy, replacement);
		}
		assert.ok(!actions.A_PlaySound?.deprecated, 'A_PlaySound should not be deprecated');
		assert.ok(!actions.A_StopSound?.deprecated, 'A_StopSound should not be deprecated');
	});
});
