import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectKeywordPropertyTranslationColors,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';

const TRANSLATION_RE = /\bTranslation\b/i;

export function registerTexturesColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'textures' }],
        {
            async provideDocumentColors(document, token) {
                const palette = await loadPlaypal();
                return collectKeywordPropertyTranslationColors(
                    document,
                    TRANSLATION_RE,
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
