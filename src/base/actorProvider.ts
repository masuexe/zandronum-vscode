import { SymbolKind, SymbolEntry, ActorSymbol } from './types';
import { SymbolProvider } from './symbolDatabase';

const DECORATE_PATTERN = /\.dec$|\.decorate$/i;
const DECORATE_FILENAME = /^DECORATE$/i;

function decode(u8: Uint8Array): string {
    return Buffer.from(u8).toString('utf-8');
}

export class ActorSymbolProvider implements SymbolProvider {
    readonly symbolKind = SymbolKind.Actor;

    canHandle(entryPath: string): boolean {
        const name = entryPath.split('/').pop() ?? '';
        return DECORATE_PATTERN.test(name) || DECORATE_FILENAME.test(name);
    }

    parse(_entryPath: string, content: Uint8Array): SymbolEntry[] {
        const text = decode(content);
        const symbols: ActorSymbol[] = [];
        let blockDepth = 0;
        let inString = false;
        let inLineComment = false;
        let inBlockComment = false;
        let currentLine = '';
        let lineNumber = 0;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const next = i + 1 < text.length ? text[i + 1] : '';

            if (inLineComment) {
                if (ch === '\n') {
                    inLineComment = false;
                    currentLine = '';
                    lineNumber++;
                }
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') { inBlockComment = false; i++; }
                else if (ch === '\n') { lineNumber++; }
                continue;
            }
            if (inString) {
                currentLine += ch;
                if (ch === '\\' && next) { currentLine += next; i++; continue; }
                if (ch === '"') { inString = false; }
                if (ch === '\n') {
                    this.parseLine(currentLine, blockDepth, lineNumber, symbols);
                    currentLine = '';
                    lineNumber++;
                }
                continue;
            }
            if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
            if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
            if (ch === '"') { inString = true; currentLine += ch; continue; }

            if (ch === '{') { blockDepth++; }
            else if (ch === '}') { blockDepth = Math.max(0, blockDepth - 1); }

            if (ch === '\n') {
                this.parseLine(currentLine, blockDepth, lineNumber, symbols);
                currentLine = '';
                lineNumber++;
            } else {
                currentLine += ch;
            }
        }
        if (currentLine) {
            this.parseLine(currentLine, blockDepth, lineNumber, symbols);
        }

        return symbols;
    }

    private parseLine(line: string, depth: number, lineNumber: number, symbols: ActorSymbol[]): void {
        if (depth > 0) { return; }
        const m = /^\s*actor\s+(\w+)\s*(?::\s*(\w+))?/i.exec(line);
        if (!m || !m[1]) { return; }
        const nameStart = m[0].toLowerCase().indexOf(m[1].toLowerCase());
        symbols.push({
            kind: SymbolKind.Actor,
            name: m[1],
            parentClass: m[2] || undefined,
            source: '',
            packageId: '',
            entryPath: '',
            location: {
                line: lineNumber,
                character: Math.max(0, nameStart)
            }
        });
    }
}
