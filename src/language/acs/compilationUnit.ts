import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { scanLineDeclarations } from './scanner';
import { getPk3Root } from '../../shared/pk3Root';
import { getBaseAcsIncludeDirs } from '../../base/baseAcsIncludes';

export type SymbolKind = 'variable' | 'constant' | 'function' | 'script';

export interface SymbolInfo {
    name: string;
    nameLower: string;
    kind: SymbolKind;
    containerFile: string;
    range: vscode.Range;
}

export type IncludeResolver = (includeName: string, currentDir: string) => string | null;

// ── SymbolTable (immutable) ──

export class SymbolTable {
    private symbols: SymbolInfo[];
    private byName: Map<string, SymbolInfo>;
    private _varSet: Set<string>;
    private _constSet: Set<string>;

    private constructor(infos: SymbolInfo[]) {
        this.symbols = infos;
        this.byName = new Map();
        this._varSet = new Set();
        this._constSet = new Set();

        for (const info of infos) {
            this.byName.set(info.nameLower, info);
            if (info.kind === 'variable') {
                this._varSet.add(info.nameLower);
            } else if (info.kind === 'constant') {
                this._constSet.add(info.nameLower);
            }
        }
    }

    static build(infos: SymbolInfo[]): SymbolTable {
        return new SymbolTable(infos);
    }

    variables(): Set<string> { return this._varSet; }
    constants(): Set<string> { return this._constSet; }

    find(nameLower: string): SymbolInfo | undefined {
        return this.byName.get(nameLower);
    }

    all(): SymbolInfo[] { return this.symbols; }
}

// ── CompilationUnit (immutable) ──

let nextVersion = 0;

export class CompilationUnit {
    readonly rootFile: string;
    readonly files: ReadonlySet<string>;
    readonly symbolTable: SymbolTable;
    readonly version: number;
    readonly builtAt: number;

    private constructor(
        rootFile: string,
        files: Set<string>,
        symbolTable: SymbolTable
    ) {
        this.rootFile = rootFile;
        this.files = files;
        this.symbolTable = symbolTable;
        this.version = nextVersion++;
        this.builtAt = Date.now();
    }

    static async build(
        rootFile: string,
        resolveInclude: IncludeResolver
    ): Promise<CompilationUnit> {
        const files = new Set<string>();
        const visited = new Set<string>();
        const currentDir = path.dirname(rootFile);

        collectIncludes(rootFile, currentDir, resolveInclude, files, visited);

        const infos: SymbolInfo[] = [];
        for (const file of files) {
            parseFileDeclarations(file, infos);
        }

        const symbolTable = SymbolTable.build(infos);
        return new CompilationUnit(rootFile, files, symbolTable);
    }
}

function collectIncludes(
    filePath: string,
    currentDir: string,
    resolveInclude: IncludeResolver,
    files: Set<string>,
    visited: Set<string>
): void {
    const key = path.resolve(filePath).toLowerCase();
    if (visited.has(key)) return;
    visited.add(key);
    files.add(path.resolve(filePath));

    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return; }

    const lines = content.split('\n');
    const dir = path.dirname(filePath);
    let inBlockComment = false;

    for (const line of lines) {
        if (inBlockComment) {
            if (line.includes('*/')) inBlockComment = false;
            continue;
        }

        const lineCommentIdx = line.indexOf('//');
        const effective = lineCommentIdx >= 0 ? line.substring(0, lineCommentIdx) : line;

        const blockStart = effective.indexOf('/*');
        if (blockStart >= 0 && effective.indexOf('*/', blockStart + 2) < 0) {
            inBlockComment = true;
        }

        scanLineDeclarations(
            effective,
            () => {}, // onDefine — not needed for include collection
            (includeName) => {
                const resolved = resolveInclude(includeName, dir);
                if (resolved) {
                    collectIncludes(resolved, dir, resolveInclude, files, visited);
                }
            },
            () => {} // onVariable — not needed for include collection
        );
    }
}

function parseFileDeclarations(filePath: string, infos: SymbolInfo[]): void {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); }
    catch { return; }

    const lines = content.split('\n');
    let inBlockComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        if (inBlockComment) {
            if (lines[lineNum].includes('*/')) inBlockComment = false;
            continue;
        }

        const lineCommentIdx = lines[lineNum].indexOf('//');
        const effective = lineCommentIdx >= 0
            ? lines[lineNum].substring(0, lineCommentIdx)
            : lines[lineNum];

        const blockStart = effective.indexOf('/*');
        if (blockStart >= 0 && effective.indexOf('*/', blockStart + 2) < 0) {
            inBlockComment = true;
        }

        scanLineDeclarations(
            effective,
            (name) => {
                infos.push({
                    name,
                    nameLower: name.toLowerCase(),
                    kind: 'constant',
                    containerFile: path.resolve(filePath),
                    range: new vscode.Range(lineNum, effective.indexOf(name), lineNum, effective.indexOf(name) + name.length)
                });
            },
            () => {}, // onInclude — handled in collectIncludes
            (name) => {
                infos.push({
                    name,
                    nameLower: name.toLowerCase(),
                    kind: 'variable',
                    containerFile: path.resolve(filePath),
                    range: new vscode.Range(lineNum, effective.indexOf(name), lineNum, effective.indexOf(name) + name.length)
                });
            }
        );
    }
}

// ── LibraryIndex ──

function findFileRecursive(dir: string, targetName: string): string | null {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return null; }

    const targetLower = targetName.toLowerCase();

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(full, targetName);
            if (found) return found;
        } else if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
            return full;
        }
    }

    return null;
}

export function defaultIncludeResolver(
    includeName: string,
    currentDir: string,
    workspaceRoot: string
): string | null {
    const relative = path.resolve(currentDir, includeName);
    if (fs.existsSync(relative)) return relative;

    const srcDir = path.join(workspaceRoot, getPk3Root());
    if (fs.existsSync(srcDir)) {
        const found = findFileRecursive(srcDir, includeName);
        if (found) return found;
    }

    const wsFound = findFileRecursive(workspaceRoot, includeName);
    if (wsFound) return wsFound;

    // Base resource ACS dirs (folders + extracted PK3)
    for (const dir of getBaseAcsIncludeDirs()) {
        const direct = path.resolve(dir, includeName);
        if (fs.existsSync(direct)) return direct;
        const found = findFileRecursive(dir, path.basename(includeName));
        if (found) return found;
    }

    return null;
}

export class LibraryIndex {
    private roots: string[] | null = null;
    private fileToRoots: Map<string, Set<string>> = new Map();
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    private async discover(): Promise<void> {
        if (this.roots !== null) return;

        const files = await vscode.workspace.findFiles('**/*.acs');
        this.roots = [];

        for (const uri of files) {
            if (await hasLibraryDirective(uri.fsPath)) {
                this.roots.push(uri.fsPath);
            }
        }
    }

    async ensureDiscovered(): Promise<void> {
        await this.discover();
    }

    getRoots(): string[] { return this.roots ?? []; }

    isRoot(filePath: string): boolean {
        if (!this.roots) return false;
        const resolved = path.resolve(filePath).toLowerCase();
        return this.roots.some(r => path.resolve(r).toLowerCase() === resolved);
    }

    lookupByFile(filePath: string): string[] {
        const resolved = path.resolve(filePath).toLowerCase();
        const roots = this.fileToRoots.get(resolved);
        return roots ? [...roots] : [];
    }

    registerFileToRoots(filePath: string, rootFile: string): void {
        const resolved = path.resolve(filePath).toLowerCase();
        const rootResolved = path.resolve(rootFile);
        let roots = this.fileToRoots.get(resolved);
        if (!roots) {
            roots = new Set();
            this.fileToRoots.set(resolved, roots);
        }
        roots.add(rootResolved);
    }

    unregisterFile(filePath: string): Set<string> | undefined {
        const resolved = path.resolve(filePath).toLowerCase();
        const roots = this.fileToRoots.get(resolved);
        this.fileToRoots.delete(resolved);
        return roots;
    }
}

async function hasLibraryDirective(filePath: string): Promise<boolean> {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(1024);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);

        const header = buf.toString('utf-8', 0, bytesRead);
        const clean = header
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        return /#library\b/im.test(clean);
    } catch {
        return false;
    }
}

// ── WorkspaceIndex ──

export class WorkspaceIndex {
    private libraryIndex: LibraryIndex;
    private cuCache = new Map<string, CompilationUnit>();
    private fileToRoots = new Map<string, Set<string>>();
    private includeResolver: IncludeResolver;

    constructor(includeResolver: IncludeResolver, workspaceRoot: string) {
        this.includeResolver = includeResolver;
        this.libraryIndex = new LibraryIndex(workspaceRoot);
    }

    async getCompilationUnits(filePath: string): Promise<CompilationUnit[]> {
        await this.libraryIndex.ensureDiscovered();

        const resolved = path.resolve(filePath);

        // Already in cache
        const roots = this.fileToRoots.get(resolved.toLowerCase());
        if (roots && roots.size > 0) {
            const cus: CompilationUnit[] = [];
            for (const root of roots) {
                const cu = this.cuCache.get(root);
                if (cu) cus.push(cu);
            }
            if (cus.length > 0) return cus;
        }

        // filePath itself is a library root
        if (this.libraryIndex.isRoot(resolved)) {
            const cu = await this.buildAndCache(resolved);
            return [cu];
        }

        // Search through library roots
        const result: CompilationUnit[] = [];
        for (const root of this.libraryIndex.getRoots()) {
            let cu = this.cuCache.get(root);
            if (!cu) {
                cu = await this.buildAndCache(root);
            }
            if (cu.files.has(resolved)) {
                result.push(cu);
            }
        }

        if (result.length > 0) return result;

        // Standalone file
        const cu = await this.buildAndCache(resolved);
        return [cu];
    }

    private async buildAndCache(rootFile: string): Promise<CompilationUnit> {
        const cu = await CompilationUnit.build(rootFile, this.includeResolver);

        const rootResolved = path.resolve(rootFile);
        this.cuCache.set(rootResolved, cu);

        for (const f of cu.files) {
            const fResolved = path.resolve(f).toLowerCase();
            let roots = this.fileToRoots.get(fResolved);
            if (!roots) {
                roots = new Set();
                this.fileToRoots.set(fResolved, roots);
            }
            roots.add(rootResolved);
        }

        return cu;
    }

    invalidate(filePath: string): void {
        const resolved = path.resolve(filePath).toLowerCase();
        const roots = this.fileToRoots.get(resolved);
        if (roots) {
            for (const root of roots) {
                this.cuCache.delete(root);
            }
            for (const root of roots) {
                const filesToRemove: string[] = [];
                for (const [file, fileRoots] of this.fileToRoots) {
                    if (fileRoots.has(root)) {
                        fileRoots.delete(root);
                        if (fileRoots.size === 0) {
                            filesToRemove.push(file);
                        }
                    }
                }
                for (const f of filesToRemove) {
                    this.fileToRoots.delete(f);
                }
            }
        }
    }

    async getVisibleSymbols(filePath: string): Promise<{
        variables: ReadonlyArray<{ name: string; detail: string }>;
        constants: ReadonlyArray<{ name: string; detail: string }>;
    }> {
        const cus = await this.getCompilationUnits(filePath);
        const cu = selectCompilationUnit(filePath, cus);
        if (!cu) return { variables: [], constants: [] };

        const resolved = path.resolve(filePath);
        const all = cu.symbolTable.all();
        return {
            variables: all.filter(s => s.kind === 'variable').map(s => ({
                name: s.name,
                detail: 'Variable' + (s.containerFile !== resolved ? ' (included)' : ''),
            })),
            constants: all.filter(s => s.kind === 'constant').map(s => ({
                name: s.name,
                detail: 'Constant (#define)' + (s.containerFile !== resolved ? ' (included)' : ''),
            })),
        };
    }
}

// ── CU selection strategy ──

export function selectCompilationUnit(
    _filePath: string,
    cus: CompilationUnit[]
): CompilationUnit | null {
    if (cus.length === 0) return null;
    return cus[0];
}
