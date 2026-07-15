import * as vscode from 'vscode';
import { SymbolEntry } from './types';
import { makeBaseResourceUri } from './baseResourceUri';

export function locationFromSymbol(sym: SymbolEntry): vscode.Location {
    const pos = new vscode.Position(
        sym.location?.line ?? 0,
        sym.location?.character ?? 0
    );

    if (sym.packageId === 'workspace') {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            return new vscode.Location(
                vscode.Uri.joinPath(folder.uri, sym.entryPath),
                pos
            );
        }
    }

    return new vscode.Location(
        makeBaseResourceUri(sym.packageId, sym.entryPath),
        pos
    );
}

export function symbolSourceDetail(sym: SymbolEntry): string {
    if (sym.packageId === 'workspace') {
        return `Workspace: ${sym.entryPath}`;
    }
    if (sym.packageId === 'builtin') {
        return 'Built-in';
    }
    return `Base: ${sym.source}`;
}
