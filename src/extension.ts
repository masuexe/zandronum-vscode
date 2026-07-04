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
import { buildPK3 } from './tools/build';
import { compileAcs, compileAllAndBuild } from './tools/compileAcs';
import { registerDecorateSemanticTokens } from './semantic/semanticTokensProvider';
import { registerAcsSemanticTokens } from './semantic/acsSemanticTokensProvider';
import { registerDefinitionProvider } from './language/decorate/definitionProvider';
import { registerAcsDefinitionProvider } from './language/acs/definitionProvider';
import { registerAcsSymbolProvider } from './language/acs/symbolProvider';
import { registerColorProvider } from './language/decorate/colorProvider';
import { registerDecorateSymbolProvider } from './language/decorate/symbolProvider';
import { registerSpriteOffsetEditor } from './editors/spriteOffsetEditorProvider';
import { getTexturesKeywords } from './shared/dataLoader';
import { TexturesParser } from './language/textures/texturesParser';
import { registerTexturesCompletionProvider } from './language/textures/completionProvider';
import { registerTexturesSymbolProvider } from './language/textures/symbolProvider';
import { registerTexturesHoverProvider } from './language/textures/hoverProvider';
import { registerTexturesFoldingProvider } from './language/textures/foldingProvider';
import { registerTexturesColorProvider } from './language/textures/colorProvider';
import { getPk3Root } from './shared/pk3Root';
import { ResourceIndex } from './language/textures/resourceIndex';
import { TextureEditorRegistry } from './language/textures/textureDocumentController';
import { PackageManager } from './base/packageManager';
import { SymbolDatabase } from './base/symbolDatabase';
import { ActorSymbolProvider } from './base/actorProvider';
import { runZandronum } from './run/launchProvider';


export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('zandronum.run', runZandronum)
    );

    const packageManager = new PackageManager(context.extensionPath);
    const symbolDatabase = new SymbolDatabase();
    symbolDatabase.registerProvider(new ActorSymbolProvider());

    async function rebuildSymbols(): Promise<void> {
        await packageManager.build();
        await symbolDatabase.build(packageManager.getPackages());
    }

    rebuildSymbols();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('zandronum-vscode.baseResources')) {
                rebuildSymbols();
            }
        })
    );

    const actionsData = getActions(context);
    const propertiesData = getProperties(context);
    const flagsData = getFlags(context);
    const expressionsData = getExpressions(context);
    const inheritanceData = getInheritance(context);
 
    registerCompletionProvider(context, actionsData, propertiesData, flagsData, expressionsData, inheritanceData, symbolDatabase);
    registerSignatureHelp(context, actionsData);
    registerHoverProvider(context, actionsData);
    registerDecorateSemanticTokens(context);
    registerDefinitionProvider(context);
    registerColorProvider(context);
    registerDecorateSymbolProvider(context);

    const acsFunctionsData = getAcsFunctions(context);
    const acsConstantsData = getAcsConstants(context);
    registerAcsCompletionProvider(context, acsFunctionsData, acsConstantsData);
    registerAcsSignatureHelp(context, acsFunctionsData);
    registerAcsHoverProvider(context, acsFunctionsData);
    registerAcsSemanticTokens(context, acsConstantsData);
    registerAcsDefinitionProvider(context);
    registerAcsSymbolProvider(context);

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
    registerTexturesColorProvider(context);

    const resourceIndex = new ResourceIndex(getPk3Root());
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



