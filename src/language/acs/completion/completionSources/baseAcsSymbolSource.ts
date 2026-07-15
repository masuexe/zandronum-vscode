import * as vscode from 'vscode';
import { CompletionSource, CompletionContext, SourceDependencies } from './Source';
import { makeConstantItem, makeFunctionItem } from '../completionItemFactory';
import { SymbolDatabase } from '../../../../base/symbolDatabase';
import { SymbolKind } from '../../../../base/types';
import { symbolSourceDetail } from '../../../../base/symbolLocation';

/** Completions from base-resource ACS symbols (defines / functions). */
export class BaseAcsSymbolSource implements CompletionSource {
    constructor(private readonly symbolDb: SymbolDatabase) {}

    canProvide(context: CompletionContext): boolean {
        if (context.insideComment || context.insideString) { return false; }
        return context.wordPrefix.length > 0;
    }

    provide(context: CompletionContext, _deps: SourceDependencies): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const lower = context.wordPrefix.toLowerCase();

        for (const sym of this.symbolDb.search(SymbolKind.AcsConstant, lower)) {
            if (sym.packageId === 'workspace') { continue; }
            const item = makeConstantItem(sym.name, 'user');
            item.detail = `Constant — ${symbolSourceDetail(sym)}`;
            items.push(item);
        }

        for (const sym of this.symbolDb.search(SymbolKind.AcsFunction, lower)) {
            if (sym.packageId === 'workspace') { continue; }
            const item = makeFunctionItem(sym.name, symbolSourceDetail(sym));
            items.push(item);
        }

        return items;
    }
}
