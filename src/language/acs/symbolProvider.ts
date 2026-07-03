import * as vscode from 'vscode';

const SCRIPT_RE = /^\s*script\s+("[^"]*"|\d+|[A-Za-z_]\w*)(?:\s+(\w+))?/i;
const FUNCTION_RE = /^\s*function\s+(?:\w+\s+)?([A-Za-z_]\w+)\s*\(/i;

function findOpeningBrace(document: vscode.TextDocument, startLine: number): number {
    if (document.lineAt(startLine).text.includes('{')) {
        return startLine;
    }
    for (let l = startLine + 1; l < document.lineCount; l++) {
        if (document.lineAt(l).text.includes('{')) {
            return l;
        }
    }
    return -1;
}

function findClosingBrace(document: vscode.TextDocument, startLine: number): number {
    let depth = 0;
    let started = false;

    for (let l = startLine; l < document.lineCount; l++) {
        const text = document.lineAt(l).text;
        for (const ch of text) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) {
            return l;
        }
    }

    return document.lineCount - 1;
}

export function registerAcsSymbolProvider(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(
            [{ language: 'acs' }],
            {
                provideDocumentSymbols(document, token) {
                    const symbols: vscode.DocumentSymbol[] = [];

                    for (let line = 0; line < document.lineCount; line++) {
                        if (token.isCancellationRequested) {
                            break;
                        }

                        const text = document.lineAt(line).text;

                        const fnMatch = FUNCTION_RE.exec(text);
                        if (fnMatch) {
                            const name = fnMatch[1];
                            const nameIdx = text.indexOf(name);
                            const braceLine = findOpeningBrace(document, line);
                            const endLine = braceLine >= 0
                                ? findClosingBrace(document, braceLine)
                                : line;

                            const nameRange = new vscode.Range(
                                line, nameIdx,
                                line, nameIdx + name.length
                            );
                            const fullRange = new vscode.Range(
                                line, 0,
                                endLine, document.lineAt(endLine).text.length
                            );

                            symbols.push(new vscode.DocumentSymbol(
                                name,
                                'function',
                                vscode.SymbolKind.Function,
                                fullRange,
                                nameRange
                            ));
                            continue;
                        }

                        const scMatch = SCRIPT_RE.exec(text);
                        if (scMatch) {
                            const ident = scMatch[1];
                            const scriptType = scMatch[2] || '';
                            const name = ident.startsWith('"') ? ident.slice(1, -1) : ident;
                            const nameIdx = text.indexOf(ident);
                            const braceLine = findOpeningBrace(document, line);
                            const endLine = braceLine >= 0
                                ? findClosingBrace(document, braceLine)
                                : line;

                            const nameRange = new vscode.Range(
                                line, nameIdx,
                                line, nameIdx + ident.length
                            );
                            const fullRange = new vscode.Range(
                                line, 0,
                                endLine, document.lineAt(endLine).text.length
                            );

                            symbols.push(new vscode.DocumentSymbol(
                                name,
                                scriptType || 'script',
                                vscode.SymbolKind.Event,
                                fullRange,
                                nameRange
                            ));
                        }
                    }

                    return symbols;
                }
            }
        )
    );
}
