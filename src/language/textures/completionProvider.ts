import * as vscode from 'vscode';
import { TexturesKeywordData } from '../../shared/dataLoader';
import { TexturesParser, TexturesContext } from './contextParser';

export function registerTexturesCompletionProvider(
    context: vscode.ExtensionContext,
    keywordsData: Record<string, TexturesKeywordData>,
    parser: TexturesParser
) {
    const definitions: [string, TexturesKeywordData][] = [];
    const textureProps: [string, TexturesKeywordData][] = [];
    const patchProps: [string, TexturesKeywordData][] = [];
    const styleValues: string[] = [];

    for (const [name, data] of Object.entries(keywordsData)) {
        switch (data.category) {
            case 'definition': definitions.push([name, data]); break;
            case 'textureProperty': textureProps.push([name, data]); break;
            case 'patchProperty': patchProps.push([name, data]); break;
        }
        if (name === 'Style' && data.params) {
            for (const p of data.params) {
                if (p.mode === 'enum' && p.enum) {
                    for (const e of p.enum) { styleValues.push(e.name); }
                }
            }
        }
    }

    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'textures' }],
        {
            provideCompletionItems(document, position) {
                parser.update(document);
                const ctx = parser.getContextAtPosition(position);
                const line = document.lineAt(position.line).text;
                const textBefore = line.substring(0, position.character);

                if (ctx === TexturesContext.Patch && /\bStyle\s+\w*$/i.test(textBefore)) {
                    return styleValues.map(v => {
                        const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
                        item.sortText = '0_' + v;
                        return item;
                    });
                }

                const items: vscode.CompletionItem[] = [];

                if (ctx === TexturesContext.Top) {
                    for (const [name, data] of definitions) {
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
                        item.detail = data.desc;
                        item.insertText = new vscode.SnippetString(
                            `${name} "\${1:name}", \${2:64}, \${3:64}\n{\n\t\$0\n}`
                        );
                        item.sortText = '0_' + name;
                        items.push(item);
                    }
                } else if (ctx === TexturesContext.Texture) {
                    for (const [name, data] of textureProps) {
                        if (name === 'Patch') {
                            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Method);
                            item.detail = data.desc;
                            item.insertText = new vscode.SnippetString(
                                `Patch "\${1:patchname}", \${2:0}, \${3:0}\n{\n\t\$0\n}`
                            );
                            item.sortText = '0_' + name;
                            items.push(item);
                        } else {
                            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                            item.detail = data.desc;
                            item.sortText = '1_' + name;
                            items.push(item);
                        }
                    }
                    const graphicItem = new vscode.CompletionItem('Graphic', vscode.CompletionItemKind.Method);
                    graphicItem.detail = 'Adds a graphic layer (alternative namespace to Patch).';
                    graphicItem.insertText = new vscode.SnippetString(
                        `Graphic "\${1:name}", \${2:0}, \${3:0}\n{\n\t\$0\n}`
                    );
                    graphicItem.sortText = '0_Graphic';
                    items.push(graphicItem);
                } else if (ctx === TexturesContext.Patch) {
                    for (const [name, data] of patchProps) {
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
                        item.detail = data.desc;
                        item.sortText = '0_' + name;
                        items.push(item);
                    }
                }

                return items;
            }
        }
    );

    context.subscriptions.push(provider);
}
