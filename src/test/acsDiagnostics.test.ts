import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	AcsDeprecatedFunction,
	lintAcsDeprecatedCalls,
	stripAcsCommentsAndStrings,
} from '../language/acs/diagnosticsProvider';

const deprecated = new Map<string, AcsDeprecatedFunction>([
	['setlineblocking', { name: 'SetLineBlocking', replacement: 'Line_SetBlocking' }],
	['getteamscore', { name: 'GetTeamScore', replacement: 'GetTeamProperty' }],
	['node', { name: 'NODE' }],
]);

suite('acsDiagnostics — deprecated calls', () => {
	test('reports deprecated ACS functions', () => {
		const diagnostics = lintAcsDeprecatedCalls(
			['script 1 OPEN { SetLineBlocking(1, 8); }'],
			deprecated
		);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"ACS function 'SetLineBlocking' is deprecated. Use 'Line_SetBlocking' instead."
		);
		assert.strictEqual(diagnostics[0].line, 0);
		assert.strictEqual(diagnostics[0].startCharacter, 16);
		assert.strictEqual(diagnostics[0].endCharacter, 16 + 'SetLineBlocking'.length);
	});

	test('matches names case-insensitively and keeps the source spelling', () => {
		const diagnostics = lintAcsDeprecatedCalls(['setlineblocking (1, 8);'], deprecated);
		assert.strictEqual(diagnostics.length, 1);
		assert.strictEqual(
			diagnostics[0].message,
			"ACS function 'setlineblocking' is deprecated. Use 'Line_SetBlocking' instead."
		);
	});

	test('reports a deprecation without a replacement', () => {
		const diagnostics = lintAcsDeprecatedCalls(['NODE();'], deprecated);
		assert.deepStrictEqual(diagnostics.map(d => d.message), ["ACS function 'NODE' is deprecated."]);
	});

	test('ignores comments and strings', () => {
		const diagnostics = lintAcsDeprecatedCalls(
			[
				'// SetLineBlocking(1, 8);',
				'/* GetTeamScore(); */',
				'Print("SetLineBlocking(1, 8);");',
			],
			deprecated
		);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('ignores calls to current functions', () => {
		const diagnostics = lintAcsDeprecatedCalls(['Print("hello");'], deprecated);
		assert.deepStrictEqual(diagnostics, []);
	});

	test('reports every call on a line and on later lines', () => {
		const diagnostics = lintAcsDeprecatedCalls(
			['SetLineBlocking(1, 8); SetLineBlocking(2, 8);', 'GetTeamScore(0);'],
			deprecated
		);
		assert.strictEqual(diagnostics.length, 3);
		assert.strictEqual(diagnostics[2].line, 1);
	});
});

suite('acsDiagnostics — comment and string stripping', () => {
	test('keeps the input length', () => {
		const src = 'a // SetLineBlocking(\n"x(" /* block */';
		const out = stripAcsCommentsAndStrings(src);
		assert.strictEqual(out.length, src.length);
		assert.ok(!out.includes('SetLineBlocking'));
		assert.ok(!out.includes('block'));
	});
});

suite('acsDiagnostics — shipped metadata', () => {
	const functions: Record<string, {
		deprecated?: boolean;
		deprecatedBy?: string;
		returns?: string;
		params?: Array<{ name: string; type: string }>;
	}> = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'acs', 'functions.json'), 'utf8')
	);

	test('marks deprecated Zandronum and engine ACS functions', () => {
		const expected: Array<[string, string]> = [
			['BlueCount', 'GetTeamProperty'],
			['BlueScore', 'GetTeamProperty'],
			['GetTeamScore', 'GetTeamProperty'],
			['RedCount', 'GetTeamProperty'],
			['RedScore', 'GetTeamProperty'],
			['SinglePlayer', 'GameType'],
			['KickFromGame', 'ForceToSpectate'],
			['SetLineBlocking', 'Line_SetBlocking'],
			['SetLineMonsterBlocking', 'Line_SetBlocking'],
		];
		for (const [name, replacement] of expected) {
			assert.strictEqual(functions[name]?.deprecated, true, `${name} should be deprecated`);
			assert.strictEqual(functions[name]?.deprecatedBy, replacement);
		}
	});

	test('keeps current ACS functions out of the deprecated list', () => {
		for (const name of ['Print', 'GetTeamProperty', 'SetMusic', 'Line_SetBlocking', 'GetActorProperty', 'ForceToSpectate']) {
			assert.ok(!functions[name]?.deprecated, `${name} should not be deprecated`);
		}
	});

	test('adds the Zandronum-only ForceToSpectate function', () => {
		const entry = functions.ForceToSpectate;
		assert.ok(entry, 'functions.json is missing ForceToSpectate');
		assert.strictEqual(entry?.returns, 'int');
		assert.deepStrictEqual(entry?.params?.map(param => param.name), ['player', 'reason']);
	});

	test('points every deprecated ACS function at an existing replacement', () => {
		for (const [name, data] of Object.entries(functions)) {
			if (!data.deprecated || !data.deprecatedBy) {
				continue;
			}
			assert.ok(functions[data.deprecatedBy], `${name} names missing replacement ${data.deprecatedBy}`);
		}
	});
});
