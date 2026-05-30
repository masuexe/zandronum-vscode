import * as vscode from 'vscode';
import { ActionData, findActionCaseInsensitive, ParamData } from '../../shared/dataLoader';
import { buildParamLabel } from '../../shared/signatureBuilder';

function buildSignatureLabel(fnName: string, params?: ParamData[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return fnName;
    }

    const paramStrs = params
        .map((p: ParamData) => `${p.type} ${p.name}`);

    return `${fnName} ${paramStrs.map(s => `<${s}>`).join(' ')}`;
}

function buildHoverContent(functionName: string, functionData: ActionData): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = Array.isArray(functionData.params)
        ? functionData.params.filter((p): p is ParamData => typeof p === 'object')
        : [];

    const signature = buildSignatureLabel(functionName, params);
    md.appendCodeblock(signature, 'sndinfo');

    if (functionData.desc) {
        md.appendMarkdown(`\n\n${functionData.desc}\n\n`);
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

export function registerSndinfoHoverProvider(
    context: vscode.ExtensionContext,
    commandsData: Record<string, ActionData>
) {
    const provider = vscode.languages.registerHoverProvider(
        [{ language: 'sndinfo' }],
        {
            provideHover(document, position) {
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_$]+/);
                if (!wordRange) {
                    return null;
                }

                const word = document.getText(wordRange);
                if (!word.startsWith('$')) {
                    return null;
                }

                const commandData = findActionCaseInsensitive(commandsData, word);
                if (!commandData) {
                    return null;
                }

                const md = buildHoverContent(word, commandData);
                return new vscode.Hover(md);
            }
        }
    );

    context.subscriptions.push(provider);
}
