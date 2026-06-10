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
    const dir = config.get<string>('accOutputDir') || 'src/acs';
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

    // 2. Include the ACS source directory
    paths.push(path.join(workspaceRoot, ACS_SOURCE_DIR));

    // 3. Always include the workspace root
    paths.push(workspaceRoot);

    // 4. Discover directories containing other .acs library files
    for (const libDir of discoverLibraryPaths(workspaceRoot, srcFile)) {
        paths.push(libDir);
    }

    // 5. User-configured include paths
    for (const p of getUserIncludePaths()) {
        const resolved = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
        paths.push(resolved);
    }

    return [...new Set(paths)];
}

const LOADACS_PATH = 'src/loadacs';
const ACS_SOURCE_DIR = 'src/acs_source';

function parseLoadAcs(workspaceRoot: string): string[] {
    const loadacsPath = path.join(workspaceRoot, LOADACS_PATH);
    if (!fs.existsSync(loadacsPath)) {
        return [];
    }

    const content = fs.readFileSync(loadacsPath, 'utf-8');
    const libraries: string[] = [];

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('#')) {
            continue;
        }
        const commentIdx = trimmed.indexOf('//');
        const name = (commentIdx >= 0 ? trimmed.substring(0, commentIdx) : trimmed).trim();
        if (name.length > 0) {
            libraries.push(name);
        }
    }

    return libraries;
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

    const ok = await compileSingleFile(srcFile, workspaceRoot);
    if (ok) {
        vscode.window.showInformationMessage(`Compiled: ${path.basename(srcFile)}`);
    } else {
        vscode.window.showErrorMessage('Compilation failed. Check the Problems panel.');
    }
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

            const oExists = fs.existsSync(outFile);
            if (code === 0 && diagnostics.length === 0 && oExists) {
                resolve(true);
            } else {
                if (!oExists) {
                    const detail = code === 0
                        ? 'ACC returned success but did not produce an output file.'
                        : '';
                    vscode.window.showErrorMessage(`Failed to compile ${path.basename(srcFile)}. ${detail}`.trim());
                }
                resolve(false);
            }
        });

        proc.on('error', () => {
            vscode.window.showErrorMessage(
                `Failed to run ACC compiler. Check that '${accPath}' is a valid path.`
            );
            resolve(false);
        });
    });
}

function hasLibraryDirective(filePath: string): boolean {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);

        const header = buf.toString('utf-8', 0, bytesRead);

        // Strip block comments and line comments for reliable detection
        const clean = header
            .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
            .replace(/\/\/.*$/gm, '');           // line comments

        return /#library\b/im.test(clean);
    } catch {
        return false;
    }
}

function findLibraryAcsFiles(workspaceRoot: string): string[] {
    const sourceDir = path.join(workspaceRoot, ACS_SOURCE_DIR);
    if (!fs.existsSync(sourceDir)) {
        return [];
    }

    const loadAcsEntries = parseLoadAcs(workspaceRoot);
    if (loadAcsEntries.length === 0) {
        return [];
    }

    const loadAcsSet = new Set(loadAcsEntries.map(e => e.toLowerCase()));
    const files: string[] = [];

    function scan(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(full);
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.acs')) {
                const baseName = path.basename(entry.name, '.acs').toLowerCase();
                if (loadAcsSet.has(baseName) && hasLibraryDirective(full)) {
                    files.push(full);
                }
            }
        }
    }

    scan(sourceDir);
    return files;
}

export async function compileAllAndBuild() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return;
    }

    diagnosticCollection.clear();

    const loadAcsEntries = parseLoadAcs(workspaceRoot);
    if (loadAcsEntries.length === 0) {
        vscode.window.showWarningMessage(`No LOADACS entries found in ${LOADACS_PATH}.`);
        return;
    }

    const acsFiles = findLibraryAcsFiles(workspaceRoot);
    if (acsFiles.length === 0) {
        vscode.window.showWarningMessage(
            `No matching ACS library files found in ${ACS_SOURCE_DIR}/ for LOADACS entries.`
        );
        return;
    }

    let totalCompiled = 0;
    let totalErrors = 0;

    for (const acsFile of acsFiles) {
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
