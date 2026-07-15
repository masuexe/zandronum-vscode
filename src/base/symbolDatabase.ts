import { SymbolKind, SymbolEntry, PackageSource } from './types';

export interface SymbolProvider {
    readonly symbolKind: SymbolKind;
    canHandle(entryPath: string): boolean;
    parse(entryPath: string, content: Uint8Array): SymbolEntry[];
}

export class SymbolDatabase {
    /** kind → lowerName → SymbolEntry */
    private data = new Map<SymbolKind, Map<string, SymbolEntry>>();
    private providers: SymbolProvider[] = [];

    registerProvider(provider: SymbolProvider): void {
        this.providers.push(provider);
    }

    async build(packages: readonly PackageSource[]): Promise<void> {
        this.data.clear();

        for (const pkg of packages) {
            const entries = await pkg.getEntries();
            for (const entry of entries) {
                for (const provider of this.providers) {
                    if (!provider.canHandle(entry.path)) { continue; }
                    const content = await pkg.openEntry(entry.path);
                    if (content.length === 0) { continue; }
                    const symbols = provider.parse(entry.path, content);
                    for (const sym of symbols) {
                        this.add({
                            ...sym,
                            packageId: pkg.id,
                            source: pkg.label,
                            entryPath: entry.path,
                        });
                    }
                }
            }
        }
    }

    query<T extends SymbolEntry>(kind: SymbolKind, name: string): T | undefined {
        const kindMap = this.data.get(kind);
        if (!kindMap) { return undefined; }
        return kindMap.get(name.toLowerCase()) as T | undefined;
    }

    queryAll(kind: SymbolKind): SymbolEntry[] {
        const kindMap = this.data.get(kind);
        if (!kindMap) { return []; }
        return Array.from(kindMap.values());
    }

    search(kind: SymbolKind, prefix: string): SymbolEntry[] {
        const kindMap = this.data.get(kind);
        if (!kindMap) { return []; }
        const lower = prefix.toLowerCase();
        const results: SymbolEntry[] = [];
        for (const [key, value] of kindMap) {
            if (key.startsWith(lower)) {
                results.push(value);
            }
        }
        return results;
    }

    private add(sym: SymbolEntry): void {
        let kindMap = this.data.get(sym.kind);
        if (!kindMap) {
            kindMap = new Map();
            this.data.set(sym.kind, kindMap);
        }
        // Later packages override earlier (caller iterates in priority order)
        kindMap.set(sym.name.toLowerCase(), sym);
    }
}
