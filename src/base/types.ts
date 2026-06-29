export enum SymbolKind {
    Actor = 'actor'
}

export interface SymbolEntry {
    kind: SymbolKind;
    name: string;
    source: string;
}

export interface ActorSymbol extends SymbolEntry {
    kind: SymbolKind.Actor;
    parentClass?: string;
}

export interface PackageEntry {
    path: string;
    size: number;
}

export interface PackageSource {
    readonly id: string;
    readonly priority: number;
    getEntries(): Promise<PackageEntry[]>;
    openEntry(path: string): Promise<Uint8Array>;
}
