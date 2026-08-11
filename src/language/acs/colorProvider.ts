import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import {
    collectTranslationColorsOnLine,
    provideTranslationColorPresentations,
} from '../shared/translationColorScan';

const CREATE_TRANSLATION_RE = /\bCreateTranslation\b/i;

export function registerAcsColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [
            { language: 'acs' },
            { pattern: '**/*.{acs,ACS}' },
            { pattern: '**/SCRIPTS' },
        ],
        {
            async provideDocumentColors(document, token) {
                const colors: vscode.ColorInformation[] = [];
                const palette = await loadPlaypal();

                for (let i = 0; i < document.lineCount; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const line = document.lineAt(i);
                    if (!CREATE_TRANSLATION_RE.test(line.text)) {
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
