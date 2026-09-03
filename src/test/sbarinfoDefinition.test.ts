import * as assert from 'assert';
import { extractInInventoryActorAtCursor } from '../language/sbarinfo/inInventoryResolve';

suite('extractInInventoryActorAtCursor', () => {
	test('hits unquoted class after InInventory', () => {
		const line = 'InInventory GammaPlayerPowerHP, 1';
		const col = line.indexOf('Gamma') + 2;
		const hit = extractInInventoryActorAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'GammaPlayerPowerHP');
	});

	test('hits quoted class', () => {
		const line = 'InInventory "Clip", 5';
		const col = line.indexOf('Clip') + 1;
		const hit = extractInInventoryActorAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'Clip');
	});

	test('skips leading not and hits the class', () => {
		const line = 'InInventory not HealthBonus';
		const col = line.indexOf('Health') + 1;
		const hit = extractInInventoryActorAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'HealthBonus');
		assert.strictEqual(extractInInventoryActorAtCursor(line, line.indexOf('not') + 1), null);
	});

	test('hits second class after &&', () => {
		const line = 'InInventory RedCard && BlueCard';
		const col = line.indexOf('Blue') + 1;
		const hit = extractInInventoryActorAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'BlueCard');
	});

	test('hits second class after || with amounts', () => {
		const line = 'InInventory Foo, 1 || Bar, 2';
		const col = line.indexOf('Bar') + 1;
		const hit = extractInInventoryActorAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'Bar');
	});

	test('ignores amount and brace', () => {
		const line = 'InInventory Foo, 12 {';
		assert.strictEqual(extractInInventoryActorAtCursor(line, line.indexOf('12')), null);
		assert.strictEqual(extractInInventoryActorAtCursor(line, line.indexOf('{')), null);
	});

	test('is case-insensitive on the command', () => {
		const line = 'ininventory Cell';
		const hit = extractInInventoryActorAtCursor(line, line.indexOf('Cell') + 1);
		assert.ok(hit);
		assert.strictEqual(hit!.className, 'Cell');
	});
});
