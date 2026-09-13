import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { expandUserPath } from '../shared/variables';
import { getPk3Root } from '../shared/pk3Root';
import { PackageSource } from '../base/types';

export interface RgbColor {
    r: number;
    g: number;
    b: number;
}

let paletteCache: RgbColor[] | null | undefined;
let cacheKey: string | undefined;

/** Live PackageManager package list; supplied during extension activation. */
let packageProvider: (() => readonly PackageSource[]) | undefined;

export function setPlaypalPackageProvider(
    provider: (() => readonly PackageSource[]) | undefined
): void {
    packageProvider = provider;
}

/**
 * Engine lump rule: strip the last extension, uppercase, compare the first 8
 * characters. Accepts PLAYPAL, PLAYPAL.lmp, PLAYPAL.txt, any casing.
 */
export function isPlaypalLumpName(fileName: string): boolean {
    const base = fileName.includes('.') ? fileName.slice(0, fileName.lastIndexOf('.')) : fileName;
    return base.slice(0, 8).toUpperCase() === 'PLAYPAL';
}

/** Root-directory/global entries only — never a nested subdir/PLAYPAL. */
export function pickPlaypalEntryPath(entryPaths: readonly string[]): string | undefined {
    return entryPaths.find(p => !p.includes('/') && isPlaypalLumpName(p));
}

/** First 768 bytes = palette 0; anything shorter is not a usable palette. */
export function parsePlaypalBytes(data: Uint8Array): RgbColor[] | null {
    if (data.length < 768) { return null; }
    const palette: RgbColor[] = [];
    for (let i = 0; i < 256; i++) {
        palette.push({
            r: data[i * 3],
            g: data[i * 3 + 1],
            b: data[i * 3 + 2]
        });
    }
    return palette;
}

export interface PlaypalResolutionOptions {
    /** Explicit zandronum-vscode.playpalPath override (file, or dir holding PLAYPAL*). */
    playpalPath?: string;
    /** Workspace root used to resolve a relative playpalPath. */
    workspaceRoot?: string;
    /** Workspace <pk3Root> directory scanned for a root-level PLAYPAL*. */
    workspacePk3RootDir?: string;
    /** Effective packages in PackageManager order; workspace is handled separately. */
    packages?: readonly PackageSource[];
}

/**
 * Resolution order: explicit playpalPath override, workspace <pk3Root> root,
 * then base resources later-loaded → earlier-loaded (highest priority first).
 */
export async function resolvePlaypal(
    options: PlaypalResolutionOptions = {}
): Promise<RgbColor[] | null> {
    if (options.playpalPath) {
        const palette = readExplicitPlaypal(options.playpalPath, options.workspaceRoot ?? '');
        if (palette) { return palette; }
    }

    if (options.workspacePk3RootDir) {
        const palette = readRootPlaypalFromDir(options.workspacePk3RootDir);
        if (palette) { return palette; }
    }

    if (options.packages && options.packages.length > 0) {
        const ordered = [...options.packages].sort((a, b) => b.priority - a.priority);
        for (const pkg of ordered) {
            // 'builtin' has no palette lumps; 'workspace' is covered by the <pk3Root> scan.
            if (pkg.id === 'builtin' || pkg.id === 'workspace') { continue; }
            try {
                const entries = await pkg.getEntries();
                const entryPath = pickPlaypalEntryPath(entries.map(e => e.path));
                if (!entryPath) { continue; }
                const palette = parsePlaypalBytes(await pkg.openEntry(entryPath));
                if (palette) { return palette; }
            } catch { /* skip unreadable package */ }
        }
    }

    return null;
}

/**
 * Cache key: explicit path + workspace <pk3Root> + package set/order. Rebuilding
 * the package list (changed baseResources) produces a different key, so both a
 * cached palette and a cached null from the previous package set are dropped.
 */
export function playpalCacheSignature(
    playpalPath: string,
    workspacePk3RootDir: string,
    packages: readonly PackageSource[]
): string {
    return [
        playpalPath,
        workspacePk3RootDir,
        packages.map(p => `${p.priority}:${p.id}`).join('|')
    ].join('\u0000');
}

export async function loadPlaypal(): Promise<RgbColor[] | null> {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const playpalPath = config.get<string>('playpalPath') || '';
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const pk3RootDir = workspaceRoot ? path.join(workspaceRoot, getPk3Root()) : '';
    const packages = packageProvider?.() ?? [];

    const key = playpalCacheSignature(playpalPath, pk3RootDir, packages);
    if (paletteCache !== undefined && cacheKey === key) {
        return paletteCache;
    }
    cacheKey = key;

    const palette = await resolvePlaypal({
        playpalPath: playpalPath || undefined,
        workspaceRoot,
        workspacePk3RootDir: pk3RootDir || undefined,
        packages
    });
    paletteCache = palette;
    return palette;
}

function readExplicitPlaypal(playpalPath: string, workspaceRoot: string): RgbColor[] | null {
    const expanded = expandUserPath(playpalPath);
    const resolved = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(workspaceRoot, expanded);

    try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
            return parsePlaypalBytes(new Uint8Array(fs.readFileSync(resolved)));
        }
        if (stat.isDirectory()) {
            return readRootPlaypalFromDir(resolved);
        }
    } catch { /* fall through to package lookup */ }
    return null;
}

function readRootPlaypalFromDir(dir: string): RgbColor[] | null {
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return null;
    }
    const matches = names.filter(isPlaypalLumpName).sort();
    for (const name of matches) {
        const fp = path.join(dir, name);
        try {
            if (!fs.statSync(fp).isFile()) { continue; }
            const palette = parsePlaypalBytes(new Uint8Array(fs.readFileSync(fp)));
            if (palette) { return palette; }
        } catch { /* try next candidate */ }
    }
    return null;
}
