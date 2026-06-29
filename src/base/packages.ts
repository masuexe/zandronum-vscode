import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { unzip } from 'fflate';
import { PackageEntry, PackageSource } from './types';

export class BuiltinPackage implements PackageSource {
    readonly priority: number;

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
    readonly priority: number;

    constructor(priority: number) {
        this.priority = priority;
    }

    async getEntries(): Promise<PackageEntry[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return []; }

        const pattern = new vscode.RelativePattern(
            workspaceFolders[0],
            `**/{DECORATE,*.dec,*.decorate,*.acs,SCRIPTS,SNDINFO,TEXTURES,LANGUAGE,*.lm}`
        );
        const uris = await vscode.workspace.findFiles(pattern);
        return uris.map(uri => ({
            path: vscode.workspace.asRelativePath(uri),
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

    constructor(
        readonly id: string,
        priority: number,
        private readonly rootPath: string
    ) {
        this.priority = priority;
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
                    path: path.relative(base, fullPath).replace(/\\/g, '/'),
                    size: stat.size
                }];
            })
        );
        return result.flat();
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const fp = path.join(this.rootPath, entryPath);
        return fs.promises.readFile(fp);
    }
}

export class ZipPackage implements PackageSource {
    readonly priority: number;
    private data: Uint8Array | undefined;

    constructor(
        readonly id: string,
        priority: number,
        private readonly filePath: string
    ) {
        this.priority = priority;
    }

    private async load(): Promise<Uint8Array> {
        if (!this.data) {
            this.data = await fs.promises.readFile(this.filePath);
        }
        return this.data;
    }

    async getEntries(): Promise<PackageEntry[]> {
        if (!fs.existsSync(this.filePath)) { return []; }
        const buf = await this.load();
        return new Promise((resolve) => {
            unzip(buf, (err, data) => {
                if (err) { resolve([]); return; }
                const entries: PackageEntry[] = [];
                for (const [p, d] of Object.entries(data)) {
                    entries.push({ path: p, size: d.length });
                }
                resolve(entries);
            });
        });
    }

    async openEntry(entryPath: string): Promise<Uint8Array> {
        const buf = await this.load();
        return new Promise((resolve) => {
            unzip(buf, (err, data) => {
                if (err || !data[entryPath]) {
                    resolve(new Uint8Array());
                    return;
                }
                resolve(data[entryPath]);
            });
        });
    }
}
