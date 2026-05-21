import * as vscode from 'vscode';
import { getActions, getProperties, getFlags, getExpressions, getInheritance, getAcsFunctions, getAcsConstants } from './shared/dataLoader';
import { registerCompletionProvider } from './language/decorate/completionProvider';
import { registerAcsCompletionProvider } from './language/acs/completionProvider';
import { registerAcsSignatureHelp } from './language/acs/signatureProvider';
import { registerAcsHoverProvider } from './language/acs/hoverProvider';
import { registerSignatureHelp } from './language/decorate/signatureProvider';
import { registerHoverProvider } from './language/decorate/hoverProvider';
import { registerEnterCompleteCommand } from './language/decorate/commands';
import { buildPK3 } from './tools/build';


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

    const acsFunctionsData = getAcsFunctions(context);
    const acsConstantsData = getAcsConstants(context);
    registerAcsCompletionProvider(context, acsFunctionsData, acsConstantsData);
    registerAcsSignatureHelp(context, acsFunctionsData);
    registerAcsHoverProvider(context, acsFunctionsData);


    const buildCmd = vscode.commands.registerCommand(
        'decorate.buildPK3',
        buildPK3
    );
    context.subscriptions.push(buildCmd);
}



