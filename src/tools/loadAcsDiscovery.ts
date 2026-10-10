import * as fs from 'fs';
import * as path from 'path';
import { PackageSource } from '../base/types';
import { FolderPackage, ZipPackage, normalizeEntryPath } from '../base/packages';
import { getPk3Root } from '../shared/pk3Root';

/** Parse LOADACS text: one library name per line, strip comments. */
export function parseLoadAcsText(content: string): string[] {
    const libraries: string[] = [];

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) {
            continue;
        }
        const commentIdx = trimmed.indexOf('//');
        const name = (commentIdx >= 0 ? trimmed.substring(0, commentIdx) : trimmed).trim();
        if (name.length > 0) {
            libraries.push(name);
        }
    }

    return libraries;
}

function isLoadAcsFileName(name: string): boolean {
    // Engine strips the last extension, then compares the ≤8-char lump name.
    const base = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    return base.slice(0, 8).toLowerCase() === 'loadacs';
}

function readWorkspaceLoadAcs(workspaceRoot: string): string[] {
    const dir = path.join(workspaceRoot, getPk3Root());
    if (!fs.existsSync(dir)) {
        return [];
    }
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const names: string[] = [];
        for (const entry of entries) {
            if (!entry.isFile() || !isLoadAcsFileName(entry.name)) { continue; }
            names.push(...parseLoadAcsText(fs.readFileSync(path.join(dir, entry.name), 'utf-8')));
        }
        return names;
    } catch {
        return [];
    }
}

async function findLoadAcsInFolder(rootPath: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
    } catch {
        return [];
    }

    const names: string[] = [];
    for (const entry of entries) {
        if (!entry.isFile()) { continue; }
        if (!isLoadAcsFileName(entry.name)) { continue; }
        try {
            const content = await fs.promises.readFile(path.join(rootPath, entry.name), 'utf-8');
            names.push(...parseLoadAcsText(content));
        } catch {
            continue;
        }
    }
    return names;
}

function isRootLoadAcsPath(entryPath: string): boolean {
    const p = normalizeEntryPath(entryPath);
    const parts = p.split('/');
    return parts.length === 1 && isLoadAcsFileName(parts[0]);
}

/**
 * Read LOADACS entries from a base resource package (folder or zip).
 * Skips builtin/workspace. Looks for a root-level LOADACS lump (any extension; engine strips it).
 */
export async function readLoadAcsFromPackage(pkg: PackageSource): Promise<string[]> {
    if (pkg.id === 'builtin' || pkg.id === 'workspace') {
        return [];
    }

    if (pkg instanceof FolderPackage) {
        return findLoadAcsInFolder(pkg.getRootPath());
    }

    try {
        const entries = await pkg.getEntries();
        const names: string[] = [];
        for (const entry of entries) {
            if (!isRootLoadAcsPath(entry.path)) { continue; }
            const bytes = await pkg.openEntry(entry.path);
            names.push(...parseLoadAcsText(Buffer.from(bytes).toString('utf-8')));
        }
        return names;
    } catch {
        return [];
    }
}

/**
 * Merge workspace LOADACS with base-resource LOADACS (workspace first, case-insensitive dedupe).
 */
export async function collectLoadAcsEntries(
    workspaceRoot: string,
    basePackages: readonly PackageSource[]
): Promise<string[]> {
    const result: string[] = [];
    const seen = new Set<string>();

    function append(names: string[]) {
        for (const name of names) {
            const key = name.toLowerCase();
            if (seen.has(key)) { continue; }
            seen.add(key);
            result.push(name);
        }
    }

    append(readWorkspaceLoadAcs(workspaceRoot));

    const packages = [...basePackages].sort((a, b) => a.priority - b.priority);
    for (const pkg of packages) {
        if (pkg.id === 'builtin' || pkg.id === 'workspace') { continue; }
        append(await readLoadAcsFromPackage(pkg));
    }

    return result;
}

/** Read launch resources without adding them to the editor's base-resource index. */
export async function readLaunchLoadAcsEntries(resources: readonly string[]): Promise<string[]> {
    const names: string[] = [];
    for (const resource of resources) {
        const stat = await fs.promises.stat(resource);
        if (stat.isDirectory()) {
            names.push(...await findLoadAcsInFolder(resource));
        } else if (/\.(pk3|zip)$/i.test(resource)) {
            const pkg = new ZipPackage(resource, 0, resource);
            names.push(...await readLoadAcsFromPackage(pkg));
            if (pkg.getLoadError()) { throw new Error(pkg.getLoadError()); }
        } else if (/\.wad$/i.test(resource)) {
            // WAD LOADACS lives in the global namespace. Read only directory + matching lumps.
            const file = await fs.promises.open(resource, 'r');
            try {
                const header = Buffer.alloc(12);
                await file.read(header, 0, 12, 0);
                const count = header.readInt32LE(4);
                const offset = header.readInt32LE(8);
                if (!/^[IP]WAD$/.test(header.toString('ascii', 0, 4))
                    || count < 0 || offset < 12 || offset + count * 16 > stat.size) {
                    throw new Error(`Invalid WAD directory: ${resource}`);
                }
                const directory = Buffer.alloc(count * 16);
                await file.read(directory, 0, directory.length, offset);
                for (let i = 0; i < count; i++) {
                    const entry = i * 16;
                    const name = directory.toString('ascii', entry + 8, entry + 16).replace(/\0.*$/, '');
                    if (name.toLowerCase() !== 'loadacs') { continue; }
                    const position = directory.readInt32LE(entry);
                    const size = directory.readInt32LE(entry + 4);
                    if (position < 0 || size < 0 || position + size > stat.size) {
                        throw new Error(`Invalid LOADACS lump: ${resource}`);
                    }
                    const content = Buffer.alloc(size);
                    await file.read(content, 0, size, position);
                    names.push(...parseLoadAcsText(content.toString('utf8')));
                }
            } finally { await file.close(); }
        } else if (/\.pk7$/i.test(resource)) {
            throw new Error(`LOADACS discovery from launch PK7 resources is not supported: ${resource}`);
        }
    }
    return names;
}
