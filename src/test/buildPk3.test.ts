import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deflateRawSync } from 'zlib';
import { unzipSync } from 'fflate';
import {
	isBuildManifestCurrent,
	loadPk3Ignore,
	normalizeZipEntryName,
	packDirectoryToPk3,
	type Pk3BuildManifest,
	type Pk3InputState,
} from '../tools/build';

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

interface ZipHeaderInfo {
	name: string;
	method: number;
	flags: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	localFlags: number;
	localCrc: number;
	localCompressedSize: number;
	localUncompressedSize: number;
	localExtraLength: number;
	compressedData: Buffer;
}

function readZipHeaders(data: Buffer): ZipHeaderInfo[] {
	let eocd = -1;
	for (let i = Math.max(0, data.length - 22 - 65535); i <= data.length - 22; i++) {
		if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; }
	}
	assert.ok(eocd >= 0, 'ZIP end-of-central-directory not found');
	const entryCount = data.readUInt16LE(eocd + 10);
	let offset = data.readUInt32LE(eocd + 16);
	const entries: ZipHeaderInfo[] = [];
	for (let n = 0; n < entryCount; n++) {
		assert.strictEqual(data.readUInt32LE(offset), 0x02014b50);
		const nameLen = data.readUInt16LE(offset + 28);
		const extraLen = data.readUInt16LE(offset + 30);
		const commentLen = data.readUInt16LE(offset + 32);
		const name = data.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
		const localOffset = data.readUInt32LE(offset + 42);
		assert.strictEqual(data.readUInt32LE(localOffset), 0x04034b50);
		const localNameLength = data.readUInt16LE(localOffset + 26);
		const localExtraLength = data.readUInt16LE(localOffset + 28);
		const compressedSize = data.readUInt32LE(offset + 20);
		const compressedDataOffset = localOffset + 30 + localNameLength + localExtraLength;
		entries.push({
			name,
			method: data.readUInt16LE(offset + 10),
			flags: data.readUInt16LE(offset + 8),
			crc: data.readUInt32LE(offset + 16),
			compressedSize,
			uncompressedSize: data.readUInt32LE(offset + 24),
			localFlags: data.readUInt16LE(localOffset + 6),
			localCrc: data.readUInt32LE(localOffset + 14),
			localCompressedSize: data.readUInt32LE(localOffset + 18),
			localUncompressedSize: data.readUInt32LE(localOffset + 22),
			localExtraLength,
			compressedData: data.subarray(compressedDataOffset, compressedDataOffset + compressedSize),
		});
		offset += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

suite('PK3 packaging', () => {
	test('build manifest detects input and output changes', async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-pk3-manifest-'));
		try {
			const outPk3 = path.join(tmpRoot, 'build.pk3');
			fs.writeFileSync(outPk3, 'pk3');
			const output = fs.statSync(outPk3);
			const inputs: Pk3InputState[] = [
				{ path: 'DECORATE.txt', size: 12, mtimeMs: 1000 },
			];
			const manifest: Pk3BuildManifest = {
				version: 3,
				inputs,
				output: { size: output.size, mtimeMs: output.mtimeMs },
			};

			assert.strictEqual(await isBuildManifestCurrent(manifest, inputs, outPk3), true);
			assert.strictEqual(await isBuildManifestCurrent({ ...manifest, version: 2 }, inputs, outPk3), false);
			assert.strictEqual(await isBuildManifestCurrent({ ...manifest, version: 1 }, inputs, outPk3), false);
			assert.strictEqual(await isBuildManifestCurrent(manifest, [], outPk3), false);
			assert.strictEqual(await isBuildManifestCurrent(
				manifest,
				[{ path: 'DECORATE.txt', size: 13, mtimeMs: 1000 }],
				outPk3
			), false);

			fs.appendFileSync(outPk3, 'changed');
			assert.strictEqual(await isBuildManifestCurrent(manifest, inputs, outPk3), false);
			fs.unlinkSync(outPk3);
			assert.strictEqual(await isBuildManifestCurrent(manifest, inputs, outPk3), false);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	test('writes standard local headers without data descriptors', async () => {
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-pk3-headers-'));
		try {
			const src = path.join(tmpRoot, 'src');
			fs.mkdirSync(src);
			const compressible = Buffer.alloc(512, 0x41);
			const stored = Buffer.from([0, 1, 2, 3]);
			fs.writeFileSync(path.join(src, 'compressible.bin'), compressible);
			fs.writeFileSync(path.join(src, 'stored.bin'), stored);

			const outPk3 = path.join(tmpRoot, 'build.pk3');
			await packDirectoryToPk3(src, outPk3);
			const archive = fs.readFileSync(outPk3);
			const headers = readZipHeaders(archive);
			assert.deepStrictEqual(headers.map(entry => entry.name), [
				'compressible.bin',
				'stored.bin',
			]);

			const deflated = headers[0];
			assert.strictEqual(deflated.method, 8);
			assert.strictEqual(deflated.flags & 0x0008, 0);
			assert.ok(deflated.compressedSize < deflated.uncompressedSize);
			assert.deepStrictEqual(
				deflated.compressedData,
				deflateRawSync(compressible, { level: 9 })
			);

			const uncompressed = headers[1];
			assert.strictEqual(uncompressed.method, 0);
			assert.strictEqual(uncompressed.flags & 0x0008, 0);

			for (const entry of headers) {
				assert.strictEqual(entry.localFlags, entry.flags);
				assert.strictEqual(entry.localCrc, entry.crc);
				assert.strictEqual(entry.localCompressedSize, entry.compressedSize);
				assert.strictEqual(entry.localUncompressedSize, entry.uncompressedSize);
				assert.strictEqual(entry.localExtraLength, 0);
			}

			const unzipped = unzipSync(new Uint8Array(archive));
			assert.deepStrictEqual(Buffer.from(unzipped['compressible.bin']), compressible);
			assert.deepStrictEqual(Buffer.from(unzipped['stored.bin']), stored);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

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
