import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isPlaypalLumpName,
    pickPlaypalEntryPath,
    parsePlaypalBytes,
    playpalCacheSignature,
    resolvePlaypal,
    setPlaypalPackageProvider,
    loadPlaypal,
    RgbColor
} from '../tools/playpalReader';
import { PackageSource } from '../base/types';

function paletteBytes(seed: number): Uint8Array {
    const data = new Uint8Array(768);
    for (let i = 0; i < 256; i++) {
        data[i * 3] = (seed + i) & 0xff;
        data[i * 3 + 1] = (seed + 1 + i) & 0xff;
        data[i * 3 + 2] = (seed + 2 + i) & 0xff;
    }
    return data;
}

function fakePackage(
    id: string,
    priority: number,
    entries: Record<string, Uint8Array>
): PackageSource {
    const lowerKeys = new Map<string, string>(
        Object.keys(entries).map(k => [k.toLowerCase(), k])
    );
    return {
        id,
        priority,
        label: id,
        async getEntries() {
            return Object.keys(entries).map(p => ({ path: p, size: entries[p].length }));
        },
        async openEntry(p: string) {
            const key = lowerKeys.get(p.toLowerCase());
            return key ? entries[key] : new Uint8Array();
        }
    };
}

function seedOf(palette: RgbColor[] | null): number | null {
    return palette ? palette[0].r : null;
}

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-playpal-'));
}

suite('playpal — engine lump-name rule', () => {
    test('accepts PLAYPAL and extension/case variants', () => {
        assert.ok(isPlaypalLumpName('PLAYPAL'));
        assert.ok(isPlaypalLumpName('PLAYPAL.lmp'));
        assert.ok(isPlaypalLumpName('PLAYPAL.txt'));
        assert.ok(isPlaypalLumpName('playpal'));
        assert.ok(isPlaypalLumpName('PlayPal.LMP'));
    });

    test('rejects non-PLAYPAL basenames', () => {
        assert.ok(!isPlaypalLumpName('PLAYPALNOT'));
        assert.ok(!isPlaypalLumpName('PLAYPALX.txt'));
        assert.ok(!isPlaypalLumpName('PALPLAY'));
        assert.ok(!isPlaypalLumpName('palette.lmp'));
    });

    test('pickPlaypalEntryPath only accepts root entries', () => {
        assert.strictEqual(pickPlaypalEntryPath(['DECORATE', 'PLAYPAL.lmp']), 'PLAYPAL.lmp');
        assert.strictEqual(pickPlaypalEntryPath(['PLAYPAL']), 'PLAYPAL');
        assert.strictEqual(pickPlaypalEntryPath(['sprites/PLAYPAL']), undefined);
        assert.strictEqual(pickPlaypalEntryPath(['sprites/PLAYPAL', 'DECORATE']), undefined);
        assert.strictEqual(pickPlaypalEntryPath([]), undefined);
    });

    test('parsePlaypalBytes requires at least 768 bytes', () => {
        assert.strictEqual(parsePlaypalBytes(new Uint8Array(767)), null);
        const palette = parsePlaypalBytes(paletteBytes(5));
        assert.ok(palette);
        assert.strictEqual(palette!.length, 256);
        assert.deepStrictEqual(palette![0], { r: 5, g: 6, b: 7 });
    });
});

suite('playpal — resolution order', () => {
    let tmpDir: string;

    suiteSetup(() => {
        tmpDir = makeTempDir();
    });

    suiteTeardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('discovers a base package root PLAYPAL when playpalPath is empty', async () => {
        const palette = await resolvePlaypal({
            packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL': paletteBytes(10) })]
        });
        assert.strictEqual(seedOf(palette), 10);
    });

    test('accepts PLAYPAL.lmp variant inside a package', async () => {
        const palette = await resolvePlaypal({
            packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL.lmp': paletteBytes(11) })]
        });
        assert.strictEqual(seedOf(palette), 11);
    });

    test('ignores a nested subdir/PLAYPAL', async () => {
        const palette = await resolvePlaypal({
            packages: [fakePackage('mod.pk3', 1, { 'sprites/PLAYPAL': paletteBytes(12) })]
        });
        assert.strictEqual(palette, null);
    });

    test('skips a package PLAYPAL shorter than 768 bytes', async () => {
        const palette = await resolvePlaypal({
            packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL': new Uint8Array(100) })]
        });
        assert.strictEqual(palette, null);
    });

    test('later base resource overrides earlier one', async () => {
        const palette = await resolvePlaypal({
            packages: [
                fakePackage('early.pk3', 1, { 'PLAYPAL': paletteBytes(20) }),
                fakePackage('late.pk3', 2, { 'PLAYPAL': paletteBytes(21) })
            ]
        });
        assert.strictEqual(seedOf(palette), 21);
    });

    test('workspace <pk3Root> PLAYPAL overrides base resources', async () => {
        const wsDir = makeTempDir();
        try {
            fs.writeFileSync(path.join(wsDir, 'PLAYPAL'), paletteBytes(30));
            const palette = await resolvePlaypal({
                workspacePk3RootDir: wsDir,
                packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL': paletteBytes(31) })]
            });
            assert.strictEqual(seedOf(palette), 30);
        } finally {
            fs.rmSync(wsDir, { recursive: true, force: true });
        }
    });

    test('explicit playpalPath file overrides packages', async () => {
        const override = path.join(tmpDir, 'override-pal');
        fs.writeFileSync(override, paletteBytes(40));
        const palette = await resolvePlaypal({
            playpalPath: override,
            workspacePk3RootDir: tmpDir,
            packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL': paletteBytes(41) })]
        });
        assert.strictEqual(seedOf(palette), 40);
    });

    test('explicit playpalPath directory resolves PLAYPAL.lmp', async () => {
        const dir = makeTempDir();
        try {
            fs.writeFileSync(path.join(dir, 'PLAYPAL.lmp'), paletteBytes(50));
            const palette = await resolvePlaypal({
                playpalPath: dir,
                packages: [fakePackage('mod.pk3', 1, { 'PLAYPAL': paletteBytes(51) })]
            });
            assert.strictEqual(seedOf(palette), 50);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('relative playpalPath resolves against workspace root', async () => {
        const wsDir = makeTempDir();
        try {
            fs.writeFileSync(path.join(wsDir, 'mypal.lmp'), paletteBytes(60));
            const palette = await resolvePlaypal({
                playpalPath: 'mypal.lmp',
                workspaceRoot: wsDir
            });
            assert.strictEqual(seedOf(palette), 60);
        } finally {
            fs.rmSync(wsDir, { recursive: true, force: true });
        }
    });

    test('returns null when no source has a palette', async () => {
        const palette = await resolvePlaypal({
            workspacePk3RootDir: tmpDir,
            packages: [fakePackage('mod.pk3', 1, { 'DECORATE': new Uint8Array(16) })]
        });
        assert.strictEqual(palette, null);
    });
});

suite('playpal — package-set cache invalidation', () => {
    test('signature changes with package set, order, and playpalPath', () => {
        const a = fakePackage('a.pk3', 1, {});
        const b = fakePackage('b.pk3', 2, {});
        const base = playpalCacheSignature('', '/ws/src', [a]);
        assert.strictEqual(playpalCacheSignature('', '/ws/src', [a]), base);
        assert.notStrictEqual(playpalCacheSignature('', '/ws/src', []), base);
        assert.notStrictEqual(playpalCacheSignature('', '/ws/src', [a, b]), base);
        assert.notStrictEqual(playpalCacheSignature('', '/ws/src', [b, a]), base);
        assert.notStrictEqual(playpalCacheSignature('/pal', '/ws/src', [a]), base);
    });

    test('loadPlaypal drops cached palette and cached null when package set changes', async function () {
        this.timeout(10000);
        // Test host prerequisites: no loose PLAYPAL in <repo>/src, no playpalPath
        // setting — so an empty provider must resolve to null.
        assert.strictEqual(seedOf(await loadPlaypalWithProvider([])), null);

        setPlaypalPackageProvider(() => [fakePackage('alpha.pk3', 1, { 'PLAYPAL': paletteBytes(11) })]);
        assert.strictEqual(seedOf(await loadPlaypal()), 11);

        // New signature (empty set) — cached palette must not leak.
        setPlaypalPackageProvider(() => []);
        assert.strictEqual(seedOf(await loadPlaypal()), null);

        // New signature again — cached null must not stick.
        setPlaypalPackageProvider(() => [fakePackage('beta.pk3', 1, { 'PLAYPAL': paletteBytes(22) })]);
        assert.strictEqual(seedOf(await loadPlaypal()), 22);

        setPlaypalPackageProvider(undefined);
    });
});

async function loadPlaypalWithProvider(packages: readonly PackageSource[]): Promise<RgbColor[] | null> {
    setPlaypalPackageProvider(() => packages);
    return loadPlaypal();
}
