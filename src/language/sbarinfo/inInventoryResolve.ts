export interface InInventoryActorAtCursor {
    className: string;
    /** Inclusive start / exclusive end of the class token (quotes excluded for strings). */
    nameStart: number;
    nameEnd: number;
}

/**
 * When the cursor is on an inventory class in `InInventory [not] Class[, amount] (&&||| Class[, amount])`,
 * return that class name. Mirrors Zandronum CommandInInventory::Parse.
 */
export function extractInInventoryActorAtCursor(
    lineText: string,
    cursorCol: number
): InInventoryActorAtCursor | null {
    const fullCmd = /\bininventory\b/gi;
    let cmdMatch: RegExpExecArray | null;

    while ((cmdMatch = fullCmd.exec(lineText)) !== null) {
        const afterCmd = cmdMatch.index + cmdMatch[0].length;
        const hit = parseInInventoryActors(lineText, afterCmd, cursorCol);
        if (hit) {
            return hit;
        }
    }

    return null;
}

function parseInInventoryActors(
    lineText: string,
    start: number,
    cursorCol: number
): InInventoryActorAtCursor | null {
    let i = skipWs(lineText, start);

    const notTok = readIdent(lineText, i);
    if (notTok && notTok.text.toLowerCase() === 'not') {
        i = skipWs(lineText, notTok.end);
    }

    for (let item = 0; item < 2; item++) {
        const cls = readClassToken(lineText, i);
        if (!cls) {
            return null;
        }

        if (cursorCol >= cls.nameStart && cursorCol <= cls.nameEnd) {
            return {
                className: cls.className,
                nameStart: cls.nameStart,
                nameEnd: cls.nameEnd,
            };
        }

        i = skipWs(lineText, cls.end);

        if (lineText[i] === ',') {
            i = skipWs(lineText, i + 1);
            const num = readNumber(lineText, i);
            if (!num) {
                return null;
            }
            i = skipWs(lineText, num.end);
        }

        if (lineText.startsWith('&&', i) || lineText.startsWith('||', i)) {
            i = skipWs(lineText, i + 2);
            continue;
        }
        break;
    }

    return null;
}

function skipWs(text: string, i: number): number {
    while (i < text.length && /\s/.test(text[i])) {
        i++;
    }
    return i;
}

function readIdent(
    text: string,
    i: number
): { text: string; start: number; end: number } | null {
    if (i >= text.length || !/[A-Za-z_]/.test(text[i])) {
        return null;
    }
    const start = i;
    i++;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
        i++;
    }
    return { text: text.slice(start, i), start, end: i };
}

function readNumber(
    text: string,
    i: number
): { start: number; end: number } | null {
    if (i >= text.length || !/[0-9]/.test(text[i])) {
        return null;
    }
    const start = i;
    while (i < text.length && /[0-9]/.test(text[i])) {
        i++;
    }
    return { start, end: i };
}

function readClassToken(
    text: string,
    i: number
): { className: string; nameStart: number; nameEnd: number; end: number } | null {
    if (i >= text.length) {
        return null;
    }

    if (text[i] === '"') {
        i++;
        const nameStart = i;
        while (i < text.length && text[i] !== '"') {
            if (text[i] === '\\' && i + 1 < text.length) {
                i += 2;
                continue;
            }
            i++;
        }
        if (i >= text.length || text[i] !== '"') {
            return null;
        }
        const nameEnd = i;
        const className = text.slice(nameStart, nameEnd);
        if (!className) {
            return null;
        }
        return { className, nameStart, nameEnd, end: i + 1 };
    }

    const ident = readIdent(text, i);
    if (!ident) {
        return null;
    }
    return {
        className: ident.text,
        nameStart: ident.start,
        nameEnd: ident.end,
        end: ident.end,
    };
}
