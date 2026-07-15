import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { buildPK3 } from './build';
import { getPk3Root } from '../shared/pk3Root';
import { getBaseAcsIncludeDirs } from '../base/baseAcsIncludes';

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
    const customDir = config.get<string>('accOutputDir');
    if (customDir) {
        return path.join(workspaceRoot, customDir);
    }
    return path.join(workspaceRoot, getPk3Root(), 'acs');
}

function getAccDir(workspaceRoot: string): string | null {
    const accPath = getAccPath();

    if (accPath !== 'acc') {
        const resolved = path.isAbsolute(accPath)
            ? accPath
            : path.resolve(workspaceRoot, accPath);
        return path.dirname(resolved);
    }

    try {
        const result = cp.execSync('where acc', { encoding: 'utf-8' });
        const first = result.trim().split('\n')[0];
        if (first) {
            return path.dirname(first.trim());
        }
    } catch {
        // acc not found in PATH
    }

    return null;
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
                if (parent !== path.dirname(srcFile)) {
                    dirs.add(parent);
                }
            }
        }
    }

    scanDir(workspaceRoot);
    return [...dirs];
}

function collectSubdirs(root: string, dirs: Set<string>) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
            const full = path.join(root, entry.name);
            dirs.add(full);
            collectSubdirs(full, dirs);
        }
    }
}

function resolveIncludePaths(workspaceRoot: string, srcFile: string): string[] {
    const paths: string[] = [];

    // 1. Include the ACC executable's directory (contains zcommon.acs etc.)
    const accDir = getAccDir(workspaceRoot);
    if (accDir) {
        paths.push(accDir);
    }

    // 2. Always include the source file's directory
    paths.push(path.dirname(srcFile));

    // 3. Include the ACS source directory and all its subdirectories
    const acsSource = path.join(workspaceRoot, getPk3Root(), 'acs_source');
    paths.push(acsSource);
    const subdirs = new Set<string>();
    collectSubdirs(acsSource, subdirs);
    for (const d of subdirs) {
        paths.push(d);
    }

    // 4. Always include the workspace root
    paths.push(workspaceRoot);

    // 5. Discover directories containing other .acs library files
    for (const libDir of discoverLibraryPaths(workspaceRoot, srcFile)) {
        paths.push(libDir);
    }

    // 6. User-configured include paths
    for (const p of getUserIncludePaths()) {
        const resolved = path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
        paths.push(resolved);
    }

    // 7. Base-resource ACS dirs (extracted PK3 + folder packages)
    for (const d of getBaseAcsIncludeDirs()) {
        paths.push(d);
        const subdirs = new Set<string>();
        collectSubdirs(d, subdirs);
        for (const sub of subdirs) {
            paths.push(sub);
        }
    }

    return [...new Set(paths)];
}

function getLoadAcsPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, getPk3Root(), 'loadacs');
}

function getAcsSourceDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, getPk3Root(), 'acs_source');
}

function parseLoadAcs(workspaceRoot: string): string[] {
    const loadacsPath = getLoadAcsPath(workspaceRoot);
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

function parseAcsErrors(output: string, srcFile: string): Map<string, vscode.Diagnostic[]> {
    const map = new Map<string, vscode.Diagnostic[]>();
    const lines = output.replace(/\r/g, '').split('\n');

    let currentFile: string | null = null;
    let currentLine: number = -1;
    let currentMessage: string[] = [];

    function flush() {
        if (currentFile && currentLine >= 0 && currentMessage.length > 0) {
            const fileKey = path.resolve(currentFile);
            let diags = map.get(fileKey);
            if (!diags) {
                diags = [];
                map.set(fileKey, diags);
            }
            const range = new vscode.Range(currentLine, 0, currentLine, Number.MAX_SAFE_INTEGER);
            const diagnostic = new vscode.Diagnostic(
                range, currentMessage.join('\n'), vscode.DiagnosticSeverity.Error
            );
            diagnostic.source = 'ACC';
            diags.push(diagnostic);
        }
        currentFile = null;
        currentLine = -1;
        currentMessage = [];
    }

    for (const line of lines) {
        // file:line: message  or  file:line: (multi-line header)
        const m = /^(.+):(\d+):\s*(.*)$/.exec(line);
        if (m) {
            const file = m[1].trim();
            const lineNum = parseInt(m[2], 10) - 1;
            const message = m[3].trim();

            flush();

            if (message.length > 0) {
                const fileKey = path.resolve(file);
                let diags = map.get(fileKey);
                if (!diags) {
                    diags = [];
                    map.set(fileKey, diags);
                }
                const range = new vscode.Range(lineNum, 0, lineNum, Number.MAX_SAFE_INTEGER);
                const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
                diagnostic.source = 'ACC';
                diags.push(diagnostic);
            } else {
                currentFile = file;
                currentLine = lineNum;
                currentMessage = [];
            }
            continue;
        }

        if (currentFile) {
            const trimmed = line.trim();
            if (trimmed.length > 0 && !/^Host byte order/i.test(trimmed)) {
                currentMessage.push(trimmed);
            }
        }
    }

    flush();

    return map;
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

    diagnosticCollection.clear();

    const ok = await compileSingleFile(srcFile, workspaceRoot);
    if (ok) {
        vscode.window.showInformationMessage(`Compiled to ${path.basename(srcFile, path.extname(srcFile))}.o`);
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
            const diagMap = parseAcsErrors(output, srcFile);

            for (const [filePath, diagnostics] of diagMap) {
                diagnosticCollection.set(vscode.Uri.file(filePath), diagnostics);
            }

            const oExists = fs.existsSync(outFile);

            // Fallback: no structured errors parsed, but ACC produced output and .o is missing
            if (diagMap.size === 0 && output.trim().length > 0 && !oExists) {
                const range = new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER);
                const diagnostic = new vscode.Diagnostic(
                    range, output.trim(), vscode.DiagnosticSeverity.Error
                );
                diagnostic.source = 'ACC';
                diagnosticCollection.set(vscode.Uri.file(srcFile), [diagnostic]);
            }

            if (code === 0 && diagMap.size === 0 && oExists) {
                resolve(true);
            } else {
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
    const sourceDir = getAcsSourceDir(workspaceRoot);
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

/**
 * Compile all ACS libraries listed in LOADACS.
 * - notConfigured: no LOADACS entries (caller may skip straight to packaging)
 * - success: every matching library compiled
 * - failure: configured but incomplete or compile errors (do not package)
 */
export type CompileLibrariesResult = 'notConfigured' | 'success' | 'failure';

export async function compileLoadAcsLibraries(
    options: { clearDiagnostics?: boolean; quietNotConfigured?: boolean } = {}
): Promise<CompileLibrariesResult> {
    const { clearDiagnostics = true, quietNotConfigured = false } = options;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return 'failure';
    }

    if (clearDiagnostics) {
        diagnosticCollection.clear();
    }

    const loadAcsEntries = parseLoadAcs(workspaceRoot);
    if (loadAcsEntries.length === 0) {
        if (!quietNotConfigured) {
            vscode.window.showWarningMessage(`No LOADACS entries found in ${getPk3Root()}/loadacs.`);
        }
        return 'notConfigured';
    }

    const acsFiles = findLibraryAcsFiles(workspaceRoot);
    if (acsFiles.length === 0) {
        vscode.window.showWarningMessage(
            `No matching ACS library files found in ${getPk3Root()}/acs_source/ for LOADACS entries.`
        );
        return 'failure';
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
        vscode.window.showErrorMessage(
            `Compiled ${totalCompiled}, ${totalErrors} failed. Fix errors before building.`
        );
        return 'failure';
    }

    vscode.window.showInformationMessage(`All ${totalCompiled} ACS libraries compiled successfully.`);
    return 'success';
}

/** @deprecated Prefer Compile Current ACS, then Build Project. Kept for keybindings. */
export async function compileCurrentAndBuild() {
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

    diagnosticCollection.clear();

    const ok = await compileSingleFile(srcFile, workspaceRoot);
    if (ok) {
        vscode.window.showInformationMessage(
            `Compiled ${path.basename(srcFile, path.extname(srcFile))}.o. Building PK3...`
        );
        await buildPK3();
    } else {
        vscode.window.showErrorMessage('Compilation failed. Check the Problems panel.');
    }
}

/** @deprecated Prefer Build Project. Kept for keybindings. */
export async function compileAllAndBuild(): Promise<boolean> {
    const result = await compileLoadAcsLibraries({ quietNotConfigured: false });
    if (result !== 'success') {
        return false;
    }
    vscode.window.showInformationMessage('Building PK3...');
    return await buildPK3();
}
