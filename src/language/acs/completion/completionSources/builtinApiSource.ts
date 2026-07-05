import * as vscode from 'vscode';
import { CompletionSource, CompletionContext, SourceDependencies } from './Source';
import { makeFunctionItem, makeConstantItem, makeEnumItem } from '../completionItemFactory';
import { buildSnippetString } from '../../../../shared/snippetBuilder';
import { ActionData } from '../../../../shared/dataLoader';

export class BuiltinApiSource implements CompletionSource {
    canProvide(context: CompletionContext): boolean {
        if (context.insideComment || context.insideString) return false;
        return context.inFunctionCall || context.wordPrefix.length > 0;
    }

    provide(context: CompletionContext, deps: SourceDependencies): vscode.CompletionItem[] {
        if (context.inFunctionCall && context.functionName && context.paramIndex !== undefined) {
            const mode = deps.functionRepository.getParamMode(
                context.functionName, context.paramIndex
            );
            if (mode) {
                return this.provideEnumItems(context, deps);
            }
            return this.provideConstants(context, deps);
        }

        if (context.inFunctionCall) {
            return this.provideConstants(context, deps);
        }

        const items: vscode.CompletionItem[] = [];
        items.push(...this.provideFunctionItems(context, deps));
        items.push(...this.provideConstants(context, deps));
        return items;
    }

    private provideFunctionItems(
        context: CompletionContext,
        deps: SourceDependencies
    ): vscode.CompletionItem[] {
        const matches = deps.functionRepository.findByPrefix(context.wordPrefix);
        const items: vscode.CompletionItem[] = [];
        for (const { name, data } of matches) {
            items.push(makeFunctionItem(
                name,
                buildSnippetString(name, data.params as any)
            ));
        }
        return items;
    }

    private provideConstants(
        context: CompletionContext,
        deps: SourceDependencies
    ): vscode.CompletionItem[] {
        const matches = deps.constantRepository.findByPrefix(context.wordPrefix);
        const items: vscode.CompletionItem[] = [];
        for (const { name } of matches) {
            items.push(makeConstantItem(name, 'builtin'));
        }
        return items;
    }

    private provideEnumItems(
        context: CompletionContext,
        deps: SourceDependencies
    ): vscode.CompletionItem[] {
        const fnName = context.functionName!;
        const paramIdx = context.paramIndex!;
        const mode = deps.functionRepository.getParamMode(fnName, paramIdx);
        if (!mode) return [];

        const action = deps.functionRepository.find(fnName);
        if (!action || !Array.isArray(action.params)) return [];

        const param = action.params[paramIdx] as any;
        if (!param || !Array.isArray(param.enum)) return [];

        const prefix = context.wordPrefix;
        const items: vscode.CompletionItem[] = [];
        for (const entry of param.enum) {
            if (prefix && !entry.name.toUpperCase().startsWith(prefix.toUpperCase())) continue;
            items.push(makeEnumItem(entry.name, entry.value));
        }
        return items;
    }
}
