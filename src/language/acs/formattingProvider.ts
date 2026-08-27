import * as vscode from 'vscode';

export type BraceStyle = 'nextLine' | 'sameLine';

export interface AcsFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
    braceStyle: BraceStyle;
    /** When true, empty same-line blocks become `{ }` and nextLine may split them. */
    spaceInEmptyBraces: boolean;
    spaceAfterComma: boolean;
    /** When true, strip blank lines immediately above a closing `}`. */
    removeBlankLinesBeforeCloseBrace: boolean;
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

const HASH_RE = /^#/;

/**
 * Strip comments (and optionally strings) for structural scanning.
 * Carries block-comment state across lines; strings do not span lines (ACS).
 *
 * `text` — comments and strings removed (brace / paren depth).
 * `code` — comments removed, strings kept (trailing `,` / `(` continuation).
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

function makeIndent(level: number, options: AcsFormatOptions): string {
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

function applyParenDelta(depth: number, structural: string): number {
    let d = depth;
    for (const ch of structural) {
        if (ch === '(') {
            d++;
        } else if (ch === ')') {
            d = Math.max(0, d - 1);
        }
    }
    return d;
}

/**
 * Previous line still open for args / call lists (`foo(` or `...,`).
 * Use comment-stripped text that still includes strings.
 */
function lineOpensContinuation(commentStrippedTrim: string): boolean {
    return commentStrippedTrim.endsWith(',') || commentStrippedTrim.endsWith('(');
}

/** Flow keywords are always new statements, never call-arg continuations. */
const ACS_FLOW_STMT_RE =
    /^(?:suspend|terminate|restart|goto|break|continue|return|case|default|else|do|until)\b/i;

/**
 * True when this line continues a multi-line call / parameter list.
 * Leading whitespace is left alone so author alignment is preserved.
 */
function isContinuationLine(
    structuralTrim: string,
    parenDepthBefore: number,
    prevOpensContinuation: boolean
): boolean {
    if (!(parenDepthBefore > 0 || prevOpensContinuation)) {
        return false;
    }
    if (structuralTrim.length === 0) {
        return true;
    }
    if (structuralTrim.startsWith('}') || HASH_RE.test(structuralTrim)) {
        return false;
    }
    if (ACS_FLOW_STMT_RE.test(structuralTrim)) {
        return false;
    }
    return true;
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

type AfterBrace = 'none' | 'openOnly' | 'emptyBlock';

interface BraceTail {
    kind: AfterBrace;
    header: string;
    fromOpen: string;
    fromClose: string;
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
    if (rest.startsWith('//')) {
        return `${header} { ${rest}`;
    }
    return `${header} { ${rest}`;
}

function sameLineEmpty(header: string, fromClose: string): string {
    return `${header} { ${fromClose.trimStart()}`;
}

function isStandaloneOpenBrace(line: string, inBlockComment: boolean): boolean {
    if (inBlockComment) {
        return false;
    }
    const scanned = structuralLine(line, inBlockComment);
    return scanned.text.trim() === '{';
}

function isBlockHeaderLine(line: string, inBlockComment: boolean): boolean {
    if (inBlockComment) {
        return false;
    }
    const scanned = structuralLine(line, inBlockComment);
    const trim = scanned.text.trim();
    return trim.length > 0 && !trim.includes('{') && !HASH_RE.test(trim);
}

function applyBraceStyle(
    lines: readonly string[],
    braceStyle: BraceStyle,
    startLine: number,
    endLine: number,
    spaceInEmptyBraces: boolean
): { lines: string[]; startLine: number; endLine: number } {
    if (endLine < startLine || lines.length === 0) {
        return { lines: lines.slice(), startLine, endLine };
    }

    if (braceStyle === 'sameLine') {
        return applySameLineBraces(lines, startLine, endLine, spaceInEmptyBraces);
    }
    return applyNextLineBraces(lines, startLine, endLine, spaceInEmptyBraces);
}

function applyNextLineBraces(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    spaceInEmptyBraces: boolean
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
        if (split.kind === 'emptyBlock') {
            if (!spaceInEmptyBraces) {
                out.push(line);
                continue;
            }
            out.push(split.header);
            out.push('{');
            out.push(split.fromClose);
            extra += 2;
            continue;
        }
        out.push(line);
    }

    return { lines: out, startLine, endLine: endLine + extra };
}

function applySameLineBraces(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    spaceInEmptyBraces: boolean
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
            if (split.kind === 'emptyBlock') {
                if (!spaceInEmptyBraces) {
                    out.push(line);
                    continue;
                }
                out.push(sameLineEmpty(split.header, split.fromClose));
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
            out[out.length - 1] = `${lines[i - 1].trimEnd()} {`;
            extra--;
            continue;
        }

        out.push(line);
    }

    return { lines: out, startLine, endLine: endLine + extra };
}

function formatSpaceAfterCommaLine(
    line: string,
    spaceAfter: boolean,
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
            out += ch;
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
            const startsComment =
                j < line.length &&
                line[j] === '/' &&
                (line[j + 1] === '/' || line[j + 1] === '*');
            if (atEnd || startsComment) {
                out += line.slice(i, j);
                i = j;
                continue;
            }
            if (spaceAfter) {
                out += ' ';
            }
            i = j;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applyCommaSpacing(
    lines: readonly string[],
    spaceAfter: boolean,
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatSpaceAfterCommaLine(out[i], spaceAfter, inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

export function removeBlankLinesBeforeCloseBrace(
    lines: readonly string[],
    startLine: number,
    endLine: number
): { lines: string[]; startLine: number; endLine: number } {
    if (endLine < startLine || lines.length === 0) {
        return { lines: lines.slice(), startLine, endLine };
    }

    const out: string[] = [];
    const blankBuffer: string[] = [];
    let inBlockComment = false;
    let removed = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const inBlockAtStart: boolean = inBlockComment;
        inBlockComment = structuralLine(line, inBlockAtStart).inBlockComment;

        if (line.trim().length === 0) {
            blankBuffer.push(line);
            continue;
        }

        const structuralTrim = structuralLine(line, inBlockAtStart).text.trim();
        const isCloseBrace = structuralTrim.startsWith('}');

        if (isCloseBrace && blankBuffer.length > 0 && inRange(i, startLine, endLine)) {
            const blankStart = i - blankBuffer.length;
            for (let b = 0; b < blankBuffer.length; b++) {
                const idx = blankStart + b;
                if (inRange(idx, startLine, endLine)) {
                    removed++;
                } else {
                    out.push(blankBuffer[b]);
                }
            }
            blankBuffer.length = 0;
        } else {
            for (const blank of blankBuffer) {
                out.push(blank);
            }
            blankBuffer.length = 0;
        }

        out.push(line);
    }

    for (const blank of blankBuffer) {
        out.push(blank);
    }

    return { lines: out, startLine, endLine: endLine - removed };
}

export function computeAcsLeadingEdits(
    lines: readonly string[],
    options: AcsFormatOptions,
    range?: LineRange
): LeadingEdit[] {
    const { startLine, endLine } = resolveLineRange(lines.length, range);
    if (endLine < startLine || lines.length === 0) {
        return [];
    }

    const edits: LeadingEdit[] = [];
    let depth = 0;
    let parenDepth = 0;
    let prevOpensContinuation = false;
    let inBlockComment = false;

    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const scanned = structuralLine(text, inBlockComment);
        inBlockComment = scanned.inBlockComment;
        const structural = scanned.text;
        const structuralTrim = structural.trim();
        const depthBefore = depth;
        const parenBefore = parenDepth;

        const isBlank = text.trim().length === 0;
        const isHash = HASH_RE.test(structuralTrim);
        const closesFirst = structuralTrim.startsWith('}');
        const continuation = isContinuationLine(
            structuralTrim,
            parenBefore,
            prevOpensContinuation
        );

        let newLeading: string | undefined;
        if (isBlank || continuation) {
            newLeading = undefined;
        } else if (isHash) {
            newLeading = '';
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

        depth = applyBraceDelta(depthBefore, structural);
        parenDepth = applyParenDelta(parenBefore, structural);
        if (!isBlank) {
            prevOpensContinuation = lineOpensContinuation(scanned.code.trim());
        }
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

export function formatAcsLines(
    lines: readonly string[],
    options: AcsFormatOptions,
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
        resolved.endLine,
        options.spaceInEmptyBraces
    );
    const stripped = options.removeBlankLinesBeforeCloseBrace
        ? removeBlankLinesBeforeCloseBrace(braced.lines, braced.startLine, braced.endLine)
        : braced;
    const commaed = applyCommaSpacing(
        stripped.lines,
        options.spaceAfterComma,
        stripped.startLine,
        stripped.endLine
    );
    return applyLeadingEdits(
        commaed,
        computeAcsLeadingEdits(commaed, options, {
            startLine: stripped.startLine,
            endLine: stripped.endLine,
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

function readBraceStyle(document: vscode.TextDocument): BraceStyle {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<string>('acs.format.braceStyle', 'nextLine');
    return raw === 'sameLine' ? 'sameLine' : 'nextLine';
}

function readSpaceAfterComma(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('acs.format.spaceAfterComma', true);
}

function readSpaceInEmptyBraces(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('acs.format.spaceInEmptyBraces', false);
}

function readRemoveBlankLinesBeforeCloseBrace(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('acs.format.removeBlankLinesBeforeCloseBrace', true);
}

function toFormatOptions(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
): AcsFormatOptions {
    return {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        braceStyle: readBraceStyle(document),
        spaceInEmptyBraces: readSpaceInEmptyBraces(document),
        spaceAfterComma: readSpaceAfterComma(document),
        removeBlankLinesBeforeCloseBrace: readRemoveBlankLinesBeforeCloseBrace(document),
    };
}

function documentEol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function editsFromDocument(
    document: vscode.TextDocument,
    formatOptions: AcsFormatOptions,
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

    const formatted = formatAcsLines(original, formatOptions, lineRange);
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

export function registerAcsFormattingProvider(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [{ language: 'acs' }];
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
