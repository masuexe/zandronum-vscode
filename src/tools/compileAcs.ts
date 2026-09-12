import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { buildPK3 } from './build';
import { getPk3Root } from '../shared/pk3Root';
import { expandUserPath } from '../shared/variables';
import { getBaseAcsIncludeDirs, getBasePackagesForCompile } from '../base/baseAcsIncludes';
import { collectLoadAcsEntries } from './loadAcsDiscovery';
import {
    ACC_MAX_CLI_INCLUDE_PATHS,
    buildAccIncludePaths,
    listDirectIncludeAndImportNames,
} from './accIncludePaths';

export {
    ACC_MAX_CLI_INCLUDE_PATHS,
    buildAccIncludePaths,
    collectNeededIncludeDirs,
    findAcsIncludeFile,
} from './accIncludePaths';
export type {
    BuildAccIncludePathsOptions,
    BuildAccIncludePathsResult,
} from './accIncludePaths';

function getAccPath(): string {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    return config.get<string>('accPath') || 'acc';
}

export function resolveAccExecutablePath(accPath: string, workspaceRoot: string): string {
    if (accPath === 'acc') { return accPath; }

    const expanded = expandUserPath(accPath);
    return path.isAbsolute(expanded)
        ? expanded
        : path.resolve(workspaceRoot, expanded);
}

function getUserIncludePaths(): string[] {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const raw = config.get<string>('accIncludePaths') || '';
    if (!raw.trim()) { return []; }
    return raw.split(';').map(p => p.trim()).filter(p => p.length > 0);
}

/** Bounded ACC process concurrency; 0 or unset → min(4, CPU count). */
function getAccConcurrency(): number {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const configured = config.get<number>('accConcurrency');
    if (typeof configured === 'number' && configured > 0) {
        return Math.floor(configured);
    }
    return Math.min(4, Math.max(1, os.cpus().length || 1));
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
    const accPath = resolveAccExecutablePath(getAccPath(), workspaceRoot);

    if (accPath !== 'acc') {
        return path.dirname(accPath);
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

function resolveIncludePaths(workspaceRoot: string, srcFile: string): string[] {
    const acsSource = getAcsSourceDir(workspaceRoot);
    const userPaths = getUserIncludePaths().map(p =>
        path.isAbsolute(p) ? p : path.join(workspaceRoot, p)
    );
    const searchRoots = [acsSource, ...getBaseAcsIncludeDirs()].filter(d =>
        Boolean(d) && fs.existsSync(d)
    );
    // Workspace acs_source first: findAcsIncludeFile prefers earlier roots and
    // exact-case basenames so local overrides beat base PK3 copies (e.g. DTADD.acs).

    const { paths, truncated } = buildAccIncludePaths({
        srcFile,
        accDir: getAccDir(workspaceRoot),
        searchRoots,
        userIncludePaths: userPaths,
    });

    if (truncated.length > 0) {
        const preview = truncated
            .slice(0, 5)
            .map(d => path.relative(workspaceRoot, d) || d)
            .join(', ');
        const more = truncated.length > 5 ? ` (+${truncated.length - 5} more)` : '';
        void vscode.window.showWarningMessage(
            `ACC allows at most ${ACC_MAX_CLI_INCLUDE_PATHS} include paths (-i); ` +
            `${truncated.length} needed director${truncated.length === 1 ? 'y was' : 'ies were'} omitted: ` +
            `${preview}${more}. Some #include files may not resolve.`
        );
    }

    return paths;
}

function getAcsSourceDir(workspaceRoot: string): string {
    return path.join(workspaceRoot, getPk3Root(), 'acs_source');
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

    const result = await compileSingleFile(srcFile, workspaceRoot, { force: true });
    if (result === 'compiled') {
        vscode.window.showInformationMessage(`Compiled to ${path.basename(srcFile, path.extname(srcFile))}.o`);
    } else {
        vscode.window.showErrorMessage('Compilation failed. Check the Problems panel.');
    }
}

async function compileSingleFile(
    srcFile: string,
    workspaceRoot: string,
    options: { force?: boolean } = {}
): Promise<'compiled' | 'skipped' | 'failed'> {
    const accPath = resolveAccExecutablePath(getAccPath(), workspaceRoot);
    const outputDir = getOutputDir(workspaceRoot);
    const includePaths = resolveIncludePaths(workspaceRoot, srcFile);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const srcName = path.basename(srcFile, path.extname(srcFile));
    const outFile = path.join(outputDir, `${srcName}.o`);

    // Incremental: skip when .o is not older than entry + transitive #includes
    if (!options.force && isObjectUpToDate(srcFile, outFile, includePaths)) {
        return 'skipped';
    }

    const args: string[] = [];
    for (const inc of includePaths) {
        args.push('-i', inc);
    }
    args.push(srcFile, outFile);

    return new Promise<'compiled' | 'skipped' | 'failed'>((resolve) => {
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
                resolve('compiled');
            } else {
                resolve('failed');
            }
        });

        proc.on('error', () => {
            vscode.window.showErrorMessage(
                `Failed to run ACC compiler. Check that '${accPath}' is a valid path.`
            );
            resolve('failed');
        });
    });
}

/**
 * Resolve an #include name against ACC-style search paths (file dir first,
 * then -i paths). Case-insensitive basename match for Windows mods.
 */
function resolveAcsInclude(includeName: string, searchPaths: readonly string[]): string | null {
    const base = path.basename(includeName);
    const lower = base.toLowerCase();
    for (const dir of searchPaths) {
        const direct = path.join(dir, includeName);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) {
            return path.resolve(direct);
        }
        const byBase = path.join(dir, base);
        if (byBase !== direct && fs.existsSync(byBase) && fs.statSync(byBase).isFile()) {
            return path.resolve(byBase);
        }
        try {
            for (const ent of fs.readdirSync(dir)) {
                if (ent.toLowerCase() === lower) {
                    const full = path.join(dir, ent);
                    if (fs.statSync(full).isFile()) {
                        return path.resolve(full);
                    }
                }
            }
        } catch { /* ignore unreadable dirs */ }
    }
    return null;
}

function listDirectIncludes(filePath: string): string[] {
    return listDirectIncludeAndImportNames(filePath);
}

/** Newest mtime among entry ACS and transitive #includes (cycle-safe). */
function newestAcsDependencyMtime(
    entryFile: string,
    includePaths: readonly string[]
): number | null {
    let newest: number | null = null;
    const visited = new Set<string>();
    const stack: string[] = [path.resolve(entryFile)];

    while (stack.length > 0) {
        const file = stack.pop()!;
        const key = file.toLowerCase();
        if (visited.has(key)) { continue; }
        visited.add(key);

        try {
            const st = fs.statSync(file);
            if (newest === null || st.mtimeMs > newest) {
                newest = st.mtimeMs;
            }
        } catch {
            continue;
        }

        const search = [path.dirname(file), ...includePaths];
        for (const name of listDirectIncludes(file)) {
            const resolved = resolveAcsInclude(name, search);
            if (resolved) {
                stack.push(resolved);
            }
        }
    }

    return newest;
}

/**
 * True when outFile exists and its mtime is >= the newest of the entry ACS
 * and all transitive #include dependencies.
 */
function isObjectUpToDate(
    srcFile: string,
    outFile: string,
    includePaths: readonly string[]
): boolean {
    try {
        if (!fs.existsSync(outFile)) { return false; }
        const newest = newestAcsDependencyMtime(srcFile, includePaths);
        if (newest === null) { return false; }
        return fs.statSync(outFile).mtimeMs >= newest;
    } catch {
        return false;
    }
}

async function mapPool<T, R>(
    items: readonly T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) { return []; }
    const results: R[] = new Array(items.length);
    let next = 0;
    const limit = Math.max(1, Math.min(concurrency, items.length));

    async function worker(): Promise<void> {
        while (true) {
            const i = next++;
            if (i >= items.length) { return; }
            results[i] = await fn(items[i]);
        }
    }

    await Promise.all(Array.from({ length: limit }, () => worker()));
    return results;
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

function findLibraryAcsFiles(workspaceRoot: string, loadAcsEntries: string[]): string[] {
    const sourceDir = getAcsSourceDir(workspaceRoot);
    if (!fs.existsSync(sourceDir) || loadAcsEntries.length === 0) {
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
 * Compile all ACS libraries listed in LOADACS (workspace + base resources).
 * - notConfigured: no LOADACS entries anywhere (caller may skip straight to packaging)
 * - success: every matching workspace library compiled or skipped as up-to-date
 * - failure: configured but incomplete or compile errors (do not package)
 */
export type CompileLibrariesResult = 'notConfigured' | 'success' | 'failure';

export interface CompileLibrariesStats {
    result: CompileLibrariesResult;
    compiled: number;
    skipped: number;
    failed: number;
    elapsedMs: number;
}

export async function compileLoadAcsLibraries(
    options: {
        clearDiagnostics?: boolean;
        quietNotConfigured?: boolean;
        quietSuccess?: boolean;
    } = {}
): Promise<CompileLibrariesStats> {
    const {
        clearDiagnostics = true,
        quietNotConfigured = false,
        quietSuccess = false,
    } = options;
    const started = Date.now();

    const empty = (result: CompileLibrariesResult): CompileLibrariesStats => ({
        result,
        compiled: 0,
        skipped: 0,
        failed: 0,
        elapsedMs: Date.now() - started,
    });

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder opened.');
        return empty('failure');
    }

    if (clearDiagnostics) {
        diagnosticCollection.clear();
    }

    const loadAcsEntries = await collectLoadAcsEntries(
        workspaceRoot,
        getBasePackagesForCompile()
    );
    if (loadAcsEntries.length === 0) {
        if (!quietNotConfigured) {
            vscode.window.showWarningMessage(
                `No LOADACS entries found in ${getPk3Root()}/loadacs or base resources.`
            );
        }
        return empty('notConfigured');
    }

    const acsFiles = findLibraryAcsFiles(workspaceRoot, loadAcsEntries);
    if (acsFiles.length === 0) {
        vscode.window.showWarningMessage(
            `No matching ACS library files found in ${getPk3Root()}/acs_source/ for LOADACS entries.`
        );
        return empty('failure');
    }

    const outcomes = await mapPool(
        acsFiles,
        getAccConcurrency(),
        (acsFile) => compileSingleFile(acsFile, workspaceRoot)
    );

    let compiled = 0;
    let skipped = 0;
    let failed = 0;
    for (const outcome of outcomes) {
        if (outcome === 'compiled') { compiled++; }
        else if (outcome === 'skipped') { skipped++; }
        else { failed++; }
    }

    const elapsedMs = Date.now() - started;

    if (failed > 0) {
        vscode.window.showErrorMessage(
            `Compiled ${compiled}, ${failed} failed (${skipped} up-to-date). Fix errors before building.`
        );
        return { result: 'failure', compiled, skipped, failed, elapsedMs };
    }

    if (!quietSuccess) {
        if (compiled === 0 && skipped > 0) {
            vscode.window.showInformationMessage(
                `All ${skipped} ACS libraries up-to-date.`
            );
        } else {
            vscode.window.showInformationMessage(
                `ACS: ${compiled} compiled, ${skipped} skipped (${(elapsedMs / 1000).toFixed(1)}s).`
            );
        }
    }

    return { result: 'success', compiled, skipped, failed, elapsedMs };
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

    const result = await compileSingleFile(srcFile, workspaceRoot, { force: true });
    if (result === 'compiled') {
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
    const stats = await compileLoadAcsLibraries({ quietNotConfigured: false });
    if (stats.result !== 'success') {
        return false;
    }
    vscode.window.showInformationMessage('Building PK3...');
    return await buildPK3();
}
