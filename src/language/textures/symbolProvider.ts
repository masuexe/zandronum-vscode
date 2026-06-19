import * as vscode from 'vscode';
import { TexturesParser, TexturesNode, TexturesNodeKind } from './texturesParser';

export function registerTexturesSymbolProvider(
    context: vscode.ExtensionContext,
    parser: TexturesParser
) {
    const docProvider = vscode.languages.registerDocumentSymbolProvider(
        [{ language: 'textures' }],
        {
            provideDocumentSymbols(document) {
                parser.update(document);
                const nodes = parser.getSymbols();
                return nodes.map(nodeToSymbol);
            }
        }
    );

    const workspaceProvider = vscode.languages.registerWorkspaceSymbolProvider({
        async provideWorkspaceSymbols(query) {
            const files = await vscode.workspace.findFiles('**/TEXTURES*');
            const results: vscode.SymbolInformation[] = [];
            const lowerQuery = query.toLowerCase();

            for (const uri of files) {
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    parser.update(doc);
                    const nodes = parser.getSymbols();
                    for (const node of nodes) {
                        if (!lowerQuery || node.name.toLowerCase().includes(lowerQuery)) {
                            results.push(new vscode.SymbolInformation(
                                node.name,
                                vscode.SymbolKind.Class,
                                `${node.type} ${node.defData?.width ?? 0}\u00d7${node.defData?.height ?? 0}`,
                                new vscode.Location(uri, node.nameRange)
                            ));
                        }
                        for (const child of node.children) {
                            if (!lowerQuery || child.name.toLowerCase().includes(lowerQuery)) {
                                results.push(new vscode.SymbolInformation(
                                    child.name,
                                    vscode.SymbolKind.Field,
                                    node.name,
                                    new vscode.Location(uri, child.nameRange)
                                ));
                            }
                        }
                    }
                } catch {
                }
            }
            return results;
        }
    });

    context.subscriptions.push(docProvider, workspaceProvider);
}

function nodeToSymbol(node: TexturesNode): vscode.DocumentSymbol {
    const kind = node.kind === TexturesNodeKind.Definition
        ? vscode.SymbolKind.Class
        : vscode.SymbolKind.Field;

    const detail = node.kind === TexturesNodeKind.Definition
        ? `${node.type} ${node.defData?.width ?? 0}\u00d7${node.defData?.height ?? 0}`
        : `(${node.patchData?.x ?? 0}, ${node.patchData?.y ?? 0})`;

    const symbol = new vscode.DocumentSymbol(
        node.name,
        detail,
        kind,
        node.range,
        node.nameRange
    );

    symbol.children = node.children.map(nodeToSymbol);
    return symbol;
}
