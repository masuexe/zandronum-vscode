import * as vscode from 'vscode';
import * as path from 'path';
import { getActions, getProperties, getFlags, getExpressions, getInheritance, getAcsFunctions, getAcsConstants, getSndinfoCommands, getStateKeywords } from './shared/dataLoader';
import { registerCompletionProvider } from './language/decorate/completionProvider';
import { registerAcsCompletionProvider } from './language/acs/completion/completionProvider';
import { registerAcsSignatureHelp } from './language/acs/signatureProvider';
import { registerAcsHoverProvider } from './language/acs/hoverProvider';
import { registerSndinfoCompletionProvider } from './language/sndinfo/completionProvider';
import { registerSndinfoSignatureHelp } from './language/sndinfo/signatureProvider';
import { registerSndinfoHoverProvider } from './language/sndinfo/hoverProvider';
import { registerSignatureHelp } from './language/decorate/signatureProvider';
import { registerHoverProvider } from './language/decorate/hoverProvider';
import { buildPK3, buildProject } from './tools/build';
import { compileAcs, compileAllAndBuild, compileCurrentAndBuild } from './tools/compileAcs';
import { registerDecorateSemanticTokens } from './semantic/semanticTokensProvider';
import { registerAcsSemanticTokens } from './semantic/acsSemanticTokensProvider';
import { WorkspaceIndex, defaultIncludeResolver } from './language/acs/compilationUnit';
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
import { registerOffsetPreview } from './language/decorate/offsetPreviewController';
import { PackageManager } from './base/packageManager';
import { SymbolDatabase } from './base/symbolDatabase';
import { ActorSymbolProvider } from './base/actorProvider';
import { AcsSymbolProvider } from './base/acsProvider';
import { extractBaseAcsSources } from './base/extractBaseAcs';
import { setBaseAcsIncludeDirs } from './base/baseAcsIncludes';
import {
    BASE_RESOURCE_SCHEME,
    BaseResourceContentProvider,
} from './base/baseResourceUri';
import { reportBaseResourceWarnings, getBaseResourceOutput } from './base/diagnostics';
import { ZipPackage } from './base/packages';
import { SymbolKind } from './base/types';
import {
    runZandronum,
    runProject,
    buildAndRunZandronum,
    compileAllBuildAndRunZandronum,
} from './run/launchProvider';


export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        // Primary project workflow (Command Palette)
        vscode.commands.registerCommand('acs.compile', compileAcs),
        vscode.commands.registerCommand('zandronum.buildProject', buildProject),
        vscode.commands.registerCommand('zandronum.runProject', runProject),
        // Legacy aliases — still executable, hidden from Command Palette
        vscode.commands.registerCommand('decorate.buildPK3', buildPK3),
        vscode.commands.registerCommand('acs.compileAllAndBuild', compileAllAndBuild),
        vscode.commands.registerCommand('acs.compileCurrentAndBuild', compileCurrentAndBuild),
        vscode.commands.registerCommand('zandronum.run', runZandronum),
        vscode.commands.registerCommand('zandronum.buildAndRun', buildAndRunZandronum),
        vscode.commands.registerCommand('acs.compileAllBuildAndRun', compileAllBuildAndRunZandronum),
    );

    const packageManager = new PackageManager(context.extensionPath);
    const symbolDatabase = new SymbolDatabase();
    symbolDatabase.registerProvider(new ActorSymbolProvider());
    symbolDatabase.registerProvider(new AcsSymbolProvider());

    const contentProvider = new BaseResourceContentProvider(packageManager);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(BASE_RESOURCE_SCHEME, contentProvider),
        contentProvider
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (doc) => {
            if (doc.uri.scheme !== BASE_RESOURCE_SCHEME) { return; }
            const name = path.basename(doc.uri.path).toLowerCase();
            let lang: string | undefined;
            if (name === 'decorate' || name.endsWith('.dec') || name.endsWith('.decorate')) {
                lang = 'decorate';
            } else if (name.endsWith('.acs') || name === 'scripts') {
                lang = 'acs';
            }
            if (lang && doc.languageId !== lang) {
                await vscode.languages.setTextDocumentLanguage(doc, lang);
            }
        })
    );

    const extractRoot = context.storageUri
        ? path.join(context.storageUri.fsPath, 'baseAcs')
        : path.join(context.globalStorageUri.fsPath, 'baseAcs');

    let rebuildGeneration = 0;
    let saveRebuildTimer: ReturnType<typeof setTimeout> | undefined;
    let lastWarningKey = '';

    async function rebuildSymbols(options?: { notifyWarnings?: boolean }): Promise<void> {
        const generation = ++rebuildGeneration;
        try {
            await packageManager.build();
            if (generation !== rebuildGeneration) { return; }

            await symbolDatabase.build(packageManager.getPackages());
            if (generation !== rebuildGeneration) { return; }

            const includeDirs = await extractBaseAcsSources(
                packageManager.getPackages(),
                extractRoot
            );
            if (generation !== rebuildGeneration) { return; }
            setBaseAcsIncludeDirs(includeDirs);

            const warnings = [
                ...packageManager.getWarnings(),
                ...packageManager.collectZipErrors(),
            ];
            const warningKey = warnings.map(w => `${w.path}|${w.message}`).join('\n');
            const notify = options?.notifyWarnings !== false && warningKey !== lastWarningKey;
            lastWarningKey = warningKey;
            reportBaseResourceWarnings(warnings, { notify });
            contentProvider.invalidateAll();

            const actors = symbolDatabase.queryAll(SymbolKind.Actor).length;
            const consts = symbolDatabase.queryAll(SymbolKind.AcsConstant).length;
            getBaseResourceOutput().appendLine(
                `[${new Date().toISOString()}] Indexed packages=${packageManager.getPackages().length} ` +
                `actors=${actors} acsConstants=${consts}`
            );
        } catch (err) {
            getBaseResourceOutput().appendLine(`Base resource rebuild failed: ${err}`);
            vscode.window.showErrorMessage(`Base resource rebuild failed: ${String(err)}`);
        }
    }

    void rebuildSymbols({ notifyWarnings: true });

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('zandronum-vscode.baseResources')) {
                lastWarningKey = '';
                void rebuildSymbols({ notifyWarnings: true });
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('zandronum.addBaseResource', async () => {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: true,
                canSelectMany: true,
                filters: {
                    'PK3 / ZIP': ['pk3', 'zip'],
                    'All': ['*']
                },
                openLabel: 'Add Base Resource'
            });
            if (!uris || uris.length === 0) { return; }

            const config = vscode.workspace.getConfiguration('zandronum-vscode');
            const current: string[] = config.get('baseResources') ?? [];
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const next = [...current];
            for (const uri of uris) {
                let p = uri.fsPath;
                if (workspaceRoot && p.toLowerCase().startsWith(workspaceRoot.toLowerCase() + path.sep)) {
                    p = path.relative(workspaceRoot, p).replace(/\\/g, '/');
                }
                if (!next.includes(p)) {
                    next.push(p);
                }
            }
            await config.update('baseResources', next, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Added ${uris.length} base resource(s).`);
        }),
        vscode.commands.registerCommand('zandronum.refreshBaseResources', async () => {
            for (const pkg of packageManager.getPackages()) {
                if (pkg instanceof ZipPackage) {
                    pkg.invalidate();
                }
            }
            await rebuildSymbols({ notifyWarnings: true });
            vscode.window.showInformationMessage('Base resources refreshed.');
        })
    );

    const actionsData = getActions(context);
    const propertiesData = getProperties(context);
    const flagsData = getFlags(context);
    const expressionsData = getExpressions(context);
    const inheritanceData = getInheritance(context);
    const stateKeywordsData = getStateKeywords(context);

    registerCompletionProvider(context, actionsData, propertiesData, flagsData, expressionsData, inheritanceData, symbolDatabase, stateKeywordsData);
    registerSignatureHelp(context, actionsData, stateKeywordsData);
    registerHoverProvider(context, actionsData, stateKeywordsData, symbolDatabase, inheritanceData);
    registerDecorateSemanticTokens(context);
    registerDefinitionProvider(context, symbolDatabase);
    registerColorProvider(context);
    registerDecorateSymbolProvider(context);

    const acsFunctionsData = getAcsFunctions(context);
    const acsConstantsData = getAcsConstants(context);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const workspaceIndex = new WorkspaceIndex(
        (name, dir) => defaultIncludeResolver(name, dir, workspaceRoot),
        workspaceRoot
    );
    registerAcsCompletionProvider(context, acsFunctionsData, acsConstantsData, workspaceIndex, symbolDatabase);
    registerAcsSignatureHelp(context, acsFunctionsData);
    registerAcsHoverProvider(context, acsFunctionsData, symbolDatabase);
    registerAcsSemanticTokens(context, acsConstantsData, workspaceIndex);
    registerAcsDefinitionProvider(context, symbolDatabase);
    registerAcsSymbolProvider(context);

    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.languageId === 'acs') {
                workspaceIndex.invalidate(doc.uri.fsPath);
            }
            if (doc.languageId === 'decorate' || doc.languageId === 'acs') {
                if (saveRebuildTimer) { clearTimeout(saveRebuildTimer); }
                saveRebuildTimer = setTimeout(() => {
                    void rebuildSymbols({ notifyWarnings: false });
                }, 400);
            }
        })
    );

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

    registerOffsetPreview(context, resourceIndex);

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
}
