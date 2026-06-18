import * as vscode from 'vscode';
import { TexturesParser } from './contextParser';

export function registerTexturesFoldingProvider(
    context: vscode.ExtensionContext,
    parser: TexturesParser
) {
    const provider = vscode.languages.registerFoldingRangeProvider(
        [{ language: 'textures' }],
        {
            provideFoldingRanges(document) {
                parser.update(document);
                return parser.getFoldingRanges();
            }
        }
    );

    context.subscriptions.push(provider);
}
