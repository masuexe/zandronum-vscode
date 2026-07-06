import * as vscode from 'vscode';

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

class DecorateSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const userVars = new Map<string, number[]>();
        const constVars = new Map<string, number[]>();

        // Pass 1: collect declarations
        let inBlockComment = false;

        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            if (inBlockComment) {
                const end = text.indexOf('*/');
                if (end >= 0) inBlockComment = false;
                continue;
            }

            // Strip line comments for declaration detection
            const lineCommentIdx = text.indexOf('//');
            const effective = lineCommentIdx >= 0 ? text.substring(0, lineCommentIdx) : text;

            // Track block comments
            const blockStart = effective.indexOf('/*');
            if (blockStart >= 0) {
                const blockEnd = effective.indexOf('*/', blockStart + 2);
                if (blockEnd < 0) inBlockComment = true;
            }

            let m: RegExpExecArray | null;

            const varRe = /\bvar\s+int\s+(user_\w+)\b/gi;
            while ((m = varRe.exec(effective)) !== null) {
                const name = m[1].toLowerCase();
                const arr = userVars.get(name) || [];
                arr.push(line);
                userVars.set(name, arr);
            }

            const constRe = /\bconst\s+int\s+(\w+)\b/gi;
            while ((m = constRe.exec(effective)) !== null) {
                const name = m[1].toLowerCase();
                const arr = constVars.get(name) || [];
                arr.push(line);
                constVars.set(name, arr);
            }
        }

        // Pass 2: find all occurrences and push tokens
        inBlockComment = false;

        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const stringRanges = getStringRanges(text);
            const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
            let wm: RegExpExecArray | null;

            // Compute comment ranges for this line
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

                const wordLower = word.toLowerCase();

                const userDecls = userVars.get(wordLower);
                if (userDecls !== undefined) {
                    const isDecl = userDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        0, // variable
                        isDecl ? 1 : 0
                    );
                    continue;
                }

                const constDecls = constVars.get(wordLower);
                if (constDecls !== undefined) {
                    const isDecl = constDecls.includes(line);
                    builder.push(
                        line, wm.index, word.length,
                        1, // enumMember
                        isDecl ? 3 : 2
                    );
                }
            }
        }

        return builder.build();
    }
}

export function registerDecorateSemanticTokens(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: 'decorate' },
            new DecorateSemanticTokensProvider(),
            legend
        )
    );
}
