import * as vscode from 'vscode';
import { CompletionSource, CompletionContext, SourceDependencies } from './Source';
import { makeKeywordItem, makeSnippetItem } from '../completionItemFactory';

const KEYWORDS = [
    'int', 'str', 'bool', 'void', 'fixed',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case',
    'break', 'continue', 'return',
    'function', 'script',
    'world', 'global',
];

export class LanguageKeywordSource implements CompletionSource {
    canProvide(context: CompletionContext): boolean {
        return context.scope === 'global' && context.wordPrefix.length > 0;
    }

    provide(context: CompletionContext, _deps: SourceDependencies): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const lower = context.wordPrefix.toLowerCase();

        for (const kw of KEYWORDS) {
            if (kw.toLowerCase().startsWith(lower)) {
                items.push(makeKeywordItem(kw));
            }
        }

        if ('function'.startsWith(lower)) {
            items.push(makeSnippetItem(
                'function',
                new vscode.SnippetString('function ${1:void} ${2:name}($3)\n{\n\t$0\n}'),
                'Snippet: function'
            ));
        }

        if ('script'.startsWith(lower)) {
            items.push(makeSnippetItem(
                'script',
                new vscode.SnippetString('script "${1:name}" (${2:void})\n{\n\t$0\n}'),
                'Snippet: script'
            ));
        }

        return items;
    }
}
