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
	resolveStateLabelInLines,
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
		assert.strictEqual(extractGotoLabelAtCursor(line, col), 'Death');

		const withOff = '    goto See+1';
		assert.strictEqual(
			extractGotoLabelAtCursor(withOff, withOff.indexOf('See') + 1),
			'See'
		);
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
		assert.deepStrictEqual(g, { kind: 'goto', label: 'Death' });

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
