import * as vscode from 'vscode';
import { ACS_KEYWORDS, scanLineDeclarations } from './scanner';
import { ActionData, AcsConstantData } from '../../shared/dataLoader';
import {
    collectWordRanges,
    isValidIdent,
    wordAt,
    WordRange
} from '../shared/renameUtils';

type DeclKind = 'variable' | 'constant';

interface FileDecl {
    name: string;
    kind: DeclKind;
    line: number;
}

interface LineSpan {
    startLine: number;
    endLine: number;
}

interface ResolvedSymbol {
    name: string;
    start: number;
    end: number;
    kind: DeclKind;
    /** When set, rename/refs are limited to this script/function body. */
    scope?: LineSpan;
}

const SCRIPT_RE = /^\s*script\s+("[^"]*"|\d+|[A-Za-z_]\w*)(?:\s+(\w+))?/i;
const FUNCTION_RE = /^\s*function\s+(?:\w+\s+)?([A-Za-z_]\w+)\s*\(/i;

function stripCommentsAndStrings(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '/') {
            break;
        }
        if (text[i] === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            i = end >= 0 ? end + 2 : text.length;
            continue;
        }
        if (text[i] === '"') {
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\') {
                    i++;
                }
                i++;
            }
            i++;
            continue;
        }
        out += text[i];
        i++;
    }
    return out;
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
        const cleaned = stripCommentsAndStrings(lines[l]);
        for (const ch of cleaned) {
            if (ch === '{') {
                depth++;
                started = true;
            } else if (ch === '}') {
                depth--;
            }
        }
        if (started && depth === 0) {
            return l;
        }
    }

    return lines.length - 1;
}

/** Nearest enclosing `script` / `function` unit containing `line`, if any. */
export function findEnclosingAcsUnitInLines(lines: string[], line: number): LineSpan | undefined {
    let best: LineSpan | undefined;
    for (let l = 0; l < lines.length; l++) {
        const text = lines[l];
        if (!SCRIPT_RE.test(text) && !FUNCTION_RE.test(text)) {
            continue;
        }
        const braceLine = findOpeningBraceInLines(lines, l);
        if (braceLine < 0) {
            continue;
        }
        const endLine = findClosingBraceInLines(lines, braceLine);
        if (line >= l && line <= endLine) {
            const span = { startLine: l, endLine };
            if (!best || (span.startLine >= best.startLine && span.endLine <= best.endLine)) {
                best = span;
            }
        }
    }
    return best;
}

function collectFileDeclarations(document: vscode.TextDocument): FileDecl[] {
    const decls: FileDecl[] = [];
    let inBlockComment = false;

    for (let line = 0; line < document.lineCount; line++) {
        const text = document.lineAt(line).text;
        if (inBlockComment) {
            if (text.includes('*/')) {
                inBlockComment = false;
            }
            continue;
        }

        const lineCommentIdx = text.indexOf('//');
        const effective = lineCommentIdx >= 0 ? text.substring(0, lineCommentIdx) : text;
        const blockStart = effective.indexOf('/*');
        if (blockStart >= 0) {
            const blockEnd = effective.indexOf('*/', blockStart + 2);
            if (blockEnd < 0) {
                inBlockComment = true;
            }
        }

        scanLineDeclarations(
            effective,
            (name) => {
                decls.push({ name, kind: 'constant', line });
            },
            () => {},
            (name) => {
                decls.push({ name, kind: 'variable', line });
            }
        );
    }

    return decls;
}

function declMap(decls: FileDecl[]): Map<string, FileDecl[]> {
    const map = new Map<string, FileDecl[]>();
    for (const d of decls) {
        const key = d.name.toLowerCase();
        const arr = map.get(key) || [];
        arr.push(d);
        map.set(key, arr);
    }
    return map;
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
    // Apply from end to start so offsets stay valid within a line
    const sorted = [...ranges].sort((a, b) =>
        a.line !== b.line ? b.line - a.line : b.start - a.start
    );
    for (const r of sorted) {
        edit.replace(uri, new vscode.Range(r.line, r.start, r.line, r.end), newName);
    }
    return edit;
}

function collectOptionsForSymbol(resolved: ResolvedSymbol) {
    return {
        caseInsensitive: true as const,
        skipPrintCast: true as const,
        ...(resolved.scope
            ? {
                startLine: resolved.scope.startLine,
                endLineInclusive: resolved.scope.endLine
            }
            : {})
    };
}

export function registerAcsRenameAndReferences(
    context: vscode.ExtensionContext,
    functionsData: Record<string, ActionData>,
    constantsData: Record<string, AcsConstantData>
) {
    const builtinFns = new Set(Object.keys(functionsData).map(k => k.toLowerCase()));
    const builtinConsts = new Set(Object.keys(constantsData).map(k => k.toLowerCase()));

    const selector = [{ language: 'acs' }];

    const references = vscode.languages.registerReferenceProvider(selector, {
        provideReferences(document, position) {
            const resolved = resolveSymbol(document, position);
            if (!resolved) {
                return [];
            }
            const lines = document.getText().split(/\r?\n/);
            const ranges = collectWordRanges(lines, resolved.name, collectOptionsForSymbol(resolved));
            return rangesToLocations(document.uri, ranges);
        }
    });

    const rename = vscode.languages.registerRenameProvider(selector, {
        prepareRename(document, position) {
            const resolved = resolveSymbol(document, position);
            if (!resolved) {
                throw new Error('Only user-declared ACS variables and #defines in this file can be renamed.');
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
            if (!isValidIdent(newName)) {
                throw new Error('Invalid identifier.');
            }
            const newKey = newName.toLowerCase();
            if (ACS_KEYWORDS.has(newKey)) {
                throw new Error(`"${newName}" is an ACS keyword.`);
            }
            if (builtinFns.has(newKey)) {
                throw new Error(`"${newName}" is a built-in ACS function.`);
            }
            if (builtinConsts.has(newKey)) {
                throw new Error(`"${newName}" is a built-in ACS constant.`);
            }

            const decls = collectFileDeclarations(document);
            const byName = declMap(decls);
            const conflict = byName.get(newKey);
            if (conflict && newKey !== resolved.name.toLowerCase()) {
                const conflictInScope = resolved.scope
                    ? conflict.some(c =>
                        c.line >= resolved.scope!.startLine && c.line <= resolved.scope!.endLine)
                    : true;
                if (conflictInScope) {
                    throw new Error(
                        resolved.scope
                            ? `"${newName}" is already declared in this script/function.`
                            : `"${newName}" is already declared in this file.`
                    );
                }
            }

            const lines = document.getText().split(/\r?\n/);
            const ranges = collectWordRanges(lines, resolved.name, collectOptionsForSymbol(resolved));
            if (ranges.length === 0) {
                return null;
            }
            return buildWorkspaceEdit(document.uri, ranges, newName);
        }
    });

    context.subscriptions.push(references, rename);

    function resolveSymbol(
        document: vscode.TextDocument,
        position: vscode.Position
    ): ResolvedSymbol | null {
        const lineText = document.lineAt(position.line).text;
        const w = wordAt(lineText, position.character);
        if (!w) {
            return null;
        }
        const key = w.word.toLowerCase();
        if (ACS_KEYWORDS.has(key) || builtinFns.has(key) || builtinConsts.has(key)) {
            return null;
        }
        const decls = collectFileDeclarations(document);
        const matches = declMap(decls).get(key);
        if (!matches || matches.length === 0) {
            return null;
        }

        const kind = matches.some(m => m.kind === 'variable') ? 'variable' : matches[0].kind;
        // #define / constants stay file-wide
        if (kind === 'constant') {
            return { name: w.word, start: w.start, end: w.end, kind };
        }

        const lines = document.getText().split(/\r?\n/);
        const unit = findEnclosingAcsUnitInLines(lines, position.line);
        if (unit) {
            const localDecls = matches.filter(
                m =>
                    m.kind === 'variable' &&
                    m.line >= unit.startLine &&
                    m.line <= unit.endLine
            );
            if (localDecls.length > 0) {
                return {
                    name: w.word,
                    start: w.start,
                    end: w.end,
                    kind,
                    scope: unit
                };
            }
        }

        // Map/world/global variable (or use outside any unit): file-wide
        return { name: w.word, start: w.start, end: w.end, kind };
    }
}
