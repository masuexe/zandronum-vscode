import * as vscode from 'vscode';
import { PackageManager } from './packageManager';
import { parseBaseResourceUri, BASE_RESOURCE_SCHEME } from './baseResourceUri';

/**
 * Binary FileSystemProvider for zandronum-base: URIs so webviews can fetch
 * PNG/JPEG bytes from ZipPackage entries via workspace.fs / asWebviewUri.
 */
export class BaseResourceFileSystemProvider implements vscode.FileSystemProvider {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    constructor(private readonly packageManager: PackageManager) {}

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => { /* no-op */ });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const bytes = await this.readFile(uri);
        return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: bytes.length
        };
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const parsed = parseBaseResourceUri(uri);
        if (!parsed) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const pkg = this.packageManager.findPackage(parsed.packageId);
        if (!pkg) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        // ZipPackage.openEntry falls back to the image map for PNG/JPEG.
        const bytes = await pkg.openEntry(parsed.entryPath);
        if (bytes.length === 0) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        return bytes;
    }

    readDirectory(): [string, vscode.FileType][] {
        throw vscode.FileSystemError.NoPermissions();
    }

    createDirectory(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    writeFile(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    delete(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    rename(): void {
        throw vscode.FileSystemError.NoPermissions();
    }

    dispose(): void {
        this._onDidChangeFile.dispose();
    }
}

export { BASE_RESOURCE_SCHEME };
