import * as vscode from 'vscode';
import * as path from 'path';

export enum ResourceType {
    Png,
    Jpeg,
    DoomGraphic,
    Unknown
}

export interface ResourceMetadata {
    uri: vscode.Uri;
    type: ResourceType;
    priority: number;
    width?: number;
    height?: number;
}

function typeFromExtension(ext: string): ResourceType {
    switch (ext.toLowerCase()) {
        case '.png': return ResourceType.Png;
        case '.jpg': case '.jpeg': return ResourceType.Jpeg;
        default: return ResourceType.Unknown;
    }
}

function computePriority(uri: vscode.Uri): number {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const segments = rel.replace(/\\/g, '/').split('/');
    if (segments[0]?.toLowerCase() === 'src') { return 10; }
    return 0;
}

export class ResourceIndex {
    private index = new Map<string, ResourceMetadata[]>();
    private watcher: vscode.FileSystemWatcher | undefined;
    private buildPromise: Promise<void> | undefined;

    build(): void {
        this.buildPromise = this.doBuild();
    }

    async whenReady(): Promise<void> {
        if (this.buildPromise) { await this.buildPromise; }
    }

    resolve(type: string, name: string): ResourceMetadata | null {
        const entries = this.index.get(name.toLowerCase());
        if (!entries || entries.length === 0) { return null; }
        if (entries.length === 1) { return entries[0]; }
        return entries.reduce((best, cur) => cur.priority > best.priority ? cur : best);
    }

    dispose(): void {
        this.watcher?.dispose();
        this.index.clear();
    }

    private async doBuild(): Promise<void> {
        this.index.clear();
        const files = await vscode.workspace.findFiles('**/*.{png,jpg,jpeg}', '**/node_modules/**');
        for (const uri of files) {
            this.addFile(uri);
        }
        this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg}');
        this.watcher.onDidCreate(uri => this.addFile(uri));
        this.watcher.onDidDelete(uri => this.removeFile(uri));
    }

    private addFile(uri: vscode.Uri): void {
        const ext = path.extname(uri.fsPath);
        const name = path.basename(uri.fsPath, ext).toLowerCase();
        const entry: ResourceMetadata = {
            uri,
            type: typeFromExtension(ext),
            priority: computePriority(uri)
        };
        const existing = this.index.get(name);
        if (existing) {
            existing.push(entry);
        } else {
            this.index.set(name, [entry]);
        }
    }

    private removeFile(uri: vscode.Uri): void {
        const ext = path.extname(uri.fsPath);
        const name = path.basename(uri.fsPath, ext).toLowerCase();
        const entries = this.index.get(name);
        if (!entries) { return; }
        const filtered = entries.filter(e => e.uri.toString() !== uri.toString());
        if (filtered.length === 0) {
            this.index.delete(name);
        } else {
            this.index.set(name, filtered);
        }
    }
}
