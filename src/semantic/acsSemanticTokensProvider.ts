import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AcsConstantData } from '../shared/dataLoader';

const legend = new vscode.SemanticTokensLegend(
    ['variable', 'enumMember'],
    ['declaration', 'readonly']
);

const ACS_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'break', 'continue', 'return', 'until', 'terminate', 'restart', 'suspend', 'goto',
    'script', 'function', 'void',
    'true', 'false', 'on', 'off',
    'world', 'global',
    'int', 'str', 'bool', 'fixed',
]);

interface IncludeDeclarations {
    vars: Set<string>;
    consts: Set<string>;
}

function getStringRanges(text: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let inString = false;
    let stringStart = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') {
            if (!inString) {
                stringStart = i + 1;
                inString = true;
            } else {
                ranges.push({ start: stringStart, end: i });
                inString = false;
            }
        }
    }

    if (inString) {
        ranges.push({ start: stringStart, end: text.length });
    }

    return ranges;
}

function isInString(charIndex: number, ranges: Array<{ start: number; end: number }>): boolean {
    return ranges.some(r => charIndex >= r.start && charIndex < r.end);
}

function isInComment(charIndex: number, lineCommentStart: number, blockRanges: Array<{ start: number; end: number }>): boolean {
    if (lineCommentStart >= 0 && charIndex >= lineCommentStart) return true;
    return blockRanges.some(r => charIndex >= r.start && charIndex < r.end);
}

function scanLineDeclarations(
    effective: string,
    onDefine: (name: string) => void,
    onInclude: (includePath: string) => void,
    onVariable: (name: string) => void
): void {
    const includeMatch = /^\s*#\s*include\s+"([^"]*)"/i.exec(effective);
    if (includeMatch) {
        onInclude(includeMatch[1]);
        return;
    }

    const defineMatch = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(effective);
    if (defineMatch) {
        const name = defineMatch[1];
        if (!ACS_KEYWORDS.has(name.toLowerCase())) {
            onDefine(name);
        }
    }

    // Function/script parameters: (int param, str param, ...)
    const paramsRe = /\(([^)]*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramsRe.exec(effective)) !== null) {
        const paramVarRe = /\b(int|str|bool|fixed)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
        let pvm: RegExpExecArray | null;
        while ((pvm = paramVarRe.exec(pm[1])) !== null) {
            const varName = pvm[2];
            if (!ACS_KEYWORDS.has(varName.toLowerCase())) {
                onVariable(varName);
            }
        }
    }

    // Top-level / block variable declarations: int|str|bool|fixed ... ;
    const varDeclRe = /\b(int|str|bool|fixed)\s+([^;]+);/gi;
    let m: RegExpExecArray | null;
    while ((m = varDeclRe.exec(effective)) !== null) {
        let tail = m[2];
        let prevTail: string;
        do {
            prevTail = tail;
            tail = tail.replace(/\([^()]*\)/g, '');
        } while (tail !== prevTail);
        const parts = tail.split(',');
        for (const part of parts) {
            const trimmed = part.trimStart().replace(/^\d+:\s*/, '');
            const idMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
            if (idMatch) {
                const varName = idMatch[1];
                if (!ACS_KEYWORDS.has(varName.toLowerCase())) {
                    onVariable(varName);
                }
            }
        }
    }
}

function findFileRecursive(dir: string, targetName: string): string | null {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }

    const targetLower = targetName.toLowerCase();

    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findFileRecursive(full, targetName);
            if (found) {
                return found;
            }
        } else if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
            return full;
        }
    }

    return null;
}

function resolveIncludePath(
    includeName: string,
    currentDir: string,
    workspaceRoot: string
): string | null {
    const relative = path.resolve(currentDir, includeName);
    if (fs.existsSync(relative)) {
        return relative;
    }

    const srcDir = path.join(workspaceRoot, 'src');
    if (fs.existsSync(srcDir)) {
        const found = findFileRecursive(srcDir, includeName);
        if (found) {
            return found;
        }
    }

    const wsFound = findFileRecursive(workspaceRoot, includeName);
    if (wsFound) {
        return wsFound;
    }

    return null;
}

class AcsSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private builtInConsts: Set<string>;
    private includeCache: Map<string, IncludeDeclarations> = new Map();

    constructor(constantsData: Record<string, AcsConstantData>) {
        this.builtInConsts = new Set(Object.keys(constantsData));
    }

    clearIncludeCache(): void {
        this.includeCache.clear();
    }

    private getIncludeDeclarations(
        filePath: string,
        workspaceRoot: string,
        visited: Set<string>
    ): IncludeDeclarations {
        const key = path.resolve(filePath).toLowerCase();

        const cached = this.includeCache.get(key);
        if (cached) {
            return cached;
        }

        if (visited.has(key)) {
            return { vars: new Set(), consts: new Set() };
        }
        visited.add(key);

        const result = this.parseFileDeclarations(filePath, workspaceRoot, visited);
        this.includeCache.set(key, result);
        return result;
    }

    private parseFileDeclarations(
        filePath: string,
        workspaceRoot: string,
        visited: Set<string>
    ): IncludeDeclarations {
        const result: IncludeDeclarations = { vars: new Set(), consts: new Set() };

        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            return result;
        }

        const lines = content.split('\n');
        const currentDir = path.dirname(filePath);
        let inBlockComment = false;

        for (const line of lines) {
            if (inBlockComment) {
                const end = line.indexOf('*/');
                if (end >= 0) {
                    inBlockComment = false;
                }
                continue;
            }

            const lineCommentIdx = line.indexOf('//');
            const effective = lineCommentIdx >= 0 ? line.substring(0, lineCommentIdx) : line;

            const blockStart = effective.indexOf('/*');
            if (blockStart >= 0) {
                const blockEnd = effective.indexOf('*/', blockStart + 2);
                if (blockEnd < 0) {
                    inBlockComment = true;
                }
            }

            scanLineDeclarations(
                effective,
                (name) => { result.consts.add(name); },
                (includeName) => {
                    const resolved = resolveIncludePath(includeName, currentDir, workspaceRoot);
                    if (resolved) {
                        const sub = this.getIncludeDeclarations(resolved, workspaceRoot, visited);
                        for (const v of sub.vars) {
                            result.vars.add(v);
                        }
                        for (const c of sub.consts) {
                            result.consts.add(c);
                        }
                    }
                },
                (name) => { result.vars.add(name); }
            );
        }

        return result;
    }

    provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const userVars = new Map<string, number[]>();
        const userConsts = new Map<string, number[]>();
        const localIncludes: string[] = [];

        // Pass 1: collect declarations
        let inBlockComment = false;

        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            if (inBlockComment) {
                const end = text.indexOf('*/');
                if (end >= 0) inBlockComment = false;
                continue;
            }

            const lineCommentIdx = text.indexOf('//');
            const effective = lineCommentIdx >= 0 ? text.substring(0, lineCommentIdx) : text;

            const blockStart = effective.indexOf('/*');
            if (blockStart >= 0) {
                const blockEnd = effective.indexOf('*/', blockStart + 2);
                if (blockEnd < 0) inBlockComment = true;
            }

            scanLineDeclarations(
                effective,
                (name) => {
                    const arr = userConsts.get(name) || [];
                    arr.push(line);
                    userConsts.set(name, arr);
                },
                (includePath) => {
                    localIncludes.push(includePath);
                },
                (name) => {
                    const arr = userVars.get(name) || [];
                    arr.push(line);
                    userVars.set(name, arr);
                }
            );
        }

        // Resolve cross-file declarations from includes
        const crossVars = new Set<string>();
        const crossConsts = new Set<string>();

        if (localIncludes.length > 0) {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
                const currentDir = path.dirname(document.uri.fsPath);
                const visited = new Set<string>();

                for (const incName of localIncludes) {
                    const resolved = resolveIncludePath(incName, currentDir, workspaceRoot);
                    if (resolved) {
                        const decl = this.getIncludeDeclarations(resolved, workspaceRoot, visited);
                        for (const v of decl.vars) {
                            crossVars.add(v);
                        }
                        for (const c of decl.consts) {
                            crossConsts.add(c);
                        }
                    }
                }
            }
        }

        // Pass 2: find all occurrences and push tokens
        inBlockComment = false;

        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const stringRanges = getStringRanges(text);
            const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
            let wm: RegExpExecArray | null;

            let lineCommentStart = -1;
            const blockRanges: Array<{ start: number; end: number }> = [];

            let i = 0;
            while (i < text.length) {
                if (inBlockComment) {
                    const start = i;
                    const end = text.indexOf('*/', i);
                    if (end >= 0) {
                        blockRanges.push({ start, end: end + 2 });
                        i = end + 2;
                        inBlockComment = false;
                    } else {
                        blockRanges.push({ start, end: text.length });
                        i = text.length;
                    }
                } else if (text[i] === '/' && text[i + 1] === '/') {
                    lineCommentStart = i;
                    break;
                } else if (text[i] === '/' && text[i + 1] === '*') {
                    const start = i;
                    const end = text.indexOf('*/', i + 2);
                    if (end >= 0) {
                        blockRanges.push({ start, end: end + 2 });
                        i = end + 2;
                    } else {
                        blockRanges.push({ start, end: text.length });
                        inBlockComment = true;
                        i = text.length;
                    }
                } else {
                    i++;
                }
            }

            while ((wm = wordRe.exec(text)) !== null) {
                const word = wm[0];

                if (isInString(wm.index, stringRanges)) continue;
                if (isInComment(wm.index, lineCommentStart, blockRanges)) continue;

                // Skip printcast prefix (s:, d:, c:, etc.) — handled by TextMate grammar
                const afterIdx = wm.index + word.length;
                if (afterIdx < text.length && text[afterIdx] === ':' && /^[abcdfiklnsx]$/i.test(word)) {
                    continue;
                }

                // 1. Local variable declaration
                const userDecls = userVars.get(word);
                if (userDecls !== undefined) {
                    const isDecl = userDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        0,
                        isDecl ? 1 : 0
                    );
                    continue;
                }

                // 2. Local #define constant
                const constDecls = userConsts.get(word);
                if (constDecls !== undefined) {
                    const isDecl = constDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        isDecl ? 3 : 2
                    );
                    continue;
                }

                // 3. Cross-file variable (from included files)
                if (crossVars.has(word)) {
                    builder.push(
                        line, wm.index, word.length,
                        0,
                        0
                    );
                    continue;
                }

                // 4. Cross-file #define constant (from included files)
                if (crossConsts.has(word)) {
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        2
                    );
                    continue;
                }

                // 5. Built-in constants
                if (this.builtInConsts.has(word)) {
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        2
                    );
                }
            }
        }

        return builder.build();
    }
}

export function registerAcsSemanticTokens(
    context: vscode.ExtensionContext,
    constantsData: Record<string, AcsConstantData>
) {
    const provider = new AcsSemanticTokensProvider(constantsData);

    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'acs' },
            provider,
            legend
        )
    );

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.languageId === 'acs') {
                provider.clearIncludeCache();
            }
        })
    );
}
