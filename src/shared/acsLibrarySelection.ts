import * as fs from 'fs';
import * as path from 'path';
import { findAcsIncludeFile } from '../tools/accIncludePaths';

/** Strip ACS block and line comments. */
export function stripAcsComments(text: string): string {
    return text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
        token => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '));
}

/** Declared runtime library name, preserving its spelling. */
export function getAcsLibraryName(filePath: string): string | null {
    try {
        const text = stripAcsComments(fs.readFileSync(filePath, 'utf-8'));
        return /^\s*#\s*library\s+"([^"\r\n]+)"/im.exec(text)?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * True when a name can be used as an ACS object lump name.
 *
 * Dots are allowed: the engine strips the last extension and keeps the first 8
 * characters, so `UICOMMON.acs.o` is the `UICOMMON` lump. MM8BDM declares
 * `#library "UICOMMON.acs"` for that reason. Path separators and characters
 * that Windows rejects in file names are not allowed.
 */
export function isValidAcsLumpName(name: string): boolean {
    return name.length > 0
        && !name.startsWith('.')
        && !/[\\/:*?"<>|\s]/.test(name);
}

/** Default import-compatible output name; LOADACS builds carry their requested lump name. */
export function getAcsObjectFileName(filePath: string): string {
    const name = getAcsLibraryName(filePath) ?? path.basename(filePath, path.extname(filePath));
    return `${name}.o`;
}

/**
 * True when a file declares a `#library` directive.
 *
 * The whole file is read: library sources may start with a long license
 * header, so a fixed-size window can miss the directive (e.g. an ACSUtils
 * header pushes `#library "uh_acsutils"` past the first kilobyte).
 */
export function hasLibraryDirective(filePath: string): boolean {
    try {
        return /^\s*#\s*library\b/im.test(stripAcsComments(fs.readFileSync(filePath, 'utf-8')));
    } catch {
        return false;
    }
}

/** Basenames (no extension, lowercased) of the `#import` targets in a file. */
export function listImportedAcsLibraries(filePath: string): string[] {
    let text: string;
    try {
        text = stripAcsComments(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return [];
    }

    const names: string[] = [];
    const re = /^\s*#\s*import\s+"([^"]+)"/gim;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        names.push(path.basename(match[1]).replace(/\.[^.]+$/, '').toLowerCase());
    }
    return names;
}

export interface AcsCompileTarget {
    sourceFile: string;
    objectFileName: string;
}

/**
 * Matcher for `zandronum-vscode.acsLibraryExcludes`. Entries may name an
 * acs_source-relative path, a file name, or a declared `#library` name.
 */
function buildExcludeMatcher(sourceDir: string, excludes: readonly string[]): (file: string) => boolean {
    const wanted = new Set<string>();
    for (const entry of excludes) {
        const key = entry.trim().replace(/\\/g, '/').toLowerCase();
        if (key) { wanted.add(key); }
    }
    if (wanted.size === 0) {
        return () => false;
    }
    const root = path.resolve(sourceDir);
    return (file: string): boolean => {
        const relative = path.relative(root, file).replace(/\\/g, '/').toLowerCase();
        if (wanted.has(relative) || wanted.has(path.basename(file).toLowerCase())) {
            return true;
        }
        const declared = getAcsLibraryName(file);
        if (declared !== null) {
            const lower = declared.toLowerCase();
            if (wanted.has(lower) || wanted.has(lower.slice(0, 8))) {
                return true;
            }
        }
        return false;
    };
}

/**
 * LOADACS uses its entry name; imports use the imported #library declaration.
 * `excludes` lists interface-only sources that the base package already provides,
 * so they must not be compiled or packed.
 */
export function selectLibraryAcsTargets(
    sourceDir: string,
    loadAcsEntries: readonly string[],
    outputMappings: Readonly<Record<string, string>> = {},
    excludes: readonly string[] = []
): AcsCompileTarget[] {
    const candidates = new Map<string, string[]>();
    const collect = (dir: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
            const full = path.resolve(dir, entry.name);
            if (entry.isDirectory()) { collect(full); }
            else if (entry.isFile() && hasLibraryDirective(full)) {
                const base = path.basename(full, path.extname(full));
                for (const name of new Set([base, getAcsLibraryName(full) ?? base])) {
                    const key = name.slice(0, 8).toLowerCase();
                    const list = candidates.get(key) ?? [];
                    list.push(full);
                    candidates.set(key, list);
                }
            }
        }
    };
    collect(sourceDir);

    const targets: AcsCompileTarget[] = [];
    const outputs = new Map<string, string>();
    const dependencies = new Set<string>();
    const isExcluded = buildExcludeMatcher(sourceDir, excludes);
    const add = (sourceFile: string, name: string): void => {
        if (isExcluded(sourceFile)) {
            return;
        }
        // A mapping is a lump name, never a filesystem path.
        if (!isValidAcsLumpName(name)) {
            throw new Error(`Invalid ACS output lump name: ${name}`);
        }
        const objectFileName = `${name}.o`;
        const key = name.slice(0, 8).toLowerCase();
        const previous = outputs.get(key);
        if (previous && previous !== sourceFile) {
            throw new Error(`ACS output collision for ${name}: ${previous} and ${sourceFile}`);
        }
        if (previous) { return; }
        outputs.set(key, sourceFile);
        targets.push({ sourceFile, objectFileName });
    };
    for (const name of loadAcsEntries) {
        for (const file of candidates.get(name.slice(0, 8).toLowerCase()) ?? []) {
            add(file, name);
        }
    }
    for (const [relativeSource, name] of Object.entries(outputMappings)) {
        const file = path.resolve(sourceDir, relativeSource);
        const relative = path.relative(path.resolve(sourceDir), file);
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)
            || !hasLibraryDirective(file)) {
            throw new Error(`ACS output mapping must reference a #library source under acs_source: ${relativeSource}`);
        }
        add(file, name);
    }

    // Follow includes too: an included header can introduce imports.
    const visit = (file: string): void => {
        if (dependencies.has(file)) { return; }
        dependencies.add(file);
        let text: string;
        try { text = stripAcsComments(fs.readFileSync(file, 'utf8')); }
        catch { return; }
        const re = /^\s*#\s*(include|import)\s+"([^"\r\n]+)"/gim;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const dependency = findAcsIncludeFile(match[2], [path.dirname(file), sourceDir]);
            if (!dependency) { continue; }
            const relative = path.relative(path.resolve(sourceDir), dependency);
            if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { continue; }
            if (match[1].toLowerCase() === 'import' && hasLibraryDirective(dependency)) {
                add(dependency, getAcsLibraryName(dependency)
                    ?? path.basename(dependency, path.extname(dependency)));
            }
            visit(dependency);
        }
    };
    for (const target of targets) { visit(target.sourceFile); }
    return targets;
}

/** Compatibility helper for callers interested only in selected sources. */
export function selectLibraryAcsFiles(sourceDir: string, loadAcsEntries: readonly string[]): string[] {
    return [...new Set(selectLibraryAcsTargets(sourceDir, loadAcsEntries).map(t => t.sourceFile))];
}
