import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';

export async function buildPK3() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('Build failed: no workspace opened');
        return;
    }

    const root = workspaceFolders[0].uri.fsPath;
    const srcPath = path.join(root, 'src');

    if (!fs.existsSync(srcPath)) {
        vscode.window.showErrorMessage('Build failed: src/ directory not found in workspace root');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building PK3...',
            cancellable: false
        }, async () => {
            const outDir = path.join(root, 'out');
            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }
            const outPath = path.join(outDir, 'build.pk3');

            const output = fs.createWriteStream(outPath);
            const archive = archiver('zip', { store: true });

            await new Promise<void>((resolve, reject) => {
                output.on('close', resolve);
                output.on('error', reject);
                archive.on('error', reject);

                archive.pipe(output);
                archive.directory(srcPath, '');
                archive.finalize();
            });
        });

        vscode.window.showInformationMessage('Build complete: out/build.pk3');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Build failed: ${message}`);
    }
}
