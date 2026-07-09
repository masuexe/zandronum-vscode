import * as vscode from 'vscode';
import * as path from 'path';

export enum ResourceType {
    Png,
    Jpeg,
    DoomGraphic,
    TextureDefinition,
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

function isInPk3Root(uri: vscode.Uri, pk3Root: string): boolean {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const target = pk3Root.replace(/\\/g, '/').toLowerCase();
    const pathLower = rel.replace(/\\/g, '/').toLowerCase();
    return pathLower.startsWith(target + '/') || pathLower === target;
}

function computeImagePriority(uri: vscode.Uri, pk3Root: string): number {
    return isInPk3Root(uri, pk3Root) ? 10 : 0;
}

function computeDefinitionPriority(uri: vscode.Uri, pk3Root: string): number {
    return isInPk3Root(uri, pk3Root) ? 20 : 5;
}

const TEXTURES_DEF_RE = /^\s*(Texture|WallTexture|Flat|Sprite|Graphic)\s+(?:optional\s+)?(?:"([^"]*)"|([^\s,]+))\s*,\s*(\d+)\s*,\s*(\d+)/gim;

export class ResourceIndex {
    private readonly pk3Root: string;
    private index = new Map<string, ResourceMetadata[]>();
    private imageWatcher: vscode.FileSystemWatcher | undefined;
    private texturesWatcher: vscode.FileSystemWatcher | undefined;
    private buildPromise: Promise<void> | undefined;

    constructor(pk3Root: string = 'src') {
        this.pk3Root = pk3Root;
    }

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

    /** Basenames of indexed image resources (png/jpeg), sorted. */
    listImageNames(): string[] {
        const names: string[] = [];
        for (const [name, entries] of this.index) {
            if (entries.some(e => e.type === ResourceType.Png || e.type === ResourceType.Jpeg)) {
                names.push(name);
            }
        }
        names.sort();
        return names;
    }

    dispose(): void {
        this.imageWatcher?.dispose();
        this.texturesWatcher?.dispose();
        this.index.clear();
    }

    private async doBuild(): Promise<void> {
        this.index.clear();
        const imageFiles = await vscode.workspace.findFiles('**/*.{png,jpg,jpeg}', '**/node_modules/**');
        for (const uri of imageFiles) {
            this.addFile(uri);
        }
        const texturesFiles = await vscode.workspace.findFiles('**/TEXTURES*', '**/node_modules/**');
        for (const uri of texturesFiles) {
            await this.scanTexturesFile(uri);
        }
        this.imageWatcher?.dispose();
        this.texturesWatcher?.dispose();
        this.imageWatcher = vscode.workspace.createFileSystemWatcher('**/*.{png,jpg,jpeg}');
        this.imageWatcher.onDidCreate(uri => this.addFile(uri));
        this.imageWatcher.onDidDelete(uri => this.removeFile(uri));
        this.texturesWatcher = vscode.workspace.createFileSystemWatcher('**/TEXTURES*');
        this.texturesWatcher.onDidCreate(uri => { void this.scanTexturesFile(uri); });
        this.texturesWatcher.onDidChange(uri => {
            this.removeDefinitionsFrom(uri);
            void this.scanTexturesFile(uri);
        });
        this.texturesWatcher.onDidDelete(uri => this.removeDefinitionsFrom(uri));
    }

    private removeDefinitionsFrom(uri: vscode.Uri): void {
        const uriStr = uri.toString();
        for (const [name, entries] of this.index) {
            const filtered = entries.filter(
                e => !(e.type === ResourceType.TextureDefinition && e.uri.toString() === uriStr)
            );
            if (filtered.length === 0) {
                this.index.delete(name);
            } else if (filtered.length !== entries.length) {
                this.index.set(name, filtered);
            }
        }
    }

    private async scanTexturesFile(uri: vscode.Uri): Promise<void> {
        try {
            const data = await vscode.workspace.fs.readFile(uri);
            const text = Buffer.from(data).toString('utf-8');
            TEXTURES_DEF_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = TEXTURES_DEF_RE.exec(text)) !== null) {
                const name = (m[2] ?? m[3]).toLowerCase();
                const width = parseInt(m[4]);
                const height = parseInt(m[5]);
                const entry: ResourceMetadata = {
                    uri,
                    type: ResourceType.TextureDefinition,
                    priority: computeDefinitionPriority(uri, this.pk3Root),
                    width,
                    height
                };
                const existing = this.index.get(name);
                if (existing) {
                    existing.push(entry);
                } else {
                    this.index.set(name, [entry]);
                }
            }
        } catch {}
    }

    private addFile(uri: vscode.Uri): void {
        const ext = path.extname(uri.fsPath);
        const name = path.basename(uri.fsPath, ext).toLowerCase();
        const entry: ResourceMetadata = {
            uri,
            type: typeFromExtension(ext),
            priority: computeImagePriority(uri, this.pk3Root)
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
