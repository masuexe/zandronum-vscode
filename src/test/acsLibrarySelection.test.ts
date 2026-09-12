import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
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

	test('returns nothing when no entries are configured', () => {
		assert.deepStrictEqual(selectLibraryAcsFiles(sourceDir, []), []);
	});
});
