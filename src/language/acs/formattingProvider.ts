import * as vscode from 'vscode';

export type BraceStyle = 'nextLine' | 'sameLine';

export interface AcsFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
    braceStyle: BraceStyle;
    /** When true, empty same-line blocks become `{ }` and nextLine may split them. */
    spaceInEmptyBraces: boolean;
    spaceAfterComma: boolean;
    /** When true, space after control keywords before `(` and before `{` after `)`. */
    spaceAfterControlKeyword: boolean;
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

/** ACC string literals use `"` or `'`; close only on the matching quote. */
function isAcsStringQuote(ch: string): boolean {
    return ch === '"' || ch === "'";
}

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
    let stringQuote: string | undefined;

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

        if (stringQuote !== undefined) {
            code += ch;
            if (ch === '\\' && next !== undefined) {
                code += next;
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
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

/** `//foo` → `// foo`; two or more spaces after the marker are left alone. */
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

/**
 * Trailing `//`: two spaces before the marker when the line has code;
 * full-line comments keep indent and only space the text after `//`.
 */
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
    let stringQuote: string | undefined;

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

        if (stringQuote !== undefined) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
            out += ch;
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applyLineCommentSpacing(
    lines: readonly string[],
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatLineCommentSpacingLine(out[i], inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
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

const BINARY_CONTINUATION_TWO = [
    '==',
    '!=',
    '<=',
    '>=',
    '&&',
    '||',
    '<<',
    '>>',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
];

/** clang BreakBeforeBinaryOperators / Prettier: `a` then newline `- b`. */
function lineStartsWithBinaryContinuationOp(structuralTrim: string): boolean {
    if (structuralTrim.length === 0) {
        return false;
    }
    const two = structuralTrim.slice(0, 2);
    if (BINARY_CONTINUATION_TWO.includes(two)) {
        return true;
    }
    const one = structuralTrim[0];
    return '+-*/%<>=&|^?:'.includes(one);
}

/**
 * Previous line looks like an unfinished expression (`x = a`, not `return` / `x = a;`).
 */
function lineEndsIncompleteExpr(commentStrippedTrim: string): boolean {
    if (commentStrippedTrim.length === 0 || HASH_RE.test(commentStrippedTrim)) {
        return false;
    }
    const last = commentStrippedTrim[commentStrippedTrim.length - 1];
    if (last === ';' || last === '{' || last === '}' || last === ',' || last === '(') {
        return false;
    }
    const afterFlow = commentStrippedTrim.replace(ACS_FLOW_STMT_RE, '');
    if (afterFlow !== commentStrippedTrim && afterFlow.trim().length === 0) {
        return false;
    }
    return /[A-Za-z0-9_)"'\]]$/.test(commentStrippedTrim);
}

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
    if (
        structuralTrim.startsWith('}') ||
        structuralTrim.startsWith('{') ||
        HASH_RE.test(structuralTrim)
    ) {
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
    let stringQuote: string | undefined;
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
        if (stringQuote !== undefined) {
            if (ch === '\\' && next !== undefined) {
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
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
    let stringQuote: string | undefined;
    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];
        if (stringQuote !== undefined) {
            if (ch === '\\' && next !== undefined) {
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
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
    let stringQuote: string | undefined;

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

        if (stringQuote !== undefined) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
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

const IDENT_CHAR_RE = /[A-Za-z0-9_]/;

function isIdentChar(ch: string): boolean {
    return IDENT_CHAR_RE.test(ch);
}

function isWordBoundaryBefore(line: string, index: number): boolean {
    return index === 0 || !isIdentChar(line[index - 1]);
}

function matchKeywordAt(line: string, index: number, keyword: string): boolean {
    if (!isWordBoundaryBefore(line, index)) {
        return false;
    }
    if (index + keyword.length > line.length) {
        return false;
    }
    for (let k = 0; k < keyword.length; k++) {
        if (line[index + k].toLowerCase() !== keyword[k].toLowerCase()) {
            return false;
        }
    }
    const after = index + keyword.length;
    return after >= line.length || !isIdentChar(line[after]);
}

function skipHorizontalSpace(line: string, index: number): number {
    let i = index;
    while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
        i++;
    }
    return i;
}

/** `192:192=248:248` / `16:47=[255,0,0]` / `112:127=%[0,0,0]` — not `n = 1`. */
function isPaletteRemapEquals(emitted: string, line: string, afterEq: number): boolean {
    if (!/:\d+$/.test(emitted)) {
        return false;
    }
    const j = skipHorizontalSpace(line, afterEq);
    if (j >= line.length) {
        return false;
    }
    const ch = line[j];
    return (ch >= '0' && ch <= '9') || ch === '[' || ch === '%';
}

function isBinaryOpStart(ch: string): boolean {
    return '><=!&|+-*/%'.includes(ch);
}

const KEYWORDS_BEFORE_PAREN = ['if', 'while', 'for', 'until', 'switch'] as const;

function formatControlFlowSpacingLine(
    line: string,
    enabled: boolean,
    inBlockComment: boolean
): { text: string; inBlockComment: boolean } {
    if (!enabled) {
        return { text: line, inBlockComment: structuralLine(line, inBlockComment).inBlockComment };
    }

    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let stringQuote: string | undefined;

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

        if (stringQuote !== undefined) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
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
        if (isAcsStringQuote(ch)) {
            stringQuote = ch;
            out += ch;
            i++;
            continue;
        }

        if (ch === '}') {
            out += ch;
            i++;
            const afterBrace = skipHorizontalSpace(line, i);
            if (matchKeywordAt(line, afterBrace, 'else') || matchKeywordAt(line, afterBrace, 'until')) {
                out += ' ';
                i = afterBrace;
            }
            continue;
        }

        if (ch === ')') {
            out += ch;
            i++;
            const afterParen = skipHorizontalSpace(line, i);
            if (afterParen < line.length && line[afterParen] === '{') {
                out += ' ';
                i = afterParen;
                continue;
            }
            if (afterParen < line.length && isBinaryOpStart(line[afterParen])) {
                out += ' ';
                i = afterParen;
            }
            continue;
        }

        if (matchKeywordAt(line, i, 'else')) {
            const kwEnd = i + 4;
            out += line.slice(i, kwEnd);
            i = skipHorizontalSpace(line, kwEnd);
            if (matchKeywordAt(line, i, 'if')) {
                out += ' ';
                const ifEnd = i + 2;
                out += line.slice(i, ifEnd);
                i = skipHorizontalSpace(line, ifEnd);
                if (i < line.length && line[i] === '(') {
                    out += ' ';
                }
                continue;
            }
            if (i < line.length) {
                out += ' ';
            }
            continue;
        }

        if (matchKeywordAt(line, i, 'do')) {
            const kwEnd = i + 2;
            out += line.slice(i, kwEnd);
            i = skipHorizontalSpace(line, kwEnd);
            if (i < line.length && line[i] === '{') {
                out += ' ';
            }
            continue;
        }

        let matchedKw = false;
        for (const kw of KEYWORDS_BEFORE_PAREN) {
            if (matchKeywordAt(line, i, kw)) {
                const kwEnd = i + kw.length;
                out += line.slice(i, kwEnd);
                i = skipHorizontalSpace(line, kwEnd);
                if (i < line.length && line[i] === '(') {
                    out += ' ';
                }
                matchedKw = true;
                break;
            }
        }
        if (matchedKw) {
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

type ExprKind = 'start' | 'open' | 'value' | 'op' | 'prefix' | 'keyword';

function isControlParenKeywordAt(line: string, index: number): boolean {
    for (const kw of KEYWORDS_BEFORE_PAREN) {
        if (matchKeywordAt(line, index, kw)) {
            return true;
        }
    }
    return false;
}

function readIdentAt(line: string, index: number): number {
    let i = index;
    while (i < line.length && isIdentChar(line[i])) {
        i++;
    }
    return i;
}

function isHexDigit(ch: string): boolean {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function readNumberAt(line: string, index: number): number {
    let i = index;
    while (i < line.length && line[i] >= '0' && line[i] <= '9') {
        i++;
    }
    if (
        i === index + 1 &&
        line[index] === '0' &&
        i < line.length &&
        (line[i] === 'x' || line[i] === 'X') &&
        i + 1 < line.length &&
        isHexDigit(line[i + 1])
    ) {
        i++;
        while (i < line.length && isHexDigit(line[i])) {
            i++;
        }
        return i;
    }
    if (i < line.length && line[i] === '.' && i + 1 < line.length && line[i + 1] >= '0' && line[i + 1] <= '9') {
        i++;
        while (i < line.length && line[i] >= '0' && line[i] <= '9') {
            i++;
        }
    }
    return i;
}

function readOperatorAt(line: string, index: number): string | undefined {
    const three = line.slice(index, index + 3);
    if (three === '<<=' || three === '>>=') {
        return three;
    }
    const two = line.slice(index, index + 2);
    if (
        two === '++' ||
        two === '--' ||
        two === '==' ||
        two === '!=' ||
        two === '<=' ||
        two === '>=' ||
        two === '&&' ||
        two === '||' ||
        two === '<<' ||
        two === '>>' ||
        two === '+=' ||
        two === '-=' ||
        two === '*=' ||
        two === '/=' ||
        two === '%=' ||
        two === '&=' ||
        two === '|=' ||
        two === '^='
    ) {
        return two;
    }
    const one = line[index];
    // `?` is the ternary operator (Google/Prettier: spaces on both sides).
    if ('+-*/%<>=!&|^?'.includes(one)) {
        return one;
    }
    return undefined;
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

function needsSpaceBeforeValue(kind: ExprKind): boolean {
    return kind === 'value' || kind === 'op' || kind === 'keyword';
}

function needsSpaceBeforeCallParen(kind: ExprKind, text: string): boolean {
    if (kind === 'op' || kind === 'keyword') {
        return true;
    }
    if (kind !== 'value') {
        return false;
    }
    const last = text[text.length - 1];
    // script 1 (void) / script "name" (void) — not a function call
    return last === '"' || last === "'" || (last !== undefined && last >= '0' && last <= '9');
}

/**
 * Tight function calls (`Name(`) and spaces around binary operators (`a + b`).
 * Control keywords keep `if (`; unary `+`/`-`/`!` stay tight.
 */
function formatCallAndOperatorSpacingLine(
    line: string,
    spaceAfterComma: boolean,
    spaceAfterControlKeyword: boolean,
    inBlockComment: boolean,
    exprContinuation: boolean,
    ternaryDepthStart: number
): { text: string; inBlockComment: boolean; ternaryDepth: number } {
    const leadLen = leadingWhitespaceLength(line);
    let out = line.slice(0, leadLen);
    let i = leadLen;
    let inBlock = inBlockComment;
    let stringQuote: string | undefined;
    let lastKind: ExprKind = 'start';
    let pendingCaseLabelColon = false;
    /** Unmatched `?` count — colon is ternary only while this is > 0. */
    let ternaryDepth = ternaryDepthStart;

    const emitValue = (token: string): void => {
        if (needsSpaceBeforeValue(lastKind)) {
            out = ensureSpaceBefore(out);
        }
        out += token;
        lastKind = 'value';
    };

    const emitBinary = (op: string): void => {
        out = ensureSpaceBefore(out);
        out += op;
        lastKind = 'op';
    };

    while (i < line.length) {
        const prevKind: ExprKind = lastKind;
        const ch = line[i];
        const next = line[i + 1];

        if (inBlock) {
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                // A closed block comment needs normal spacing before the next token.
                lastKind = 'value';
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (stringQuote !== undefined) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = undefined;
            }
            i++;
            lastKind = 'value';
            continue;
        }

        if (ch === '/' && next === '/') {
            if (needsSpaceBeforeValue(prevKind)) {
                out = ensureSpaceBefore(out);
            }
            out += line.slice(i);
            break;
        }
        if (ch === '/' && next === '*') {
            if (needsSpaceBeforeValue(prevKind)) {
                out = ensureSpaceBefore(out);
            }
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (isAcsStringQuote(ch)) {
            if (needsSpaceBeforeValue(prevKind)) {
                out = ensureSpaceBefore(out);
            }
            stringQuote = ch;
            out += ch;
            i++;
            lastKind = 'value';
            continue;
        }

        if (ch === ' ' || ch === '\t') {
            i++;
            continue;
        }

        if (ch === '#' && prevKind === 'start') {
            out += line.slice(i);
            break;
        }

        if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
            const end = readIdentAt(line, i);
            const ident = line.slice(i, end);
            const after = skipHorizontalSpace(line, end);
            if (after < line.length && line[after] === '(' && !matchKeywordAt(line, i, 'return')) {
                if (needsSpaceBeforeValue(prevKind)) {
                    out = ensureSpaceBefore(out);
                }
                if (isControlParenKeywordAt(line, i)) {
                    out += spaceAfterControlKeyword ? `${ident} (` : `${ident}(`;
                } else {
                    out += `${ident}(`;
                }
                i = after + 1;
                lastKind = 'open';
                continue;
            }
            if (
                prevKind === 'start' &&
                (matchKeywordAt(line, i, 'case') || matchKeywordAt(line, i, 'default'))
            ) {
                pendingCaseLabelColon = true;
            }
            emitValue(ident);
            if (matchKeywordAt(line, i, 'return')) {
                lastKind = 'keyword';
            }
            i = end;
            continue;
        }

        if (ch >= '0' && ch <= '9') {
            const end = readNumberAt(line, i);
            emitValue(line.slice(i, end));
            i = end;
            continue;
        }

        const op = readOperatorAt(line, i);
        if (op !== undefined) {
            if (op === '++' || op === '--') {
                out += op;
                i += 2;
                lastKind = prevKind === 'value' ? 'value' : 'prefix';
                continue;
            }
            if (exprContinuation && prevKind === 'start' && (op === '+' || op === '-')) {
                emitBinary(op);
                i += op.length;
                continue;
            }
            if (
                op === '!' ||
                ((op === '+' || op === '-') && (prevKind !== 'value' || pendingCaseLabelColon))
            ) {
                if (pendingCaseLabelColon || needsSpaceBeforeValue(prevKind)) {
                    out = ensureSpaceBefore(out);
                }
                out += op;
                i += op.length;
                lastKind = 'prefix';
                continue;
            }
            if (op === '=' && isPaletteRemapEquals(out, line, i + 1)) {
                out += '=';
                i += 1;
                lastKind = 'open';
                continue;
            }
            emitBinary(op);
            if (op === '?') {
                ternaryDepth++;
            }
            i += op.length;
            continue;
        }

        if (ch === '(') {
            if (needsSpaceBeforeCallParen(prevKind, out)) {
                out = ensureSpaceBefore(out);
            }
            out += ch;
            i++;
            lastKind = 'open';
            continue;
        }

        if (ch === '[') {
            out += ch;
            i++;
            lastKind = 'open';
            continue;
        }

        if (ch === ')' || ch === ']') {
            out += ch;
            i++;
            lastKind = 'value';
            continue;
        }

        if (ch === ',') {
            out += ',';
            i++;
            const after = skipHorizontalSpace(line, i);
            const atEnd = after >= line.length;
            if (spaceAfterComma && !atEnd && line[after] !== ')' && line[after] !== ']') {
                out += ' ';
            }
            i = after;
            lastKind = 'open';
            continue;
        }

        if (ch === ';') {
            out += ';';
            i++;
            const after = skipHorizontalSpace(line, i);
            const atEnd = after >= line.length;
            if (!atEnd && line[after] !== ')' && line[after] !== ']' && line[after] !== '}') {
                out += ' ';
            }
            i = after;
            lastKind = 'open';
            continue;
        }

        if (ch === ':') {
            // Google style: spaces on both sides of ternary `:`.
            // Printcasts (`s:"x"`), world/global slots (`1:name`), and case labels stay tight.
            // Wrapped `a ? b` / `: c` carries `?` depth; a leading `:` after an
            // incomplete expression is also the ternary colon (`:lvl` → `: lvl`).
            const wrappedTernaryColon = exprContinuation && prevKind === 'start';
            if (ternaryDepth > 0 || wrappedTernaryColon) {
                emitBinary(':');
                if (ternaryDepth > 0) {
                    ternaryDepth--;
                }
                i++;
                continue;
            }
            out += ':';
            i++;
            if (pendingCaseLabelColon) {
                pendingCaseLabelColon = false;
                const after = skipHorizontalSpace(line, i);
                const atEnd = after >= line.length;
                if (!atEnd) {
                    out += ' ';
                }
                i = after;
            }
            lastKind = 'open';
            continue;
        }

        if (ch === '{') {
            if (needsSpaceBeforeValue(prevKind)) {
                out = ensureSpaceBefore(out);
            }
            out += ch;
            i++;
            lastKind = 'start';
            continue;
        }

        if (ch === '}') {
            out += ch;
            i++;
            lastKind = 'value';
            continue;
        }

        out += ch;
        i++;
        lastKind = 'value';
    }

    return { text: out, inBlockComment: inBlock, ternaryDepth };
}

function applyCallAndOperatorSpacing(
    lines: readonly string[],
    spaceAfterComma: boolean,
    spaceAfterControlKeyword: boolean,
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    let prevIncompleteExpr = false;
    let ternaryDepth = 0;
    for (let i = 0; i < out.length; i++) {
        const inBlockAtStart = inBlockComment;
        const formatted = formatCallAndOperatorSpacingLine(
            out[i],
            spaceAfterComma,
            spaceAfterControlKeyword,
            inBlockComment,
            prevIncompleteExpr,
            ternaryDepth
        );
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
        if (out[i].trim().length > 0) {
            const code = structuralLine(out[i], inBlockAtStart).code.trim();
            if (code.length > 0) {
                prevIncompleteExpr = lineEndsIncompleteExpr(code);
                ternaryDepth = prevIncompleteExpr ? formatted.ternaryDepth : 0;
            }
        }
    }
    return out;
}

function applyControlFlowSpacing(
    lines: readonly string[],
    enabled: boolean,
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatControlFlowSpacingLine(out[i], enabled, inBlockComment);
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

function skipBalancedParens(s: string, openAt: number): number {
    if (s[openAt] !== '(') {
        return -1;
    }
    let depth = 0;
    for (let i = openAt; i < s.length; i++) {
        if (s[i] === '(') {
            depth++;
        } else if (s[i] === ')') {
            depth--;
            if (depth === 0) {
                return i + 1;
            }
        }
    }
    return -1;
}

/** `if` / `else if` / `while` / `for` / `do` / `switch` / `else`, optional leading `}`. */
const CONTROL_HEADER_RE =
    /^(?:}\s*)?(else\s+if|if|else|while|for|do|switch)\b/i;

const ELSE_LINE_RE = /^(?:}\s*)?else\b/i;

/**
 * Code after a control keyword (and its `(...)` if any).
 * Unclosed `(` counts as no same-line body.
 */
function restAfterControlHeader(structuralTrim: string): string | undefined {
    const m = CONTROL_HEADER_RE.exec(structuralTrim);
    if (!m) {
        return undefined;
    }
    const keyword = m[1].toLowerCase().replace(/\s+/g, ' ');
    let i = skipSpaces(structuralTrim, m[0].length);
    if (keyword !== 'else' && keyword !== 'do') {
        if (i < structuralTrim.length && structuralTrim[i] === '(') {
            const afterParen = skipBalancedParens(structuralTrim, i);
            if (afterParen < 0) {
                return undefined;
            }
            i = skipSpaces(structuralTrim, afterParen);
        }
    }
    return structuralTrim.slice(i);
}

/** `if (` / `while (` / … still open across the next line. */
function isUnclosedControlParenHeader(structuralTrim: string): boolean {
    const m = CONTROL_HEADER_RE.exec(structuralTrim);
    if (!m) {
        return false;
    }
    const keyword = m[1].toLowerCase().replace(/\s+/g, ' ');
    if (keyword === 'else' || keyword === 'do') {
        return false;
    }
    let i = skipSpaces(structuralTrim, m[0].length);
    if (i >= structuralTrim.length || structuralTrim[i] !== '(') {
        return false;
    }
    return skipBalancedParens(structuralTrim, i) < 0;
}

/** Control line whose body is the following line (`if (x)` / `else`), not `if (x) {` or `if (x) stmt;`. */
function isHangingControlHeader(structuralTrim: string): boolean {
    const rest = restAfterControlHeader(structuralTrim);
    return rest !== undefined && rest.length === 0;
}

function restAfterCaseLabelColon(structuralTrim: string): string | undefined {
    if (!/^(case|default)\b/i.test(structuralTrim)) {
        return undefined;
    }
    const colon = structuralTrim.indexOf(':');
    if (colon < 0) {
        return undefined;
    }
    return structuralTrim.slice(colon + 1).trim();
}

function isCaseOrDefaultLabel(structuralTrim: string): boolean {
    return /^(case|default)\b/i.test(structuralTrim);
}

function isHangingCaseLabel(structuralTrim: string): boolean {
    const rest = restAfterCaseLabelColon(structuralTrim);
    return rest !== undefined && rest.length === 0;
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
    let prevIncompleteExpr = false;
    let inBlockComment = false;
    /** Final indent of the line an open block comment started on. */
    let blockCommentRefIndent: string | undefined;
    /** Extra indent levels for a braceless `if` / `else` / `while` / `for` body. */
    let hangingExtra = 0;
    /** Extra used by the last hanging body; an immediately following `else` aligns to that `if`. */
    let maybeElseExtra = 0;
    /** Multi-line `if (` / `while (` whose `)` is still ahead. */
    let pendingControlParen = false;
    /** `case` / `default` body extra, keyed by brace depth of the switch interior. */
    const caseExtraAtDepth: number[] = [];

    const inheritedCaseExtra = (depth: number): number => {
        let sum = 0;
        for (let d = 0; d < depth; d++) {
            sum += caseExtraAtDepth[d] ?? 0;
        }
        return sum;
    };

    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const inBlockAtStart = inBlockComment;
        const scanned = structuralLine(text, inBlockAtStart);
        inBlockComment = scanned.inBlockComment;
        const structural = scanned.text;
        const structuralTrim = structural.trim();
        const depthBefore = depth;
        const parenBefore = parenDepth;

        const isBlank = text.trim().length === 0;
        const isHash = HASH_RE.test(structuralTrim);
        const closesFirst = structuralTrim.startsWith('}');
        const isOpenBraceLine = structuralTrim.startsWith('{');
        const isElseLine = ELSE_LINE_RE.test(structuralTrim);
        const isCaseLabel = isCaseOrDefaultLabel(structuralTrim);
        const hangingHeader = isHangingControlHeader(structuralTrim);
        const continuation = isContinuationLine(
            structuralTrim,
            parenBefore,
            prevOpensContinuation
        );
        const exprContinuation =
            prevIncompleteExpr && lineStartsWithBinaryContinuationOp(structuralTrim);

        if (!isElseLine) {
            maybeElseExtra = 0;
        }

        let extra = hangingExtra;
        if (isCaseLabel) {
            extra = 0;
        } else if (isOpenBraceLine && hangingExtra > 0) {
            extra = hangingExtra - 1;
        } else if (isElseLine && !closesFirst) {
            extra = maybeElseExtra > 0 ? maybeElseExtra - 1 : 0;
        }
        if (!closesFirst) {
            extra += inheritedCaseExtra(depthBefore);
            if (!isCaseLabel) {
                extra += caseExtraAtDepth[depthBefore] ?? 0;
            }
        }

        let newLeading: string | undefined;
        if (inBlockAtStart && structuralTrim.length === 0 && blockCommentRefIndent !== undefined) {
            // Block comment interior: `*` under the `*` of `/*`, `*/` with `/*`,
            // plain prose keeps the author's indent.
            const commentTrim = text.trim();
            if (commentTrim.startsWith('*')) {
                // `*` (and the `*` of `*/`) aligns under the `*` of `/*`.
                newLeading = `${blockCommentRefIndent} `;
            } else {
                newLeading = undefined;
            }
        } else if (isBlank || continuation) {
            newLeading = undefined;
        } else if (exprContinuation) {
            newLeading = makeIndent(depthBefore + extra + 1, options);
        } else if (isHash) {
            newLeading = '';
        } else if (closesFirst) {
            newLeading = makeIndent(
                Math.max(0, depthBefore - 1 + inheritedCaseExtra(depthBefore)),
                options
            );
        } else {
            newLeading = makeIndent(depthBefore + extra, options);
        }

        if (newLeading !== undefined && line >= startLine && line <= endLine) {
            const oldLeading = text.slice(0, leadingWhitespaceLength(text));
            if (oldLeading !== newLeading) {
                edits.push({ line, newLeading });
            }
        }

        if (inBlockComment) {
            if (!inBlockAtStart) {
                blockCommentRefIndent =
                    newLeading !== undefined
                        ? newLeading
                        : text.slice(0, leadingWhitespaceLength(text));
            }
        } else {
            blockCommentRefIndent = undefined;
        }

        const depthAfter = applyBraceDelta(depthBefore, structural);
        const parenAfter = applyParenDelta(parenBefore, structural);

        if (!isBlank && !isHash) {
            if (continuation) {
                if (pendingControlParen) {
                    if (depthAfter > depthBefore) {
                        hangingExtra = 0;
                        maybeElseExtra = 0;
                        pendingControlParen = false;
                    } else if (parenAfter === 0) {
                        hangingExtra = 1;
                        maybeElseExtra = 0;
                        pendingControlParen = false;
                    }
                }
            } else if (isCaseLabel) {
                hangingExtra = 0;
                maybeElseExtra = 0;
                pendingControlParen = false;
                caseExtraAtDepth[depthBefore] = isHangingCaseLabel(structuralTrim) ? 1 : 0;
            } else if (isOpenBraceLine) {
                hangingExtra = 0;
                maybeElseExtra = 0;
            } else if (closesFirst) {
                hangingExtra = hangingHeader ? 1 : 0;
                maybeElseExtra = 0;
                pendingControlParen = false;
                caseExtraAtDepth[depthBefore] = 0;
            } else if (isUnclosedControlParenHeader(structuralTrim)) {
                pendingControlParen = true;
            } else if (hangingHeader) {
                const elseBase = isElseLine && maybeElseExtra > 0 ? maybeElseExtra - 1 : hangingExtra;
                hangingExtra = elseBase + 1;
                maybeElseExtra = 0;
            } else {
                maybeElseExtra = hangingExtra;
                hangingExtra = 0;
            }
        }

        depth = depthAfter;
        parenDepth = parenAfter;
        if (!isBlank) {
            prevOpensContinuation = lineOpensContinuation(scanned.code.trim());
            const code = scanned.code.trim();
            if (code.length > 0) {
                prevIncompleteExpr = lineEndsIncompleteExpr(code);
            }
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
    const controlSpaced = applyControlFlowSpacing(
        commaed,
        options.spaceAfterControlKeyword,
        stripped.startLine,
        stripped.endLine
    );
    const exprSpaced = applyCallAndOperatorSpacing(
        controlSpaced,
        options.spaceAfterComma,
        options.spaceAfterControlKeyword,
        stripped.startLine,
        stripped.endLine
    );
    const commented = applyLineCommentSpacing(
        exprSpaced,
        stripped.startLine,
        stripped.endLine
    );
    return applyLeadingEdits(
        commented,
        computeAcsLeadingEdits(commented, options, {
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

function readSpaceAfterControlKeyword(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('acs.format.spaceAfterControlKeyword', true);
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
        spaceAfterControlKeyword: readSpaceAfterControlKeyword(document),
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
