import { SymbolKind, SymbolEntry, AcsConstantSymbol, AcsFunctionSymbol } from './types';
import { SymbolProvider } from './symbolDatabase';
import { ACS_KEYWORDS } from '../language/acs/scanner';

const ACS_PATTERN = /\.acs$/i;
const ACS_FILENAME = /^(SCRIPTS|ACS)$/i;

function decode(u8: Uint8Array): string {
    return Buffer.from(u8).toString('utf-8');
}

/**
 * Indexes user #define / #libdefine constants and function declarations
 * from ACS source files inside packages.
 */
export class AcsSymbolProvider implements SymbolProvider {
    readonly symbolKind = SymbolKind.AcsConstant;

    canHandle(entryPath: string): boolean {
        const name = entryPath.split('/').pop() ?? '';
        return ACS_PATTERN.test(name) || ACS_FILENAME.test(name);
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
                if (end < 0) { continue; }
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
        }

        return symbols;
    }

    private scanDefines(effective: string, lineNumber: number, symbols: SymbolEntry[]): void {
        const defineRe = /#\s*(?:libdefine|define)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
        let m: RegExpExecArray | null;
        while ((m = defineRe.exec(effective)) !== null) {
            const name = m[1];
            if (ACS_KEYWORDS.has(name.toLowerCase())) { continue; }
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
        if (!m) { return; }
        const name = m[1];
        if (ACS_KEYWORDS.has(name.toLowerCase())) { return; }
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
}
