import * as assert from 'assert';
import {
	parseFirstScriptArg,
	enrichNamedExecuteParams,
	scriptParamsBeyondArity,
} from '../language/acs/namedScriptResolve';
import {
	extractIncludePath,
	extractScriptArgAtCursor,
} from '../language/acs/definitionProvider';
import { extractScriptParams, parseTypedParamList } from '../base/acsProvider';
import { AcsScriptSymbol, SymbolKind } from '../base/types';
import { ParamData } from '../shared/dataLoader';

suite('extractIncludePath — ACS preprocessor paths', () => {
	test('jumps from #include quoted path', () => {
		const line = '#include "common/lib.acs"';
		const col = line.indexOf('lib') + 1;
		assert.strictEqual(extractIncludePath(line, col), 'common/lib.acs');
	});

	test('jumps from #import quoted path', () => {
		const line = '#import "common/lib.acs"';
		const col = line.indexOf('lib') + 1;
		assert.strictEqual(extractIncludePath(line, col), 'common/lib.acs');
	});

	test('is case-insensitive and allows space after #', () => {
		const line = '# IMPORT "BARLIB.acs"';
		const col = line.indexOf('BAR') + 1;
		assert.strictEqual(extractIncludePath(line, col), 'BARLIB.acs');
	});

	test('ignores cursor outside the quotes', () => {
		const line = '#import "common/lib.acs"';
		assert.strictEqual(extractIncludePath(line, line.indexOf('import') + 1), null);
		assert.strictEqual(extractIncludePath(line, line.length), null);
	});
});

suite('extractScriptArgAtCursor — script-name hover', () => {
	test('hits string first arg and returns callee', () => {
		const line = 'ACS_NamedExecuteWithResult("core_weaponcolor", JUGGERNAUT_DYE)';
		const col = line.indexOf('weapon') + 1;
		const hit = extractScriptArgAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.key, 'core_weaponcolor');
		assert.strictEqual(hit!.calleeName, 'ACS_NamedExecuteWithResult');
		assert.strictEqual(line.slice(hit!.argStart, hit!.argEnd), '"core_weaponcolor"');
	});

	test('ignores later args', () => {
		const line = 'ACS_NamedExecuteWithResult("core_weaponcolor", JUGGERNAUT_DYE)';
		const col = line.indexOf('JUGGERNAUT') + 2;
		assert.strictEqual(extractScriptArgAtCursor(line, col), null);
	});

	test('supports numbered ACS_Execute', () => {
		const line = 'ACS_Execute(42, 0, 1)';
		const col = line.indexOf('42') + 1;
		const hit = extractScriptArgAtCursor(line, col);
		assert.ok(hit);
		assert.strictEqual(hit!.key, '42');
		assert.strictEqual(hit!.calleeName, 'ACS_Execute');
	});
});

suite('namedScriptResolve — parseFirstScriptArg', () => {
	test('reads string script while cursor would be on later args', () => {
		const key = parseFirstScriptArg('ACS_NamedExecute("GiveAmmo", 0, tid, amount');
		assert.strictEqual(key, 'GiveAmmo');
	});

	test('reads numbered script', () => {
		assert.strictEqual(parseFirstScriptArg('ACS_Execute(42, 0, 1)'), '42');
	});

	test('rejects non-script callables', () => {
		assert.strictEqual(parseFirstScriptArg('Thing_Damage(0, 10)'), null);
	});

	test('supports CallACS', () => {
		assert.strictEqual(parseFirstScriptArg('CallACS("GiveAmmo", 1, 2)'), 'GiveAmmo');
	});
});

suite('namedScriptResolve — enrichNamedExecuteParams', () => {
	const script: AcsScriptSymbol = {
		kind: SymbolKind.AcsScript,
		name: 'GiveAmmo',
		scriptKey: 'GiveAmmo',
		params: [
			{ type: 'int', name: 'tid' },
			{ type: 'int', name: 'amount' },
		],
		source: 'workspace',
		packageId: 'workspace',
		entryPath: 'acs/lib.acs',
	};

	test('overlays arg slots after script + map', () => {
		const base: ParamData[] = [
			{ name: 'script', type: 'string' },
			{ name: 'map', type: 'int' },
			{ name: 's_arg1', type: 'int', optional: true },
			{ name: 's_arg2', type: 'int', optional: true },
			{ name: 's_arg3', type: 'int', optional: true },
		];
		const enriched = enrichNamedExecuteParams(base, script);
		assert.strictEqual(enriched[0].name, 'script');
		assert.strictEqual(enriched[1].name, 'map');
		assert.strictEqual(enriched[2].name, 'tid');
		assert.strictEqual(enriched[3].name, 'amount');
		assert.strictEqual(enriched[4].name, 's_arg3');
		assert.strictEqual(enriched[2].optional, true);
	});

	test('CallACS-style arg1 without map', () => {
		const base: ParamData[] = [
			{ name: 'script', type: 'string' },
			{ name: 'arg1', type: 'int', optional: true },
			{ name: 'arg2', type: 'int', optional: true },
			{ name: 'arg3', type: 'int', optional: true },
			{ name: 'arg4', type: 'int', optional: true },
		];
		const enriched = enrichNamedExecuteParams(base, script);
		assert.strictEqual(enriched[1].name, 'tid');
		assert.strictEqual(enriched[2].name, 'amount');
		assert.strictEqual(enriched[3].name, 'arg3');
	});

	test('extra script params beyond arity', () => {
		const base: ParamData[] = [
			{ name: 'script', type: 'string' },
			{ name: 'arg1', type: 'int', optional: true },
		];
		const wide: AcsScriptSymbol = {
			...script,
			params: [
				{ type: 'int', name: 'a' },
				{ type: 'int', name: 'b' },
				{ type: 'int', name: 'c' },
			],
		};
		const extra = scriptParamsBeyondArity(base, wide);
		assert.deepStrictEqual(extra, [
			{ type: 'int', name: 'b' },
			{ type: 'int', name: 'c' },
		]);
	});
});

suite('AcsSymbolProvider — script param parsing', () => {
	test('parseTypedParamList handles void and same-type lists', () => {
		assert.deepStrictEqual(parseTypedParamList('void'), []);
		assert.deepStrictEqual(parseTypedParamList('int a, b, str c'), [
			{ type: 'int', name: 'a' },
			{ type: 'int', name: 'b' },
			{ type: 'str', name: 'c' },
		]);
	});

	test('extractScriptParams supports wrapped lists', () => {
		const lines = [
			'script "Wide"(int a,',
			'  int b,',
			'  int c)',
			'{',
			'}',
		];
		const m = /^\s*script\s+("[^"]*"|\d+|[A-Za-z_]\w*)(?:\s+(\w+))?/i.exec(lines[0]);
		assert.ok(m);
		const { params, linesConsumed } = extractScriptParams(lines, 0, lines[0].slice(m![0].length));
		assert.strictEqual(linesConsumed, 2);
		assert.deepStrictEqual(params, [
			{ type: 'int', name: 'a' },
			{ type: 'int', name: 'b' },
			{ type: 'int', name: 'c' },
		]);
	});
});
