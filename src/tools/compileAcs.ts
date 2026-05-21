import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

function getAccPath(): string {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    return config.get<string>('accPath') || 'acc';
}

function getUserIncludePaths(): string[] {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const raw = config.get<string>('accIncludePaths') || '';
    if (!raw.trim()) return [];
    return raw.split(';').map(p => p.trim()).filter(p => p.length > 0);
}

function getOutputDir(workspaceRoot: string): string {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const dir = config.get<string>('accOutputDir') || 'acs';
    return path.join(workspaceRoot, dir);
}

function discoverLibraryPaths(workspaceRoot: string, srcFile: string): string[] {
    const dirs = new Set<string>();

    function scanDir(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scanDir(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.acs')) {
                const parent = path.dirname(full);
                // Only add if not the source file's directory (already included)
                if (parent !== path.dirname(srcFile)) {
                    dirs.add(parent);
                }
            }
        }
    }

    scanDir(workspaceRoot);
    return [...dirs];
}

function resolveIncludePaths(workspaceRoot: string, srcFile: string): string[] {
    const paths: string[] = [];

    // 1. Always include the source file's directory
    paths.push(path.dirname(srcFile));

    // 2. Always include the workspace root
    paths.push(workspaceRoot);

    // 3. Discover directories containing other .acs library files
    for (const libDir of discoverLibraryPaths(workspaceRoot, srcFile)) {
        paths.push(libDir);
    }

    // 4. User-configured include paths
    for (const p of getUserIncludePaths()) {
        const resolved = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
        paths.push(resolved);
    }

    return [...new Set(paths)];
}

const diagnosticCollection = vscode.languages.createDiagnosticCollection('acs');

function parseAcsErrors(output: string, srcFile: string): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = [];
    // ACC format: C:\path\file.acs:11: Missing semicolon.
    const re = /^(.+?):(\d+):\s*(.+)$/gm;

    let match: RegExpExecArray | null;
    while ((match = re.exec(output)) !== null) {
        const file = match[1].trim();
        const lineNum = parseInt(match[2], 10) - 1; // 0-based
        const message = match[3].trim();

        // Only match errors for the source file (ignore library errors)
        if (path.resolve(file).toLowerCase() !== path.resolve(srcFile).toLowerCase()) continue;

        const range = new vscode.Range(lineNum, 0, lineNum, Number.MAX_SAFE_INTEGER);
        const diagnostic = new vscode.Diagnostic(
            range,
            message,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'ACC';
        diagnostics.push(diagnostic);
    }

    return diagnostics;
}

export async function compileAcs() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'acs') {
        vscode.window.showWarningMessage('Open an ACS file to compile.');
        return;
    }

    const srcFile = editor.document.uri.fsPath;

    // Save if dirty
    if (editor.document.isDirty) {
        await editor.document.save();
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return;
    }

    const accPath = getAccPath();
    const outputDir = getOutputDir(workspaceRoot);
    const includePaths = resolveIncludePaths(workspaceRoot, srcFile);

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const srcName = path.basename(srcFile, path.extname(srcFile));
    const outFile = path.join(outputDir, `${srcName}.o`);

    // Build ACC command line
    const args: string[] = [];
    for (const inc of includePaths) {
        args.push('-i', inc);
    }
    args.push(srcFile, outFile);

    // Clear previous diagnostics
    diagnosticCollection.clear();

    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Compiling ${srcName}.acs...`,
            cancellable: false
        },
        async () => {
            return new Promise<void>((resolve) => {
                const proc = cp.spawn(accPath, args, {
                    cwd: workspaceRoot,
                    shell: false
                });

                let stdout = '';
                let stderr = '';

                proc.stdout.on('data', (data: Buffer) => {
                    stdout += data.toString();
                });

                proc.stderr.on('data', (data: Buffer) => {
                    stderr += data.toString();
                });

                proc.on('close', (code) => {
                    const output = stderr + stdout;
                    const diagnostics = parseAcsErrors(output, srcFile);
                    diagnosticCollection.set(vscode.Uri.file(srcFile), diagnostics);

                    if (code === 0 && diagnostics.length === 0) {
                        vscode.window.showInformationMessage(
                            `Compiled ${srcName}.acs → ${path.relative(workspaceRoot, outFile)}`
                        );
                    } else if (diagnostics.length > 0) {
                        vscode.window.showErrorMessage(
                            `Compilation failed with ${diagnostics.length} error(s).`
                        );
                    } else {
                        vscode.window.showErrorMessage(
                            `ACC exited with code ${code}.\n${output.substring(0, 500)}`
                        );
                    }

                    resolve();
                });

                proc.on('error', (err) => {
                    vscode.window.showErrorMessage(
                        `Failed to launch ACC: ${err.message}\n\nSet the path in preferences: zandronum-vscode.accPath`
                    );
                    resolve();
                });
            });
        }
    );
}
