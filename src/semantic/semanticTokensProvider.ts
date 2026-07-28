import * as vscode from 'vscode';
import { SymbolDatabase } from '../base/symbolDatabase';
import { findActorSpanInLines } from '../language/decorate/renameProvider';
import {
    parseActorHeader,
    visibleUserVarsForActor,
} from '../language/decorate/actorUserVars';

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

function isInComment(
    charIndex: number,
    lineCommentStart: number,
    blockRanges: Array<{ start: number; end: number }>
): boolean {
    if (lineCommentStart >= 0 && charIndex >= lineCommentStart) {
        return true;
    }
    return blockRanges.some(r => charIndex >= r.start && charIndex < r.end);
}

interface ActorTokenScope {
    startLine: number;
    endLine: number;
    /** lowercase user_* visible in this actor */
    userVars: Set<string>;
    /** lowercase → declaration line numbers within this document */
    userVarDeclLines: Map<string, number[]>;
    /** lowercase const names declared in this actor */
    constVars: Map<string, number[]>;
}

class DecorateSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeSemanticTokens = this.changeEmitter.event;

    constructor(private readonly symbolDb?: SymbolDatabase) {}

    notifyChanged(): void {
        this.changeEmitter.fire();
    }

    provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
        }

        const scopes = this.buildActorScopes(lines);
        const lineToScope: Array<ActorTokenScope | undefined> = new Array(lines.length);

        for (const scope of scopes) {
            for (let l = scope.startLine; l <= scope.endLine; l++) {
                lineToScope[l] = scope;
            }
        }

        // File-level consts still supported for tokens outside actors? Keep per-actor only.
        let inBlockComment = false;

        for (let line = 0; line < lines.length; line++) {
            const text = lines[line];
            const stringRanges = getStringRanges(text);
            const wordRe = /[A-Za-z0-9_]+/g;
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

            const scope = lineToScope[line];

            while ((wm = wordRe.exec(text)) !== null) {
                const word = wm[0];

                if (isInString(wm.index, stringRanges)) {
                    continue;
                }
                if (isInComment(wm.index, lineCommentStart, blockRanges)) {
                    continue;
                }

                if (!scope) {
                    continue;
                }

                const wordLower = word.toLowerCase();

                if (scope.userVars.has(wordLower)) {
                    const declLines = scope.userVarDeclLines.get(wordLower);
                    const isDecl = declLines?.includes(line) === true;
                    builder.push(
                        line,
                        wm.index,
                        word.length,
                        0,
                        isDecl ? 1 : 0
                    );
                    continue;
                }

                const constDecls = scope.constVars.get(wordLower);
                if (constDecls !== undefined) {
                    const isDecl = constDecls.includes(line);
                    builder.push(
                        line,
                        wm.index,
                        word.length,
                        1,
                        isDecl ? 3 : 2
                    );
                }
            }
        }

        return builder.build();
    }

    private buildActorScopes(lines: string[]): ActorTokenScope[] {
        const scopes: ActorTokenScope[] = [];
        const seenStarts = new Set<number>();

        for (let line = 0; line < lines.length; line++) {
            const header = parseActorHeader(lines[line]);
            if (!header) {
                continue;
            }
            const span = findActorSpanInLines(lines, line);
            if (!span || seenStarts.has(span.startLine)) {
                continue;
            }
            seenStarts.add(span.startLine);

            const localVars = new Set<string>();
            const userVarDeclLines = new Map<string, number[]>();
            const varRe = /\bvar\s+int\s+(user_\w+)\b/gi;
            for (let l = span.startLine; l <= span.endLine; l++) {
                const text = lines[l];
                const commentIdx = text.indexOf('//');
                const effective = commentIdx >= 0 ? text.slice(0, commentIdx) : text;
                varRe.lastIndex = 0;
                let vm: RegExpExecArray | null;
                while ((vm = varRe.exec(effective)) !== null) {
                    const name = vm[1].toLowerCase();
                    localVars.add(name);
                    const arr = userVarDeclLines.get(name) || [];
                    arr.push(l);
                    userVarDeclLines.set(name, arr);
                }
            }

            const userVars = visibleUserVarsForActor(
                this.symbolDb,
                header.name,
                header.parentClass,
                localVars
            );

            const constVars = new Map<string, number[]>();
            const constRe = /\bconst\s+int\s+(\w+)\b/gi;
            for (let l = span.startLine; l <= span.endLine; l++) {
                const text = lines[l];
                const commentIdx = text.indexOf('//');
                const effective = commentIdx >= 0 ? text.slice(0, commentIdx) : text;
                constRe.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = constRe.exec(effective)) !== null) {
                    const name = m[1].toLowerCase();
                    const arr = constVars.get(name) || [];
                    arr.push(l);
                    constVars.set(name, arr);
                }
            }

            scopes.push({
                startLine: span.startLine,
                endLine: span.endLine,
                userVars,
                userVarDeclLines,
                constVars
            });
        }

        return scopes;
    }
}

let decorateSemanticTokensProvider: DecorateSemanticTokensProvider | undefined;

export function registerDecorateSemanticTokens(
    context: vscode.ExtensionContext,
    symbolDb?: SymbolDatabase
) {
    decorateSemanticTokensProvider = new DecorateSemanticTokensProvider(symbolDb);
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'decorate' },
            decorateSemanticTokensProvider,
            legend
        )
    );
}

/** Refresh DECORATE semantic tokens after SymbolDatabase rebuild. */
export function refreshDecorateSemanticTokens(): void {
    decorateSemanticTokensProvider?.notifyChanged();
}
