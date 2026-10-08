import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	ACC_MAX_CLI_INCLUDE_PATHS,
	buildAccIncludePaths,
	findAcsIncludeFile,
} from '../tools/accIncludePaths';
import { cleanAcsObjectFiles, resolveAccExecutablePath } from '../tools/compileAcs';

suite('ACC executable path', () => {
	const workspaceRoot = path.join(path.sep, 'workspace', 'mod');

	test('keeps the PATH command unchanged', () => {
		assert.strictEqual(resolveAccExecutablePath('acc', workspaceRoot), 'acc');
	});

	test('expands a home-relative path', () => {
		assert.strictEqual(
			resolveAccExecutablePath('~/appfiles/acc/acc', workspaceRoot),
			path.join(os.homedir(), 'appfiles', 'acc', 'acc')
		);
	});

	test('keeps an absolute path unchanged', () => {
		const absolute = path.join(path.sep, 'opt', 'acc', 'acc');
		assert.strictEqual(resolveAccExecutablePath(absolute, workspaceRoot), absolute);
	});

	test('resolves a relative path from the workspace', () => {
		assert.strictEqual(
			resolveAccExecutablePath('tools/acc', workspaceRoot),
			path.join(workspaceRoot, 'tools', 'acc')
		);
	});
});

suite('ACC include path budget', () => {
	let tmpRoot: string;
	let acsSource: string;
	let accDir: string;
	let deepModApi: string;
	let imports: string;

	suiteSetup(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-inc-'));
		acsSource = path.join(tmpRoot, 'acs_source');
		accDir = path.join(tmpRoot, 'acc');
		fs.mkdirSync(accDir);
		fs.writeFileSync(path.join(accDir, 'zcommon.acs'), '// stub\n');

		// Deep nesting that would fall past slot 15 if every subdir were -i'd
		deepModApi = path.join(acsSource, 'vendor', 'shared', 'mod_api');
		imports = path.join(acsSource, 'imports');
		fs.mkdirSync(deepModApi, { recursive: true });
		fs.mkdirSync(imports, { recursive: true });

		for (let i = 0; i < 20; i++) {
			fs.mkdirSync(path.join(acsSource, `pad_${i}`, 'nested'), { recursive: true });
		}

		fs.writeFileSync(path.join(deepModApi, 'dtadd.acs'), '// dtadd\n');
		fs.writeFileSync(path.join(imports, 'uh_acsutils.acs'), '// utils\n');

		fs.writeFileSync(
			path.join(acsSource, 'uh_tools.acs'),
			[
				'#library "uh_tools"',
				'#include "zcommon.acs"',
				'#import "uh_acsutils.acs"',
				'#include "dtadd.acs"',
				'',
			].join('\n')
		);
	});

	suiteTeardown(() => {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	});

	test('resolves basename includes under deep dirs without flooding -i', () => {
		const found = findAcsIncludeFile('dtadd.acs', [acsSource]);
		assert.strictEqual(found, path.resolve(deepModApi, 'dtadd.acs'));

		const result = buildAccIncludePaths({
			srcFile: path.join(acsSource, 'uh_tools.acs'),
			accDir,
			searchRoots: [acsSource],
		});

		assert.ok(result.paths.length <= ACC_MAX_CLI_INCLUDE_PATHS);
		assert.strictEqual(result.truncated.length, 0);
		assert.ok(result.paths.includes(path.resolve(accDir)));
		assert.ok(result.paths.includes(path.resolve(deepModApi)));
		assert.ok(result.paths.includes(path.resolve(imports)));
		assert.ok(!result.paths.some(p => /pad_\d+/.test(p)));
	});

	test('reports truncated dirs when over the ACC CLI budget', () => {
		const result = buildAccIncludePaths({
			srcFile: path.join(acsSource, 'uh_tools.acs'),
			accDir,
			searchRoots: [acsSource],
			userIncludePaths: Array.from({ length: 20 }, (_, i) =>
				path.join(tmpRoot, `user_${i}`)
			),
			maxCliPaths: 4,
		});
		assert.strictEqual(result.paths.length, 4);
		assert.ok(result.truncated.length > 0);
	});

	test('prefers workspace exact-case file over later root uppercase copy', () => {
		const baseRoot = path.join(tmpRoot, 'baseAcs');
		const baseModApi = path.join(baseRoot, 'acs_source', 'mod api');
		fs.mkdirSync(baseModApi, { recursive: true });
		fs.writeFileSync(path.join(baseModApi, 'DTADD.acs'), '// base uppercase\n');

		const found = findAcsIncludeFile('dtadd.acs', [acsSource, baseRoot]);
		assert.strictEqual(found, path.resolve(deepModApi, 'dtadd.acs'));

		const result = buildAccIncludePaths({
			srcFile: path.join(acsSource, 'uh_tools.acs'),
			accDir,
			searchRoots: [acsSource, baseRoot],
		});
		assert.ok(result.paths.includes(path.resolve(deepModApi)));
		assert.ok(!result.paths.some(p => p.includes(`${path.sep}mod api`)));
	});
});

suite('ACS object cleanup', () => {
	let outputDir: string;

	setup(() => {
		outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-clean-'));
	});

	teardown(() => {
		fs.rmSync(outputDir, { recursive: true, force: true });
	});

	test('removes old objects while preserving sources, resources and subdirectories', async () => {
		for (const name of ['renamed.o', 'removed.O', 'current.o', 'keep.acs', 'keep.png']) {
			fs.writeFileSync(path.join(outputDir, name), name);
		}
		fs.mkdirSync(path.join(outputDir, 'nested.o'));
		fs.writeFileSync(path.join(outputDir, 'nested.o', 'keep.o'), 'nested');

		await cleanAcsObjectFiles(outputDir);

		assert.deepStrictEqual(fs.readdirSync(outputDir).sort(), ['keep.acs', 'keep.png', 'nested.o']);
		assert.strictEqual(fs.readFileSync(path.join(outputDir, 'nested.o', 'keep.o'), 'utf8'), 'nested');
	});

	test('accepts a missing output directory on the first build', async () => {
		await cleanAcsObjectFiles(path.join(outputDir, 'missing'));
		assert.ok(!fs.existsSync(path.join(outputDir, 'missing')));
	});

	test('propagates cleanup errors so the caller can stop packaging', async () => {
		const file = path.join(outputDir, 'not-a-directory');
		fs.writeFileSync(file, 'keep');
		await assert.rejects(cleanAcsObjectFiles(file));
		assert.strictEqual(fs.readFileSync(file, 'utf8'), 'keep');
	});
});
