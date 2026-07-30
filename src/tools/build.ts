import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Zip, ZipPassThrough } from 'fflate';
import { getPk3Root } from '../shared/pk3Root';

let currentGen = 0;
let isBuilding = false;

/** @returns true when a fresh PK3 was written successfully */
export async function buildPK3(options: { quiet?: boolean } = {}): Promise<boolean> {
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

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building PK3...',
            cancellable: false
        }, async (progress) => {
            await packDirectoryToPk3(srcPath, outPath, (message) => {
                progress.report({ message });
            });
        });
        if (gen !== currentGen) { return false; }
        if (!options.quiet) {
            vscode.window.showInformationMessage('Build complete: out/build.pk3');
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
export async function buildProject(): Promise<boolean> {
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
    const ok = await buildPK3({ quiet: true });
    const pk3Ms = Date.now() - pk3Started;
    if (!ok) {
        return false;
    }

    const totalMs = Date.now() - totalStarted;
    const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const acsPart = acs.result === 'notConfigured'
        ? 'ACS: none'
        : `ACS: ${fmt(acs.elapsedMs)} (${acs.compiled} compiled, ${acs.skipped} skipped)`;
    vscode.window.showInformationMessage(
        `${acsPart} · PK3: ${fmt(pk3Ms)} · total ${fmt(totalMs)}`
    );
    return true;
}

interface FileEntry {
    archiveName: string;
    diskPath: string;
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

async function walkFiles(dir: string, base: string): Promise<FileEntry[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const result: FileEntry[][] = await Promise.all(
        entries.map(async (e): Promise<FileEntry[]> => {
            const fullPath = path.join(dir, e.name);
            if (e.isDirectory()) {
                return walkFiles(fullPath, base);
            }
            const archiveName = normalizeZipEntryName(
                path.relative(base, fullPath).replace(/\\/g, '/')
            );
            if (!archiveName) {
                return [];
            }
            return [{ archiveName, diskPath: fullPath }];
        })
    );
    return result.flat();
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
    onProgress?: (message: string) => void
): Promise<number> {
    const outDir = path.dirname(outPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    onProgress?.('Scanning files...');
    const fileEntries = await walkFiles(srcPath, srcPath);

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
