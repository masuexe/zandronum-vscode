import * as fs from 'fs';
import * as path from 'path';

/**
 * ACC `MAX_INCLUDE_PATHS` is 16; slot 0 is reserved for the file being parsed.
 * Extra `-i` paths beyond this are silently dropped (acc-branch-zandronum).
 */
export const ACC_MAX_CLI_INCLUDE_PATHS = 15;

const ACC_BUILTIN_INCLUDES = new Set([
    'zcommon.acs',
    'zdefs.acs',
    'zspecial.acs',
    'zwvars.acs',
]);

export interface BuildAccIncludePathsOptions {
    srcFile: string;
    accDir: string | null;
    /** Roots to recursively search for #include / #import targets (e.g. acs_source). */
    searchRoots: readonly string[];
    userIncludePaths?: readonly string[];
    maxCliPaths?: number;
}

export interface BuildAccIncludePathsResult {
    paths: string[];
    /** Needed dirs that did not fit in the ACC `-i` budget. */
    truncated: string[];
}

function collectBasenameMatches(root: string, targetBaseLower: string, out: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectBasenameMatches(full, targetBaseLower, out);
        } else if (entry.isFile() && entry.name.toLowerCase() === targetBaseLower) {
            out.push(path.resolve(full));
        }
    }
}

/**
 * Find an include/import target under search roots (earlier roots win).
 *
 * Match order (ACC on Linux is case-sensitive for the #include string):
 * 1. Exact relative path under each root
 * 2. Exact-case basename under each root (earlier root first)
 * 3. Case-insensitive basename under each root (fallback only)
 *
 * Callers should put workspace `acs_source` before base-resource extract dirs
 * so local overrides win over PK3 copies (often `DTADD.acs` vs `dtadd.acs`).
 */
export function findAcsIncludeFile(
    includeName: string,
    searchRoots: readonly string[]
): string | null {
    const base = path.basename(includeName);
    if (ACC_BUILTIN_INCLUDES.has(base.toLowerCase())) {
        return null;
    }
    const baseLower = base.toLowerCase();
    const roots = searchRoots.filter(root => Boolean(root) && fs.existsSync(root));

    for (const root of roots) {
        const direct = path.resolve(root, includeName);
        try {
            if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
                return direct;
            }
        } catch { /* ignore */ }
    }

    for (const root of roots) {
        const matches: string[] = [];
        collectBasenameMatches(root, baseLower, matches);
        const exactCase = matches.filter(m => path.basename(m) === base);
        if (exactCase.length > 0) {
            exactCase.sort((a, b) => a.localeCompare(b));
            return exactCase[0];
        }
    }

    for (const root of roots) {
        const matches: string[] = [];
        collectBasenameMatches(root, baseLower, matches);
        if (matches.length > 0) {
            matches.sort((a, b) => a.localeCompare(b));
            return matches[0];
        }
    }

    return null;
}

export function listDirectIncludeAndImportNames(filePath: string): string[] {
    try {
        const text = fs.readFileSync(filePath, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        const names: string[] = [];
        const re = /^\s*#\s*(?:include|import)\s+"([^"]+)"/gim;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            names.push(m[1]);
        }
        return names;
    } catch {
        return [];
    }
}

/**
 * Walk entry + transitive #include/#import and collect directories ACC must see
 * via `-i` (ACC does not recurse into subdirectories of an include path).
 */
export function collectNeededIncludeDirs(
    entryFile: string,
    searchRoots: readonly string[]
): string[] {
    const dirs: string[] = [];
    const seenDir = new Set<string>();
    const visitedFile = new Set<string>();
    const stack: string[] = [path.resolve(entryFile)];

    const addDir = (dir: string) => {
        const key = path.resolve(dir);
        const lower = key.toLowerCase();
        if (seenDir.has(lower)) { return; }
        seenDir.add(lower);
        dirs.push(key);
    };

    while (stack.length > 0) {
        const file = stack.pop()!;
        const fileKey = file.toLowerCase();
        if (visitedFile.has(fileKey)) { continue; }
        visitedFile.add(fileKey);

        addDir(path.dirname(file));

        for (const name of listDirectIncludeAndImportNames(file)) {
            const resolved = findAcsIncludeFile(name, searchRoots);
            if (resolved) {
                stack.push(resolved);
            }
        }
    }

    return dirs;
}

/**
 * Build the `-i` list for one ACC invocation, capped at ACC's hard limit.
 * Prefer ACC dir + source dir + dirs of transitively resolved includes over
 * dumping every subdirectory (which silently overflows MAX_INCLUDE_PATHS).
 */
export function buildAccIncludePaths(
    options: BuildAccIncludePathsOptions
): BuildAccIncludePathsResult {
    const maxCli = options.maxCliPaths ?? ACC_MAX_CLI_INCLUDE_PATHS;
    const ordered: string[] = [];
    const seen = new Set<string>();

    const push = (dir: string | null | undefined): void => {
        if (!dir) { return; }
        const key = path.resolve(dir);
        const lower = key.toLowerCase();
        if (seen.has(lower)) { return; }
        seen.add(lower);
        ordered.push(key);
    };

    push(options.accDir);
    push(path.dirname(options.srcFile));

    for (const d of collectNeededIncludeDirs(options.srcFile, options.searchRoots)) {
        push(d);
    }

    // User paths fill remaining slots after required/resolved dirs.
    for (const p of options.userIncludePaths ?? []) {
        push(p);
    }

    if (ordered.length <= maxCli) {
        return { paths: ordered, truncated: [] };
    }
    return {
        paths: ordered.slice(0, maxCli),
        truncated: ordered.slice(maxCli),
    };
}
