import * as vscode from 'vscode';

export type BraceStyle = 'nextLine' | 'sameLine';

export interface SbarinfoFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
    braceStyle: BraceStyle;
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

/**
 * Strip comments (and optionally strings) for structural scanning.
 * Carries block-comment state across lines; strings do not span lines.
 *
 * `text` — comments and strings removed (brace depth).
 * `code` — comments removed, strings kept.
 */
export function structuralLine(
    line: string,
    inBlockComment: boolean
): { text: string; code: string; inBlockComment: boolean } {
    let out = '';
    let code = '';
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
            code += ch;
            if (ch === '\\' && next !== undefined) {
                code += next;
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
            code += ch;
            i++;
            continue;
        }

        out += ch;
        code += ch;
        i++;
    }

    return { text: out, code, inBlockComment: inBlock };
}

function leadingWhitespaceLength(line: string): number {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
}

function rtrimHorizontal(text: string): string {
    return text.replace(/[ \t]+$/, '');
}

function lineHasCode(text: string): boolean {
    return text.slice(leadingWhitespaceLength(text)).length > 0;
}

function endsWithSpace(text: string): boolean {
    const ch = text[text.length - 1];
    return ch === ' ' || ch === '\t';
}

function ensureSpaceBefore(text: string): string {
    if (text.length === 0 || endsWithSpace(text)) {
        return text;
    }
    return `${text} `;
}

function isIdentChar(ch: string): boolean {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
}

/** `Translation"192:192=4:4"` → `Translation "192:192=4:4"`. */
function emitOpeningQuote(out: string): string {
    const last = out[out.length - 1];
    if (last !== undefined && isIdentChar(last)) {
        return `${ensureSpaceBefore(out)}"`;
    }
    return `${out}"`;
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

function inRange(line: number, startLine: number, endLine: number): boolean {
    return line >= startLine && line <= endLine;
}

function isCommentStart(line: string, index: number): boolean {
    return line[index] === '/' && (line[index + 1] === '/' || line[index + 1] === '*');
}

function makeIndent(level: number, options: SbarinfoFormatOptions): string {
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

function hasLineComment(line: string, inBlockComment: boolean): boolean {
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
            return true;
        }
        if (ch === '/' && next === '*') {
            return true;
        }
        if (ch === '"') {
            inString = true;
        }
        i++;
    }
    return false;
}

function skipSpaces(line: string, i: number): number {
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
        i++;
    }
    return i;
}

function isLineCommentAt(line: string, i: number): boolean {
    return line[i] === '/' && line[i + 1] === '/';
}

function isBlockCommentAt(line: string, i: number): boolean {
    return line[i] === '/' && line[i + 1] === '*';
}

function findFirstStructuralOpenBrace(line: string, inBlockComment: boolean): number {
    if (inBlockComment) {
        return -1;
    }
    let i = 0;
    let inString = false;
    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];
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
            return -1;
        }
        if (ch === '/' && next === '*') {
            return -1;
        }
        if (ch === '"') {
            inString = true;
            i++;
            continue;
        }
        if (ch === '{') {
            return i;
        }
        i++;
    }
    return -1;
}

type AfterBrace = 'none' | 'openOnly' | 'emptyBlock';

interface BraceTail {
    kind: AfterBrace;
    header: string;
    fromOpen: string;
    fromClose: string;
}

function classifySameLineBrace(line: string, inBlockComment: boolean): BraceTail {
    const none: BraceTail = { kind: 'none', header: '', fromOpen: '', fromClose: '' };
    const openIndex = findFirstStructuralOpenBrace(line, inBlockComment);
    if (openIndex < 0) {
        return none;
    }
    const header = line.slice(0, openIndex).trimEnd();
    if (header.trim().length === 0) {
        return none;
    }

    let i = skipSpaces(line, openIndex + 1);
    if (isBlockCommentAt(line, i)) {
        return none;
    }
    if (i >= line.length || isLineCommentAt(line, i)) {
        return {
            kind: 'openOnly',
            header,
            fromOpen: line.slice(openIndex),
            fromClose: '',
        };
    }
    if (line[i] === '}') {
        const closeIndex = i;
        i = skipSpaces(line, closeIndex + 1);
        if (i < line.length && !isLineCommentAt(line, i)) {
            return none;
        }
        return {
            kind: 'emptyBlock',
            header,
            fromOpen: '',
            fromClose: line.slice(closeIndex),
        };
    }
    return none;
}

function sameLineOpen(header: string, fromOpen: string): string {
    const rest = fromOpen.replace(/^\{[ \t]*/, '');
    if (rest.length === 0) {
        return `${header} {`;
    }
    return `${header} { ${rest}`;
}

function isStandaloneOpenBrace(line: string, inBlockComment: boolean): boolean {
    if (inBlockComment) {
        return false;
    }
    return structuralLine(line, inBlockComment).text.trim() === '{';
}

function isBlockHeaderLine(line: string, inBlockComment: boolean): boolean {
    if (inBlockComment) {
        return false;
    }
    const trim = structuralLine(line, inBlockComment).text.trim();
    return trim.length > 0 && !trim.includes('{');
}

function applyNextLineBraces(
    lines: readonly string[],
    startLine: number,
    endLine: number
): { lines: string[]; startLine: number; endLine: number } {
    const out: string[] = [];
    let inBlockComment = false;
    let extra = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const inBlockAtStart: boolean = inBlockComment;
        inBlockComment = structuralLine(line, inBlockAtStart).inBlockComment;

        if (!inRange(i, startLine, endLine)) {
            out.push(line);
            continue;
        }

        const split = classifySameLineBrace(line, inBlockAtStart);
        if (split.kind === 'openOnly') {
            out.push(split.header);
            const braceLine = split.fromOpen.trimEnd() === '{' ? '{' : split.fromOpen;
            out.push(braceLine);
            extra++;
            continue;
        }
        out.push(line);
    }

    return { lines: out, startLine, endLine: endLine + extra };
}

function applySameLineBraces(
    lines: readonly string[],
    startLine: number,
    endLine: number
): { lines: string[]; startLine: number; endLine: number } {
    const inBlockAt: boolean[] = [];
    let block = false;
    for (let i = 0; i < lines.length; i++) {
        inBlockAt.push(block);
        block = structuralLine(lines[i], block).inBlockComment;
    }

    const out: string[] = [];
    let extra = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const inBlockAtStart = inBlockAt[i];

        if (inRange(i, startLine, endLine)) {
            const split = classifySameLineBrace(line, inBlockAtStart);
            if (split.kind === 'openOnly') {
                out.push(sameLineOpen(split.header, split.fromOpen));
                continue;
            }
        }

        if (
            inRange(i, startLine, endLine) &&
            i > 0 &&
            inRange(i - 1, startLine, endLine) &&
            isStandaloneOpenBrace(line, inBlockAtStart) &&
            !hasLineComment(line, inBlockAtStart) &&
            !hasLineComment(lines[i - 1], inBlockAt[i - 1]) &&
            isBlockHeaderLine(lines[i - 1], inBlockAt[i - 1])
        ) {
            out[out.length - 1] = `${out[out.length - 1].trimEnd()} {`;
            extra--;
            continue;
        }

        out.push(line);
    }

    return { lines: out, startLine, endLine: endLine + extra };
}

function applyBraceStyle(
    lines: readonly string[],
    braceStyle: BraceStyle,
    startLine: number,
    endLine: number
): { lines: string[]; startLine: number; endLine: number } {
    if (endLine < startLine || lines.length === 0) {
        return { lines: lines.slice(), startLine, endLine };
    }
    if (braceStyle === 'sameLine') {
        return applySameLineBraces(lines, startLine, endLine);
    }
    return applyNextLineBraces(lines, startLine, endLine);
}

function formatSpaceAfterCommaLine(
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
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
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
            out += line.slice(i);
            break;
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        if (ch === ',') {
            out += ',';
            i++;
            let j = i;
            while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
                j++;
            }
            const atEnd = j >= line.length;
            const startsComment = j < line.length && isCommentStart(line, j);
            if (atEnd || startsComment) {
                out += line.slice(i, j);
                i = j;
                continue;
            }
            out += ' ';
            i = j;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function formatSpaceBeforeOpenBraceLine(
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
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
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
            out += line.slice(i);
            break;
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        if (ch === '{') {
            out = ensureSpaceBefore(out);
            out += '{';
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function formatSlashSlashComment(comment: string): string {
    let markerLen = 2;
    if (comment[2] === '/' || comment[2] === '!') {
        markerLen = 3;
    }
    const marker = comment.slice(0, markerLen);
    const rest = comment.slice(markerLen);
    const leadWs = /^[ \t]*/.exec(rest)?.[0] ?? '';
    if (leadWs.length >= 2) {
        return comment;
    }
    const body = rest.slice(leadWs.length);
    return body.length === 0 ? marker : `${marker} ${body}`;
}

function emitSlashSlashComment(out: string, comment: string): string {
    const formatted = formatSlashSlashComment(comment);
    if (lineHasCode(rtrimHorizontal(out))) {
        return `${rtrimHorizontal(out)}  ${formatted}`;
    }
    return `${out}${formatted}`;
}

function formatLineCommentSpacingLine(
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
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
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
            return { text: emitSlashSlashComment(out, line.slice(i)), inBlockComment: inBlock };
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applyLinePass(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    formatLine: (line: string, inBlockComment: boolean) => { text: string; inBlockComment: boolean }
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatLine(out[i], inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

export function computeSbarinfoLeadingEdits(
    lines: readonly string[],
    options: SbarinfoFormatOptions,
    range?: LineRange
): LeadingEdit[] {
    const { startLine, endLine } = resolveLineRange(lines.length, range);
    if (endLine < startLine || lines.length === 0) {
        return [];
    }

    const edits: LeadingEdit[] = [];
    let depth = 0;
    let inBlockComment = false;

    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const scanned = structuralLine(text, inBlockComment);
        inBlockComment = scanned.inBlockComment;
        const structuralTrim = scanned.text.trim();
        const depthBefore = depth;

        const isBlank = text.trim().length === 0;
        const closesFirst = structuralTrim.startsWith('}');

        let newLeading: string | undefined;
        if (isBlank) {
            newLeading = undefined;
        } else if (closesFirst) {
            newLeading = makeIndent(Math.max(0, depthBefore - 1), options);
        } else {
            newLeading = makeIndent(depthBefore, options);
        }

        if (newLeading !== undefined && line >= startLine && line <= endLine) {
            const oldLeading = text.slice(0, leadingWhitespaceLength(text));
            if (oldLeading !== newLeading) {
                edits.push({ line, newLeading });
            }
        }

        depth = applyBraceDelta(depthBefore, scanned.text);
    }

    return edits;
}

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

export function formatSbarinfoLines(
    lines: readonly string[],
    options: SbarinfoFormatOptions = {
        tabSize: 2,
        insertSpaces: true,
        braceStyle: 'nextLine',
    },
    range?: LineRange
): string[] {
    const resolved = resolveLineRange(lines.length, range);
    if (resolved.endLine < resolved.startLine) {
        return lines.slice();
    }

    const braced = applyBraceStyle(
        lines,
        options.braceStyle,
        resolved.startLine,
        resolved.endLine
    );
    const commaed = applyLinePass(
        braced.lines,
        braced.startLine,
        braced.endLine,
        formatSpaceAfterCommaLine
    );
    const openBraced = applyLinePass(
        commaed,
        braced.startLine,
        braced.endLine,
        formatSpaceBeforeOpenBraceLine
    );
    const commented = applyLinePass(
        openBraced,
        braced.startLine,
        braced.endLine,
        formatLineCommentSpacingLine
    );
    return applyLeadingEdits(
        commented,
        computeSbarinfoLeadingEdits(commented, options, {
            startLine: braced.startLine,
            endLine: braced.endLine,
        })
    );
}

export function trimTrailingBlankLines(lines: readonly string[]): string[] {
    const out = lines.slice();
    while (out.length > 0 && out[out.length - 1].trim().length === 0) {
        out.pop();
    }
    return out;
}

export function buildFormattedDocumentText(lines: readonly string[], eol: string): string {
    const trimmed = trimTrailingBlankLines(lines);
    if (trimmed.length === 0) {
        return eol;
    }
    return trimmed.join(eol) + eol;
}

function documentEol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function readBraceStyle(document: vscode.TextDocument): BraceStyle {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<string>('sbarinfo.format.braceStyle', 'nextLine');
    return raw === 'sameLine' ? 'sameLine' : 'nextLine';
}

function toFormatOptions(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
): SbarinfoFormatOptions {
    return {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        braceStyle: readBraceStyle(document),
    };
}

function editsFromDocument(
    document: vscode.TextDocument,
    formatOptions: SbarinfoFormatOptions,
    range?: vscode.Range
): vscode.TextEdit[] {
    const original: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        original.push(document.lineAt(i).text);
    }

    const lineRange: LineRange | undefined = range
        ? {
            startLine: range.start.line,
            endLine: range.end.line,
            endCharacter: range.end.character,
        }
        : undefined;

    const formatted = formatSbarinfoLines(original, formatOptions, lineRange);
    const eol = documentEol(document);

    if (!lineRange) {
        const oldText = document.getText();
        const newText = buildFormattedDocumentText(formatted, eol);
        if (newText === oldText) {
            return [];
        }
        return [
            vscode.TextEdit.replace(
                new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(oldText.length)
                ),
                newText
            ),
        ];
    }

    const resolved = resolveLineRange(original.length, lineRange);
    if (resolved.endLine < resolved.startLine) {
        return [];
    }
    const delta = formatted.length - original.length;
    const newEnd = resolved.endLine + delta;
    const replacement = formatted.slice(resolved.startLine, newEnd + 1).join(eol);
    const prior = original.slice(resolved.startLine, resolved.endLine + 1).join(eol);
    if (replacement === prior) {
        return [];
    }
    return [
        vscode.TextEdit.replace(
            new vscode.Range(
                resolved.startLine,
                0,
                resolved.endLine,
                original[resolved.endLine].length
            ),
            replacement
        ),
    ];
}

export function registerSbarinfoFormattingProvider(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [{ language: 'sbarinfo' }];
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
