import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { zipSync, unzipSync } from 'fflate';
import { buildProject } from '../tools/build';
import { getBuildOutputPath } from '../shared/buildOutput';
import { readLaunchLoadAcsEntries } from '../tools/loadAcsDiscovery';

suite('ACS project build with launch-only addons', () => {
    let root: string;
    let fixture: string;
    let addon: string;
    const previous = new Map<string, unknown>();
    const config = vscode.workspace.getConfiguration('zandronum-vscode');

    suiteSetup(async function () {
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // Integration tests must use a disposable workspace, never a user's project.
        if (process.platform === 'win32' || !workspace?.startsWith(`${os.tmpdir()}${path.sep}`)) {
            this.skip();
        }
        root = workspace!;
        fixture = fs.mkdtempSync(path.join(root, 'acs-build-'));
        const contentRoot = path.join(fixture, 'src');
        fs.mkdirSync(path.join(contentRoot, 'acs_source', 'compat'), { recursive: true });
        fs.mkdirSync(path.join(contentRoot, 'acs'));
        fs.writeFileSync(path.join(contentRoot, 'LOADACS.txt'), 'MAIN\n');
        fs.writeFileSync(path.join(contentRoot, 'acs_source', 'main.acs'), '#library "MAIN"\n');
        fs.writeFileSync(path.join(contentRoot, 'acs_source', 'compat', 'PNGBUTTN.acs'),
            '#library "PINGBUTT"\n#import "renamed.txt"\n');
        fs.writeFileSync(path.join(contentRoot, 'acs_source', 'renamed.txt'),
            '#library "UTILS"\n#import "deep.txt"\n');
        fs.writeFileSync(path.join(contentRoot, 'acs_source', 'deep.txt'), '#library "DEEP"\n');
        addon = path.join(fixture, 'addon.pk3');
        fs.writeFileSync(addon, zipSync({ 'LOADACS.anything': Buffer.from('PNGBUTTN\n') }));
        const compiler = path.join(fixture, 'acc');
        fs.writeFileSync(compiler, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const source = args[args.length - 2];
if (!fs.readFileSync(source, 'utf8').includes('FAIL')) {
    fs.writeFileSync(args[args.length - 1], Buffer.from('ACS\\0'));
}
`);
        fs.chmodSync(compiler, 0o755);
        for (const [key, value] of Object.entries({
            pk3Root: path.relative(root, contentRoot), accPath: compiler, accOutputDir: '',
            cleanBeforeBuild: true, acsLibraryOutputs: {},
        })) {
            previous.set(key, config.inspect(key)?.workspaceValue);
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        }
    });

    suiteTeardown(async () => {
        for (const [key, value] of previous) {
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        }
        if (fixture) { fs.rmSync(fixture, { recursive: true, force: true }); }
    });

    test('cleans and rebuilds a launch-only override plus transitive imports into the PK3', async () => {
        const outputDir = path.join(fixture, 'src', 'acs');
        fs.writeFileSync(path.join(outputDir, 'obsolete.o'), 'old');
        const addonBefore = fs.readFileSync(addon);
        assert.strictEqual(await buildProject({ launchResources: [addon] }), true);
        assert.deepStrictEqual(fs.readdirSync(outputDir).sort(), ['DEEP.o', 'MAIN.o', 'PNGBUTTN.o', 'UTILS.o']);
        const archive = unzipSync(fs.readFileSync(getBuildOutputPath()));
        for (const name of ['MAIN', 'PNGBUTTN', 'UTILS', 'DEEP']) {
            assert.ok(archive[`acs/${name}.o`]);
        }
        assert.strictEqual(archive['acs/PINGBUTT.o'], undefined);
        assert.strictEqual(Buffer.from(archive['LOADACS.txt']).toString(), 'MAIN\n');
        assert.deepStrictEqual(fs.readFileSync(addon), addonBefore);
    });

    test('Build Project can explicitly select an optional override without any launch resources', async () => {
        await config.update('acsLibraryOutputs', { 'compat/PNGBUTTN.acs': 'PNGBUTTN' }, vscode.ConfigurationTarget.Workspace);
        assert.strictEqual(await buildProject(), true);
        assert.ok(unzipSync(fs.readFileSync(getBuildOutputPath()))['acs/PNGBUTTN.o']);
        await config.update('acsLibraryOutputs', {}, vscode.ConfigurationTarget.Workspace);
    });

    test('exit zero without an output artifact stops packaging even if old bytecode existed', async () => {
        const source = path.join(fixture, 'src', 'acs_source', 'compat', 'PNGBUTTN.acs');
        const oldArchive = fs.readFileSync(getBuildOutputPath());
        fs.appendFileSync(source, '// FAIL\n');
        assert.strictEqual(await buildProject({ launchResources: [addon] }), false);
        assert.deepStrictEqual(fs.readFileSync(getBuildOutputPath()), oldArchive);
        assert.ok(!fs.existsSync(path.join(fixture, 'src', 'acs', 'PNGBUTTN.o')));
    });

    test('invalid launch resource prevents cleanup', async () => {
        const object = path.join(fixture, 'src', 'acs', 'keep.o');
        fs.writeFileSync(object, 'old');
        assert.strictEqual(await buildProject({ launchResources: [path.join(fixture, 'missing.pk3')] }), false);
        assert.strictEqual(fs.readFileSync(object, 'utf8'), 'old');
    });

    test('reads all global LOADACS lumps from WAD launch resources', async () => {
        const data = Buffer.from('ONE\nTWO\n');
        const header = Buffer.alloc(12);
        header.write('PWAD');
        header.writeInt32LE(2, 4);
        header.writeInt32LE(12 + data.length, 8);
        const directory = Buffer.alloc(32);
        for (let i = 0; i < 2; i++) {
            directory.writeInt32LE(12 + i * 4, i * 16);
            directory.writeInt32LE(4, i * 16 + 4);
            directory.write('LOADACS', i * 16 + 8);
        }
        const wad = path.join(fixture, 'addon.wad');
        fs.writeFileSync(wad, Buffer.concat([header, data, directory]));
        assert.deepStrictEqual(await readLaunchLoadAcsEntries([wad]), ['ONE', 'TWO']);
    });
});
