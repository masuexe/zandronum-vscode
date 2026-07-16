import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { FolderPackage, ZipPackage } from '../base/packages';
import {
	parseLoadAcsText,
	readLoadAcsFromPackage,
	collectLoadAcsEntries,
} from '../tools/loadAcsDiscovery';
import { getPk3Root } from '../shared/pk3Root';

suite('LOADACS discovery — parseLoadAcsText', () => {
	test('parses names and strips comments', () => {
		const text = [
			'// header',
			'# ignored directive line',
			'',
			'myLib',
			'otherLib // trailing',
			'  spacedLib  ',
		].join('\n');
		assert.deepStrictEqual(parseLoadAcsText(text), ['myLib', 'otherLib', 'spacedLib']);
	});

	test('returns empty for blank input', () => {
		assert.deepStrictEqual(parseLoadAcsText(''), []);
		assert.deepStrictEqual(parseLoadAcsText('// only comments\n'), []);
	});
});

suite('LOADACS discovery — packages and merge', () => {
	let tmpRoot: string;
	let workspaceRoot: string;
	let baseFolder: string;
	let tmpPk3: string;

	suiteSetup(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-loadacs-'));
		workspaceRoot = path.join(tmpRoot, 'ws');
		baseFolder = path.join(tmpRoot, 'base');
		const pk3Root = getPk3Root();
		fs.mkdirSync(path.join(workspaceRoot, pk3Root), { recursive: true });
		fs.writeFileSync(
			path.join(workspaceRoot, pk3Root, 'loadacs'),
			'wsLib\nsharedLib\n'
		);

		fs.mkdirSync(baseFolder, { recursive: true });
		fs.writeFileSync(
			path.join(baseFolder, 'loadacs'),
			'baseLib\nsharedLib\n'
		);

		const zipped = zipSync({
			loadacs: Buffer.from('zipLib\nsharedLib\n'),
			'acs/x.acs': Buffer.from('#library "x"\n'),
		});
		tmpPk3 = path.join(tmpRoot, 'base.pk3');
		fs.writeFileSync(tmpPk3, zipped);
	});

	suiteTeardown(() => {
		try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
	});

	test('readLoadAcsFromPackage reads FolderPackage root loadacs', async () => {
		const pkg = new FolderPackage(baseFolder, 1, baseFolder);
		const names = await readLoadAcsFromPackage(pkg);
		assert.deepStrictEqual(names, ['baseLib', 'sharedLib']);
	});

	test('readLoadAcsFromPackage reads ZipPackage root loadacs', async () => {
		const pkg = new ZipPackage(tmpPk3, 1, tmpPk3);
		const names = await readLoadAcsFromPackage(pkg);
		assert.deepStrictEqual(names, ['zipLib', 'sharedLib']);
	});

	test('readLoadAcsFromPackage reads ZipPackage LOADACS.txt', async () => {
		const zippedTxt = zipSync({
			'LOADACS.txt': Buffer.from('fromTxtLib\n'),
			'acs/x.acs': Buffer.from('#library "x"\n'),
		});
		const pk3Txt = path.join(tmpRoot, 'loadacs-txt.pk3');
		fs.writeFileSync(pk3Txt, zippedTxt);
		const pkg = new ZipPackage(pk3Txt, 1, pk3Txt);
		const names = await readLoadAcsFromPackage(pkg);
		assert.deepStrictEqual(names, ['fromTxtLib']);
	});

	test('readLoadAcsFromPackage accepts arbitrary LOADACS extension', async () => {
		const zipped = zipSync({
			'LOADACS.whatever': Buffer.from('extLib\n'),
		});
		const pk3 = path.join(tmpRoot, 'loadacs-ext.pk3');
		fs.writeFileSync(pk3, zipped);
		const pkg = new ZipPackage(pk3, 1, pk3);
		const names = await readLoadAcsFromPackage(pkg);
		assert.deepStrictEqual(names, ['extLib']);
	});

	test('collectLoadAcsEntries merges workspace first and dedupes case-insensitively', async () => {
		const folderPkg = new FolderPackage(baseFolder, 1, baseFolder);
		const zipPkg = new ZipPackage(tmpPk3, 2, tmpPk3);
		const merged = await collectLoadAcsEntries(workspaceRoot, [folderPkg, zipPkg]);
		assert.deepStrictEqual(merged, ['wsLib', 'sharedLib', 'baseLib', 'zipLib']);
	});

	test('collectLoadAcsEntries works with only base packages', async () => {
		const emptyWs = path.join(tmpRoot, 'empty-ws');
		fs.mkdirSync(path.join(emptyWs, getPk3Root()), { recursive: true });
		const folderPkg = new FolderPackage(baseFolder, 1, baseFolder);
		const merged = await collectLoadAcsEntries(emptyWs, [folderPkg]);
		assert.deepStrictEqual(merged, ['baseLib', 'sharedLib']);
	});
});
