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

class DecorateSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
    provideDocumentSemanticTokens(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.SemanticTokens> {
        const builder = new vscode.SemanticTokensBuilder(legend);
        const userVars = new Map<string, number[]>();
        const constVars = new Map<string, number[]>();

        // Pass 1: collect declarations
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;

            let m = /\bvar\s+int\s+(user_\w+)\b/i.exec(text);
            if (m) {
                const name = m[1].toLowerCase();
                const arr = userVars.get(name) || [];
                arr.push(line);
                userVars.set(name, arr);
            }

            m = /\bconst\s+int\s+(\w+)\b/i.exec(text);
            if (m) {
                const name = m[1].toLowerCase();
                const arr = constVars.get(name) || [];
                arr.push(line);
                constVars.set(name, arr);
            }
        }

        // Pass 2: find all occurrences and push tokens
        for (let line = 0; line < document.lineCount; line++) {
            const text = document.lineAt(line).text;
            const stringRanges = getStringRanges(text);
            const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
            let wm: RegExpExecArray | null;

            while ((wm = wordRe.exec(text)) !== null) {
                const word = wm[0];

                if (isInString(wm.index, stringRanges)) {
                    continue;
                }

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
                    continue;
                }

                // System enums: SXF_*, CHF_*, INVENTORY.*, WEAPON.* etc.
                if (/\b[A-Z][A-Z0-9]*[_.][A-Z][A-Z0-9_]+\b/.test(word)) {
                    builder.push(
                        line, wm.index, word.length,
                        1, // enumMember
                        0
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
