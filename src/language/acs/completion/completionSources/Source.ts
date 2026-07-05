import * as vscode from 'vscode';
import { CompletionContext } from '../completionContext';

export interface CompletionSource {
    canProvide(context: CompletionContext): boolean;
    provide(context: CompletionContext, deps: SourceDependencies): vscode.CompletionItem[] | Promise<vscode.CompletionItem[]>;
}

export type { CompletionContext };

export interface SourceDependencies {
    functionRepository: import('../repositories/functionRepository').FunctionRepository;
    constantRepository: import('../repositories/constantRepository').ConstantRepository;
    visibleSymbolProvider: import('../visibleSymbolProvider').VisibleSymbolProvider;
}
