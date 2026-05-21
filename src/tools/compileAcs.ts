import * as vscode from 'vscode';

function getAccPath(): string {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    return config.get<string>('accPath') || 'acc';
}

export async function compileAcs() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'acs') {
        vscode.window.showWarningMessage('Open an ACS file to compile.');
        return;
    }

    const filePath = editor.document.uri.fsPath;
    const accPath = getAccPath();

    vscode.window.showInformationMessage(
        `ACC compiler path: ${accPath}\nCompiling: ${filePath}\n\nCompilation not yet integrated.`
    );
}
