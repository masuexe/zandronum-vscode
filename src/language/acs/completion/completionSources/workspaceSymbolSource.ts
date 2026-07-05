import * as vscode from 'vscode';
import { CompletionSource, CompletionContext, SourceDependencies } from './Source';
import { makeVariableItem, makeConstantItem } from '../completionItemFactory';

export class WorkspaceSymbolSource implements CompletionSource {
    canProvide(context: CompletionContext): boolean {
        if (context.insideComment || context.insideString) return false;
        return context.wordPrefix.length > 0;
    }

    async provide(context: CompletionContext, deps: SourceDependencies): Promise<vscode.CompletionItem[]> {
        const symbols = await deps.visibleSymbolProvider.getVisibleSymbols('');
        const items: vscode.CompletionItem[] = [];
        const lower = context.wordPrefix.toLowerCase();

        for (const v of symbols.variables) {
            if (v.name.toLowerCase().startsWith(lower)) {
                items.push(makeVariableItem(v.name, v.detail));
            }
        }

        for (const c of symbols.constants) {
            if (c.name.toLowerCase().startsWith(lower)) {
                items.push(makeConstantItem(c.name, 'user'));
            }
        }

        return items;
    }
}
