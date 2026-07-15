import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { unsupportedArchiveMessage, isSupportedArchive } from '../base/archiveFormats';
import { ZipPackage, FolderPackage, normalizeEntryPath } from '../base/packages';
import { ActorSymbolProvider } from '../base/actorProvider';
import { AcsSymbolProvider } from '../base/acsProvider';
import { SymbolDatabase } from '../base/symbolDatabase';
import { SymbolKind } from '../base/types';
import { extractBaseAcsSources } from '../base/extractBaseAcs';
import { makeBaseResourceUri, parseBaseResourceUri } from '../base/baseResourceUri';

suite('Base Resource — archive formats', () => {
	test('rejects .wad and .pk7', () => {
		assert.ok(unsupportedArchiveMessage('doom2.wad')?.includes('WAD'));
		assert.ok(unsupportedArchiveMessage('mod.pk7')?.includes('PK7'));
		assert.strictEqual(unsupportedArchiveMessage('mod.pk3'), undefined);
		assert.strictEqual(unsupportedArchiveMessage('mod.zip'), undefined);
		assert.ok(isSupportedArchive('a.pk3'));
		assert.ok(isSupportedArchive('a.zip'));
		assert.ok(!isSupportedArchive('a.wad'));
	});
});

suite('Base Resource — ZipPackage cache', () => {
	let tmpPk3: string;

	suiteSetup(() => {
		const decorate = Buffer.from('actor Zombie : Actor {}\nactor Demon : Actor {}\n');
		const acs = Buffer.from('#define MY_CONST 1\nfunction void Hello(void) {}\n');
		const zipped = zipSync({
			'actors/enemies.dec': decorate,
			'acs/lib.acs': acs,
		});
		tmpPk3 = path.join(os.tmpdir(), `zandro-base-test-${Date.now()}.pk3`);
		fs.writeFileSync(tmpPk3, zipped);
	});

	suiteTeardown(() => {
		try { fs.unlinkSync(tmpPk3); } catch { /* ignore */ }
	});

	test('getEntries and openEntry share one unzip', async () => {
		const pkg = new ZipPackage('test.pk3', 1, tmpPk3);
		const entries = await pkg.getEntries();
		assert.ok(entries.some(e => normalizeEntryPath(e.path) === 'actors/enemies.dec'));
		const bytes = await pkg.openEntry('actors/enemies.dec');
		assert.ok(bytes.length > 0);
		assert.ok(Buffer.from(bytes).toString('utf-8').includes('Zombie'));
		assert.strictEqual(pkg.getLoadError(), undefined);
	});

	test('case-insensitive openEntry', async () => {
		const pkg = new ZipPackage('test.pk3', 1, tmpPk3);
		const bytes = await pkg.openEntry('ACTORS/Enemies.DEC');
		assert.ok(bytes.length > 0);
	});

	test('ActorSymbolProvider finds actors with location', async () => {
		const pkg = new ZipPackage('test.pk3', 1, tmpPk3);
		const content = await pkg.openEntry('actors/enemies.dec');
		const provider = new ActorSymbolProvider();
		const symbols = provider.parse('actors/enemies.dec', content);
		assert.strictEqual(symbols.length, 2);
		assert.strictEqual(symbols[0].name, 'Zombie');
		assert.ok(symbols[0].location);
		assert.strictEqual(symbols[0].location!.line, 0);
	});

	test('AcsSymbolProvider finds define and function', async () => {
		const pkg = new ZipPackage('test.pk3', 1, tmpPk3);
		const content = await pkg.openEntry('acs/lib.acs');
		const provider = new AcsSymbolProvider();
		const symbols = provider.parse('acs/lib.acs', content);
		const names = symbols.map(s => s.name);
		assert.ok(names.includes('MY_CONST'));
		assert.ok(names.includes('Hello'));
	});

	test('SymbolDatabase indexes with package metadata and override order', async () => {
		const pkg = new ZipPackage('deps/test.pk3', 1, tmpPk3);
		const db = new SymbolDatabase();
		db.registerProvider(new ActorSymbolProvider());
		db.registerProvider(new AcsSymbolProvider());
		await db.build([pkg]);

		const zombie = db.query(SymbolKind.Actor, 'zombie');
		assert.ok(zombie);
		assert.strictEqual(zombie!.source, path.basename(tmpPk3));
		assert.strictEqual(zombie!.packageId, 'deps/test.pk3');
		assert.strictEqual(zombie!.entryPath, 'actors/enemies.dec');

		const c = db.query(SymbolKind.AcsConstant, 'MY_CONST');
		assert.ok(c);
	});

	test('extractBaseAcsSources writes ACS files', async () => {
		const pkg = new ZipPackage('deps/test.pk3', 1, tmpPk3);
		const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-acs-'));
		try {
			const dirs = await extractBaseAcsSources([pkg], extractRoot);
			assert.strictEqual(dirs.length, 1);
			const found = fs.readdirSync(dirs[0], { recursive: true }) as string[];
			assert.ok(found.some(f => String(f).toLowerCase().endsWith('lib.acs')));
		} finally {
			fs.rmSync(extractRoot, { recursive: true, force: true });
		}
	});
});

suite('Base Resource — FolderPackage', () => {
	test('walks directory entries', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-folder-'));
		try {
			fs.writeFileSync(path.join(dir, 'DECORATE'), 'actor Foo {}\n');
			const pkg = new FolderPackage('local', 1, dir);
			const entries = await pkg.getEntries();
			assert.ok(entries.some(e => e.path === 'DECORATE'));
			const bytes = await pkg.openEntry('DECORATE');
			assert.ok(Buffer.from(bytes).toString('utf-8').includes('Foo'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

suite('Base Resource — URI helpers', () => {
	test('round-trip packageId and entryPath', () => {
		const uri = makeBaseResourceUri('./deps/base.pk3', 'actors/a.dec');
		const parsed = parseBaseResourceUri(uri);
		assert.ok(parsed);
		assert.strictEqual(parsed!.packageId, './deps/base.pk3');
		assert.strictEqual(parsed!.entryPath, 'actors/a.dec');
	});
});

suite('Base Resource — override order', () => {
	test('later package overrides earlier actor', async () => {
		const makePkg = async (id: string, actorLine: string) => {
			const zipped = zipSync({ 'DECORATE': Buffer.from(actorLine) });
			const file = path.join(os.tmpdir(), `zandro-ov-${id}-${Date.now()}.pk3`);
			fs.writeFileSync(file, zipped);
			return { pkg: new ZipPackage(id, 1, file), file };
		};
		const a = await makePkg('first', 'actor Shared : Actor {}\n');
		const b = await makePkg('second', 'actor Shared : Demon {}\n');
		try {
			const db = new SymbolDatabase();
			db.registerProvider(new ActorSymbolProvider());
			await db.build([a.pkg, b.pkg]);
			const sym = db.query(SymbolKind.Actor, 'Shared');
			assert.ok(sym);
			assert.strictEqual(sym!.packageId, 'second');
			assert.strictEqual((sym as { parentClass?: string }).parentClass, 'Demon');
		} finally {
			try { fs.unlinkSync(a.file); } catch { /* ignore */ }
			try { fs.unlinkSync(b.file); } catch { /* ignore */ }
		}
	});
});
