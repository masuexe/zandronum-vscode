import * as vscode from 'vscode';

export type StateLabelStyle = 'outdent' | 'indent';

export interface DecorateFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
    stateLabelStyle: StateLabelStyle;
}

export interface LineRange {
    startLine: number;
    endLine: number;
    /** When 0 and endLine > startLine, endLine is treated as exclusive (VS Code selection quirk). */
    endCharacter?: number;
}

export interface LeadingEdit {
    line: number;
    newLeading: string;
}

/** Unquoted state-label path ending with `:`. */
const LABEL_RE = /^[A-Za-z0-9_']+(?:\.[A-Za-z0-9_']+)*\s*:/;
const STATES_RE = /^states\b/i;
const HASH_RE = /^#/;

/**
 * Strip line/block comments and double-quoted strings for brace scanning.
 * Carries block-comment state across lines; strings do not span lines (DECORATE).
 */
export function structuralLine(
    line: string,
    inBlockComment: boolean
): { text: string; inBlockComment: boolean } {
    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let inString = false;

    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];

        if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            if (ch === '\\' && next !== undefined) {
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            break;
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function leadingWhitespaceLength(line: string): number {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
}

function makeIndent(level: number, options: DecorateFormatOptions): string {
    if (level <= 0) {
        return '';
    }
    const tabSize = Math.max(1, options.tabSize | 0);
    if (options.insertSpaces) {
        return ' '.repeat(level * tabSize);
    }
    return '\t'.repeat(level);
}

function applyBraceDelta(depth: number, structural: string): number {
    let d = depth;
    for (const ch of structural) {
        if (ch === '{') {
            d++;
        } else if (ch === '}') {
            d--;
        }
    }
    return Math.max(0, d);
}

function hasOpenBrace(structural: string): boolean {
    return structural.includes('{');
}

function isStateLabel(structuralTrim: string): boolean {
    return LABEL_RE.test(structuralTrim);
}

function resolveLineRange(
    lineCount: number,
    range?: LineRange
): { startLine: number; endLine: number } {
    if (!range) {
        return { startLine: 0, endLine: lineCount - 1 };
    }
    let startLine = Math.max(0, range.startLine);
    let endLine = Math.min(lineCount - 1, range.endLine);
    if (range.endCharacter === 0 && endLine > startLine) {
        endLine--;
    }
    if (startLine > endLine) {
        return { startLine: 0, endLine: -1 };
    }
    return { startLine, endLine };
}

/**
 * Compute leading-whitespace replacements for DECORATE lines.
 * Only leading indent changes; line content and trailing whitespace are preserved.
 */
export function computeDecorateLeadingEdits(
    lines: readonly string[],
    options: DecorateFormatOptions,
    range?: LineRange
): LeadingEdit[] {
    const { startLine, endLine } = resolveLineRange(lines.length, range);
    if (endLine < startLine || lines.length === 0) {
        return [];
    }

    const edits: LeadingEdit[] = [];
    let depth = 0;
    let inBlockComment = false;
    /** Brace depth of the interior of a `States { ... }` block, or -1. */
    let statesBodyDepth = -1;
    /** Depth when `States` was seen without `{` on the same line, or -1. */
    let pendingStatesDepth = -1;

    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const scanned = structuralLine(text, inBlockComment);
        inBlockComment = scanned.inBlockComment;
        const structural = scanned.text;
        const structuralTrim = structural.trim();
        const depthBefore = depth;

        const isBlank = text.trim().length === 0;
        const isHash = HASH_RE.test(structuralTrim);
        const isStates = STATES_RE.test(structuralTrim);
        const closesFirst = structuralTrim.startsWith('}');
        const inStatesTop =
            statesBodyDepth >= 0 && depthBefore === statesBodyDepth;
        const label =
            inStatesTop && structuralTrim.length > 0 && isStateLabel(structuralTrim);

        let indentLevel = depthBefore;
        if (isBlank) {
            // leave blank / whitespace-only lines alone
        } else if (isHash) {
            indentLevel = 0;
        } else if (closesFirst) {
            indentLevel = Math.max(0, depthBefore - 1);
        } else if (label && options.stateLabelStyle === 'outdent') {
            indentLevel = Math.max(0, depthBefore - 1);
        } else {
            indentLevel = depthBefore;
        }

        if (!isBlank && line >= startLine && line <= endLine) {
            const newLeading = makeIndent(indentLevel, options);
            const oldLeading = text.slice(0, leadingWhitespaceLength(text));
            if (oldLeading !== newLeading) {
                edits.push({ line, newLeading });
            }
        }

        if (isStates && !hasOpenBrace(structural)) {
            pendingStatesDepth = depthBefore;
        }

        const depthAfter = applyBraceDelta(depthBefore, structural);
        const opened = depthAfter > depthBefore;

        if (opened && (isStates || pendingStatesDepth >= 0)) {
            statesBodyDepth = depthAfter;
            pendingStatesDepth = -1;
        }

        depth = depthAfter;

        if (statesBodyDepth >= 0 && depth < statesBodyDepth) {
            statesBodyDepth = -1;
        }
        if (pendingStatesDepth >= 0 && depth < pendingStatesDepth) {
            pendingStatesDepth = -1;
        }
    }

    return edits;
}

/** Apply leading edits; returns a new array (unchanged lines keep the same string). */
export function applyLeadingEdits(
    lines: readonly string[],
    edits: readonly LeadingEdit[]
): string[] {
    if (edits.length === 0) {
        return lines.slice();
    }
    const out = lines.slice();
    for (const edit of edits) {
        const text = out[edit.line];
        const oldLen = leadingWhitespaceLength(text);
        out[edit.line] = edit.newLeading + text.slice(oldLen);
    }
    return out;
}

/** Format full lines (test helper). */
export function formatDecorateLines(
    lines: readonly string[],
    options: DecorateFormatOptions,
    range?: LineRange
): string[] {
    return applyLeadingEdits(lines, computeDecorateLeadingEdits(lines, options, range));
}

function readStateLabelStyle(document: vscode.TextDocument): StateLabelStyle {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<string>('decorate.format.stateLabelStyle', 'outdent');
    return raw === 'indent' ? 'indent' : 'outdent';
}

function toFormatOptions(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
): DecorateFormatOptions {
    return {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        stateLabelStyle: readStateLabelStyle(document),
    };
}

function editsFromDocument(
    document: vscode.TextDocument,
    formatOptions: DecorateFormatOptions,
    range?: vscode.Range
): vscode.TextEdit[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }

    const lineRange: LineRange | undefined = range
        ? {
            startLine: range.start.line,
            endLine: range.end.line,
            endCharacter: range.end.character,
        }
        : undefined;

    const leadingEdits = computeDecorateLeadingEdits(lines, formatOptions, lineRange);
    const result: vscode.TextEdit[] = [];
    for (const edit of leadingEdits) {
        const text = document.lineAt(edit.line).text;
        const oldLen = leadingWhitespaceLength(text);
        result.push(
            vscode.TextEdit.replace(
                new vscode.Range(edit.line, 0, edit.line, oldLen),
                edit.newLeading
            )
        );
    }
    return result;
}

export function registerDecorateFormattingProvider(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [{ language: 'decorate' }];
    const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
        provideDocumentFormattingEdits(document, options) {
            return editsFromDocument(document, toFormatOptions(document, options));
        },
        provideDocumentRangeFormattingEdits(document, range, options) {
            return editsFromDocument(document, toFormatOptions(document, options), range);
        },
    };

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, provider),
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, provider)
    );
}
