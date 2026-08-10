import * as assert from 'assert';
import { ParamData } from '../shared/dataLoader';
import { findActorSpanInLines } from '../language/decorate/renameProvider';
import {
	actorIsWeaponDescendant,
	collectStateLabelsInActor,
	defaultGunFlashLabel,
	extractGotoLabelAtCursor,
	extractGunFlashAtCursor,
	extractJumpLabelAtCursor,
	extractStateLabelAtCursor,
	isStateLabelParam,
	isStateLabelParamAtIndex,
	parseSimpleStateLabel,
	resolveParentClass,
	resolveStateLabelInLines,
	findStateLabelInAnyActor,
	shiftLabelByOffset,
} from '../language/decorate/stateLabelResolve';

const sampleActions = {
	A_Jump: {
		params: [
			{ name: 'chance', type: 'int', optional: true },
			{ name: 'label', type: 'string' },
			{ name: '...', type: 'state', optional: true, variadic: true },
		] as ParamData[],
	},
	A_JumpIf: {
		params: [
			{ name: 'expression', type: 'bool' },
			{ name: 'label', type: 'string' },
		] as ParamData[],
	},
	A_ReFire: {
		params: [{ name: 'flash', type: 'state', optional: true }] as ParamData[],
	},
	A_SpawnItemEx: {
		params: [{ name: 'missile', type: 'string' }] as ParamData[],
	},
};

suite('stateLabelResolve — collect labels', () => {
	test('collects multi-label States block', () => {
		const lines = [
			'actor Foo',
			'{',
			'  States',
			'  {',
			'  Spawn:',
			'    TROO A 1',
			'    goto See',
			'  See:',
			'    TROO A 1 stop',
			'  Death:',
			'    TROO A 1 stop',
			'  }',
			'}',
		];
		const span = findActorSpanInLines(lines, 0);
		assert.ok(span);
		const labels = collectStateLabelsInActor(lines, span!);
		assert.strictEqual(labels.get('spawn')?.line, 4);
		assert.strictEqual(labels.get('see')?.line, 7);
		assert.strictEqual(labels.get('death')?.line, 9);
		assert.strictEqual(labels.size, 3);
	});

	test('indexes Flash.AnimA dotted label line', () => {
		const lines = [
			'actor MyGun : Weapon',
			'{',
			'  States {',
			'  Flash.AnimA:',
			'    PISF A 1 stop',
			'  NoFlash:',
			'    TNT1 A 0 stop',
			'  }',
			'}',
		];
		const span = findActorSpanInLines(lines, 0);
		assert.ok(span);
		const labels = collectStateLabelsInActor(lines, span!);
		assert.ok(labels.has('flash.anima'));
		assert.strictEqual(labels.get('flash.anima')?.line, 3);
		assert.ok(labels.has('noflash'));
	});

	test('indexes consecutive Flash: + AnimA: as Flash.AnimA', () => {
		const lines = [
			'actor MyGun : Weapon',
			'{',
			'  States {',
			'  Flash:',
			'  AnimA:',
			'    PISF A 1 stop',
			'  }',
			'}',
		];
		const span = findActorSpanInLines(lines, 0);
		assert.ok(span);
		const labels = collectStateLabelsInActor(lines, span!);
		assert.ok(labels.has('flash'));
		assert.ok(labels.has('anima'));
		assert.ok(labels.has('flash.anima'));
		assert.strictEqual(labels.get('flash.anima')?.line, 4);
	});
});

suite('stateLabelResolve — dotted jump targets', () => {
	test('parseSimpleStateLabel accepts Flash.AnimA', () => {
		assert.strictEqual(parseSimpleStateLabel('"Flash.AnimA"'), 'Flash.AnimA');
		assert.strictEqual(parseSimpleStateLabel('Flash.AnimA'), 'Flash.AnimA');
		assert.strictEqual(parseSimpleStateLabel('NoFlash'), 'NoFlash');
		assert.strictEqual(parseSimpleStateLabel('2Flash'), '2Flash');
		assert.strictEqual(parseSimpleStateLabel("O'Brien"), "O'Brien");
		assert.strictEqual(parseSimpleStateLabel('Bad-Name'), null);
	});

	test('A_Jump / goto extract dotted labels', () => {
		const jump = '    TNT1 A 0 A_Jump(256, "Flash.AnimA")';
		assert.strictEqual(
			extractJumpLabelAtCursor(jump, jump.indexOf('Flash') + 1, sampleActions),
			'Flash.AnimA'
		);
		const gotoLine = '    goto Flash.AnimA';
		const gotoHit = extractGotoLabelAtCursor(gotoLine, gotoLine.indexOf('AnimA') + 1);
		assert.strictEqual(gotoHit?.label, 'Flash.AnimA');
		assert.strictEqual(gotoHit?.offset, undefined);
	});

	test('resolve Flash.AnimA to dotted definition', () => {
		const lines = [
			'actor MyGun : Weapon',
			'{',
			'  States {',
			'  Fire:',
			'    PISG A 1 A_Jump(256, "Flash.AnimA")',
			'  Flash.AnimA:',
			'    PISF A 1 stop',
			'  }',
			'}',
		];
		const span = findActorSpanInLines(lines, 0);
		assert.ok(span);
		const hit = resolveStateLabelInLines(lines, 'MyGun', span!, 'Flash.AnimA');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 5);
	});
});

suite('stateLabelResolve — param detection', () => {
	test('isStateLabelParam matches type state and name rules', () => {
		assert.ok(isStateLabelParam({ name: 'flash', type: 'state' }));
		assert.ok(isStateLabelParam({ name: 'label', type: 'string' }));
		assert.ok(isStateLabelParam({ name: 'offset', type: 'string' }));
		assert.ok(!isStateLabelParam({ name: 'missile', type: 'string' }));
		assert.ok(!isStateLabelParam({ name: 'chance', type: 'int' }));
	});

	test('variadic state tail after fixed params', () => {
		const params = sampleActions.A_Jump.params;
		assert.ok(!isStateLabelParamAtIndex(params, 0));
		assert.ok(isStateLabelParamAtIndex(params, 1));
		assert.ok(isStateLabelParamAtIndex(params, 2));
		assert.ok(isStateLabelParamAtIndex(params, 5));
	});
});

suite('stateLabelResolve — cursor extraction', () => {
	test('goto Label and Label+offset', () => {
		const line = '    goto Death';
		const col = line.indexOf('Death') + 1;
		const hit = extractGotoLabelAtCursor(line, col);
		assert.strictEqual(hit?.label, 'Death');
		assert.strictEqual(hit?.offset, undefined);

		const withOff = '    goto See+1';
		const hit2 = extractGotoLabelAtCursor(withOff, withOff.indexOf('See') + 1);
		assert.strictEqual(hit2?.label, 'See');
		assert.strictEqual(hit2?.offset, 1);
	});

	test('goto Label-N is invalid: offset stays undefined', () => {
		const line = '    goto See-2';
		const hit = extractGotoLabelAtCursor(line, line.indexOf('See') + 1);
		assert.strictEqual(hit?.label, 'See');
		assert.strictEqual(hit?.offset, undefined);
	});

	test('goto Actor::Label is out of scope', () => {
		const line = '    goto Super::See';
		assert.strictEqual(
			extractGotoLabelAtCursor(line, line.indexOf('Super') + 1),
			null
		);
	});

	test('A_Jump(128, "See") and A_JumpIf(true, Fail)', () => {
		const jump = '    TROO A 1 A_Jump(128, "See")';
		const seeCol = jump.indexOf('"See"') + 2;
		assert.strictEqual(
			extractJumpLabelAtCursor(jump, seeCol, sampleActions),
			'See'
		);
		// chance arg is not a label
		assert.strictEqual(
			extractJumpLabelAtCursor(jump, jump.indexOf('128') + 1, sampleActions),
			null
		);

		const jumpIf = '    TROO A 1 A_JumpIf(true, Fail)';
		assert.strictEqual(
			extractJumpLabelAtCursor(jumpIf, jumpIf.indexOf('Fail') + 1, sampleActions),
			'Fail'
		);
	});

	test('does not treat A_SpawnItemEx class name as label', () => {
		const line = '    TNT1 A 0 A_SpawnItemEx("Foo")';
		assert.strictEqual(
			extractJumpLabelAtCursor(line, line.indexOf('Foo') + 1, sampleActions),
			null
		);
	});

	test('extractStateLabelAtCursor distinguishes goto vs jump', () => {
		const g = extractStateLabelAtCursor('    goto Death', 10, sampleActions);
		assert.deepStrictEqual(g, { kind: 'goto', label: 'Death', offset: undefined });

		const j = extractStateLabelAtCursor(
			'    A_JumpIf(true, "See")',
			'    A_JumpIf(true, "See")'.indexOf('See') + 1,
			sampleActions
		);
		assert.deepStrictEqual(j, { kind: 'jump', label: 'See' });
	});
});

suite('stateLabelResolve — inheritance walk', () => {
	const decorate = [
		'actor Parent',
		'{',
		'  States',
		'  {',
		'  Spawn:',
		'    TROO A 1',
		'    goto Death',
		'  Death:',
		'    TROO A 1 stop',
		'  See:',
		'    TROO A 1 stop',
		'  }',
		'}',
		'actor Child : Parent',
		'{',
		'  States',
		'  {',
		'  Spawn:',
		'    TROO A 1 A_JumpIf(true, "See")',
		'  Death:',
		'    TROO B 1 stop',
		'  See:',
		'    TROO B 1 stop',
		'  }',
		'}',
	];

	test('Goto in parent resolves parent Death, not child override', () => {
		const parentSpan = findActorSpanInLines(decorate, 0);
		assert.ok(parentSpan);
		const hit = resolveStateLabelInLines(decorate, 'Parent', parentSpan!, 'Death');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 7); // Parent Death:
		// Child Death is line 19 — must not win
		assert.notStrictEqual(hit!.line, 19);
	});

	test('A_JumpIf in child prefers child See', () => {
		const childSpan = findActorSpanInLines(decorate, 18);
		assert.ok(childSpan);
		const hit = resolveStateLabelInLines(decorate, 'Child', childSpan!, 'See');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 21); // Child See:
	});

	test('jump label missing on child walks to parent', () => {
		const lines = [
			'actor Parent',
			'{',
			'  States {',
			'  Missile:',
			'    TROO A 1 stop',
			'  }',
			'}',
			'actor Child : Parent',
			'{',
			'  States {',
			'  Spawn:',
			'    TROO A 1 A_JumpIf(true, "Missile")',
			'  }',
			'}',
		];
		const childSpan = findActorSpanInLines(lines, 10);
		assert.ok(childSpan);
		const hit = resolveStateLabelInLines(lines, 'Child', childSpan!, 'Missile');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 3);
	});

	test('three-level chain: Child → Mid → BossBase finds MegamanDeath', () => {
		const lines = [
			'actor BossBase',
			'{',
			'  States {',
			'  MegamanDeath:',
			'    TROO H 5 stop',
			'  MegamanGib:',
			'    TROO I 5 stop',
			'  }',
			'}',
			'actor Mid : BossBase',
			'{',
			'  States {',
			'  Spawn:',
			'    TROO A 1 loop',
			'  }',
			'}',
			'actor Child : Mid',
			'{',
			'  States {',
			'  Death:',
			'    TROO A 1 goto MegamanDeath',
			'  }',
			'}',
		];
		const childSpan = findActorSpanInLines(lines, 19);
		assert.ok(childSpan);
		const death = resolveStateLabelInLines(lines, 'Child', childSpan!, 'MegamanDeath');
		assert.ok(death);
		assert.strictEqual(death!.line, 3);
		const gib = resolveStateLabelInLines(lines, 'Child', childSpan!, 'MegamanGib');
		assert.ok(gib);
		assert.strictEqual(gib!.line, 5);
	});

	test('resolveParentClass uses Mid header when Mid is absent from DB', () => {
		const lines = [
			'actor BossBase',
			'{',
			'  States {',
			'  MegamanDeath:',
			'    TROO A 1 stop',
			'  }',
			'}',
			'actor Mid : BossBase',
			'{',
			'  States {',
			'  Spawn:',
			'    TROO A 1 loop',
			'  }',
			'}',
			'actor Child : Mid',
			'{',
			'  States {',
			'  Death:',
			'    TROO A 1 goto MegamanDeath',
			'  }',
			'}',
		];
		// No SymbolDatabase — parent must come from open buffer headers
		assert.strictEqual(
			resolveParentClass('Child', { openLines: lines }),
			'Mid'
		);
		assert.strictEqual(
			resolveParentClass('Mid', { openLines: lines, symbolDb: undefined }),
			'BossBase'
		);
		assert.strictEqual(
			resolveParentClass('BossBase', { openLines: lines }),
			undefined
		);

		const childSpan = findActorSpanInLines(lines, 18);
		assert.ok(childSpan);
		const hit = resolveStateLabelInLines(lines, 'Child', childSpan!, 'MegamanDeath');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 3);
	});

	test('findStateLabelInAnyActor finds label when inheritance chain is broken', () => {
		// Simulates: Child → MissingMid (not in buffer) while ClassBaseU0 holds the label
		const lines = [
			'actor ClassBaseU0 : ClassBase0',
			'{',
			'  States {',
			'  MegamanPain:',
			'    TROO A 1 stop',
			'  MegamanDeath:',
			'    TROO H 5 stop',
			'  }',
			'}',
			'actor Child : MissingMid',
			'{',
			'  States {',
			'  Death:',
			'    TROO A 1 goto MegamanDeath',
			'  }',
			'}',
		];
		const childSpan = findActorSpanInLines(lines, 9);
		assert.ok(childSpan);
		// Inheritance-only resolve fails (MissingMid absent)
		assert.strictEqual(
			resolveStateLabelInLines(lines, 'Child', childSpan!, 'MegamanDeath'),
			undefined
		);
		const anyDeath = findStateLabelInAnyActor(lines, 'MegamanDeath');
		assert.ok(anyDeath);
		assert.strictEqual(anyDeath!.line, 5);
		const anyPain = findStateLabelInAnyActor(lines, 'MegamanPain');
		assert.ok(anyPain);
		assert.strictEqual(anyPain!.line, 3);
	});
});

suite('stateLabelResolve — A_GunFlash', () => {
	const inheritanceData = {
		Weapon: { category: 'Inventory', extends: 'Inventory' },
		Inventory: { category: 'Inventory', extends: 'Actor' },
		Pistol: { category: 'Inventory', extends: 'Weapon' },
	};

	test('cursor on A_GunFlash under Fire defaults to Flash', () => {
		const lines = [
			'actor MyGun : Weapon',
			'{',
			'  States {',
			'  Fire:',
			'    PISG A 5 A_GunFlash',
			'  Flash:',
			'    PISF A 1 stop',
			'  }',
			'}',
		];
		const line = lines[4];
		const col = line.indexOf('A_GunFlash') + 2;
		const hit = extractGunFlashAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.explicitLabel, null);
		assert.strictEqual(defaultGunFlashLabel(lines, 4), 'Flash');

		const resolved = extractStateLabelAtCursor(
			line,
			col,
			sampleActions,
			{},
			{ lines, lineNumber: 4 }
		);
		assert.deepStrictEqual(resolved, {
			kind: 'jump',
			label: 'Flash',
			gunFlashDefault: true,
		});
	});

	test('cursor on A_GunFlash() under AltFire defaults to AltFlash', () => {
		const lines = [
			'actor MyGun : Weapon',
			'{',
			'  States {',
			'  AltFire:',
			'    PISG A 5 A_GunFlash()',
			'  AltFlash:',
			'    PISF A 1 stop',
			'  }',
			'}',
		];
		const line = lines[4];
		const col = line.indexOf('A_GunFlash') + 1;
		assert.strictEqual(defaultGunFlashLabel(lines, 4), 'AltFlash');
		const resolved = extractStateLabelAtCursor(
			line,
			col,
			sampleActions,
			{},
			{ lines, lineNumber: 4 }
		);
		assert.strictEqual(resolved?.label, 'AltFlash');
		assert.strictEqual(resolved?.gunFlashDefault, true);
	});

	test('A_GunFlash("CustomFlash") on name resolves CustomFlash', () => {
		const line = '    PISG A 5 A_GunFlash("CustomFlash")';
		const col = line.indexOf('A_GunFlash') + 3;
		const hit = extractGunFlashAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.explicitLabel, 'CustomFlash');
		const resolved = extractStateLabelAtCursor(line, col, sampleActions);
		assert.deepStrictEqual(resolved, {
			kind: 'jump',
			label: 'CustomFlash',
		});
	});

	test('explicit arg on string still returns label (regression)', () => {
		const line = '    PISG A 5 A_GunFlash("CustomFlash")';
		const actions = {
			...sampleActions,
			A_GunFlash: {
				params: [
					{ name: 'flash', type: 'state', optional: true },
					{ name: 'flags', type: 'int', optional: true },
				] as ParamData[],
			},
		};
		const col = line.indexOf('CustomFlash') + 1;
		assert.strictEqual(
			extractJumpLabelAtCursor(line, col, actions),
			'CustomFlash'
		);
	});

	test('Weapon descendant passes legality; Actor does not', () => {
		assert.ok(
			actorIsWeaponDescendant('MyGun', 'Weapon', undefined, inheritanceData)
		);
		assert.ok(
			actorIsWeaponDescendant('Pistol', undefined, undefined, inheritanceData)
		);
		assert.ok(
			!actorIsWeaponDescendant('ZombieMan', 'Actor', undefined, inheritanceData)
		);
		assert.ok(
			!actorIsWeaponDescendant('HealthBonus', 'Inventory', undefined, inheritanceData)
		);
	});
});

suite('stateLabelResolve — relative goto offset', () => {
	const LINES = [
		'actor Foo',
		'{',
		'  States',
		'  {',
		'  Flash:',
		'    TNT1 A 0',
		'',
		'    // comment line',
		'    PUFF A 5 Bright',
		'    PUFF B 5',
		'  AnimA:',
		'    PUFF C 1 A_SetTranslucent(0.5,1)',
		'    PUFF D 1 stop',
		'  }',
		'}',
	];

	test('shiftLabelByOffset skips blank/comment/label lines', () => {
		// First frame is offset 0; offset 1 = second frame (PUFF A 5 at line 8)
		const hit = shiftLabelByOffset(LINES, 4, 1);
		assert.strictEqual(hit?.line, 8);
		assert.strictEqual(hit?.character, 4);
	});

	test('counts frames across blank, comment and label lines', () => {
		// Flash block: TNT1 A 0 (0), PUFF A 5 (1), PUFF B 5 (2), AnimA: PUFF C 1 (3), PUFF D 1 (4)
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 1)?.line, 8);
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 2)?.line, 9);
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 3)?.line, 11);
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 4)?.line, 12);
	});

	test('offset 0 and negative are rejected', () => {
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 0), undefined);
		assert.strictEqual(shiftLabelByOffset(LINES, 4, -2), undefined);
	});

	test('offset past end of States block returns undefined', () => {
		assert.strictEqual(shiftLabelByOffset(LINES, 4, 5), undefined);
	});

	test('multi-letter frames count one state per letter (FFF = 3)', () => {
		const lines = [
			'actor Foo',
			'{',
			'  States {',
			'  Flash:',
			'    TNT1 A 0',
			'    TNT1 B 1',
			'    8H51 FFF 1 stop',
			'    TNT1 C 1 stop',
			'  }',
			'}',
		];
		// array indices: 0=A, 1=B, 2,3,4=FFF, 5=C
		assert.strictEqual(shiftLabelByOffset(lines, 3, 2)?.line, 6);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 3)?.line, 6);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 4)?.line, 6);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 5)?.line, 7);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 6), undefined);
	});

	test('quoted frame strings count one state per char', () => {
		const lines = [
			'actor Foo',
			'{',
			'  States {',
			'  Spawn2:',
			'    "----" "###########" 3 A_Fadeout',
			'    TNT1 A 0 stop',
			'  }',
			'}',
		];
		// indices 0..10 = "###########", 11 = TNT1 A 0
		assert.strictEqual(shiftLabelByOffset(lines, 3, 10)?.line, 4);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 11)?.line, 5);
		assert.strictEqual(shiftLabelByOffset(lines, 3, 12), undefined);
	});

	test('extractStateLabelAtCursor carries goto offset', () => {
		const line = '    goto Flash+2';
		const col = line.indexOf('Flash') + 1;
		const hit = extractStateLabelAtCursor(line, col, sampleActions);
		assert.deepStrictEqual(hit, { kind: 'goto', label: 'Flash', offset: 2 });
	});
});
