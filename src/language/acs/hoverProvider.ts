import * as vscode from 'vscode';
import { ActionData, findActionCaseInsensitive, ParamData } from '../../shared/dataLoader';
import { buildSignatureLabel, buildParamLabel } from '../../shared/signatureBuilder';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SymbolKind } from '../../base/types';
import { symbolSourceDetail } from '../../base/symbolLocation';

function buildHoverContent(functionName: string, functionData: ActionData): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = Array.isArray(functionData.params)
        ? functionData.params.filter((p): p is ParamData => typeof p === 'object')
        : [];

    const signature = buildSignatureLabel(functionName, params);
    md.appendCodeblock(signature, 'acs');

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

export function registerAcsHoverProvider(
    context: vscode.ExtensionContext,
    functionsData: Record<string, ActionData>,
    symbolDb?: SymbolDatabase
) {
    const provider = vscode.languages.registerHoverProvider(
        [{ language: 'acs' }],
        {
            provideHover(document, position) {
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
                if (!wordRange) {
                    return null;
                }

                const word = document.getText(wordRange);
                const functionData = findActionCaseInsensitive(functionsData, word);
                if (functionData) {
                    return new vscode.Hover(buildHoverContent(word, functionData));
                }

                if (symbolDb) {
                    const fn = symbolDb.query(SymbolKind.AcsFunction, word);
                    if (fn) {
                        const md = new vscode.MarkdownString();
                        md.appendCodeblock(`function ${fn.name}(...)`, 'acs');
                        md.appendMarkdown(`\n\n**Source:** ${symbolSourceDetail(fn)}`);
                        if (fn.entryPath) {
                            md.appendMarkdown(`\n\n\`${fn.entryPath}\``);
                        }
                        return new vscode.Hover(md);
                    }
                    const c = symbolDb.query(SymbolKind.AcsConstant, word);
                    if (c) {
                        const md = new vscode.MarkdownString();
                        md.appendCodeblock(`#define ${c.name}`, 'acs');
                        md.appendMarkdown(`\n\n**Source:** ${symbolSourceDetail(c)}`);
                        if (c.entryPath) {
                            md.appendMarkdown(`\n\n\`${c.entryPath}\``);
                        }
                        return new vscode.Hover(md);
                    }
                }

                return null;
            }
        }
    );

    context.subscriptions.push(provider);
}
