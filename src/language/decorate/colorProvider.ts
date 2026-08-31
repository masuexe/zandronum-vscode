import * as vscode from 'vscode';
import { ActionData } from '../../shared/dataLoader';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectKeywordPropertyTranslationColors,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';
import {
    buildColorParameterIndex,
    collectDecorateFunctionColors,
    provideNamedColorPresentations,
    resolveNamedColor,
} from './namedColorScan';

const TRANSLATION_LINE_RE = /\bTranslation\b/i;

export function registerColorProvider(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>,
    x11Colors: Record<string, [number, number, number]>
) {
    const colorParameterIndex = buildColorParameterIndex(actionsData);
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'decorate' }],
        {
            async provideDocumentColors(document, token) {
                const palette = await loadPlaypal();
                const translationColors = collectKeywordPropertyTranslationColors(
                    document,
                    TRANSLATION_LINE_RE,
                    palette,
                    token
                );
                const namedColors = collectDecorateFunctionColors(
                    document,
                    colorParameterIndex,
                    x11Colors,
                    token
                );
                return [...translationColors, ...namedColors];
            },

            async provideColorPresentations(color, context) {
                const currentText = context.document.getText(context.range);
                if (resolveNamedColor(currentText, x11Colors)) {
                    return provideNamedColorPresentations(color, context);
                }
                const palette = await loadPlaypal();
                return provideTranslationColorPresentations(color, context, palette);
            }
        }
    );

    context.subscriptions.push(provider);
}
