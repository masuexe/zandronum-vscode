import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectKeywordPropertyTranslationColors,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';

const TRANSLATION_LINE_RE = /\bTranslation\b/i;

export function registerColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'decorate' }],
        {
            async provideDocumentColors(document, token) {
                const palette = await loadPlaypal();
                return collectKeywordPropertyTranslationColors(
                    document,
                    TRANSLATION_LINE_RE,
                    palette,
                    token
                );
            },

            async provideColorPresentations(color, context) {
                const palette = await loadPlaypal();
                return provideTranslationColorPresentations(color, context, palette);
            }
        }
    );

    context.subscriptions.push(provider);
}
