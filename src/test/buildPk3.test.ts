import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unzipSync } from 'fflate';
import { normalizeZipEntryName, packDirectoryToPk3, loadPk3Ignore } from '../tools/build';

/** Filenames from the ZIP central directory (authoritative entry list). */
function listZipCentralDirectoryNames(data: Buffer): string[] {
	let eocd = -1;
	for (let i = Math.max(0, data.length - 22 - 65535); i <= data.length - 22; i++) {
		if (data.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
		}
	}
	assert.ok(eocd >= 0, 'ZIP end-of-central-directory not found');
	const entryCount = data.readUInt16LE(eocd + 10);
	let offset = data.readUInt32LE(eocd + 16);
	const names: string[] = [];
	for (let n = 0; n < entryCount; n++) {
		assert.strictEqual(data.readUInt32LE(offset), 0x02014b50, `bad CD signature at ${offset}`);
		const nameLen = data.readUInt16LE(offset + 28);
		const extraLen = data.readUInt16LE(offset + 30);
		const commentLen = data.readUInt16LE(offset + 32);
		const nameStart = offset + 46;
		names.push(data.subarray(nameStart, nameStart + nameLen).toString('utf8'));
		offset = nameStart + nameLen + extraLen + commentLen;
	}
	return names;
}

suite('PK3 packaging', () => {
	test('normalizeZipEntryName forces / and rejects directories', () => {
		assert.strictEqual(normalizeZipEntryName('sprites\\skins\\a.png'), 'sprites/skins/a.png');
		assert.strictEqual(normalizeZipEntryName('sprites/skins/core_flipx/'), null);
		assert.strictEqual(normalizeZipEntryName('sprites\\skins\\core_flipx\\'), null);
		assert.strictEqual(normalizeZipEntryName(''), null);
	});

	test('packDirectoryToPk3 writes files only with forward-slash paths', async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-pk3-'));
		try {
			const src = path.join(tmpRoot, 'src');
			const nested = path.join(src, 'sprites', 'skins', 'core_flipx');
			fs.mkdirSync(nested, { recursive: true });
			fs.writeFileSync(path.join(nested, 'a.png'), Buffer.from([1, 2, 3, 4]));
			fs.writeFileSync(path.join(src, 'DECORATE.txt'), 'actor Dummy {}\n');
			// Empty nested dir with no files — must not become a ZIP directory entry
			fs.mkdirSync(path.join(src, 'sprites', 'skins', 'empty_only'), { recursive: true });

			const outPk3 = path.join(tmpRoot, 'out', 'build.pk3');
			const count = await packDirectoryToPk3(src, outPk3);
			assert.strictEqual(count, 2);
			assert.ok(fs.existsSync(outPk3));

			const zipBuf = fs.readFileSync(outPk3);
			const cdNames = listZipCentralDirectoryNames(zipBuf);
			assert.strictEqual(cdNames.length, 2, `expected 2 entries, got ${cdNames.join(',')}`);

			for (const name of cdNames) {
				assert.ok(!name.includes('\\'), `backslash in entry: ${name}`);
				assert.ok(!name.endsWith('/'), `directory entry: ${name}`);
				assert.ok(!name.endsWith('\\'), `directory entry: ${name}`);
			}

			const unzipped = unzipSync(new Uint8Array(zipBuf));
			const keys = Object.keys(unzipped).sort();
			assert.deepStrictEqual(keys, [
				'DECORATE.txt',
				'sprites/skins/core_flipx/a.png',
			]);
			assert.ok(unzipped['sprites/skins/core_flipx/a.png'].length > 0);
			assert.ok(unzipped['DECORATE.txt'].length > 0);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('lean filter via .pk3ignore excludes ACS sources but keeps .o', async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-pk3-lean-'));
		try {
			const src = path.join(tmpRoot, 'src');
			fs.mkdirSync(path.join(src, 'acs_source', 'unholy'), { recursive: true });
			fs.mkdirSync(path.join(src, 'acs'), { recursive: true });
			fs.writeFileSync(path.join(src, 'acs_source', 'unholy', 'UNHOLY.acs'), '#library "UNHOLY"\n');
			fs.writeFileSync(path.join(src, 'acs', 'UNHOLY.o'), Buffer.from([0, 1, 2]));
			fs.writeFileSync(path.join(src, 'LOADACS'), 'UNHOLY\n');
			fs.writeFileSync(path.join(src, 'notes.acs'), '// stray\n');
			fs.writeFileSync(
				path.join(src, '.pk3ignore'),
				['acs_source/', '**/*.acs', ''].join('\n')
			);

			const leanOut = path.join(tmpRoot, 'out', 'lean.pk3');
			const filter = loadPk3Ignore(src);
			assert.ok(filter, 'expected .pk3ignore to load');
			const leanCount = await packDirectoryToPk3(src, leanOut, { filter });
			assert.strictEqual(leanCount, 2);

			const leanKeys = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(leanOut)))).sort();
			assert.deepStrictEqual(leanKeys, ['LOADACS', 'acs/UNHOLY.o']);

			const fullOut = path.join(tmpRoot, 'out', 'full.pk3');
			const fullCount = await packDirectoryToPk3(src, fullOut);
			assert.ok(fullCount >= 4, `expected sources packed when lean off, got ${fullCount}`);
			const fullKeys = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(fullOut))));
			assert.ok(fullKeys.includes('acs_source/unholy/UNHOLY.acs'));
			assert.ok(fullKeys.includes('notes.acs'));
			assert.ok(!fullKeys.includes('.pk3ignore'), '.pk3ignore must never be packed');
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});
});
