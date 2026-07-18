import * as vscode from 'vscode';
import {
    collectWordRanges,
    isValidIdent,
    isValidUserVarName,
    wordAt,
    WordRange
} from '../shared/renameUtils';

const ACTOR_RE = /^\s*actor\s+(\w+)/i;

interface ActorSpan {
    startLine: number;
    endLine: number;
}

type DecorateDeclKind = 'userVar' | 'const';

interface DecorateDecl {
    name: string;
    kind: DecorateDeclKind;
    line: number;
}

function findOpeningBraceInLines(lines: string[], startLine: number): number {
    if (lines[startLine]?.includes('{')) {
        return startLine;
    }
    for (let l = startLine + 1; l < lines.length; l++) {
        if (lines[l].includes('{')) {
            return l;
        }
    }
    return -1;
}

function findClosingBraceInLines(lines: string[], startLine: number): number {
    let depth = 0;
    let started = false;

    for (let l = startLine; l < lines.length; l++) {
        const text = lines[l];
        for (const ch of text) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) {
            return l;
        }
    }

    return lines.length - 1;
}

/** Find actor block containing `line` in raw source lines, or null. */
export function findActorSpanInLines(lines: string[], line: number): ActorSpan | null {
    let best: ActorSpan | null = null;

    for (let l = 0; l < lines.length; l++) {
        if (!ACTOR_RE.test(lines[l])) {
            continue;
        }
        const braceLine = findOpeningBraceInLines(lines, l);
        if (braceLine < 0) {
            continue;
        }
        const endLine = findClosingBraceInLines(lines, braceLine);
        if (line >= l && line <= endLine) {
            best = { startLine: l, endLine };
        }
    }

    return best;
}

/** Find actor block containing `line`, or null. */
export function findActorContainingLine(
    document: vscode.TextDocument,
    line: number
): ActorSpan | null {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return findActorSpanInLines(lines, line);
}

function stripLineComment(text: string): string {
    const idx = text.indexOf('//');
    return idx >= 0 ? text.substring(0, idx) : text;
}

function collectActorDeclarations(
    document: vscode.TextDocument,
    actor: ActorSpan
): DecorateDecl[] {
    const decls: DecorateDecl[] = [];
    const varRe = /\bvar\s+int\s+(user_\w+)\b/gi;
    const constRe = /\bconst\s+(?:int|float)\s+(\w+)\b/gi;

    for (let line = actor.startLine; line <= actor.endLine; line++) {
        const effective = stripLineComment(document.lineAt(line).text);
        let m: RegExpExecArray | null;
        varRe.lastIndex = 0;
        while ((m = varRe.exec(effective)) !== null) {
            decls.push({ name: m[1], kind: 'userVar', line });
        }
        constRe.lastIndex = 0;
        while ((m = constRe.exec(effective)) !== null) {
            decls.push({ name: m[1], kind: 'const', line });
        }
    }

    return decls;
}

function rangesToLocations(uri: vscode.Uri, ranges: WordRange[]): vscode.Location[] {
    return ranges.map(r => new vscode.Location(
        uri,
        new vscode.Range(r.line, r.start, r.line, r.end)
    ));
}

function buildWorkspaceEdit(
    uri: vscode.Uri,
    ranges: WordRange[],
    newName: string
): vscode.WorkspaceEdit {
    const edit = new vscode.WorkspaceEdit();
    const sorted = [...ranges].sort((a, b) =>
        a.line !== b.line ? b.line - a.line : b.start - a.start
    );
    for (const r of sorted) {
        edit.replace(uri, new vscode.Range(r.line, r.start, r.line, r.end), newName);
    }
    return edit;
}

export function registerDecorateRenameAndReferences(context: vscode.ExtensionContext) {
    const selector = [{ language: 'decorate' }];

    const references = vscode.languages.registerReferenceProvider(selector, {
        provideReferences(document, position) {
            const resolved = resolveSymbol(document, position);
            if (!resolved) {
                return [];
            }
            const lines = document.getText().split(/\r?\n/);
            const ranges = collectWordRanges(lines, resolved.name, {
                caseInsensitive: true,
                startLine: resolved.actor.startLine,
                endLineInclusive: resolved.actor.endLine
            });
            return rangesToLocations(document.uri, ranges);
        }
    });

    const rename = vscode.languages.registerRenameProvider(selector, {
        prepareRename(document, position) {
            const resolved = resolveSymbol(document, position);
            if (!resolved) {
                throw new Error('Only user_ variables and const declarations inside an actor can be renamed.');
            }
            return new vscode.Range(
                position.line,
                resolved.start,
                position.line,
                resolved.end
            );
        },

        provideRenameEdits(document, position, newName) {
            const resolved = resolveSymbol(document, position);
            if (!resolved) {
                return null;
            }

            if (resolved.kind === 'userVar') {
                if (!isValidUserVarName(newName)) {
                    throw new Error('User variables must be named user_<name> (letters, digits, underscore).');
                }
            } else if (!isValidIdent(newName)) {
                throw new Error('Invalid identifier.');
            }

            const newKey = newName.toLowerCase();
            const decls = collectActorDeclarations(document, resolved.actor);
            if (
                newKey !== resolved.name.toLowerCase() &&
                decls.some(d => d.name.toLowerCase() === newKey)
            ) {
                throw new Error(`"${newName}" is already declared in this actor.`);
            }

            const lines = document.getText().split(/\r?\n/);
            const ranges = collectWordRanges(lines, resolved.name, {
                caseInsensitive: true,
                startLine: resolved.actor.startLine,
                endLineInclusive: resolved.actor.endLine
            });
            if (ranges.length === 0) {
                return null;
            }
            return buildWorkspaceEdit(document.uri, ranges, newName);
        }
    });

    context.subscriptions.push(references, rename);
}

function resolveSymbol(
    document: vscode.TextDocument,
    position: vscode.Position
): {
    name: string;
    start: number;
    end: number;
    kind: DecorateDeclKind;
    actor: ActorSpan;
} | null {
    const actor = findActorContainingLine(document, position.line);
    if (!actor) {
        return null;
    }

    const lineText = document.lineAt(position.line).text;
    const w = wordAt(lineText, position.character);
    if (!w) {
        return null;
    }

    const decls = collectActorDeclarations(document, actor);
    const key = w.word.toLowerCase();
    const match = decls.find(d => d.name.toLowerCase() === key);
    if (!match) {
        return null;
    }

    return {
        name: w.word,
        start: w.start,
        end: w.end,
        kind: match.kind,
        actor
    };
}
