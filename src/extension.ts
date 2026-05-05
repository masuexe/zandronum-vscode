import * as vscode from 'vscode';
import { getActions, getProperties, getFlags, getExpressions } from './completion/dataLoader';
import { registerCompletionProvider } from './completion/completionProvider';
import { registerSignatureHelp } from './completion/signatureProvider';
import { registerEnterCompleteCommand } from './completion/commands';
import { buildPK3 } from './build';


export function activate(context: vscode.ExtensionContext) {
    const actionsData = getActions(context);
    const propertiesData = getProperties(context);
    const flagsData = getFlags(context);
    const expressionsData = getExpressions(context);
 
    registerCompletionProvider(context, actionsData, propertiesData, flagsData, expressionsData);
    registerSignatureHelp(context, actionsData);
    registerEnterCompleteCommand(context);


    const buildCmd = vscode.commands.registerCommand(
        'decorate.buildPK3',
        buildPK3
    );
    context.subscriptions.push(buildCmd);
}



