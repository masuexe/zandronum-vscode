import * as path from 'path';
import * as vscode from 'vscode';

export function getBuildOutputPath(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return path.join(root, 'out', 'build.pk3');
}
