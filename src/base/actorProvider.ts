import { SymbolKind, SymbolEntry, ActorSymbol } from './types';
import { SymbolProvider } from './symbolDatabase';

const DECORATE_PATTERN = /\.dec$|\.decorate$|\.txt$/i;
const DECORATE_FILENAME = /^DECORATE(\.txt)?$/i;
const ACTOR_RE = /^\s*actor\s+(\w+)\s*(?::\s*(\w+))?/i;
const USER_VAR_RE = /\bvar\s+int\s+(user_\w+)\b/gi;

function decode(u8: Uint8Array): string {
    return Buffer.from(u8).toString('utf-8');
}

function countBraces(line: string): { opens: number; closes: number } {
    let opens = 0;
    let closes = 0;
    for (const ch of line) {
        if (ch === '{') {
            opens++;
        } else if (ch === '}') {
            closes++;
        }
    }
    return { opens, closes };
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
        let currentActor: ActorSymbol | undefined;

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
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i++;
                } else if (ch === '\n') {
                    lineNumber++;
                }
                continue;
            }
            if (inString) {
                currentLine += ch;
                if (ch === '\\' && next) {
                    currentLine += next;
                    i++;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                if (ch === '\n') {
                    currentActor = this.parseLine(
                        currentLine,
                        blockDepth,
                        lineNumber,
                        symbols,
                        currentActor
                    );
                    currentLine = '';
                    lineNumber++;
                }
                continue;
            }
            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }
            if (ch === '"') {
                inString = true;
                currentLine += ch;
                continue;
            }

            if (ch === '{') {
                blockDepth++;
            } else if (ch === '}') {
                blockDepth = Math.max(0, blockDepth - 1);
            }

            if (ch === '\n') {
                currentActor = this.parseLine(
                    currentLine,
                    blockDepth,
                    lineNumber,
                    symbols,
                    currentActor
                );
                currentLine = '';
                lineNumber++;
            } else {
                currentLine += ch;
            }
        }
        if (currentLine) {
            this.parseLine(currentLine, blockDepth, lineNumber, symbols, currentActor);
        }

        return symbols;
    }

    private parseLine(
        line: string,
        depthAfter: number,
        lineNumber: number,
        symbols: ActorSymbol[],
        currentActor: ActorSymbol | undefined
    ): ActorSymbol | undefined {
        const { opens, closes } = countBraces(line);
        const depthBefore = depthAfter - opens + closes;

        const m = ACTOR_RE.exec(line);
        if (m && m[1] && depthBefore === 0) {
            const nameStart = m[0].toLowerCase().indexOf(m[1].toLowerCase());
            currentActor = {
                kind: SymbolKind.Actor,
                name: m[1],
                parentClass: m[2] || undefined,
                userVars: [],
                source: '',
                packageId: '',
                entryPath: '',
                location: {
                    line: lineNumber,
                    character: Math.max(0, nameStart)
                }
            };
            symbols.push(currentActor);
        }

        if (currentActor && (depthAfter > 0 || (m !== null && opens > 0))) {
            USER_VAR_RE.lastIndex = 0;
            let vm: RegExpExecArray | null;
            while ((vm = USER_VAR_RE.exec(line)) !== null) {
                const name = vm[1];
                if (!currentActor.userVars) {
                    currentActor.userVars = [];
                }
                if (!currentActor.userVars.some(v => v.toLowerCase() === name.toLowerCase())) {
                    currentActor.userVars.push(name);
                }
            }
        }

        if (depthAfter === 0 && !m) {
            return undefined;
        }
        return currentActor;
    }
}
