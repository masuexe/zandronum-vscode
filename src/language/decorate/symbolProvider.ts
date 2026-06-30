import * as vscode from 'vscode';

const ACTOR_RE = /^\s*actor\s+(\w+)(?:\s*:\s*(\w+))?/i;
const LABEL_RE = /^\s*([A-Za-z_]\w*)\s*:/;
const EXCLUDED_LABELS = new Set(['actor', 'states', 'goto', 'loop', 'stop', 'wait', 'fail']);

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

interface ActorBlock {
    name: string;
    parentClass?: string;
    nameLine: number;
    nameChar: number;
    startLine: number;
    endLine: number;
}

export function registerDecorateSymbolProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerDocumentSymbolProvider(
        [{ language: 'decorate' }],
        {
            provideDocumentSymbols(document, token) {
                const actors: ActorBlock[] = [];

                for (let line = 0; line < document.lineCount; line++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const text = document.lineAt(line).text;
                    const m = ACTOR_RE.exec(text);
                    if (!m) {
                        continue;
                    }

                    const name = m[1];
                    const parentClass = m[2];
                    const nameIndex = text.indexOf(name);

                    const braceLine = findOpeningBrace(document, line);
                    const endLine = braceLine >= 0
                        ? findClosingBrace(document, braceLine)
                        : line;

                    actors.push({
                        name,
                        parentClass,
                        nameLine: line,
                        nameChar: nameIndex,
                        startLine: line,
                        endLine
                    });
                }

                const symbols: vscode.DocumentSymbol[] = [];

                for (const actor of actors) {
                    const nameRange = new vscode.Range(
                        actor.nameLine, actor.nameChar,
                        actor.nameLine, actor.nameChar + actor.name.length
                    );
                    const fullRange = new vscode.Range(
                        actor.startLine, 0,
                        actor.endLine, document.lineAt(actor.endLine).text.length
                    );
                    const detail = actor.parentClass ? `\u2192 ${actor.parentClass}` : '';

                    const actorSymbol = new vscode.DocumentSymbol(
                        actor.name,
                        detail,
                        vscode.SymbolKind.Class,
                        fullRange,
                        nameRange
                    );

                    for (let l = actor.startLine + 1; l < actor.endLine; l++) {
                        const text = document.lineAt(l).text;
                        const lm = LABEL_RE.exec(text);
                        if (!lm) {
                            continue;
                        }

                        const label = lm[1];
                        if (EXCLUDED_LABELS.has(label.toLowerCase())) {
                            continue;
                        }

                        const labelChar = text.indexOf(label);
                        const labelRange = new vscode.Range(
                            l, labelChar,
                            l, labelChar + label.length
                        );

                        actorSymbol.children.push(
                            new vscode.DocumentSymbol(
                                label,
                                '',
                                vscode.SymbolKind.Event,
                                labelRange,
                                labelRange
                            )
                        );
                    }

                    symbols.push(actorSymbol);
                }

                return symbols;
            }
        }
    );

    context.subscriptions.push(provider);
}
