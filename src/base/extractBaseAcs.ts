import * as fs from 'fs';
import * as path from 'path';
import { PackageSource } from './types';
import { FolderPackage, ZipPackage, normalizeEntryPath } from './packages';
import { sanitizeDirName } from './packageManager';

function isAcsEntry(entryPath: string): boolean {
    const name = entryPath.split('/').pop() ?? '';
    return /\.acs$/i.test(name) || /^(SCRIPTS|ACS)$/i.test(name);
}

/**
 * Extract ACS sources from ZipPackage base resources into extension storage
 * so ACC and IncludeResolver can use real filesystem paths.
 * FolderPackage roots are returned as-is (no copy).
 */
export async function extractBaseAcsSources(
    packages: readonly PackageSource[],
    extractRoot: string
): Promise<string[]> {
    await fs.promises.mkdir(extractRoot, { recursive: true });
    const includeDirs: string[] = [];

    for (const pkg of packages) {
        if (pkg.id === 'builtin' || pkg.id === 'workspace') { continue; }

        if (pkg instanceof FolderPackage) {
            includeDirs.push(pkg.getRootPath());
            continue;
        }

        if (!(pkg instanceof ZipPackage)) { continue; }

        const destRoot = path.join(extractRoot, sanitizeDirName(pkg.id));
        await fs.promises.rm(destRoot, { recursive: true, force: true });
        await fs.promises.mkdir(destRoot, { recursive: true });

        const entries = await pkg.getEntries();
        let wroteAny = false;
        for (const entry of entries) {
            if (!isAcsEntry(entry.path)) { continue; }
            const content = await pkg.openEntry(entry.path);
            if (content.length === 0) { continue; }
            const outPath = path.join(destRoot, ...normalizeEntryPath(entry.path).split('/'));
            await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
            await fs.promises.writeFile(outPath, content);
            wroteAny = true;
        }

        if (wroteAny) {
            includeDirs.push(destRoot);
        }
    }

    return includeDirs;
}
