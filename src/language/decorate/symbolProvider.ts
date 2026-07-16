import * as vscode from 'vscode';

const ACTOR_RE = /^\s*actor\s+(\w+)(?:\s*:\s*(\w+))?/i;
const LABEL_RE = /^\s*([A-Za-z_]\w*)\s*:/;
const STATES_RE = /^\s*states\b/i;
/** Zandronum: user vars are int-only; names must begin with user_. */
const USER_VAR_RE = /\bvar\s+int\s+(user_\w+)(?:\s*\[\s*(\d+)\s*\])?/gi;
const CONST_RE = /\bconst\s+(int|float)\s+(\w+)/gi;
const EXCLUDED_LABELS = new Set(['actor', 'states', 'goto', 'loop', 'stop', 'wait', 'fail']);

function stripLineComment(text: string): string {
    const idx = text.indexOf('//');
    return idx >= 0 ? text.substring(0, idx) : text;
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

function pushUserVarSymbols(
    line: number,
    text: string,
    effective: string,
    children: vscode.DocumentSymbol[]
): void {
    USER_VAR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USER_VAR_RE.exec(effective)) !== null) {
        const name = m[1];
        const size = m[2];
        const displayName = size !== undefined ? `${name}[${size}]` : name;
        const detail = size !== undefined ? `var int[${size}]` : 'var int';
        const nameChar = text.indexOf(name, m.index);
        if (nameChar < 0) {
            continue;
        }
        const nameRange = new vscode.Range(line, nameChar, line, nameChar + name.length);
        children.push(new vscode.DocumentSymbol(
            displayName,
            detail,
            vscode.SymbolKind.Variable,
            nameRange,
            nameRange
        ));
    }
}

function pushConstSymbols(
    line: number,
    text: string,
    effective: string,
    children: vscode.DocumentSymbol[]
): void {
    CONST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CONST_RE.exec(effective)) !== null) {
        const type = m[1].toLowerCase();
        const name = m[2];
        const nameChar = text.indexOf(name, m.index);
        if (nameChar < 0) {
            continue;
        }
        const nameRange = new vscode.Range(line, nameChar, line, nameChar + name.length);
        children.push(new vscode.DocumentSymbol(
            name,
            `const ${type}`,
            vscode.SymbolKind.Constant,
            nameRange,
            nameRange
        ));
    }
}

function collectActorChildren(
    document: vscode.TextDocument,
    actor: ActorBlock,
    token: vscode.CancellationToken
): vscode.DocumentSymbol[] {
    const children: vscode.DocumentSymbol[] = [];
    let inStates = false;
    const labelLines: number[] = [];

    for (let l = actor.startLine + 1; l < actor.endLine; l++) {
        if (token.isCancellationRequested) {
            break;
        }

        const text = document.lineAt(l).text;
        const effective = stripLineComment(text);

        if (!inStates) {
            if (STATES_RE.test(effective)) {
                inStates = true;
                continue;
            }
            pushUserVarSymbols(l, text, effective, children);
            pushConstSymbols(l, text, effective, children);
            continue;
        }

        const lm = LABEL_RE.exec(effective);
        if (!lm) {
            continue;
        }
        const label = lm[1];
        if (EXCLUDED_LABELS.has(label.toLowerCase())) {
            continue;
        }
        labelLines.push(l);
    }

    for (let i = 0; i < labelLines.length; i++) {
        const l = labelLines[i];
        const text = document.lineAt(l).text;
        const lm = LABEL_RE.exec(stripLineComment(text))!;
        const label = lm[1];
        const labelChar = text.indexOf(label);

        const nextLine = (i + 1 < labelLines.length)
            ? labelLines[i + 1] - 1
            : actor.endLine - 1;

        const labelRange = new vscode.Range(
            l, labelChar,
            l, labelChar + label.length
        );
        const spanRange = new vscode.Range(
            l, 0,
            nextLine, document.lineAt(nextLine).text.length
        );

        children.push(
            new vscode.DocumentSymbol(
                label,
                '',
                vscode.SymbolKind.Event,
                spanRange,
                labelRange
            )
        );
    }

    return children;
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

                    actorSymbol.children = collectActorChildren(document, actor, token);
                    symbols.push(actorSymbol);
                }

                return symbols;
            }
        }
    );

    context.subscriptions.push(provider);
}
