import * as vscode from 'vscode';
import { RgbColor } from '../../tools/playpalReader';

const COLOR_VALUE_RE_SOURCE =
    '(%)?\\[(\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)\\s*,\\s*(\\d+(?:\\.\\d+)?)\\s*\\]|\\b(\\d{1,3})\\b';

export interface TranslationPropertySpan {
    startLine: number;
    endLine: number;
    /** Column of the Translation keyword on `startLine`. */
    keywordColumn: number;
}

export interface TranslationColorVisit {
    startColumn: number;
    endColumn: number;
    color: vscode.Color;
}

export function isFloatContext(lineText: string, matchIndex: number): boolean {
    let quotePos = -1;
    for (let i = matchIndex - 1; i >= 0; i--) {
        if (lineText[i] === '"') {
            quotePos = i;
            break;
        }
    }
    const segment = quotePos >= 0
        ? lineText.substring(quotePos, matchIndex)
        : lineText.substring(0, matchIndex);
    return segment.includes('%');
}

function isPaletteMatch(match: RegExpExecArray): boolean {
    return match[5] !== undefined;
}

export function findNearestPaletteIndex(color: vscode.Color, palette: RgbColor[]): number {
    let best = 0;
    let bestDist = Infinity;
    const cr = color.red * 255;
    const cg = color.green * 255;
    const cb = color.blue * 255;
    for (let i = 0; i < palette.length; i++) {
        const dr = cr - palette[i].r;
        const dg = cg - palette[i].g;
        const db = cb - palette[i].b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}

/** Strip `//` comments, ignoring `//` inside double-quoted strings. */
export function stripLineComment(line: string): string {
    let inString = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (!inString && ch === '/' && line[i + 1] === '/') {
            return line.slice(0, i);
        }
    }
    return line;
}

function endsWithContinuationComma(line: string): boolean {
    return stripLineComment(line).trimEnd().endsWith(',');
}

function hasUnclosedQuote(line: string): boolean {
    let count = 0;
    for (const ch of stripLineComment(line)) {
        if (ch === '"') {
            count++;
        }
    }
    return count % 2 === 1;
}

/** True when the line is (or ends with) the Translation keyword and has no value yet. */
export function isTranslationKeywordOnlyLine(line: string, keywordRe: RegExp): boolean {
    const stripped = stripLineComment(line);
    const kwIndex = stripped.search(keywordRe);
    if (kwIndex < 0) {
        return false;
    }
    const after = stripped.slice(kwIndex).replace(keywordRe, '').replace(/[{}]/g, '').trim();
    return after.length === 0;
}

/** Quoted remaps / bare palette ranges / RGB brackets that continue a Translation value. */
export function isTranslationValueLine(line: string): boolean {
    let t = stripLineComment(line).trim();
    if (!t || t.startsWith('}')) {
        return false;
    }
    // Values may sit before closing braces: `"0:0=1:1"}}`
    return t.startsWith('"')
        || /^\d{1,3}\s*:/.test(t)
        || t.startsWith('%[')
        || t.startsWith('[');
}

function shouldContinueTranslationProperty(
    prevLine: string,
    nextLine: string,
    keywordRe: RegExp
): boolean {
    if (!isTranslationValueLine(nextLine)) {
        return false;
    }
    return endsWithContinuationComma(prevLine)
        || hasUnclosedQuote(prevLine)
        || isTranslationKeywordOnlyLine(prevLine, keywordRe);
}

export function forEachKeywordPropertyTranslationSpan(
    document: vscode.TextDocument,
    keywordRe: RegExp,
    onSpan: (span: TranslationPropertySpan) => boolean | void,
    token?: vscode.CancellationToken
): void {
    let i = 0;
    while (i < document.lineCount) {
        if (token?.isCancellationRequested) {
            break;
        }
        const lineText = document.lineAt(i).text;
        const kwIndex = stripLineComment(lineText).search(keywordRe);
        if (kwIndex < 0) {
            i++;
            continue;
        }

        let j = i;
        while (j < document.lineCount) {
            if (token?.isCancellationRequested) {
                break;
            }
            const text = document.lineAt(j).text;
            if (j + 1 >= document.lineCount) {
                break;
            }
            if (!shouldContinueTranslationProperty(text, document.lineAt(j + 1).text, keywordRe)) {
                break;
            }
            j++;
        }
        if (onSpan({ startLine: i, endLine: j, keywordColumn: kwIndex }) === false) {
            return;
        }
        i = j + 1;
    }
}

export function collectKeywordPropertyTranslationSpans(
    document: vscode.TextDocument,
    keywordRe: RegExp,
    token?: vscode.CancellationToken
): TranslationPropertySpan[] {
    const spans: TranslationPropertySpan[] = [];
    forEachKeywordPropertyTranslationSpan(document, keywordRe, span => {
        spans.push(span);
    }, token);
    return spans;
}

/** First span whose `endLine >= fromLine`, assuming spans are sorted by startLine. */
export function firstSpanIndexOverlapping(
    spans: readonly TranslationPropertySpan[],
    fromLine: number
): number {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].endLine < fromLine) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}

export function spansOverlappingLines(
    spans: readonly TranslationPropertySpan[],
    fromLine: number,
    toLine: number
): TranslationPropertySpan[] {
    const out: TranslationPropertySpan[] = [];
    for (let i = firstSpanIndexOverlapping(spans, fromLine); i < spans.length; i++) {
        const span = spans[i];
        if (span.startLine > toLine) {
            break;
        }
        out.push(span);
    }
    return out;
}

/**
 * DECORATE/TEXTURES-style property: after a line matching `keywordRe`, keep scanning
 * following value lines (trailing comma, unclosed quote, or keyword-only then quoted remaps).
 * On the keyword line, only text at/after the keyword is scanned (avoids patch x,y false hits).
 */
export function collectKeywordPropertyTranslationColors(
    document: vscode.TextDocument,
    keywordRe: RegExp,
    palette: RgbColor[] | null,
    token?: vscode.CancellationToken
): vscode.ColorInformation[] {
    const colors: vscode.ColorInformation[] = [];
    forEachKeywordPropertyTranslationSpan(document, keywordRe, span => {
        colors.push(...collectTranslationColorsForSpan(document, span, palette, span.startLine, span.endLine, undefined, token));
    }, token);
    return colors;
}

export function collectTranslationColorsForSpan(
    document: vscode.TextDocument,
    span: TranslationPropertySpan,
    palette: RgbColor[] | null,
    fromLine: number,
    toLine: number,
    maxColors?: number,
    token?: vscode.CancellationToken
): vscode.ColorInformation[] {
    const colors: vscode.ColorInformation[] = [];
    const start = Math.max(span.startLine, fromLine);
    const end = Math.min(span.endLine, toLine);
    for (let line = start; line <= end; line++) {
        if (token?.isCancellationRequested) {
            break;
        }
        if (maxColors !== undefined && colors.length >= maxColors) {
            break;
        }
        const fromCol = line === span.startLine ? span.keywordColumn : 0;
        const remaining = maxColors === undefined ? undefined : maxColors - colors.length;
        const chunk = collectTranslationColorsOnLine(document.lineAt(line).text, line, palette, fromCol, remaining);
        colors.push(...chunk);
    }
    return colors;
}

/**
 * ACS CreateTranslation(...): scan from the keyword line through the closing `)`.
 */
export function collectCreateTranslationColors(
    document: vscode.TextDocument,
    palette: RgbColor[] | null,
    token?: vscode.CancellationToken
): vscode.ColorInformation[] {
    const keywordRe = /\bCreateTranslation\b/i;
    const colors: vscode.ColorInformation[] = [];
    let i = 0;
    while (i < document.lineCount) {
        if (token?.isCancellationRequested) {
            break;
        }
        const lineText = document.lineAt(i).text;
        const kwIndex = lineText.search(keywordRe);
        if (kwIndex < 0) {
            i++;
            continue;
        }

        let depth = 0;
        let seenParen = false;
        let endLine = i;
        outer: for (let j = i; j < document.lineCount; j++) {
            if (token?.isCancellationRequested) {
                break;
            }
            const code = stripLineComment(document.lineAt(j).text);
            const from = j === i ? kwIndex : 0;
            for (let c = from; c < code.length; c++) {
                const ch = code[c];
                if (ch === '(') {
                    depth++;
                    seenParen = true;
                } else if (ch === ')') {
                    depth--;
                    if (seenParen && depth <= 0) {
                        endLine = j;
                        break outer;
                    }
                }
            }
            endLine = j;
            if (seenParen && depth === 0) {
                break;
            }
        }

        for (let j = i; j <= endLine; j++) {
            if (token?.isCancellationRequested) {
                break;
            }
            colors.push(...collectTranslationColorsOnLine(document.lineAt(j).text, j, palette));
        }
        i = endLine + 1;
    }
    return colors;
}

/**
 * Walk palette indices and [r,g,b] / %[…] values on one line.
 * `onMatch` may return false to stop.
 */
export function visitTranslationColorMatches(
    lineText: string,
    fromColumn: number,
    palette: RgbColor[] | null,
    onMatch: (visit: TranslationColorVisit) => boolean | void
): void {
    const segment = fromColumn > 0 ? lineText.slice(fromColumn) : lineText;
    const colBase = fromColumn > 0 ? fromColumn : 0;
    const re = new RegExp(COLOR_VALUE_RE_SOURCE, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(segment)) !== null) {
        if (isPaletteMatch(match)) {
            if (!palette) {
                continue;
            }
            const idx = parseInt(match[5], 10);
            if (idx > 255) {
                continue;
            }
            const pal = palette[idx];
            const color = new vscode.Color(pal.r / 255, pal.g / 255, pal.b / 255, 1);
            const startColumn = colBase + match.index;
            const endColumn = colBase + match.index + match[0].length;
            if (onMatch({ startColumn, endColumn, color }) === false) {
                return;
            }
            continue;
        }

        const r = parseFloat(match[2]);
        const g = parseFloat(match[3]);
        const b = parseFloat(match[4]);

        if (isNaN(r) || isNaN(g) || isNaN(b)) {
            continue;
        }

        const floatMode = isFloatContext(segment, match.index);

        if (floatMode) {
            if (r < 0 || r > 2 || g < 0 || g > 2 || b < 0 || b > 2) {
                continue;
            }
        } else if (r > 255 || g > 255 || b > 255) {
            continue;
        }

        const hasPercent = match[1] === '%';
        const startColumn = colBase + match.index + (hasPercent ? 1 : 0);
        const endColumn = colBase + match.index + match[0].length;
        const color = floatMode
            ? new vscode.Color(Math.min(r / 2, 1), Math.min(g / 2, 1), Math.min(b / 2, 1), 1)
            : new vscode.Color(r / 255, g / 255, b / 255, 1);
        if (onMatch({ startColumn, endColumn, color }) === false) {
            return;
        }
    }
}

/** Collect ColorInformation for palette indices and [r,g,b] / %[…] values on one line. */
export function collectTranslationColorsOnLine(
    lineText: string,
    lineNumber: number,
    palette: RgbColor[] | null,
    fromColumn = 0,
    maxColors?: number
): vscode.ColorInformation[] {
    const colors: vscode.ColorInformation[] = [];
    visitTranslationColorMatches(lineText, fromColumn, palette, visit => {
        if (maxColors !== undefined && colors.length >= maxColors) {
            return false;
        }
        const startPos = new vscode.Position(lineNumber, visit.startColumn);
        const endPos = new vscode.Position(lineNumber, visit.endColumn);
        colors.push(new vscode.ColorInformation(new vscode.Range(startPos, endPos), visit.color));
        return maxColors === undefined || colors.length < maxColors;
    });
    return colors;
}

export async function provideTranslationColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range },
    palette: RgbColor[] | null
): Promise<vscode.ColorPresentation[]> {
    const rangeText = context.document.getText(context.range);

    if (/^\d{1,3}$/.test(rangeText)) {
        if (!palette) {
            return [new vscode.ColorPresentation(rangeText)];
        }

        const ri = Math.round(color.red * 255);
        const gi = Math.round(color.green * 255);
        const bi = Math.round(color.blue * 255);
        const p1 = new vscode.ColorPresentation(`[${ri},${gi},${bi}]`);
        p1.textEdit = vscode.TextEdit.replace(context.range, `[${ri},${gi},${bi}]`);

        const nearestIdx = findNearestPaletteIndex(color, palette);
        const p2 = new vscode.ColorPresentation(String(nearestIdx));
        p2.textEdit = vscode.TextEdit.replace(context.range, String(nearestIdx));

        return [p1, p2];
    }

    const lineText = context.document.lineAt(context.range.start.line).text;
    const floatMode = isFloatContext(lineText, context.range.start.character);

    if (floatMode) {
        const m = /^\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]$/.exec(rangeText.trim());
        const orig = m
            ? { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) }
            : null;
        const eps = 0.002;
        let fr: number, fg: number, fb: number;
        if (orig
            && Math.abs(color.red - Math.min(orig.r / 2, 1)) < eps
            && Math.abs(color.green - Math.min(orig.g / 2, 1)) < eps
            && Math.abs(color.blue - Math.min(orig.b / 2, 1)) < eps) {
            fr = orig.r; fg = orig.g; fb = orig.b;
        } else {
            fr = Math.max(0, Math.min(2, color.red * 2));
            fg = Math.max(0, Math.min(2, color.green * 2));
            fb = Math.max(0, Math.min(2, color.blue * 2));
        }
        const label = `[${+fr.toFixed(4)},${+fg.toFixed(4)},${+fb.toFixed(4)}]`;
        const p1 = new vscode.ColorPresentation(label);
        p1.textEdit = vscode.TextEdit.replace(context.range, label);
        return [p1];
    }

    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    const label = `[${r},${g},${b}]`;
    const p1 = new vscode.ColorPresentation(label);
    p1.textEdit = vscode.TextEdit.replace(context.range, label);

    const pres = [p1];

    if (palette) {
        const idx = findNearestPaletteIndex(color, palette);
        const p2 = new vscode.ColorPresentation(String(idx));
        p2.textEdit = vscode.TextEdit.replace(context.range, String(idx));
        pres.push(p2);
    }

    return pres;
}
