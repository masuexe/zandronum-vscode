export interface SoundDefPos {
    name: string;
    line: number;
    character: number;
}

/** SNDINFO commands that introduce a logical name (token index of that name). */
const DEFINE_COMMAND_NAME_INDEX: Readonly<Record<string, number>> = {
    $random: 1,
    $alias: 1,
    $playersound: 3,
    $playeralias: 3,
    $playersounddup: 3,
};

export function lumpBaseName(fileName: string): string {
    const base = fileName.includes('.')
        ? fileName.slice(0, fileName.lastIndexOf('.'))
        : fileName;
    return base.slice(0, 8).toLowerCase();
}

export function isSndinfoFileName(fileName: string): boolean {
    return lumpBaseName(fileName) === 'sndinfo';
}

interface SndinfoToken {
    text: string;
    start: number;
}

function stripCommentsPreserveOffsets(text: string): string {
    let out = '';
    let i = 0;
    let inLine = false;
    let inBlock = false;
    let inString = false;

    while (i < text.length) {
        const ch = text[i];
        const next = i + 1 < text.length ? text[i + 1] : '';

        if (inLine) {
            if (ch === '\n') {
                inLine = false;
                out += '\n';
            } else {
                out += ' ';
            }
            i++;
            continue;
        }
        if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                out += '  ';
                i += 2;
                continue;
            }
            out += ch === '\n' ? '\n' : ' ';
            i++;
            continue;
        }
        if (inString) {
            out += ch;
            if (ch === '\\' && next) {
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
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLine = true;
            out += '  ';
            i += 2;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            out += '  ';
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

function tokenizeSndinfoLine(line: string): SndinfoToken[] {
    const tokens: SndinfoToken[] = [];
    let i = 0;
    while (i < line.length) {
        while (i < line.length && /\s/.test(line[i])) {
            i++;
        }
        if (i >= line.length) {
            break;
        }
        if (line[i] === '"') {
            const contentStart = i + 1;
            i++;
            while (i < line.length && line[i] !== '"') {
                i++;
            }
            tokens.push({ text: line.slice(contentStart, i), start: contentStart });
            if (i < line.length) {
                i++;
            }
            continue;
        }
        if (line[i] === '{' || line[i] === '}') {
            i++;
            continue;
        }
        const start = i;
        while (i < line.length && !/\s/.test(line[i]) && line[i] !== '{' && line[i] !== '}') {
            i++;
        }
        tokens.push({ text: line.slice(start, i), start });
    }
    return tokens;
}

/**
 * Collect SNDINFO logical-name definitions. Later entries override earlier ones.
 */
export function collectSoundDefinitions(text: string): SoundDefPos[] {
    const cleaned = stripCommentsPreserveOffsets(text);
    const lines = cleaned.split(/\r?\n/);
    const byName = new Map<string, SoundDefPos>();

    for (let line = 0; line < lines.length; line++) {
        const tokens = tokenizeSndinfoLine(lines[line]);
        if (tokens.length === 0) {
            continue;
        }

        const first = tokens[0].text;
        if (first.startsWith('$')) {
            const nameIndex = DEFINE_COMMAND_NAME_INDEX[first.toLowerCase()];
            if (nameIndex === undefined || nameIndex >= tokens.length) {
                continue;
            }
            const tok = tokens[nameIndex];
            if (!tok.text) {
                continue;
            }
            byName.set(tok.text.toLowerCase(), {
                name: tok.text,
                line,
                character: tok.start,
            });
            continue;
        }

        if (tokens.length < 2) {
            continue;
        }
        byName.set(first.toLowerCase(), {
            name: first,
            line,
            character: tokens[0].start,
        });
    }

    return [...byName.values()];
}

export function findSoundDefinitionInText(
    text: string,
    soundName: string
): SoundDefPos | undefined {
    const key = soundName.toLowerCase();
    const defs = collectSoundDefinitions(text);
    for (let i = defs.length - 1; i >= 0; i--) {
        if (defs[i].name.toLowerCase() === key) {
            return defs[i];
        }
    }
    return undefined;
}
