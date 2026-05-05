import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';

export async function buildPK3() {

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage("No workspace opened");
        return;
    }

    const root = workspaceFolders[0].uri.fsPath;

    const srcPath = path.join(root, 'src');
    const outPath = path.join(root, 'build.pk3');

    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    output.on('close', () => {
        vscode.window.showInformationMessage(`Build complete: ${outPath}`);
    });

    archive.on('error', err => {
        vscode.window.showErrorMessage(err.message);
    });

    archive.pipe(output);

    // ⭐ 把 src 目录内容加入 zip（关键）
    archive.directory(srcPath, false);

    await archive.finalize();
}
