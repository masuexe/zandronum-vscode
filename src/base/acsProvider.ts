import {
    SymbolKind,
    SymbolEntry,
    AcsConstantSymbol,
    AcsFunctionSymbol,
    AcsScriptSymbol,
    AcsScriptParam,
} from './types';
import { SymbolProvider } from './symbolDatabase';
import { ACS_KEYWORDS } from '../language/acs/scanner';

const ACS_PATTERN = /\.acs$/i;

function lumpBaseName(fileName: string): string {
    const base = fileName.includes('.')
        ? fileName.slice(0, fileName.lastIndexOf('.'))
        : fileName;
    return base.slice(0, 8);
}

function decode(u8: Uint8Array): string {
    return Buffer.from(u8).toString('utf-8');
}

const SCRIPT_HEADER_RE = /^\s*script\s+("[^"]*"|\d+|[A-Za-z_]\w*)(?:\s+(\w+))?/i;

/**
 * Indexes user #define / #libdefine constants, function declarations,
 * and script headers (with params) from ACS source files inside packages.
 */
export class AcsSymbolProvider implements SymbolProvider {
    readonly symbolKind = SymbolKind.AcsConstant;

    canHandle(entryPath: string): boolean {
        const name = entryPath.split('/').pop() ?? '';
        if (ACS_PATTERN.test(name)) {
            return true;
        }
        const lump = lumpBaseName(name);
        return /^(SCRIPTS|ACS)$/i.test(lump);
    }

    parse(_entryPath: string, content: Uint8Array): SymbolEntry[] {
        const text = decode(content);
        const symbols: SymbolEntry[] = [];
        const lines = text.split(/\r?\n/);
        let inBlockComment = false;

        for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            let line = lines[lineNumber];

            if (inBlockComment) {
                const end = line.indexOf('*/');
                if (end < 0) {
                    continue;
                }
                line = line.substring(end + 2);
                inBlockComment = false;
            }

            const lineCommentIdx = line.indexOf('//');
            const blockStart = line.indexOf('/*');
            let effective = line;
            if (blockStart >= 0 && (lineCommentIdx < 0 || blockStart < lineCommentIdx)) {
                const blockEnd = line.indexOf('*/', blockStart + 2);
                if (blockEnd < 0) {
                    effective = line.substring(0, blockStart);
                    inBlockComment = true;
                } else {
                    effective = line.substring(0, blockStart) + line.substring(blockEnd + 2);
                }
            } else if (lineCommentIdx >= 0) {
                effective = line.substring(0, lineCommentIdx);
            }

            this.scanDefines(effective, lineNumber, symbols);
            this.scanFunctions(effective, lineNumber, symbols);
            const scriptAdvance = this.scanScript(lines, lineNumber, effective, symbols);
            if (scriptAdvance > 0) {
                lineNumber += scriptAdvance;
            }
        }

        return symbols;
    }

    private scanDefines(effective: string, lineNumber: number, symbols: SymbolEntry[]): void {
        const defineRe = /#\s*(?:libdefine|define)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
        let m: RegExpExecArray | null;
        while ((m = defineRe.exec(effective)) !== null) {
            const name = m[1];
            if (ACS_KEYWORDS.has(name.toLowerCase())) {
                continue;
            }
            const character = m.index + m[0].lastIndexOf(name);
            const sym: AcsConstantSymbol = {
                kind: SymbolKind.AcsConstant,
                name,
                source: '',
                packageId: '',
                entryPath: '',
                location: { line: lineNumber, character }
            };
            symbols.push(sym);
        }
    }

    private scanFunctions(effective: string, lineNumber: number, symbols: SymbolEntry[]): void {
        // function returnType Name( or function Name(
        const fnRe = /^\s*function\s+(?:(?:int|str|bool|fixed|void)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;
        const m = fnRe.exec(effective);
        if (!m) {
            return;
        }
        const name = m[1];
        if (ACS_KEYWORDS.has(name.toLowerCase())) {
            return;
        }
        const character = m[0].toLowerCase().lastIndexOf(name.toLowerCase());
        const sym: AcsFunctionSymbol = {
            kind: SymbolKind.AcsFunction,
            name,
            source: '',
            packageId: '',
            entryPath: '',
            location: { line: lineNumber, character: Math.max(0, character) }
        };
        symbols.push(sym);
    }

    /**
     * @returns extra lines consumed beyond `lineNumber` (for multi-line param lists)
     */
    private scanScript(
        lines: string[],
        lineNumber: number,
        effective: string,
        symbols: SymbolEntry[]
    ): number {
        const m = SCRIPT_HEADER_RE.exec(effective);
        if (!m) {
            return 0;
        }

        const rawKey = m[1];
        const scriptKey =
            rawKey.startsWith('"') && rawKey.endsWith('"')
                ? rawKey.slice(1, -1)
                : rawKey;
        if (!scriptKey) {
            return 0;
        }

        const keyInLine = effective.indexOf(rawKey);
        const character = keyInLine >= 0
            ? (rawKey.startsWith('"') ? keyInLine + 1 : keyInLine)
            : 0;

        const afterHeader = effective.slice(m[0].length);
        const { params, linesConsumed } = extractScriptParams(lines, lineNumber, afterHeader);

        const sym: AcsScriptSymbol = {
            kind: SymbolKind.AcsScript,
            name: scriptKey,
            scriptKey,
            params,
            source: '',
            packageId: '',
            entryPath: '',
            location: { line: lineNumber, character }
        };
        symbols.push(sym);
        return linesConsumed;
    }
}

function stripLineComment(text: string): string {
    const idx = text.indexOf('//');
    return idx >= 0 ? text.slice(0, idx) : text;
}

/**
 * Parse `(int a, int b)` after a script header. Supports wrapped param lists.
 * `afterHeader` is the remainder of the header line after `script Name [TYPE]`.
 */
export function extractScriptParams(
    lines: string[],
    startLine: number,
    afterHeader: string
): { params: AcsScriptParam[]; linesConsumed: number } {
    let search = afterHeader;
    let line = startLine;
    let parenStart = search.indexOf('(');

    // Params may start on a following line before `{`
    while (parenStart < 0 && line + 1 < lines.length) {
        const next = stripLineComment(lines[line + 1]);
        if (next.includes('{') && !next.includes('(')) {
            return { params: [], linesConsumed: 0 };
        }
        line++;
        search = next;
        parenStart = search.indexOf('(');
        if (parenStart < 0 && search.includes('{')) {
            return { params: [], linesConsumed: line - startLine };
        }
    }

    if (parenStart < 0) {
        return { params: [], linesConsumed: 0 };
    }

    let depth = 0;
    let buf = '';
    let i = parenStart;
    let curLine = line;
    let curText = search;

    while (curLine < lines.length) {
        while (i < curText.length) {
            const ch = curText[i];
            if (ch === '(') {
                depth++;
                if (depth > 1) {
                    buf += ch;
                }
            } else if (ch === ')') {
                depth--;
                if (depth === 0) {
                    return {
                        params: parseTypedParamList(buf),
                        linesConsumed: curLine - startLine
                    };
                }
                buf += ch;
            } else if (depth >= 1) {
                buf += ch;
            }
            i++;
        }
        curLine++;
        if (curLine >= lines.length) {
            break;
        }
        curText = stripLineComment(lines[curLine]);
        i = 0;
        if (depth >= 1) {
            buf += ' ';
        }
    }

    return { params: [], linesConsumed: 0 };
}

/** Parse `int a, str b` / `int a, b` / `void`. */
export function parseTypedParamList(text: string): AcsScriptParam[] {
    const trimmed = text.trim();
    if (!trimmed || /^void$/i.test(trimmed)) {
        return [];
    }

    const params: AcsScriptParam[] = [];
    let lastType = 'int';
    for (const part of trimmed.split(',')) {
        const piece = part.trim();
        if (!piece) {
            continue;
        }
        const typed = /^(int|str|bool|fixed)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(piece);
        if (typed) {
            lastType = typed[1].toLowerCase();
            params.push({ type: lastType, name: typed[2] });
            continue;
        }
        const bare = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(piece);
        if (bare && !ACS_KEYWORDS.has(bare[1].toLowerCase())) {
            params.push({ type: lastType, name: bare[1] });
        }
    }
    return params;
}
