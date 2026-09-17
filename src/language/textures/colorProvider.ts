import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';
import { provideTranslationColorPresentations } from '../shared/translationColorScan';
import { TexturesTranslationViewportPreview, TRANSLATION_PREVIEW_MODE_SETTING } from './translationViewportPreview';

export function registerTexturesColorProvider(context: vscode.ExtensionContext) {
    const viewportPreview = new TexturesTranslationViewportPreview();

    let generation = 0;
    const register = () => vscode.languages.registerColorProvider(
        [{ language: 'textures' }],
        {
            async provideDocumentColors(document, token) {
                const requestGeneration = generation;
                const version = document.version;
                if (viewportPreview.isViewportMode(document.uri)) {
                    return viewportPreview.provideNativeDocumentColors(document, null, token);
                }
                const palette = await loadPlaypal();
                if (requestGeneration !== generation || document.isClosed || version !== document.version
                    || token.isCancellationRequested) { return []; }
                return viewportPreview.provideNativeDocumentColors(document, palette, token);
            },

            async provideColorPresentations(color, context) {
                const palette = await loadPlaypal();
                return provideTranslationColorPresentations(color, context, palette);
            }
        }
    );

    let provider = register();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration(TRANSLATION_PREVIEW_MODE_SETTING)
            && !e.affectsConfiguration('editor.colorDecorators')) { return; }
        generation++;
        // One lifecycle refresh for all TEXTURES documents; each query reads its URI config.
        if (refreshTimer) { clearTimeout(refreshTimer); }
        refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            provider.dispose();
            provider = register();
        }, 0);
    });
    context.subscriptions.push(viewportPreview, configListener, new vscode.Disposable(() => {
        generation++;
        if (refreshTimer) { clearTimeout(refreshTimer); }
        provider.dispose();
    }));
}
