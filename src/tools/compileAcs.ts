import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { buildPK3 } from './build';

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
    if (editor.document.isDirty) {
        await editor.document.save();
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return;
    }

    await compileSingleFile(srcFile, workspaceRoot);
}

async function compileSingleFile(srcFile: string, workspaceRoot: string): Promise<boolean> {
    const accPath = getAccPath();
    const outputDir = getOutputDir(workspaceRoot);
    const includePaths = resolveIncludePaths(workspaceRoot, srcFile);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const srcName = path.basename(srcFile, path.extname(srcFile));
    const outFile = path.join(outputDir, `${srcName}.o`);

    const args: string[] = [];
    for (const inc of includePaths) {
        args.push('-i', inc);
    }
    args.push(srcFile, outFile);

    return new Promise<boolean>((resolve) => {
        const proc = cp.spawn(accPath, args, {
            cwd: workspaceRoot,
            shell: false
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
        proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

        proc.on('close', (code) => {
            const output = stderr + stdout;
            const diagnostics = parseAcsErrors(output, srcFile);
            diagnosticCollection.set(vscode.Uri.file(srcFile), diagnostics);

            if (code === 0 && diagnostics.length === 0) {
                resolve(true);
            } else {
                resolve(false);
            }
        });

        proc.on('error', () => {
            resolve(false);
        });
    });
}

function readLoadAcsLibraries(workspaceRoot: string): string[] {
    const srcDir = path.join(workspaceRoot, 'src');

    // Find a file named LOADACS (any extension or none) in src/
    let loadAcsPath: string | null = null;
    try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const nameWithoutExt = entry.name.includes('.')
                ? entry.name.substring(0, entry.name.lastIndexOf('.'))
                : entry.name;
            if (nameWithoutExt.toUpperCase() === 'LOADACS') {
                loadAcsPath = path.join(srcDir, entry.name);
                break;
            }
        }
    } catch {
        return [];
    }

    if (!loadAcsPath) return [];

    try {
        const content = fs.readFileSync(loadAcsPath, 'utf-8');
        return content
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('//'));
    } catch {
        return [];
    }
}

function findAcsFile(workspaceRoot: string, libName: string): string | null {
    const searchName = libName.toLowerCase() + '.acs';

    function scan(dir: string): string | null {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return null; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = scan(full);
                if (found) return found;
            } else if (entry.isFile() && entry.name.toLowerCase() === searchName) {
                return full;
            }
        }
        return null;
    }

    return scan(workspaceRoot);
}

export async function compileAllAndBuild() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return;
    }

    diagnosticCollection.clear();

    const libNames = readLoadAcsLibraries(workspaceRoot);
    if (libNames.length === 0) {
        vscode.window.showWarningMessage('No LOADACS file found in workspace root, or it is empty.');
        return;
    }

    let totalCompiled = 0;
    let totalErrors = 0;

    for (const libName of libNames) {
        const acsFile = findAcsFile(workspaceRoot, libName);
        if (!acsFile) {
            vscode.window.showWarningMessage(`ACS source not found for library "${libName}".`);
            totalErrors++;
            continue;
        }

        const ok = await compileSingleFile(acsFile, workspaceRoot);
        if (ok) {
            totalCompiled++;
        } else {
            totalErrors++;
        }
    }

    if (totalErrors > 0) {
        const msg = `Compiled ${totalCompiled}, ${totalErrors} failed. Fix errors before building.`;
        vscode.window.showErrorMessage(msg);
        return;
    }

    // All compiled, now build PK3
    await buildPK3();
}
