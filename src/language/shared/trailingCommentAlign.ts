/** Minimum columns between code and a trailing `//`. Wider gaps stay as written. */
const MIN_GAP = 2;

export function visualColumnLength(text: string, tabSize: number): number {
    const size = tabSize > 0 ? tabSize : 4;
    let col = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\t') {
            col += size - (col % size);
        } else {
            col++;
        }
    }
    return col;
}

function rtrimHorizontal(text: string): string {
    return text.replace(/[ \t]+$/, '');
}

/**
 * First structural `//`, or -1. Carries block-comment state; strings do not span lines.
 */
export function scanLineCommentIndex(
    line: string,
    inBlockComment: boolean,
    isStringQuote: (ch: string) => boolean
): { commentIndex: number; inBlockComment: boolean } {
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
            return { commentIndex: i, inBlockComment: inBlock };
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            i += 2;
            continue;
        }
        if (isStringQuote(ch)) {
            stringQuote = ch;
            i++;
            continue;
        }
        i++;
    }

    return { commentIndex: -1, inBlockComment: inBlock };
}

/**
 * Trailing `//` keeps whatever gap is already there when it is at least two columns.
 * A shorter gap is padded up to two. Comments are not pulled onto one column.
 * Full-line comments are left to the comment-spacing pass.
 */
export function alignTrailingLineComments(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    tabSize: number,
    isStringQuote: (ch: string) => boolean
): string[] {
    const out = lines.slice();
    let inBlockComment = false;

    for (let i = 0; i < out.length; i++) {
        const inBlockAtStart = inBlockComment;
        const scanned = scanLineCommentIndex(out[i], inBlockAtStart, isStringQuote);
        inBlockComment = scanned.inBlockComment;

        const inRange = i >= startLine && i <= endLine;
        if (!inRange || inBlockAtStart || scanned.commentIndex < 0) {
            continue;
        }

        const rawCode = out[i].slice(0, scanned.commentIndex);
        const code = rtrimHorizontal(rawCode);
        if (code.trim().length === 0) {
            continue;
        }

        const gap = rawCode.slice(code.length);
        const gapCols = visualColumnLength(rawCode, tabSize) - visualColumnLength(code, tabSize);
        if (gapCols >= MIN_GAP) {
            continue;
        }
        out[i] = `${code}${gap}${' '.repeat(MIN_GAP - gapCols)}${out[i].slice(scanned.commentIndex)}`;
    }

    return out;
}
