import * as vscode from 'vscode';

export type BraceStyle = 'nextLine' | 'sameLine';

export interface DecorateFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
    /** Extra spaces after the `States {` indent for labels. `0` is wiki (label aligned with `{`). */
    stateLabelIndent: number;
    /**
     * Extra spaces after the `States {` indent for frames / Goto / Loop.
     * `null` uses `tabSize` (wiki: one editor indent past `{`).
     */
    stateFrameIndent: number | null;
    braceStyle: BraceStyle;
    /**
     * When true, empty same-line blocks become `{ }` and nextLine may split them.
     * When false, leave `Actor Foo {}` alone.
     */
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

/** Unquoted state-label path ending with `:`. */
const LABEL_RE = /^[A-Za-z0-9_']+(?:\.[A-Za-z0-9_']+)*\s*:/;
const STATES_RE = /^states\b/i;
const HASH_RE = /^#/;

/**
 * Strip comments (and optionally strings) for structural scanning.
 * Carries block-comment state across lines; strings do not span lines (DECORATE).
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

function rtrimHorizontal(text: string): string {
    return text.replace(/[ \t]+$/, '');
}

function lineHasCode(text: string): boolean {
    return text.slice(leadingWhitespaceLength(text)).length > 0;
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

function extraSpaces(count: number): string {
    return ' '.repeat(Math.max(0, count | 0));
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

function hasOpenBrace(structural: string): boolean {
    return structural.includes('{');
}

function isStateLabel(structuralTrim: string): boolean {
    return LABEL_RE.test(structuralTrim);
}

/**
 * Previous line still open for args / Translation lists (`foo(` or `...,`).
 * Use comment-stripped text that still includes strings: `"a", "b"` is complete,
 * not a trailing comma (string-stripped `text` would look like ` ,`).
 */
function lineOpensContinuation(commentStrippedTrim: string): boolean {
    return commentStrippedTrim.endsWith(',') || commentStrippedTrim.endsWith('(');
}

/**
 * True when this line continues a multi-line call / property list.
 * Leading whitespace is left alone so author alignment is preserved.
 */
function isContinuationLine(
    structuralTrim: string,
    parenDepthBefore: number,
    prevOpensContinuation: boolean,
    isLabel: boolean
): boolean {
    if (!(parenDepthBefore > 0 || prevOpensContinuation)) {
        return false;
    }
    // Entire line was strings/comments → structural empty (e.g. Translation `"..."`).
    if (structuralTrim.length === 0) {
        return true;
    }
    if (structuralTrim.startsWith('}') || HASH_RE.test(structuralTrim) || isLabel) {
        return false;
    }
    // Flow keywords are always new statements inside States, never call args.
    if (/^(goto|loop|stop|wait|fail)\b/i.test(structuralTrim)) {
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
    /** Original text from `{` onward (openOnly). */
    fromOpen: string;
    /** Original text from `}` onward for emptyBlock. */
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

/**
 * Classify a same-line `{` that can be split/normalized.
 * `none` if `{` is missing, standalone, or followed by code / block comments.
 */
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
    let inBlockComment: boolean = false;
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
    inBlockComment: boolean,
    ternaryDepthStart: number
): { text: string; inBlockComment: boolean; ternaryDepth: number } {
    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let inString = false;
    /** Unmatched `?` count — colon is ternary only while this is > 0. */
    let ternaryDepth = ternaryDepthStart;

    const endsWithSpace = (): boolean => {
        const ch = out[out.length - 1];
        return ch === ' ' || ch === '\t';
    };

    const ensureSpaceBefore = (): void => {
        if (out.length > 0 && !endsWithSpace()) {
            out += ' ';
        }
    };

    const emitSpaceAfterOp = (): void => {
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
            return;
        }
        out += ' ';
        i = j;
    };

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

        // Google / Prettier: `cond ? then : else` — spaces on both sides.
        if (ch === '?') {
            ensureSpaceBefore();
            out += '?';
            i++;
            ternaryDepth++;
            emitSpaceAfterOp();
            continue;
        }

        // Class-scoped goto (`Super::See`) is one token — do not insert spaces.
        if (ch === ':' && next === ':') {
            out += '::';
            i += 2;
            continue;
        }

        if (ch === ':') {
            const wrappedTernaryColon = out.trim().length === 0;
            if (ternaryDepth > 0 || wrappedTernaryColon) {
                ensureSpaceBefore();
                out += ':';
                i++;
                if (ternaryDepth > 0) {
                    ternaryDepth--;
                }
                emitSpaceAfterOp();
                continue;
            }
            out += ':';
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
            out += ' ';
            i = j;
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

    return { text: out, inBlockComment: inBlock, ternaryDepth };
}

function applyCommaSpacing(
    lines: readonly string[],
    spaceAfter: boolean,
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    let ternaryDepth = 0;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatSpaceAfterCommaLine(
            out[i],
            spaceAfter,
            inBlockComment,
            ternaryDepth
        );
        inBlockComment = formatted.inBlockComment;
        ternaryDepth = formatted.ternaryDepth;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

function isIdentChar(ch: string): boolean {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
}

function matchWordAt(line: string, index: number, word: string): boolean {
    if (index > 0 && isIdentChar(line[index - 1])) {
        return false;
    }
    if (index + word.length > line.length) {
        return false;
    }
    for (let k = 0; k < word.length; k++) {
        if (line[index + k].toLowerCase() !== word[k].toLowerCase()) {
            return false;
        }
    }
    const after = index + word.length;
    return after >= line.length || !isIdentChar(line[after]);
}

/**
 * Wiki-style `Damage (expr)` — space between the property and `(`.
 * Does not touch DamageType / DamageFactor or state actions like A_Jump(.
 */
function formatDamageParenSpacingLine(
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
            out += ch;
            i++;
            continue;
        }

        if (matchWordAt(line, i, 'Damage')) {
            const word = line.slice(i, i + 6);
            out += word;
            i += 6;
            let j = i;
            while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
                j++;
            }
            if (j < line.length && line[j] === '(') {
                out += ' ';
                i = j;
            }
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applyDamageParenSpacing(
    lines: readonly string[],
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatDamageParenSpacingLine(out[i], inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

/**
 * Compact DECORATE: `Parent{` / `States{` → `Parent {` / `States {`.
 * Does not insert a space after `{` (`{Obituary` stays tight).
 */
function formatSpaceBeforeBraceLine(
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
            out += ch;
            i++;
            continue;
        }

        if (ch === '{') {
            if (out.length > 0) {
                const prev = out[out.length - 1];
                if (prev !== ' ' && prev !== '\t') {
                    out += ' ';
                }
            }
            out += '{';
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applySpaceBeforeBrace(
    lines: readonly string[],
    startLine: number,
    endLine: number
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatSpaceBeforeBraceLine(out[i], inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

/**
 * Drop blank / whitespace-only lines immediately above a closing `}`.
 * Only removes blanks when both those lines and the `}` fall inside [startLine, endLine].
 */
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
    let parenDepth = 0;
    let prevOpensContinuation = false;
    let inBlockComment = false;
    /** Final indent of the line an open block comment started on. */
    let blockCommentRefIndent: string | undefined;
    /** Brace depth of the interior of a `States { ... }` block, or -1. */
    let statesBodyDepth = -1;
    /** Depth when `States` was seen without `{` on the same line, or -1. */
    let pendingStatesDepth = -1;

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
        const isStates = STATES_RE.test(structuralTrim);
        const closesFirst = structuralTrim.startsWith('}');
        const inStatesTop =
            statesBodyDepth >= 0 && depthBefore === statesBodyDepth;
        const label =
            inStatesTop && structuralTrim.length > 0 && isStateLabel(structuralTrim);
        const continuation = isContinuationLine(
            structuralTrim,
            parenBefore,
            prevOpensContinuation,
            label
        );
        const statesBraceLevel = Math.max(0, statesBodyDepth - 1);
        const labelExtra = Math.max(0, options.stateLabelIndent | 0);
        const frameExtra =
            options.stateFrameIndent === null || options.stateFrameIndent === undefined
                ? Math.max(1, options.tabSize | 0)
                : Math.max(0, options.stateFrameIndent | 0);

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
            // Blank lines and multi-line arg / Translation continuations keep author indent.
            newLeading = undefined;
        } else if (isHash) {
            newLeading = '';
        } else if (closesFirst) {
            newLeading = makeIndent(Math.max(0, depthBefore - 1), options);
        } else if (inStatesTop && label) {
            newLeading = makeIndent(statesBraceLevel, options) + extraSpaces(labelExtra);
        } else if (inStatesTop) {
            newLeading = makeIndent(statesBraceLevel, options) + extraSpaces(frameExtra);
        } else {
            newLeading = makeIndent(depthBefore, options);
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
        parenDepth = applyParenDelta(parenBefore, structural);
        if (!isBlank) {
            prevOpensContinuation = lineOpensContinuation(scanned.code.trim());
        }

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

/** Format full lines (test helper). Line count may change after brace restyle. */
export function formatDecorateLines(
    lines: readonly string[],
    options: DecorateFormatOptions,
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
    const damageSpaced = applyDamageParenSpacing(
        commaed,
        stripped.startLine,
        stripped.endLine
    );
    const braceSpaced = applySpaceBeforeBrace(
        damageSpaced,
        stripped.startLine,
        stripped.endLine
    );
    const commented = applyLineCommentSpacing(
        braceSpaced,
        stripped.startLine,
        stripped.endLine
    );
    return applyLeadingEdits(
        commented,
        computeDecorateLeadingEdits(commented, options, {
            startLine: stripped.startLine,
            endLine: stripped.endLine,
        })
    );
}

/** Drop trailing blank / whitespace-only lines (VS Code EOF newline shows as an extra empty line). */
export function trimTrailingBlankLines(lines: readonly string[]): string[] {
    const out = lines.slice();
    while (out.length > 0 && out[out.length - 1].trim().length === 0) {
        out.pop();
    }
    return out;
}

/** Join lines and ensure the document ends with exactly one line terminator. */
export function buildFormattedDocumentText(lines: readonly string[], eol: string): string {
    const trimmed = trimTrailingBlankLines(lines);
    if (trimmed.length === 0) {
        return eol;
    }
    return trimmed.join(eol) + eol;
}

function readIntSetting(
    document: vscode.TextDocument,
    key: string,
    fallback: number
): number {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<number>(key, fallback);
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
}

function readOptionalIntSetting(
    document: vscode.TextDocument,
    key: string
): number | null {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<number | null>(key, null);
    if (raw === null || raw === undefined) {
        return null;
    }
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : null;
}

function readBraceStyle(document: vscode.TextDocument): BraceStyle {
    const raw = vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<string>('decorate.format.braceStyle', 'nextLine');
    return raw === 'sameLine' ? 'sameLine' : 'nextLine';
}

function readSpaceAfterComma(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('decorate.format.spaceAfterComma', true);
}

function readSpaceInEmptyBraces(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('decorate.format.spaceInEmptyBraces', false);
}

function readRemoveBlankLinesBeforeCloseBrace(document: vscode.TextDocument): boolean {
    return vscode.workspace
        .getConfiguration('zandronum-vscode', document.uri)
        .get<boolean>('decorate.format.removeBlankLinesBeforeCloseBrace', true);
}

function toFormatOptions(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions
): DecorateFormatOptions {
    return {
        tabSize: options.tabSize,
        insertSpaces: options.insertSpaces,
        stateLabelIndent: readIntSetting(document, 'decorate.format.stateLabelIndent', 0),
        stateFrameIndent: readOptionalIntSetting(document, 'decorate.format.stateFrameIndent'),
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
    formatOptions: DecorateFormatOptions,
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

    const formatted = formatDecorateLines(original, formatOptions, lineRange);
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
