import * as vscode from 'vscode';
import { getActions, getProperties, getFlags, getExpressions, getInheritance, getAcsFunctions, getAcsConstants, getSndinfoCommands } from './shared/dataLoader';
import { registerCompletionProvider } from './language/decorate/completionProvider';
import { registerAcsCompletionProvider } from './language/acs/completionProvider';
import { registerAcsSignatureHelp } from './language/acs/signatureProvider';
import { registerAcsHoverProvider } from './language/acs/hoverProvider';
import { registerSndinfoCompletionProvider } from './language/sndinfo/completionProvider';
import { registerSndinfoSignatureHelp } from './language/sndinfo/signatureProvider';
import { registerSndinfoHoverProvider } from './language/sndinfo/hoverProvider';
import { registerSignatureHelp } from './language/decorate/signatureProvider';
import { registerHoverProvider } from './language/decorate/hoverProvider';
import { registerEnterCompleteCommand } from './language/decorate/commands';
import { buildPK3 } from './tools/build';
import { compileAcs, compileAllAndBuild } from './tools/compileAcs';
import { registerDecorateSemanticTokens } from './semantic/semanticTokensProvider';
import { registerAcsSemanticTokens } from './semantic/acsSemanticTokensProvider';
import { registerDefinitionProvider } from './language/decorate/definitionProvider';
import { registerAcsDefinitionProvider } from './language/acs/definitionProvider';
import { registerColorProvider } from './language/decorate/colorProvider';
import { registerSpriteOffsetEditor } from './editors/spriteOffsetEditorProvider';
import { getTexturesKeywords } from './shared/dataLoader';
import { TexturesParser } from './language/textures/texturesParser';
import { registerTexturesCompletionProvider } from './language/textures/completionProvider';
import { registerTexturesSymbolProvider } from './language/textures/symbolProvider';
import { registerTexturesHoverProvider } from './language/textures/hoverProvider';
import { registerTexturesFoldingProvider } from './language/textures/foldingProvider';
import { ResourceIndex } from './language/textures/resourceIndex';
import { TextureEditorRegistry } from './language/textures/textureDocumentController';


export function activate(context: vscode.ExtensionContext) {
    const actionsData = getActions(context);
    const propertiesData = getProperties(context);
    const flagsData = getFlags(context);
    const expressionsData = getExpressions(context);
    const inheritanceData = getInheritance(context);
 
    registerCompletionProvider(context, actionsData, propertiesData, flagsData, expressionsData, inheritanceData);
    registerSignatureHelp(context, actionsData);
    registerHoverProvider(context, actionsData);
    registerEnterCompleteCommand(context);
    registerDecorateSemanticTokens(context);
    registerDefinitionProvider(context);
    registerColorProvider(context);

    const acsFunctionsData = getAcsFunctions(context);
    const acsConstantsData = getAcsConstants(context);
    registerAcsCompletionProvider(context, acsFunctionsData, acsConstantsData);
    registerAcsSignatureHelp(context, acsFunctionsData);
    registerAcsHoverProvider(context, acsFunctionsData);
    registerAcsSemanticTokens(context, acsConstantsData);
    registerAcsDefinitionProvider(context);

    const sndinfoCommandsData = getSndinfoCommands(context);
    registerSndinfoCompletionProvider(context, sndinfoCommandsData);
    registerSndinfoSignatureHelp(context, sndinfoCommandsData);
    registerSndinfoHoverProvider(context, sndinfoCommandsData);


    const texturesData = getTexturesKeywords(context);
    const texturesParser = new TexturesParser();
    registerTexturesCompletionProvider(context, texturesData, texturesParser);
    registerTexturesSymbolProvider(context, texturesParser);
    registerTexturesHoverProvider(context, texturesData);
    registerTexturesFoldingProvider(context, texturesParser);

    const resourceIndex = new ResourceIndex();
    resourceIndex.build();
    context.subscriptions.push({ dispose: () => resourceIndex.dispose() });

    const textureEditorRegistry = new TextureEditorRegistry();
    context.subscriptions.push({ dispose: () => textureEditorRegistry.dispose() });

    context.subscriptions.push(
        vscode.commands.registerCommand('textures.openEditor', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active text editor.');
                return;
            }
            if (editor.document.languageId !== 'textures') {
                vscode.window.showWarningMessage(
                    `Current file language is "${editor.document.languageId}", expected "textures". ` +
                    'Ensure the file is named TEXTURES or set the language mode manually.'
                );
                return;
            }
            texturesParser.update(editor.document);
            const node = texturesParser.getDefinitionAtPosition(editor.selection.active);
            const textureName = node?.name ?? texturesParser.getSymbols()[0]?.name;
            if (!textureName) {
                vscode.window.showWarningMessage('No texture definitions found in this file.');
                return;
            }
            textureEditorRegistry.open(
                editor.document, textureName, texturesParser, resourceIndex, context
            );
        })
    );

    registerSpriteOffsetEditor(context);

    const buildCmd = vscode.commands.registerCommand(
        'decorate.buildPK3',
        buildPK3
    );
    context.subscriptions.push(buildCmd);

    const compileAcsCmd = vscode.commands.registerCommand(
        'acs.compile',
        compileAcs
    );
    context.subscriptions.push(compileAcsCmd);

    const compileAllCmd = vscode.commands.registerCommand(
        'acs.compileAllAndBuild',
        compileAllAndBuild
    );
    context.subscriptions.push(compileAllCmd);
}



