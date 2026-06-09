import * as vscode from 'vscode';
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

class AcsSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private builtInConsts: Set<string>;

    constructor(constantsData: Record<string, AcsConstantData>) {
        this.builtInConsts = new Set(Object.keys(constantsData));
    }

    provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const userVars = new Map<string, number[]>();
        const userConsts = new Map<string, number[]>();

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

            // #define constants
            const defineMatch = /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(effective);
            if (defineMatch) {
                const name = defineMatch[1];
                if (!ACS_KEYWORDS.has(name.toLowerCase())) {
                    const arr = userConsts.get(name) || [];
                    arr.push(line);
                    userConsts.set(name, arr);
                }
            }

            // Function/script parameters: (int param, str param, ...)
            const paramsRe = /\(([^)]*)\)/g;
            let pm: RegExpExecArray | null;
            while ((pm = paramsRe.exec(effective)) !== null) {
                const params = pm[1];
                const paramVarRe = /\b(int|str|bool|fixed)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
                let pvm: RegExpExecArray | null;
                while ((pvm = paramVarRe.exec(params)) !== null) {
                    const varName = pvm[2];
                    if (ACS_KEYWORDS.has(varName.toLowerCase())) continue;
                    const arr = userVars.get(varName) || [];
                    arr.push(line);
                    userVars.set(varName, arr);
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
                        if (ACS_KEYWORDS.has(varName.toLowerCase())) continue;
                        const arr = userVars.get(varName) || [];
                        arr.push(line);
                        userVars.set(varName, arr);
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
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'acs' },
            new AcsSemanticTokensProvider(constantsData),
            legend
        )
    );
}
