import * as assert from 'assert';
import { collectSoundDefinitions, findSoundDefinitionInText, isSndinfoFileName } from '../base/sndinfoParse';
import { SndinfoSymbolProvider } from '../base/sndinfoProvider';
import {
	extractSoundArgAtCursor,
	extractSoundPropertyAtCursor,
	isSoundStringParam,
} from '../language/sndinfo/soundResolve';
import { ActionData, ParamData } from '../shared/dataLoader';
import { SymbolKind } from '../base/types';

suite('collectSoundDefinitions', () => {
	test('reads assignment, $random, and $alias', () => {
		const text = [
			'weapons/pistol		DSPISTOL',
			'$random weapons/shotgf { weapons/shotf1 weapons/shotf2 }',
			'$alias weapons/shotgr weapons/shotgf',
			'$limit weapons/pistol 4',
		].join('\n');
		const defs = collectSoundDefinitions(text);
		const names = defs.map(d => d.name).sort();
		assert.deepStrictEqual(names, ['weapons/pistol', 'weapons/shotgf', 'weapons/shotgr'].sort());
		const pistol = findSoundDefinitionInText(text, 'WEAPONS/PISTOL');
		assert.ok(pistol);
		assert.strictEqual(pistol!.line, 0);
		assert.strictEqual(text.split('\n')[0].slice(pistol!.character).startsWith('weapons/pistol'), true);
	});

	test('later assignment overrides earlier', () => {
		const text = 'foo DSFIRST\nfoo DSSECOND\n';
		const hit = findSoundDefinitionInText(text, 'foo');
		assert.ok(hit);
		assert.strictEqual(hit!.line, 1);
	});

	test('ignores comments and $random brace members', () => {
		const text = [
			'// weapons/hidden DSLUMP',
			'/*',
			'weapons/block DSBLOCK',
			'*/',
			'$random weapons/shotgf',
			'{',
			'	weapons/shotf1',
			'	weapons/shotf2',
			'}',
		].join('\n');
		const defs = collectSoundDefinitions(text);
		assert.strictEqual(defs.length, 1);
		assert.strictEqual(defs[0].name, 'weapons/shotgf');
	});

	test('reads quoted names and $playersound', () => {
		const text = [
			'"misc/chat"		DSRADIO',
			'$playersound player male *death PLDETH',
		].join('\n');
		assert.ok(findSoundDefinitionInText(text, 'misc/chat'));
		assert.ok(findSoundDefinitionInText(text, '*death'));
	});
});

suite('extractSoundArgAtCursor', () => {
	test('hits PlaySound second arg', () => {
		const line = 'PlaySound(0, "weapons/pistol", CHAN_WEAPON);';
		const col = line.indexOf('pistol') + 1;
		const hit = extractSoundArgAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.sound, 'weapons/pistol');
		assert.strictEqual(hit!.calleeName, 'PlaySound');
	});

	test('hits AmbientSound first arg and ignores volume', () => {
		const line = 'AmbientSound("world/drip", 0.5);';
		const onSound = extractSoundArgAtCursor(line, line.indexOf('drip') + 1);
		assert.ok(onSound);
		assert.strictEqual(onSound!.sound, 'world/drip');
		assert.strictEqual(extractSoundArgAtCursor(line, line.indexOf('0.5')), null);
	});

	test('hits A_PlaySound whattoplay from actions metadata', () => {
		const actions: Record<string, ActionData> = {
			A_PlaySound: {
				params: [
					{ name: 'whattoplay', type: 'string' },
					{ name: 'slot', type: 'int' },
				],
			},
		};
		const line = 'TNT1 A 0 A_PlaySound("weapons/pistol", CHAN_WEAPON)';
		const hit = extractSoundArgAtCursor(line, line.indexOf('pistol') + 1, actions);
		assert.ok(hit);
		assert.strictEqual(hit!.sound, 'weapons/pistol');
		assert.strictEqual(hit!.calleeName, 'A_PlaySound');
		assert.strictEqual(extractSoundArgAtCursor(line, line.indexOf('CHAN') + 1, actions), null);
	});

	test('does not treat Sector_ChangeSound int as a sound string', () => {
		const actions: Record<string, ActionData> = {
			Sector_ChangeSound: {
				params: [
					{ name: 'tag', type: 'int' },
					{ name: 'sound', type: 'int' },
				],
			},
		};
		const line = 'Sector_ChangeSound(1, 2)';
		assert.strictEqual(extractSoundArgAtCursor(line, line.indexOf('2'), actions), null);
	});
});

suite('extractSoundPropertyAtCursor', () => {
	test('hits quoted SeeSound value', () => {
		const line = 'SeeSound "grunt/sight"';
		const hit = extractSoundPropertyAtCursor(line, line.indexOf('sight') + 1);
		assert.ok(hit);
		assert.strictEqual(hit!.sound, 'grunt/sight');
		assert.strictEqual(hit!.propertyName, 'SeeSound');
		assert.strictEqual(extractSoundPropertyAtCursor(line, line.indexOf('See') + 1), null);
	});

	test('hits Inventory.PickupSound and skips SoundClass', () => {
		const pickup = extractSoundPropertyAtCursor(
			'Inventory.PickupSound "misc/i_pkup"',
			'Inventory.PickupSound "misc/i_pkup"'.indexOf('pkup') + 1
		);
		assert.ok(pickup);
		assert.strictEqual(pickup!.sound, 'misc/i_pkup');
		assert.strictEqual(
			extractSoundPropertyAtCursor('Player.SoundClass marine', 'Player.SoundClass marine'.indexOf('marine') + 1),
			null
		);
	});
});

suite('isSoundStringParam', () => {
	const cases: Array<[ParamData, boolean]> = [
		[{ name: 'whattoplay', type: 'string' }, true],
		[{ name: 'meleesound', type: 'string' }, true],
		[{ name: 'sound', type: 'int' }, false],
		[{ name: 'slot', type: 'string' }, false],
		[{ name: 'pufftype', type: 'string' }, false],
	];
	for (const [param, expected] of cases) {
		test(`${param.name}:${param.type} → ${expected}`, () => {
			assert.strictEqual(isSoundStringParam(param), expected);
		});
	}
});

suite('SndinfoSymbolProvider', () => {
	test('handles SNDINFO lumps and parses logical names', () => {
		const provider = new SndinfoSymbolProvider();
		assert.strictEqual(provider.canHandle('SNDINFO'), true);
		assert.strictEqual(provider.canHandle('sndinfo.txt'), true);
		assert.strictEqual(provider.canHandle('commands.json'), false);
		const symbols = provider.parse(
			'SNDINFO',
			Buffer.from('weapons/pistol\tDSPISTOL\n$alias weapons/shotgr weapons/shotgf\n')
		);
		const names = symbols.map(s => s.name).sort();
		assert.deepStrictEqual(names, ['weapons/pistol', 'weapons/shotgr']);
		assert.strictEqual(symbols[0].kind, SymbolKind.Sound);
	});
});

suite('isSndinfoFileName', () => {
	test('matches engine lump identity', () => {
		assert.strictEqual(isSndinfoFileName('SNDINFO'), true);
		assert.strictEqual(isSndinfoFileName('sndinfo.txt'), true);
		assert.strictEqual(isSndinfoFileName('SNDINFO.whatever'), true);
		assert.strictEqual(isSndinfoFileName('sndinfo1.txt'), false);
		assert.strictEqual(isSndinfoFileName('commands.json'), false);
	});
});
