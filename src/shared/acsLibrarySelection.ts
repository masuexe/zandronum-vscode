import * as fs from 'fs';
import * as path from 'path';

/** Strip ACS block and line comments. */
export function stripAcsComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
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
        return /#library\b/im.test(stripAcsComments(fs.readFileSync(filePath, 'utf-8')));
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

/**
 * Select the `#library` sources under `sourceDir` that the engine will need:
 * every LOADACS entry plus the libraries those entries `#import`, transitively.
 *
 * Imported libraries are resolved at runtime by lump name rather than through
 * LOADACS, so they must be compiled and packaged too. Omitting them leaves the
 * engine with unresolved imports and crashes when an imported function runs.
 */
export function selectLibraryAcsFiles(
    sourceDir: string,
    loadAcsEntries: readonly string[]
): string[] {
    const candidates = new Map<string, string[]>();

    const collect = (dir: string): void => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') { continue; }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                collect(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.acs')) {
                const base = path.basename(entry.name, '.acs').toLowerCase();
                const list = candidates.get(base);
                if (list) { list.push(full); } else { candidates.set(base, [full]); }
            }
        }
    };
    collect(sourceDir);

    const selected: string[] = [];
    const queued = new Set<string>();
    const queue: string[] = [];

    const enqueue = (name: string): void => {
        const key = name.trim().toLowerCase();
        if (!key || queued.has(key)) { return; }
        queued.add(key);
        queue.push(key);
    };
    for (const name of loadAcsEntries) { enqueue(name); }

    while (queue.length > 0) {
        const name = queue.shift() as string;
        for (const file of candidates.get(name) ?? []) {
            if (!hasLibraryDirective(file)) { continue; }
            selected.push(file);
            for (const imported of listImportedAcsLibraries(file)) { enqueue(imported); }
        }
    }

    return selected;
}
