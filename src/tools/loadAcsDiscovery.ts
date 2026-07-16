import * as fs from 'fs';
import * as path from 'path';
import { PackageSource } from '../base/types';
import { FolderPackage, normalizeEntryPath } from '../base/packages';
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
    return /^loadacs(\.txt)?$/i.test(name);
}

function readWorkspaceLoadAcs(workspaceRoot: string): string[] {
    const dir = path.join(workspaceRoot, getPk3Root());
    if (!fs.existsSync(dir)) {
        return [];
    }
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !isLoadAcsFileName(entry.name)) { continue; }
            return parseLoadAcsText(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
        }
    } catch {
        return [];
    }
    return [];
}

async function findLoadAcsInFolder(rootPath: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.isFile()) { continue; }
        if (!isLoadAcsFileName(entry.name)) { continue; }
        try {
            const content = await fs.promises.readFile(path.join(rootPath, entry.name), 'utf-8');
            return parseLoadAcsText(content);
        } catch {
            return [];
        }
    }
    return [];
}

function isRootLoadAcsPath(entryPath: string): boolean {
    const p = normalizeEntryPath(entryPath);
    const parts = p.split('/');
    return parts.length === 1 && isLoadAcsFileName(parts[0]);
}

/**
 * Read LOADACS entries from a base resource package (folder or zip).
 * Skips builtin/workspace. Looks for a root-level `loadacs` / `loadacs.txt` lump.
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
        const candidate = entries.find(e => isRootLoadAcsPath(e.path));
        if (!candidate) { return []; }
        const bytes = await pkg.openEntry(candidate.path);
        if (bytes.length === 0) { return []; }
        return parseLoadAcsText(Buffer.from(bytes).toString('utf-8'));
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
