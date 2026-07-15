import * as vscode from 'vscode';
import { ActionData, AcsConstantData } from '../../../shared/dataLoader';
import { WorkspaceIndex } from '../compilationUnit';
import { buildCompletionContext } from './completionContext';
import { CompletionSource, SourceDependencies } from './completionSources/Source';
import { LanguageKeywordSource } from './completionSources/languageKeywordSource';
import { BuiltinApiSource } from './completionSources/builtinApiSource';
import { WorkspaceSymbolSource } from './completionSources/workspaceSymbolSource';
import { BaseAcsSymbolSource } from './completionSources/baseAcsSymbolSource';
import { createFunctionRepository } from './repositories/functionRepository';
import { createConstantRepository } from './repositories/constantRepository';
import { SymbolDatabase } from '../../../base/symbolDatabase';

export function registerAcsCompletionProvider(
    context: vscode.ExtensionContext,
    functionsData: Record<string, ActionData>,
    constantsData: Record<string, AcsConstantData>,
    workspaceIndex: WorkspaceIndex,
    symbolDb?: SymbolDatabase,
) {
    const sources: CompletionSource[] = [
        new LanguageKeywordSource(),
        new BuiltinApiSource(),
        new WorkspaceSymbolSource(),
    ];
    if (symbolDb) {
        sources.push(new BaseAcsSymbolSource(symbolDb));
    }

    const deps: SourceDependencies = {
        functionRepository: createFunctionRepository(functionsData),
        constantRepository: createConstantRepository(constantsData),
        visibleSymbolProvider: workspaceIndex,
    };

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            [{ language: 'acs' }],
            {
                async provideCompletionItems(document, position, token, trigger) {
                    const ctx = buildCompletionContext(document, position);
                    if (ctx.insideComment) return [];

                    if (trigger?.triggerCharacter === ',' || trigger?.triggerCharacter === '|') {
                        if (!ctx.inFunctionCall || !ctx.functionName || ctx.paramIndex === undefined) return [];
                        const mode = deps.functionRepository.getParamMode(
                            ctx.functionName, ctx.paramIndex
                        );
                        if (!mode) return [];
                        if (trigger.triggerCharacter === '|' && mode !== 'flags') return [];
                    }

                    const items: vscode.CompletionItem[] = [];
                    for (const source of sources) {
                        if (token.isCancellationRequested) break;
                        if (!source.canProvide(ctx)) continue;
                        const result = source.provide(ctx, deps);
                        items.push(...await result);
                    }
                    return items;
                }
            },
            '(', ',', '|'
        )
    );
}
