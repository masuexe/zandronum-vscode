import * as vscode from 'vscode';
import * as path from 'path';
import { PackageSource } from './types';
import {
    BuiltinPackage,
    WorkspacePackage,
    FolderPackage,
    ZipPackage
} from './packages';

function resolvePath(reference: string, workspaceRoot: string): string {
    if (path.isAbsolute(reference)) { return reference; }
    return path.resolve(workspaceRoot, reference);
}

function isZip(reference: string): boolean {
    const ext = path.extname(reference).toLowerCase();
    return ext === '.pk3' || ext === '.zip' || ext === '.pk7';
}

export class PackageManager {
    private packages: PackageSource[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly extensionPath: string) {}

    async build(): Promise<void> {
        const config = vscode.workspace.getConfiguration('zandronum-vscode');
        const baseResources: string[] = config.get('baseResources') ?? [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        const list: PackageSource[] = [];
        let priority = 0;

        list.push(new BuiltinPackage(
            'builtin',
            priority++,
            this.extensionPath
        ));

        for (const ref of baseResources) {
            const resolved = resolvePath(ref, workspaceRoot);
            if (isZip(resolved)) {
                list.push(new ZipPackage(ref, priority++, resolved));
            } else {
                list.push(new FolderPackage(ref, priority++, resolved));
            }
        }

        list.push(new WorkspacePackage(priority++));

        this.packages = list;
        this._onDidChange.fire();
    }

    getPackages(): readonly PackageSource[] {
        return this.packages;
    }
}
