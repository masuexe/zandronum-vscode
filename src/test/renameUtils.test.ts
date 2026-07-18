import * as assert from 'assert';
import {
	collectWordRanges,
	isValidIdent,
	isValidUserVarName,
	wordAt,
} from '../language/shared/renameUtils';
import { findActorSpanInLines } from '../language/decorate/renameProvider';
import { findEnclosingAcsUnitInLines } from '../language/acs/renameProvider';
import { scanLineDeclarations } from '../language/acs/scanner';

suite('renameUtils — isValidIdent / user var', () => {
	test('accepts normal identifiers', () => {
		assert.ok(isValidIdent('foo'));
		assert.ok(isValidIdent('_bar'));
		assert.ok(isValidIdent('a1'));
	});

	test('rejects invalid identifiers', () => {
		assert.ok(!isValidIdent(''));
		assert.ok(!isValidIdent('1foo'));
		assert.ok(!isValidIdent('foo-bar'));
	});

	test('user var names require user_ prefix', () => {
		assert.ok(isValidUserVarName('user_rockets'));
		assert.ok(isValidUserVarName('USER_FOO'));
		assert.ok(!isValidUserVarName('rockets'));
		assert.ok(!isValidUserVarName('user_'));
	});
});

suite('renameUtils — collectWordRanges', () => {
	test('finds case-insensitive whole-word matches', () => {
		const lines = [
			'int Foo = 1;',
			'Foo = Foo + 1;',
			'// Foo ignored',
			'str s = "Foo";',
			'food = 0;',
		];
		const ranges = collectWordRanges(lines, 'foo', { caseInsensitive: true });
		assert.strictEqual(ranges.length, 3);
		assert.deepStrictEqual(ranges.map(r => r.line), [0, 1, 1]);
	});

	test('skips block comments across lines', () => {
		const lines = [
			'int bar = 1;',
			'/* bar',
			'   bar */',
			'bar = 2;',
		];
		const ranges = collectWordRanges(lines, 'bar', { caseInsensitive: true });
		assert.strictEqual(ranges.length, 2);
		assert.deepStrictEqual(ranges.map(r => r.line), [0, 3]);
	});

	test('respects start/end line bounds', () => {
		const lines = [
			'actor A {',
			'  var int user_a;',
			'}',
			'actor B {',
			'  var int user_a;',
			'}',
		];
		const ranges = collectWordRanges(lines, 'user_a', {
			caseInsensitive: true,
			startLine: 0,
			endLineInclusive: 2,
		});
		assert.strictEqual(ranges.length, 1);
		assert.strictEqual(ranges[0].line, 1);
	});

	test('skips ACS printcast prefixes', () => {
		const lines = ['Print(s:msg);', 'int msg = 1;'];
		const ranges = collectWordRanges(lines, 's', {
			caseInsensitive: true,
			skipPrintCast: true,
		});
		assert.strictEqual(ranges.length, 0);
	});
});

suite('renameUtils — wordAt', () => {
	test('returns word under cursor', () => {
		const text = '  user_foo = 1;';
		const w = wordAt(text, 4);
		assert.ok(w);
		assert.strictEqual(w!.word, 'user_foo');
	});
});

suite('DECORATE actor span', () => {
	test('finds containing actor for nested line', () => {
		const lines = [
			'actor Foo {',
			'  var int user_a;',
			'  States {',
			'  Spawn:',
			'    TNT1 A 1',
			'  }',
			'}',
			'actor Bar {',
			'  Health 1',
			'}',
		];
		const span = findActorSpanInLines(lines, 3);
		assert.ok(span);
		assert.strictEqual(span!.startLine, 0);
		assert.strictEqual(span!.endLine, 6);

		const bar = findActorSpanInLines(lines, 8);
		assert.ok(bar);
		assert.strictEqual(bar!.startLine, 7);
	});
});

suite('ACS declaration scan for rename', () => {
	test('collects vars and defines from a file body', () => {
		const lines = [
			'#define MAX_FOO 3',
			'int counter;',
			'script 1 ENTER {',
			'  int localVar = 0;',
			'  counter = localVar;',
			'}',
		];
		const vars: string[] = [];
		const consts: string[] = [];
		for (const line of lines) {
			scanLineDeclarations(
				line,
				(n) => consts.push(n.toLowerCase()),
				() => {},
				(n) => vars.push(n.toLowerCase())
			);
		}
		assert.ok(consts.includes('max_foo'));
		assert.ok(vars.includes('counter'));
		assert.ok(vars.includes('localvar'));

		const ranges = collectWordRanges(lines, 'localVar', {
			caseInsensitive: true,
			skipPrintCast: true,
		});
		assert.strictEqual(ranges.length, 2);
	});
});

suite('ACS script/function unit span', () => {
	test('scopes local rename to one script when name repeats', () => {
		const lines = [
			'script "A" (void) {',
			'  int ammo = 1;',
			'  ammo = ammo + 1;',
			'}',
			'script "B" (void) {',
			'  int ammo = 2;',
			'  ammo = ammo + 2;',
			'}',
		];
		const unitA = findEnclosingAcsUnitInLines(lines, 1);
		assert.ok(unitA);
		assert.strictEqual(unitA!.startLine, 0);
		assert.strictEqual(unitA!.endLine, 3);

		const unitB = findEnclosingAcsUnitInLines(lines, 5);
		assert.ok(unitB);
		assert.strictEqual(unitB!.startLine, 4);
		assert.strictEqual(unitB!.endLine, 7);

		const rangesA = collectWordRanges(lines, 'ammo', {
			caseInsensitive: true,
			skipPrintCast: true,
			startLine: unitA!.startLine,
			endLineInclusive: unitA!.endLine,
		});
		assert.deepStrictEqual(rangesA.map((r) => r.line), [1, 2, 2]);

		const rangesB = collectWordRanges(lines, 'ammo', {
			caseInsensitive: true,
			skipPrintCast: true,
			startLine: unitB!.startLine,
			endLineInclusive: unitB!.endLine,
		});
		assert.deepStrictEqual(rangesB.map((r) => r.line), [5, 6, 6]);
	});
});
