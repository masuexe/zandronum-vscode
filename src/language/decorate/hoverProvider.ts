import * as vscode from 'vscode';
import { ActionData, findActionCaseInsensitive, ParamData } from '../../shared/dataLoader';
import { buildSignatureLabel, buildParamLabel } from '../../shared/signatureBuilder';

function buildHoverContent(functionName: string, actionData: ActionData): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = Array.isArray(actionData.params)
        ? actionData.params.filter((p): p is ParamData => typeof p === 'object')
        : [];

    const signature = buildSignatureLabel(functionName, params);
    md.appendCodeblock(signature, 'decorate');

    if (actionData.desc) {
        md.appendMarkdown(`\n\n${actionData.desc}\n\n`);
    }

    if (params.length > 0) {
        md.appendMarkdown('\n**Parameters:**\n\n');

        params.forEach((param) => {
            const label = buildParamLabel(param);
            md.appendMarkdown(`- \`${label}\`\n`);

            if (param.mode === 'bitmask' && Array.isArray(param.enum)) {
                md.appendMarkdown(`  - **Bitmask values:**\n`);
                param.enum.forEach((v: { name: string; value: number }) => {
                    md.appendMarkdown(`    - \`${v.name}\` = ${v.value}\n`);
                });
            } else if (param.mode === 'enum' && Array.isArray(param.enum)) {
                md.appendMarkdown(`  - **Enum values:**\n`);
                param.enum.forEach((v: { name: string; value: number }) => {
                    md.appendMarkdown(`    - \`${v.name}\` = ${v.value}\n`);
                });
            }
        });
    }

    return md;
}

export function registerHoverProvider(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>
) {
    const provider = vscode.languages.registerHoverProvider(
        [{ language: 'decorate' }],
        {
            provideHover(document, position) {
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
                if (!wordRange) {
                    return null;
                }

                const word = document.getText(wordRange);
                const actionData = findActionCaseInsensitive(actionsData, word);
                if (!actionData) {
                    return null;
                }

                const md = buildHoverContent(word, actionData);
                return new vscode.Hover(md);
            }
        }
    );

    context.subscriptions.push(provider);
}
