import * as vscode from 'vscode';
import * as path from 'path';
import { AcsConstantData } from '../shared/dataLoader';
import { scanLineDeclarations } from '../language/acs/scanner';
import { WorkspaceIndex, selectCompilationUnit } from '../language/acs/compilationUnit';

const legend = new vscode.SemanticTokensLegend(
    ['variable', 'enumMember'],
    ['declaration', 'readonly']
);

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
    private workspaceIndex: WorkspaceIndex;

    constructor(
        constantsData: Record<string, AcsConstantData>,
        workspaceIndex: WorkspaceIndex
    ) {
        this.builtInConsts = new Set(Object.keys(constantsData).map(k => k.toLowerCase()));
        this.workspaceIndex = workspaceIndex;
    }

    async provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): Promise<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const userVars = new Map<string, number[]>();
        const userConsts = new Map<string, number[]>();

        // Pass 1: collect local declarations
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
                    const key = name.toLowerCase();
                    const arr = userConsts.get(key) || [];
                    arr.push(line);
                    userConsts.set(key, arr);
                },
                () => {}, // includes handled by CompilationUnit
                (name) => {
                    const key = name.toLowerCase();
                    const arr = userVars.get(key) || [];
                    arr.push(line);
                    userVars.set(key, arr);
                }
            );
        }

        // Get cross-file declarations from CompilationUnit
        const cus = await this.workspaceIndex.getCompilationUnits(document.uri.fsPath);
        const cu = selectCompilationUnit(document.uri.fsPath, cus);
        const crossVars = cu ? cu.symbolTable.variables() : new Set<string>();
        const crossConsts = cu ? cu.symbolTable.constants() : new Set<string>();

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

                const after = text.substring(afterIdx);

                const wordLower = word.toLowerCase();

                // 1. Local #define constant — may be used as script identifier
                const constDecls = userConsts.get(wordLower);
                if (constDecls !== undefined) {
                    const isDecl = constDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        isDecl ? 3 : 2
                    );
                    continue;
                }

                // 2. Cross-file #define constant (from CU)
                if (crossConsts.has(wordLower)) {
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        2
                    );
                    continue;
                }

                // 3. Built-in constants
                if (this.builtInConsts.has(wordLower)) {
                    builder.push(
                        line, wm.index, word.length,
                        1,
                        2
                    );
                    continue;
                }

                // Skip function calls/declarations — handled by TextMate grammar
                if (/^\s*\(/.test(after)) {
                    continue;
                }

                // 4. Local variable declaration
                const userDecls = userVars.get(wordLower);
                if (userDecls !== undefined) {
                    const isDecl = userDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        0,
                        isDecl ? 1 : 0
                    );
                    continue;
                }

                // 5. Cross-file variable (from CU)
                if (crossVars.has(wordLower)) {
                    builder.push(
                        line, wm.index, word.length,
                        0,
                        0
                    );
                    continue;
                }
            }
        }

        return builder.build();
    }
}

export function registerAcsSemanticTokens(
    context: vscode.ExtensionContext,
    constantsData: Record<string, AcsConstantData>,
    workspaceIndex: WorkspaceIndex
) {
    const provider = new AcsSemanticTokensProvider(constantsData, workspaceIndex);

    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'acs' },
            provider,
            legend
        )
    );
}
