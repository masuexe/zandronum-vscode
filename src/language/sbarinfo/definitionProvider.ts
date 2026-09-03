import * as vscode from 'vscode';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { resolveActorDefinition } from '../decorate/actorResolve';
import { extractInInventoryActorAtCursor } from './inInventoryResolve';

export { extractInInventoryActorAtCursor } from './inInventoryResolve';

export function registerSbarinfoDefinitionProvider(
    context: vscode.ExtensionContext,
    symbolDb?: SymbolDatabase
): void {
    const provider = vscode.languages.registerDefinitionProvider(
        [{ language: 'sbarinfo' }],
        {
            async provideDefinition(
                document: vscode.TextDocument,
                position: vscode.Position,
                token: vscode.CancellationToken
            ): Promise<vscode.Definition | undefined> {
                const lineText = document.lineAt(position.line).text;
                const actor = extractInInventoryActorAtCursor(lineText, position.character);
                if (!actor) {
                    return undefined;
                }
                return resolveActorDefinition(
                    actor.className,
                    document.uri,
                    token,
                    symbolDb
                );
            },
        }
    );
    context.subscriptions.push(provider);
}
