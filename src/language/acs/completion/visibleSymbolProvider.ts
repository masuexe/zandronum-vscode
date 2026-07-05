export interface CompletionSymbol {
    name: string;
    detail: string;
}

export interface VisibleSymbols {
    variables: readonly CompletionSymbol[];
    constants: readonly CompletionSymbol[];
}

export interface VisibleSymbolProvider {
    getVisibleSymbols(filePath: string): Promise<VisibleSymbols>;
}
