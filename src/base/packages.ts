import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { unzip } from 'fflate';
import { PackageEntry, PackageSource } from './types';
import { getPk3Root } from '../shared/pk3Root';

/** Normalize archive/entry paths to forward-slash, no leading slash. */
export function normalizeEntryPath(entryPath: string): string {
    return entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function findEntryKey(map: Map<string, Uint8Array>, entryPath: string): string | undefined {
    const normalized = normalizeEntryPath(entryPath);
    if (map.has(normalized)) {
        return normalized;
    }
    const lower = normalized.toLowerCase();
    for (const key of map.keys()) {
        if (key.toLowerCase() === lower) {
            return key;
        }
    }
    return undefined;
}

function shouldExtractZipEntry(entryPath: string): boolean {
    const normalized = normalizeEntryPath(entryPath);
    const name = normalized.split('/').pop() ?? '';
    if (!name) { return false; }
    // ZDoom/Zandronum often use DECORATE.txt and actor defs in .txt lumps.
    if (/^(DECORATE|SCRIPTS|SNDINFO|TEXTURES|LANGUAGE|LOADACS)(\.txt)?$/i.test(name)) { return true; }
    return /\.(dec|decorate|acs|lm|txt)$/i.test(name);
}

export class BuiltinPackage implements PackageSource {
    readonly priority: number;
    readonly label = 'builtin';

    constructor(
        readonly id: string,
        priority: number,
        private readonly extensionPath: string
    ) {
        this.priority = priority;
    }

    async getEntries(): Promise<PackageEntry[]> {
        const dataDir = path.join(this.extensionPath, 'data');
        const dirs = ['decorate', 'acs', 'sndinfo', 'textures'];
        const entries: PackageEntry[] = [];
        for (const dir of dirs) {
            const dirPath = path.join(dataDir, dir);
            if (!fs.existsSync(dirPath)) { continue; }
            const files = await fs.promises.readdir(dirPath);
            for (const file of files) {
                const fp = path.join(dirPath, file);
                const stat = await fs.promises.stat(fp);
                entries.push({
                    path: `${dir}/${file}`,
                    size: stat.size
                });
            }
        }
        return entries;
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const fp = path.join(this.extensionPath, 'data', entryPath);
        return fs.promises.readFile(fp);
    }
}

export class WorkspacePackage implements PackageSource {
    readonly id = 'workspace';
    readonly label = 'workspace';
    readonly priority: number;

    constructor(priority: number) {
        this.priority = priority;
    }

    async getEntries(): Promise<PackageEntry[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return []; }

        // Only index the PK3 content root — not the rest of the workspace.
        // Base resources are loaded separately via PackageManager.
        const pk3RootUri = vscode.Uri.joinPath(workspaceFolders[0].uri, getPk3Root());
        const pattern = new vscode.RelativePattern(
            pk3RootUri,
            `**/{DECORATE,DECORATE.txt,*.dec,*.decorate,*.acs,SCRIPTS,SNDINFO,TEXTURES,LANGUAGE,*.lm}`
        );
        const uris = await vscode.workspace.findFiles(pattern);
        return uris.map(uri => ({
            path: normalizeEntryPath(vscode.workspace.asRelativePath(uri)),
            size: 0
        }));
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { throw new Error('No workspace'); }
        const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, entryPath);
        return vscode.workspace.fs.readFile(uri);
    }
}

export class FolderPackage implements PackageSource {
    readonly priority: number;
    readonly label: string;

    constructor(
        readonly id: string,
        priority: number,
        private readonly rootPath: string
    ) {
        this.priority = priority;
        this.label = path.basename(rootPath) || rootPath;
    }

    getRootPath(): string {
        return this.rootPath;
    }

    async getEntries(): Promise<PackageEntry[]> {
        return this.walkDir(this.rootPath, this.rootPath);
    }

    private async walkDir(dir: string, base: string): Promise<PackageEntry[]> {
        if (!fs.existsSync(dir)) { return []; }
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        const result: PackageEntry[][] = await Promise.all(
            entries.map(async (e): Promise<PackageEntry[]> => {
                const fullPath = path.join(dir, e.name);
                if (e.isDirectory()) {
                    return this.walkDir(fullPath, base);
                }
                const stat = await fs.promises.stat(fullPath);
                return [{
                    path: normalizeEntryPath(path.relative(base, fullPath)),
                    size: stat.size
                }];
            })
        );
        return result.flat();
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const fp = path.join(this.rootPath, normalizeEntryPath(entryPath));
        return fs.promises.readFile(fp);
    }
}

export class ZipPackage implements PackageSource {
    readonly priority: number;
    readonly label: string;
    private rawData: Uint8Array | undefined;
    private entryMap: Map<string, Uint8Array> | undefined;
    private loadError: string | undefined;

    constructor(
        readonly id: string,
        priority: number,
        private readonly filePath: string
    ) {
        this.priority = priority;
        this.label = path.basename(filePath);
    }

    getFilePath(): string {
        return this.filePath;
    }

    getLoadError(): string | undefined {
        return this.loadError;
    }

    private async ensureEntryMap(): Promise<Map<string, Uint8Array>> {
        if (this.entryMap) {
            return this.entryMap;
        }
        if (!fs.existsSync(this.filePath)) {
            this.loadError = `File not found: ${this.filePath}`;
            this.entryMap = new Map();
            return this.entryMap;
        }

        if (!this.rawData) {
            this.rawData = await fs.promises.readFile(this.filePath);
        }

        const buf = this.rawData;
        this.entryMap = await new Promise<Map<string, Uint8Array>>((resolve) => {
            unzip(buf, {
                filter: (file) => shouldExtractZipEntry(file.name)
            }, (err, data) => {
                const map = new Map<string, Uint8Array>();
                if (err) {
                    this.loadError = `Failed to read PK3/ZIP (${this.label}): ${err.message}`;
                    resolve(map);
                    return;
                }
                for (const [p, d] of Object.entries(data)) {
                    const key = normalizeEntryPath(p);
                    if (!key || key.endsWith('/')) { continue; }
                    map.set(key, d);
                }
                resolve(map);
            });
        });

        return this.entryMap;
    }

    async getEntries(): Promise<PackageEntry[]> {
        const map = await this.ensureEntryMap();
        const entries: PackageEntry[] = [];
        for (const [p, d] of map) {
            entries.push({ path: p, size: d.length });
        }
        return entries;
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const map = await this.ensureEntryMap();
        const key = findEntryKey(map, entryPath);
        if (!key) {
            return new Uint8Array();
        }
        return map.get(key)!;
    }

    /** Invalidate cached unzip (e.g. after file watcher fires). */
    invalidate(): void {
        this.rawData = undefined;
        this.entryMap = undefined;
        this.loadError = undefined;
    }
}
