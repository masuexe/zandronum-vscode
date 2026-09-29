import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	getAcsLibraryName,
	getAcsObjectFileName,
	hasLibraryDirective,
	listImportedAcsLibraries,
	selectLibraryAcsFiles,
} from '../shared/acsLibrarySelection';

suite('ACS library selection', () => {
	let tmpRoot: string;
	let sourceDir: string;

	const write = (rel: string, content: string): string => {
		const full = path.join(sourceDir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content);
		return full;
	};

	suiteSetup(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-lib-'));
		sourceDir = path.join(tmpRoot, 'acs_source');

		write('a.acs', '#library "a"\n#import "b.acs"\n');
		// Long license header pushes #library well past the first kilobyte.
		const header = '/*\n' + ' * license line\n'.repeat(220) + ' */\n';
		write('nested/b.acs', header + '#library "b"\n#import "c.acs"\n');
		write('nested/c.acs', '#library "c"\n');
		write('d.acs', '#library "d"\n');
		write('empty.acs', '// #library "fake"\n');
		write('e.acs', '#library "e"\n// #import "d.acs"\n');
		write('pit.acs', '#library "pit"\n#import "8BDT.acs"\n');
		write('overrides/8BDT.acs', '#library "CORE8BDT"\n#import "helper.txt"\n');
		write('overrides/helper.txt', '#LIBRARY "HELPER"\n#import "8BDT.acs"\n');
	});

	suiteTeardown(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	test('detects #library after a long license header', () => {
		assert.strictEqual(hasLibraryDirective(path.join(sourceDir, 'nested', 'b.acs')), true);
		assert.strictEqual(hasLibraryDirective(path.join(sourceDir, 'a.acs')), true);
	});

	test('ignores a commented-out #library', () => {
		assert.strictEqual(hasLibraryDirective(path.join(sourceDir, 'empty.acs')), false);
	});

	test('names objects after the declared library rather than the source', () => {
		const file = path.join(sourceDir, 'overrides', '8BDT.acs');
		assert.strictEqual(getAcsLibraryName(file), 'CORE8BDT');
		assert.strictEqual(getAcsObjectFileName(file), 'CORE8BDT.o');
	});

	test('reads mixed-case directives after long headers and inline comments', () => {
		const file = write('directive.txt', '/* license\n' + ' * line\n'.repeat(220) +
			' */\n# LiBrArY /* name */ "MiXeD" // trailing comment\n');
		assert.strictEqual(getAcsObjectFileName(file), 'MiXeD.o');
	});

	test('ignores fake directives in comments and strings', () => {
		const file = write('comments.acs', [
			'/* #library "WRONG" */',
			'// #library "WRONG"',
			'str text = "//"; /* #library "WRONG" */',
			'str other = "#library \\"WRONG\\"";',
			'#library "REAL"',
		].join('\n'));
		assert.strictEqual(getAcsLibraryName(file), 'REAL');
	});

	test('keeps basename output for sources without a named library', () => {
		assert.strictEqual(getAcsObjectFileName(path.join(sourceDir, 'empty.acs')), 'empty.o');
		assert.strictEqual(getAcsObjectFileName(write('map.script', 'script 1 OPEN {}')), 'map.o');
		assert.strictEqual(getAcsObjectFileName(write('unnamed.acs', '#library\n')), 'unnamed.o');
		assert.deepStrictEqual(selectLibraryAcsFiles(sourceDir, ['unnamed']),
			[path.join(sourceDir, 'unnamed.acs')]);
	});

	test('lists only real #import targets', () => {
		assert.deepStrictEqual(listImportedAcsLibraries(path.join(sourceDir, 'a.acs')), ['b']);
		assert.deepStrictEqual(listImportedAcsLibraries(path.join(sourceDir, 'e.acs')), []);
	});

	test('selects LOADACS entries plus their transitive imports', () => {
		const selected = selectLibraryAcsFiles(sourceDir, ['a'])
			.map(f => path.basename(f, '.acs'))
			.sort();
		assert.deepStrictEqual(selected, ['a', 'b', 'c']);
	});

	test('does not select unreferenced libraries', () => {
		const selected = selectLibraryAcsFiles(sourceDir, ['d'])
			.map(f => path.basename(f, '.acs'));
		assert.deepStrictEqual(selected, ['d']);
	});

	test('selects a LOADACS library by declaration and follows filename imports', () => {
		const selected = selectLibraryAcsFiles(sourceDir, ['core8bdt'])
			.map(f => path.basename(f)).sort();
		assert.deepStrictEqual(selected, ['8BDT.acs', 'helper.txt']);
	});

	test('selects differently named imports and deduplicates library and file aliases', () => {
		const selected = selectLibraryAcsFiles(sourceDir, ['pit', 'CORE8BDT', '8bdt'])
			.map(f => path.basename(f)).sort();
		assert.deepStrictEqual(selected, ['8BDT.acs', 'helper.txt', 'pit.acs']);
	});

	test('returns nothing when no entries are configured', () => {
		assert.deepStrictEqual(selectLibraryAcsFiles(sourceDir, []), []);
	});
});
