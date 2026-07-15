import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PackageBuildWarning, PackageSource } from './types';
import {
    BuiltinPackage,
    WorkspacePackage,
    FolderPackage,
    ZipPackage
} from './packages';
import { isSupportedArchive, unsupportedArchiveMessage } from './archiveFormats';

function resolvePath(reference: string, workspaceRoot: string): string {
    if (path.isAbsolute(reference)) { return reference; }
    return path.resolve(workspaceRoot, reference);
}

export class PackageManager {
    private packages: PackageSource[] = [];
    private warnings: PackageBuildWarning[] = [];
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly extensionPath: string) {}

    async build(): Promise<void> {
        const config = vscode.workspace.getConfiguration('zandronum-vscode');
        const baseResources: string[] = config.get('baseResources') ?? [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

        const list: PackageSource[] = [];
        const warnings: PackageBuildWarning[] = [];
        let priority = 0;

        list.push(new BuiltinPackage(
            'builtin',
            priority++,
            this.extensionPath
        ));

        for (const ref of baseResources) {
            if (!ref || !ref.trim()) { continue; }
            const resolved = resolvePath(ref.trim(), workspaceRoot);
            const unsupported = unsupportedArchiveMessage(resolved);
            if (unsupported) {
                warnings.push({ path: ref, message: unsupported });
                continue;
            }

            if (isSupportedArchive(resolved)) {
                if (!fs.existsSync(resolved)) {
                    warnings.push({ path: ref, message: `File not found: ${resolved}` });
                    continue;
                }
                list.push(new ZipPackage(ref, priority++, resolved));
            } else {
                if (!fs.existsSync(resolved)) {
                    warnings.push({ path: ref, message: `Path not found: ${resolved}` });
                    continue;
                }
                const stat = fs.statSync(resolved);
                if (!stat.isDirectory()) {
                    warnings.push({
                        path: ref,
                        message: `Unsupported base resource type (expected .pk3/.zip or directory): ${resolved}`
                    });
                    continue;
                }
                list.push(new FolderPackage(ref, priority++, resolved));
            }
        }

        list.push(new WorkspacePackage(priority++));

        this.packages = list;
        this.warnings = warnings;
        this._onDidChange.fire();
    }

    getPackages(): readonly PackageSource[] {
        return this.packages;
    }

    getWarnings(): readonly PackageBuildWarning[] {
        return this.warnings;
    }

    findPackage(packageId: string): PackageSource | undefined {
        return this.packages.find(p => p.id === packageId);
    }

    collectZipErrors(): PackageBuildWarning[] {
        const extra: PackageBuildWarning[] = [];
        for (const pkg of this.packages) {
            if (pkg instanceof ZipPackage) {
                const err = pkg.getLoadError();
                if (err) {
                    extra.push({ path: pkg.id, message: err });
                }
            }
        }
        return extra;
    }

    getAcsIncludeDirs(extractRoot: string | undefined): string[] {
        const dirs: string[] = [];
        for (const pkg of this.packages) {
            if (pkg.id === 'builtin' || pkg.id === 'workspace') { continue; }
            if (pkg instanceof FolderPackage) {
                dirs.push(pkg.getRootPath());
            } else if (pkg instanceof ZipPackage && extractRoot) {
                const dest = path.join(extractRoot, sanitizeDirName(pkg.id));
                if (fs.existsSync(dest)) {
                    dirs.push(dest);
                }
            }
        }
        return dirs;
    }
}

export function sanitizeDirName(id: string): string {
    return id.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'pkg';
}
