import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { deflateRawSync } from 'zlib';
import ignore, { type Ignore } from 'ignore';
import { getPk3Root } from '../shared/pk3Root';
import { crc32 } from './png/crc32';

let currentGen = 0;
let isBuilding = false;

const PK3_IGNORE_FILENAME = '.pk3ignore';
const BUILD_MANIFEST_VERSION = 3;

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

const MAX_CONCURRENT_PREPARES = 8;
const MAX_ZIP16 = 0xFFFF;
const MAX_ZIP32 = 0xFFFFFFFF;
const ZIP_LOCAL_FILE_HEADER = 0x04034B50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014B50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054B50;
const ZIP_METHOD_STORE = 0;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_FLAG_DEFLATE_MAXIMUM = 0x0002;
const ZIP_FLAG_UTF8 = 0x0800;

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

/**
 * Pack every file under srcPath into a Zandronum-compatible ZIP/PK3 at outPath.
 * Writes only file entries with `/` separators — never empty directory entries.
 * Uses DEFLATE level 9 when it makes an entry smaller, otherwise STORE.
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

        await writeCompatibleZip(fileEntries, tmpPath, onProgress);

        // Atomic replace of the destination PK3
        await fs.promises.rename(tmpPath, outPath);
    } catch (err) {
        try { await fs.promises.unlink(tmpPath); } catch { /* ignore */ }
        throw err;
    }

    return fileEntries.length;
}

interface PreparedZipEntry {
    archiveName: string;
    nameBytes: Buffer;
    data: Uint8Array;
    crc: number;
    compressedSize: number;
    uncompressedSize: number;
    method: number;
    flags: number;
    dosTime: number;
    dosDate: number;
}

type CentralZipEntry = Omit<PreparedZipEntry, 'data'> & {
    localHeaderOffset: number;
};

function dosDateTime(mtime: Date): { dosTime: number; dosDate: number } {
    const year = Math.min(2107, Math.max(1980, mtime.getFullYear()));
    return {
        dosTime: (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1),
        dosDate: ((year - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate(),
    };
}

async function prepareZipEntry(entry: FileEntry): Promise<PreparedZipEntry> {
    const [source, stat] = await Promise.all([
        fs.promises.readFile(entry.diskPath),
        fs.promises.stat(entry.diskPath),
    ]);
    if (source.length > MAX_ZIP32) {
        throw new Error(`ZIP entry exceeds 4 GiB: ${entry.archiveName}`);
    }

    // Files are read in small bounded batches. Raw zlib DEFLATE produces a
    // conventional ZIP stream while keeping compression work bounded.
    const compressed = deflateRawSync(source, { level: 9 });
    const useDeflate = compressed.length < source.length;
    const data = useDeflate ? compressed : source;
    const nameBytes = Buffer.from(entry.archiveName, 'utf8');
    if (nameBytes.length > MAX_ZIP16) {
        throw new Error(`ZIP entry name exceeds 65535 bytes: ${entry.archiveName}`);
    }

    const utf8Flag = /^[\x00-\x7F]*$/.test(entry.archiveName) ? 0 : ZIP_FLAG_UTF8;
    const { dosTime, dosDate } = dosDateTime(stat.mtime);
    return {
        archiveName: entry.archiveName,
        nameBytes,
        data,
        crc: crc32(source),
        compressedSize: data.length,
        uncompressedSize: source.length,
        method: useDeflate ? ZIP_METHOD_DEFLATE : ZIP_METHOD_STORE,
        flags: utf8Flag | (useDeflate ? ZIP_FLAG_DEFLATE_MAXIMUM : 0),
        dosTime,
        dosDate,
    };
}

function localFileHeader(entry: PreparedZipEntry): Buffer {
    const header = Buffer.alloc(30 + entry.nameBytes.length);
    header.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.dosTime, 10);
    header.writeUInt16LE(entry.dosDate, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressedSize, 18);
    header.writeUInt32LE(entry.uncompressedSize, 22);
    header.writeUInt16LE(entry.nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    entry.nameBytes.copy(header, 30);
    return header;
}

function centralFileHeader(entry: CentralZipEntry): Buffer {
    const header = Buffer.alloc(46 + entry.nameBytes.length);
    header.writeUInt32LE(ZIP_CENTRAL_FILE_HEADER, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.dosTime, 12);
    header.writeUInt16LE(entry.dosDate, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressedSize, 20);
    header.writeUInt32LE(entry.uncompressedSize, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.localHeaderOffset, 42);
    entry.nameBytes.copy(header, 46);
    return header;
}

function endOfCentralDirectory(entryCount: number, directorySize: number, directoryOffset: number): Buffer {
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
    footer.writeUInt16LE(0, 4);
    footer.writeUInt16LE(0, 6);
    footer.writeUInt16LE(entryCount, 8);
    footer.writeUInt16LE(entryCount, 10);
    footer.writeUInt32LE(directorySize, 12);
    footer.writeUInt32LE(directoryOffset, 16);
    footer.writeUInt16LE(0, 20);
    return footer;
}

async function writeAt(
    output: fs.promises.FileHandle,
    data: Uint8Array,
    position: number
): Promise<number> {
    let written = 0;
    while (written < data.length) {
        const result = await output.write(data, written, data.length - written, position + written);
        if (result.bytesWritten === 0) {
            throw new Error('Failed to make progress while writing PK3');
        }
        written += result.bytesWritten;
    }
    return position + written;
}

async function writeCompatibleZip(
    fileEntries: readonly FileEntry[],
    outPath: string,
    onProgress?: (message: string) => void
): Promise<void> {
    if (fileEntries.length > MAX_ZIP16) {
        throw new Error(`PK3 has ${fileEntries.length} files; Zandronum supports at most 65535`);
    }

    const sortedEntries = [...fileEntries].sort((a, b) =>
        a.archiveName < b.archiveName ? -1 : a.archiveName > b.archiveName ? 1 : 0
    );
    const centralEntries: CentralZipEntry[] = [];
    const output = await fs.promises.open(outPath, 'w');
    let position = 0;

    try {
        for (let i = 0; i < sortedEntries.length; i += MAX_CONCURRENT_PREPARES) {
            const batch = sortedEntries.slice(i, i + MAX_CONCURRENT_PREPARES);
            const prepared = await Promise.all(batch.map(prepareZipEntry));
            for (const entry of prepared) {
                const header = localFileHeader(entry);
                const nextPosition = position + header.length + entry.data.length;
                if (nextPosition > MAX_ZIP32) {
                    throw new Error('PK3 exceeds the 4 GiB limit supported by Zandronum');
                }
                const { data: _data, ...metadata } = entry;
                centralEntries.push({ ...metadata, localHeaderOffset: position });
                position = await writeAt(output, header, position);
                position = await writeAt(output, entry.data, position);
            }
            onProgress?.(`${Math.min(i + batch.length, sortedEntries.length)}/${sortedEntries.length} files`);
        }

        const directoryOffset = position;
        for (const entry of centralEntries) {
            position = await writeAt(output, centralFileHeader(entry), position);
        }
        const directorySize = position - directoryOffset;
        if (position + 22 > MAX_ZIP32) {
            throw new Error('PK3 central directory exceeds the 4 GiB limit supported by Zandronum');
        }
        await writeAt(
            output,
            endOfCentralDirectory(centralEntries.length, directorySize, directoryOffset),
            position
        );
    } finally {
        await output.close();
    }
}
