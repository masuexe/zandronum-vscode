import * as vscode from 'vscode';
import { CompletionSource, CompletionContext, SourceDependencies } from './Source';
import { makeDirectiveItem } from '../completionItemFactory';
import { directivesMatchingPrefix } from '../acsDirectives';

export class PreprocessorDirectiveSource implements CompletionSource {
    canProvide(context: CompletionContext): boolean {
        if (context.insideComment || context.insideString || context.insideInclude) {
            return false;
        }
        return context.insideHashDirective && context.braceDepth === 0 && context.scope === 'global';
    }

    provide(context: CompletionContext, _deps: SourceDependencies): vscode.CompletionItem[] {
        if (context.directiveHashCharacter === undefined || context.line === undefined || context.character === undefined) {
            return [];
        }
        const range = new vscode.Range(
            context.line,
            context.directiveHashCharacter,
            context.line,
            context.character
        );
        return directivesMatchingPrefix(context.wordPrefix).map((d) => makeDirectiveItem(d, range));
    }
}
