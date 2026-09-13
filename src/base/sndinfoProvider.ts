import { SymbolKind, SymbolEntry, SoundSymbol } from './types';
import { SymbolProvider } from './symbolDatabase';
import { collectSoundDefinitions, isSndinfoFileName } from './sndinfoParse';

function decode(u8: Uint8Array): string {
    return Buffer.from(u8).toString('utf-8');
}

/** Indexes SNDINFO logical names from package lumps (workspace + base PK3). */
export class SndinfoSymbolProvider implements SymbolProvider {
    readonly symbolKind = SymbolKind.Sound;

    canHandle(entryPath: string): boolean {
        const name = entryPath.split('/').pop() ?? '';
        return isSndinfoFileName(name);
    }

    parse(_entryPath: string, content: Uint8Array): SymbolEntry[] {
        const defs = collectSoundDefinitions(decode(content));
        const symbols: SoundSymbol[] = [];
        for (const def of defs) {
            symbols.push({
                kind: SymbolKind.Sound,
                name: def.name,
                source: '',
                packageId: '',
                entryPath: '',
                location: { line: def.line, character: def.character },
            });
        }
        return symbols;
    }
}
