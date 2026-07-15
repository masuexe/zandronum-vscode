import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';
import { getPk3Root } from '../shared/pk3Root';

let currentGen = 0;
let isBuilding = false;

/** @returns true when a fresh PK3 was written successfully */
export async function buildPK3(): Promise<boolean> {
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
        await doBuild(srcPath, outPath);
        if (gen !== currentGen) { return false; }
        vscode.window.showInformationMessage('Build complete: out/build.pk3');
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
 * Project build: compile LOADACS libraries when configured, then package PK3.
 * Skips ACS when LOADACS is absent; stops without packaging on compile failure.
 */
export async function buildProject(): Promise<boolean> {
    // Dynamic import avoids a static cycle with compileAcs → buildPK3.
    const { compileLoadAcsLibraries } = await import('./compileAcs.js');
    const result = await compileLoadAcsLibraries({ quietNotConfigured: true });
    if (result === 'failure') {
        return false;
    }
    return buildPK3();
}

interface FileEntry {
    archiveName: string;
    diskPath: string;
}

const MAX_CONCURRENT_READS = 64;

async function walkFiles(dir: string, base: string): Promise<FileEntry[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const result: FileEntry[][] = await Promise.all(
        entries.map(async (e): Promise<FileEntry[]> => {
            const fullPath = path.join(dir, e.name);
            const archiveName = path.relative(base, fullPath).replace(/\\/g, '/');
            if (e.isDirectory()) {
                return walkFiles(fullPath, base);
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

async function doBuild(srcPath: string, outPath: string): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Building PK3...',
        cancellable: false
    }, async (progress) => {
        const outDir = path.dirname(outPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        progress.report({ message: 'Scanning files...' });
        const fileEntries = await walkFiles(srcPath, srcPath);

        const archive = archiver('zip', { store: true });
        const output = fs.createWriteStream(outPath);
        let fileCount = 0;

        await new Promise<void>((resolve, reject) => {
            output.on('close', () => resolve());
            output.on('error', reject);
            archive.on('error', reject);

            archive.pipe(output);

            (async () => {
                for (let i = 0; i < fileEntries.length; i += MAX_CONCURRENT_READS) {
                    const batch = fileEntries.slice(i, i + MAX_CONCURRENT_READS);
                    const files = await readBatch(batch);
                    for (const f of files) {
                        archive.append(f.data, { name: f.archiveName, store: true });
                    }
                    fileCount += files.length;
                    progress.report({
                        message: `${fileCount}/${fileEntries.length} files`
                    });
                }
                archive.finalize();
            })().catch(reject);
        });
    });
}
