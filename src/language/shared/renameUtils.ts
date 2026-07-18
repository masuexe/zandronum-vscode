/** Line-local character range (end exclusive). */
export interface WordRange {
    line: number;
    start: number;
    end: number;
}

export function isValidIdent(name: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Zandronum DECORATE user variable names must begin with user_. */
export function isValidUserVarName(name: string): boolean {
    return /^user_[A-Za-z0-9_]+$/i.test(name) && name.length >= 6;
}

function getStringRanges(text: string): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    let inString = false;
    let stringStart = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') {
            if (!inString) {
                stringStart = i;
                inString = true;
            } else if (i === 0 || text[i - 1] !== '\\') {
                ranges.push({ start: stringStart, end: i + 1 });
                inString = false;
            }
        }
    }

    if (inString) {
        ranges.push({ start: stringStart, end: text.length });
    }

    return ranges;
}

function isInRanges(charIndex: number, ranges: Array<{ start: number; end: number }>): boolean {
    return ranges.some(r => charIndex >= r.start && charIndex < r.end);
}

export interface CollectWordOptions {
    caseInsensitive?: boolean;
    /** Inclusive start line (default 0). */
    startLine?: number;
    /** Inclusive end line (default last line). */
    endLineInclusive?: number;
    /** ACS: skip single-letter printcast prefixes (s:, d:, …). */
    skipPrintCast?: boolean;
}

/**
 * Collect occurrences of `name` as whole words in `lines`.
 * Skips string literals and line/block comments (block comments tracked across lines).
 */
export function collectWordRanges(
    lines: string[],
    name: string,
    options: CollectWordOptions = {}
): WordRange[] {
    if (!name || lines.length === 0) {
        return [];
    }

    const caseInsensitive = options.caseInsensitive !== false;
    const target = caseInsensitive ? name.toLowerCase() : name;
    const startLine = options.startLine ?? 0;
    const endLine = options.endLineInclusive ?? lines.length - 1;
    const skipPrintCast = options.skipPrintCast === true;
    const results: WordRange[] = [];
    let inBlockComment = false;
    const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;

    for (let line = 0; line < lines.length; line++) {
        const text = lines[line];
        const stringRanges = getStringRanges(text);
        let lineCommentStart = -1;
        const blockRanges: Array<{ start: number; end: number }> = [];

        let i = 0;
        while (i < text.length) {
            if (inBlockComment) {
                const start = i;
                const end = text.indexOf('*/', i);
                if (end >= 0) {
                    blockRanges.push({ start, end: end + 2 });
                    i = end + 2;
                    inBlockComment = false;
                } else {
                    blockRanges.push({ start, end: text.length });
                    i = text.length;
                }
            } else if (text[i] === '/' && text[i + 1] === '/') {
                if (!isInRanges(i, stringRanges)) {
                    lineCommentStart = i;
                    break;
                }
                i++;
            } else if (text[i] === '/' && text[i + 1] === '*') {
                if (!isInRanges(i, stringRanges)) {
                    const start = i;
                    const end = text.indexOf('*/', i + 2);
                    if (end >= 0) {
                        blockRanges.push({ start, end: end + 2 });
                        i = end + 2;
                    } else {
                        blockRanges.push({ start, end: text.length });
                        inBlockComment = true;
                        i = text.length;
                    }
                } else {
                    i++;
                }
            } else {
                i++;
            }
        }

        if (line < startLine || line > endLine) {
            continue;
        }

        wordRe.lastIndex = 0;
        let wm: RegExpExecArray | null;
        while ((wm = wordRe.exec(text)) !== null) {
            const word = wm[0];
            const wordKey = caseInsensitive ? word.toLowerCase() : word;
            if (wordKey !== target) {
                continue;
            }
            if (isInRanges(wm.index, stringRanges)) {
                continue;
            }
            if (lineCommentStart >= 0 && wm.index >= lineCommentStart) {
                continue;
            }
            if (isInRanges(wm.index, blockRanges)) {
                continue;
            }
            if (skipPrintCast) {
                const afterIdx = wm.index + word.length;
                if (
                    afterIdx < text.length &&
                    text[afterIdx] === ':' &&
                    /^[abcdfiklnsx]$/i.test(word)
                ) {
                    continue;
                }
            }
            results.push({
                line,
                start: wm.index,
                end: wm.index + word.length
            });
        }
    }

    return results;
}

/** Word under column `character` on `lineText`, or null. */
export function wordAt(lineText: string, character: number): { word: string; start: number; end: number } | null {
    if (character < 0 || character > lineText.length) {
        return null;
    }
    const wordRe = /[A-Za-z_][A-Za-z0-9_]*/g;
    let wm: RegExpExecArray | null;
    while ((wm = wordRe.exec(lineText)) !== null) {
        const start = wm.index;
        const end = start + wm[0].length;
        if (character >= start && character <= end) {
            return { word: wm[0], start, end };
        }
    }
    return null;
}
