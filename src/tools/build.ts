import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import { Zip, ZipPassThrough } from 'fflate';
import { getPk3Root } from '../shared/pk3Root';

let currentGen = 0;
let isBuilding = false;

const PK3_IGNORE_FILENAME = '.pk3ignore';
const BUILD_MANIFEST_VERSION = 1;

export interface Pk3InputState {
    path: string;
    size: number;
    mtimeMs: number;
}

export interface Pk3BuildManifest {
    version: number;
    inputs: Pk3InputState[];
    output: {
        size: number;
        mtimeMs: number;
    };
}

export interface BuildPk3Options {
    quiet?: boolean;
    /** Skip packaging when the last successful build has identical inputs and output. */
    skipIfUnchanged?: boolean;
    onResult?: (result: 'built' | 'skipped') => void;
}

/** @returns true when the PK3 was built successfully or is already current */
export async function buildPK3(options: BuildPk3Options = {}): Promise<boolean> {
    const gen = ++currentGen;

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('Build failed: no workspace opened');
        return false;
    }

    const pk3Root = getPk3Root();
    const root = workspaceFolders[0].uri.fsPath;
    const srcPath = path.join(root, pk3Root);

    if (!fs.existsSync(srcPath)) {
        vscode.window.showErrorMessage(
            `Build failed: ${pk3Root}/ directory not found in workspace root`
        );
        return false;
    }

    if (isBuilding) {
        return false;
    }

    isBuilding = true;
    const outPath = path.join(root, 'out', 'build.pk3');
    const leanPack = vscode.workspace.getConfiguration('zandronum-vscode').get<boolean>('pk3LeanPack') === true;
    const filter = leanPack ? loadPk3Ignore(srcPath) : null;
    const leanNote = leanPack
        ? (filter ? 'lean' : 'lean: no .pk3ignore')
        : null;

    try {
        const fileEntries = await walkFiles(srcPath, srcPath, filter);
        const inputs = await snapshotInputFiles(fileEntries);
        const manifestPath = `${outPath}.manifest.json`;

        if (options.skipIfUnchanged) {
            const previous = await readBuildManifest(manifestPath);
            if (previous && await isBuildManifestCurrent(previous, inputs, outPath)) {
                options.onResult?.('skipped');
                if (!options.quiet) {
                    vscode.window.showInformationMessage('PK3 is up-to-date; packaging skipped.');
                }
                return true;
            }
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building PK3...',
            cancellable: false
        }, async (progress) => {
            await packDirectoryToPk3(srcPath, outPath, {
                onProgress: (message) => { progress.report({ message }); },
                filter,
                fileEntries,
            });
        });
        if (gen !== currentGen) { return false; }
        await writeBuildManifest(manifestPath, await createBuildManifest(inputs, outPath));
        options.onResult?.('built');
        if (!options.quiet) {
            const suffix = leanNote ? ` (${leanNote})` : '';
            vscode.window.showInformationMessage(`Build complete: out/build.pk3${suffix}`);
        }
        return true;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Build failed: ${message}`);
        return false;
    } finally {
        isBuilding = false;
        if (gen !== currentGen) {
            buildPK3();
        }
    }
}

/**
 * Project build: compile LOADACS libraries when configured (workspace + base
 * resources), then package PK3. Skips ACS when no LOADACS entries exist;
 * stops without packaging on compile failure.
 */
export async function buildProject(
    options: { skipUnchangedPk3?: boolean } = {}
): Promise<boolean> {
    // Dynamic import avoids a static cycle with compileAcs → buildPK3.
    const { compileLoadAcsLibraries } = await import('./compileAcs.js');
    const totalStarted = Date.now();

    const acs = await compileLoadAcsLibraries({
        quietNotConfigured: true,
        quietSuccess: true,
    });
    if (acs.result === 'failure') {
        return false;
    }

    const pk3Started = Date.now();
    const pk3Status: { result: 'built' | 'skipped' } = { result: 'built' };
    const ok = await buildPK3({
        quiet: true,
        skipIfUnchanged: options.skipUnchangedPk3,
        onResult: result => { pk3Status.result = result; },
    });
    const pk3Ms = Date.now() - pk3Started;
    if (!ok) {
        return false;
    }

    const totalMs = Date.now() - totalStarted;
    const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const acsPart = acs.result === 'notConfigured'
        ? 'ACS: none'
        : `ACS: ${fmt(acs.elapsedMs)} (${acs.compiled} compiled, ${acs.skipped} skipped)`;
    const pk3Part = pk3Status.result === 'skipped'
        ? 'PK3: up-to-date'
        : `PK3: ${fmt(pk3Ms)}`;
    vscode.window.showInformationMessage(
        `${acsPart} · ${pk3Part} · total ${fmt(totalMs)}`
    );
    return true;
}

export interface FileEntry {
    archiveName: string;
    diskPath: string;
}

export interface PackPk3Options {
    onProgress?: (message: string) => void;
    /** When set, skip paths ignored by this filter (gitignore semantics relative to pk3 root). */
    filter?: Ignore | null;
    /** Pre-enumerated package inputs, used by incremental builds to avoid a second walk. */
    fileEntries?: readonly FileEntry[];
}

const MAX_CONCURRENT_READS = 64;

/** Normalize ZIP entry path: forward slashes only, no trailing slash (not a directory). */
export function normalizeZipEntryName(name: string): string | null {
    const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.endsWith('/')) {
        return null;
    }
    return normalized;
}

/**
 * Load `<pk3Root>/.pk3ignore`. Returns null when missing/unreadable (no rules).
 * Always ignores `.pk3ignore` itself so it is never packed.
 */
export function loadPk3Ignore(pk3RootAbs: string): Ignore | null {
    const ignorePath = path.join(pk3RootAbs, PK3_IGNORE_FILENAME);
    const ig = ignore();
    ig.add(PK3_IGNORE_FILENAME);
    if (!fs.existsSync(ignorePath)) {
        return null;
    }
    try {
        const text = fs.readFileSync(ignorePath, 'utf8');
        ig.add(text);
        return ig;
    } catch {
        return null;
    }
}

function shouldSkipPath(relPosix: string, isDirectory: boolean, filter: Ignore | null | undefined): boolean {
    if (!relPosix) {
        return false;
    }
    // Always skip the ignore file itself even when lean is off / no filter loaded.
    if (relPosix === PK3_IGNORE_FILENAME || relPosix.endsWith('/' + PK3_IGNORE_FILENAME)) {
        return true;
    }
    if (!filter) {
        return false;
    }
    const check = isDirectory && !relPosix.endsWith('/') ? `${relPosix}/` : relPosix;
    return filter.ignores(check);
}

async function walkFiles(
    dir: string,
    base: string,
    filter?: Ignore | null
): Promise<FileEntry[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const result: FileEntry[][] = await Promise.all(
        entries.map(async (e): Promise<FileEntry[]> => {
            const fullPath = path.join(dir, e.name);
            const relPosix = path.relative(base, fullPath).replace(/\\/g, '/');
            if (e.isDirectory()) {
                if (shouldSkipPath(relPosix, true, filter)) {
                    return [];
                }
                return walkFiles(fullPath, base, filter);
            }
            if (shouldSkipPath(relPosix, false, filter)) {
                return [];
            }
            const archiveName = normalizeZipEntryName(relPosix);
            if (!archiveName) {
                return [];
            }
            return [{ archiveName, diskPath: fullPath }];
        })
    );
    return result.flat();
}

async function snapshotInputFiles(fileEntries: readonly FileEntry[]): Promise<Pk3InputState[]> {
    const states = await Promise.all(fileEntries.map(async entry => {
        const stat = await fs.promises.stat(entry.diskPath);
        return {
            path: entry.archiveName,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        };
    }));
    return states.sort((a, b) => a.path.localeCompare(b.path));
}

async function createBuildManifest(
    inputs: Pk3InputState[],
    outPath: string
): Promise<Pk3BuildManifest> {
    const output = await fs.promises.stat(outPath);
    return {
        version: BUILD_MANIFEST_VERSION,
        inputs,
        output: { size: output.size, mtimeMs: output.mtimeMs },
    };
}

export async function isBuildManifestCurrent(
    manifest: Pk3BuildManifest,
    inputs: readonly Pk3InputState[],
    outPath: string
): Promise<boolean> {
    if (manifest.version !== BUILD_MANIFEST_VERSION
        || !Array.isArray(manifest.inputs)
        || !manifest.output
        || manifest.inputs.length !== inputs.length) {
        return false;
    }
    for (let i = 0; i < inputs.length; i++) {
        const previous = manifest.inputs[i];
        const current = inputs[i];
        if (previous.path !== current.path
            || previous.size !== current.size
            || previous.mtimeMs !== current.mtimeMs) {
            return false;
        }
    }
    try {
        const output = await fs.promises.stat(outPath);
        return output.isFile()
            && output.size === manifest.output.size
            && output.mtimeMs === manifest.output.mtimeMs;
    } catch {
        return false;
    }
}

async function readBuildManifest(manifestPath: string): Promise<Pk3BuildManifest | null> {
    try {
        return JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Pk3BuildManifest;
    } catch {
        return null;
    }
}

async function writeBuildManifest(
    manifestPath: string,
    manifest: Pk3BuildManifest
): Promise<void> {
    const tmpPath = `${manifestPath}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(manifest));
    await fs.promises.rename(tmpPath, manifestPath);
}

async function readBatch(files: FileEntry[]): Promise<Array<{ archiveName: string; data: Buffer }>> {
    const buffers = await Promise.all(
        files.map(f => fs.promises.readFile(f.diskPath))
    );
    return files.map((f, i) => ({ archiveName: f.archiveName, data: buffers[i] }));
}

/**
 * Pack every file under srcPath into a store (uncompressed) ZIP/PK3 at outPath.
 * Writes only file entries with `/` separators — never empty directory entries.
 * Uses a temp file then rename for atomic replace.
 */
export async function packDirectoryToPk3(
    srcPath: string,
    outPath: string,
    onProgressOrOptions?: ((message: string) => void) | PackPk3Options
): Promise<number> {
    const options: PackPk3Options = typeof onProgressOrOptions === 'function'
        ? { onProgress: onProgressOrOptions }
        : (onProgressOrOptions ?? {});
    const { onProgress, filter } = options;

    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    onProgress?.('Scanning files...');
    const fileEntries = options.fileEntries
        ? [...options.fileEntries]
        : await walkFiles(srcPath, srcPath, filter);

    const tmpPath = `${outPath}.tmp`;
    try {
        if (fs.existsSync(tmpPath)) {
            await fs.promises.unlink(tmpPath);
        }

        await writeStoreZip(fileEntries, tmpPath, onProgress);

        // Atomic replace of the destination PK3
        await fs.promises.rename(tmpPath, outPath);
    } catch (err) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        throw err;
    }

    return fileEntries.length;
}

async function writeStoreZip(
    fileEntries: FileEntry[],
    outPath: string,
    onProgress?: (message: string) => void
): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outPath);
        let settled = false;

        const fail = (err: Error) => {
            if (settled) { return; }
            settled = true;
            output.destroy();
            reject(err);
        };

        output.on('error', fail);

        const zip = new Zip((err, data, final) => {
            if (err) {
                fail(err instanceof Error ? err : new Error(String(err)));
                return;
            }
            if (!output.write(data) && !final) {
                // backpressure ignored for simplicity; store ZIP chunks are small headers + data
            }
            if (final) {
                output.end(() => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                });
            }
        });

        (async () => {
            let fileCount = 0;
            for (let i = 0; i < fileEntries.length; i += MAX_CONCURRENT_READS) {
                const batch = fileEntries.slice(i, i + MAX_CONCURRENT_READS);
                const files = await readBatch(batch);
                for (const f of files) {
                    const name = normalizeZipEntryName(f.archiveName);
                    if (!name) { continue; }
                    const entry = new ZipPassThrough(name);
                    zip.add(entry);
                    // Copy into a standalone Uint8Array — ZipPassThrough may retain the view.
                    entry.push(Uint8Array.from(f.data), true);
                    fileCount++;
                }
                onProgress?.(`${fileCount}/${fileEntries.length} files`);
            }
            zip.end();
        })().catch(fail);
    });
}
