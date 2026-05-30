import * as vscode from 'vscode';
import { ActionData } from '../../shared/dataLoader';

function getWordPrefix(lineText: string, position: vscode.Position): string {
    let prefix = '';
    let i = position.character - 1;
    while (i >= 0 && /[A-Za-z0-9_$]/.test(lineText[i])) {
        prefix = lineText[i] + prefix;
        i--;
    }
    return prefix;
}

function provideCommandItems(
    commandsData: Record<string, ActionData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [name, data] of Object.entries(commandsData)) {
        if (prefix && !name.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
        item.detail = data.desc || 'SNDINFO command';
        item.insertText = name.substring(1);
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
                const line = document.lineAt(position.line);
                const lineText = line.text;
                const wordPrefix = getWordPrefix(lineText, position);

                const textBefore = lineText.substring(0, position.character);

                // Only trigger when $ is preceded by whitespace or line start
                if (!/(?:^|\s)\$/.test(textBefore)) {
                    return [];
                }

                return provideCommandItems(commandsData, wordPrefix);
            }
        },
        '$'
    );

    context.subscriptions.push(provider);
}
