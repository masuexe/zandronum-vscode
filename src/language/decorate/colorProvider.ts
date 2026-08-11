import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectTranslationColorsOnLine,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';

const TRANSLATION_LINE_RE = /\bTranslation\b/i;

export function registerColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'decorate' }],
        {
            async provideDocumentColors(document, token) {
                const colors: vscode.ColorInformation[] = [];
                const palette = await loadPlaypal();

                for (let i = 0; i < document.lineCount; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const line = document.lineAt(i);
                    if (!TRANSLATION_LINE_RE.test(line.text)) {
                        continue;
                    }

                    colors.push(...collectTranslationColorsOnLine(line.text, i, palette));
                }

                return colors;
            },

            async provideColorPresentations(color, context) {
                const palette = await loadPlaypal();
                return provideTranslationColorPresentations(color, context, palette);
            }
        }
    );

    context.subscriptions.push(provider);
}
