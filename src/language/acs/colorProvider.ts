import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectCreateTranslationColors,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';

export function registerAcsColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [
            { language: 'acs' },
            { pattern: '**/*.{acs,ACS}' },
            { pattern: '**/SCRIPTS' },
        ],
        {
            async provideDocumentColors(document, token) {
                const palette = await loadPlaypal();
                return collectCreateTranslationColors(document, palette, token);
            },

            async provideColorPresentations(color, context) {
                const palette = await loadPlaypal();
                return provideTranslationColorPresentations(color, context, palette);
            }
        }
    );

    context.subscriptions.push(provider);
}
