import * as vscode from 'vscode';
import { ActionData } from '../../shared/dataLoader';

/** Prefix from '$' through the cursor, plus the range that completion must replace. */
function getCommandPrefixAt(
    lineText: string,
    position: vscode.Position
): { prefix: string; range: vscode.Range } | undefined {
    let i = position.character - 1;
    while (i >= 0 && /[A-Za-z0-9_]/.test(lineText[i])) {
        i--;
    }
    if (i < 0 || lineText[i] !== '$') {
        return undefined;
    }
    // '$' must not be mid-identifier
    if (i > 0 && /[A-Za-z0-9_]/.test(lineText[i - 1])) {
        return undefined;
    }

    const start = i;
    return {
        prefix: lineText.substring(start, position.character),
        range: new vscode.Range(position.line, start, position.line, position.character)
    };
}

function provideCommandItems(
    commandsData: Record<string, ActionData>,
    prefix: string,
    range: vscode.Range
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [name, data] of Object.entries(commandsData)) {
        if (prefix && !name.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = data.desc || 'SNDINFO command';
        item.insertText = name;
        item.range = range;
        item.sortText = '0_' + name;

        items.push(item);
    }

    return items;
}

export function registerSndinfoCompletionProvider(
    context: vscode.ExtensionContext,
    commandsData: Record<string, ActionData>
) {
    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'sndinfo' }],
        {
            provideCompletionItems(document, position) {
                const lineText = document.lineAt(position.line).text;
                const at = getCommandPrefixAt(lineText, position);
                if (!at) {
                    return [];
                }

                return provideCommandItems(commandsData, at.prefix, at.range);
            }
        },
        '$'
    );

    context.subscriptions.push(provider);
}
