export enum SymbolKind {
    Actor = 'actor',
    AcsConstant = 'acsConstant',
    AcsFunction = 'acsFunction',
    AcsScript = 'acsScript',
}

export interface SymbolLocation {
    line: number;
    character: number;
}

export interface SymbolEntry {
    kind: SymbolKind;
    name: string;
    /** Display label for the package/source (e.g. filename of the PK3). */
    source: string;
    packageId: string;
    entryPath: string;
    location?: SymbolLocation;
}

export interface ActorSymbol extends SymbolEntry {
    kind: SymbolKind.Actor;
    parentClass?: string;
}

export interface AcsConstantSymbol extends SymbolEntry {
    kind: SymbolKind.AcsConstant;
}

export interface AcsFunctionSymbol extends SymbolEntry {
    kind: SymbolKind.AcsFunction;
}

export interface AcsScriptParam {
    name: string;
    type: string;
}

export interface AcsScriptSymbol extends SymbolEntry {
    kind: SymbolKind.AcsScript;
    /** Script name or number as string (lookup key; stored case-preserved). */
    scriptKey: string;
    params: AcsScriptParam[];
}

export interface PackageEntry {
    path: string;
    size: number;
}

export interface PackageSource {
    readonly id: string;
    readonly priority: number;
    /** Human-readable label for UI (e.g. basename of archive). */
    readonly label: string;
    getEntries(): Promise<PackageEntry[]>;
    openEntry(path: string): Promise<Uint8Array>;
}

export type PackageBuildWarning = {
    path: string;
    message: string;
};
