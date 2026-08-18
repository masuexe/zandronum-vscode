import * as vscode from 'vscode';
import { ActionData, findActionCaseInsensitive, ParamData } from '../../shared/dataLoader';
import { buildSignatureLabel, buildParamLabel } from '../../shared/signatureBuilder';
import { SymbolDatabase } from '../../base/symbolDatabase';
import {
    AcsConstantSymbol,
    AcsFunctionSymbol,
    AcsScriptSymbol,
    SymbolKind,
} from '../../base/types';
import { symbolSourceDetail } from '../../base/symbolLocation';
import {
    callTextFromLine,
    resolveNamedScriptOverlay,
    tryScriptNameHover,
} from './namedScriptResolve';

function buildHoverContent(
    functionName: string,
    functionData: ActionData,
    options?: {
        params?: ParamData[];
        script?: AcsScriptSymbol;
        extraScriptParams?: { name: string; type: string }[];
    }
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = options?.params
        ?? (Array.isArray(functionData.params)
            ? functionData.params.filter((p): p is ParamData => typeof p === 'object')
            : []);

    const returns = functionData.returns;
    const customSig =
        typeof functionData.signature === 'string' && functionData.signature.length > 0
            ? functionData.signature
            : undefined;
    const signature =
        options?.params
            ? buildSignatureLabel(functionName, params, returns)
            : (customSig ?? buildSignatureLabel(functionName, params, returns));
    md.appendCodeblock(signature, 'acs');

    if (options?.script) {
        md.appendMarkdown(
            `\n\n**Script:** \`${options.script.scriptKey}\` (${symbolSourceDetail(options.script)})\n\n`
        );
    }

    if (returns === 'void') {
        md.appendMarkdown(`\n\n**Returns:** none\n\n`);
    } else if (returns) {
        md.appendMarkdown(`\n\n**Returns:** \`${returns}\`\n\n`);
    }

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

    const extras = options?.extraScriptParams;
    if (extras && extras.length > 0) {
        md.appendMarkdown('\n**Additional script parameters** (beyond engine arity):\n\n');
        for (const p of extras) {
            md.appendMarkdown(`- \`${p.type} ${p.name}\`\n`);
        }
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
                const lineText = document.lineAt(position.line).text;
                const scriptHover = tryScriptNameHover(
                    lineText,
                    position.line,
                    position.character,
                    symbolDb,
                    'acs'
                );
                if (scriptHover) {
                    return scriptHover;
                }

                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
                if (!wordRange) {
                    return null;
                }

                const word = document.getText(wordRange);
                const functionData = findActionCaseInsensitive(functionsData, word);
                if (functionData) {
                    const baseParams = Array.isArray(functionData.params)
                        ? functionData.params.filter((p): p is ParamData => typeof p === 'object')
                        : [];
                    const overlay = resolveNamedScriptOverlay(
                        word,
                        baseParams,
                        callTextFromLine(lineText, wordRange.start.character),
                        symbolDb
                    );
                    return new vscode.Hover(
                        buildHoverContent(
                            word,
                            functionData,
                            overlay.script
                                ? {
                                    params: overlay.params,
                                    script: overlay.script,
                                    extraScriptParams: overlay.extraScriptParams,
                                }
                                : undefined
                        )
                    );
                }

                if (symbolDb) {
                    const fn = symbolDb.query<AcsFunctionSymbol>(SymbolKind.AcsFunction, word);
                    if (fn) {
                        const md = new vscode.MarkdownString();
                        const ret = fn.returns ? `${fn.returns} ` : '';
                        md.appendCodeblock(`function ${ret}${fn.name}(...)`, 'acs');
                        if (fn.returns === 'void') {
                            md.appendMarkdown(`\n\n**Returns:** none\n\n`);
                        } else if (fn.returns) {
                            md.appendMarkdown(`\n\n**Returns:** \`${fn.returns}\`\n\n`);
                        }
                        md.appendMarkdown(`\n\n**Source:** ${symbolSourceDetail(fn)}`);
                        if (fn.entryPath) {
                            md.appendMarkdown(`\n\n\`${fn.entryPath}\``);
                        }
                        return new vscode.Hover(md);
                    }
                    const c = symbolDb.query<AcsConstantSymbol>(SymbolKind.AcsConstant, word);
                    if (c) {
                        const md = new vscode.MarkdownString();
                        const defineLine = c.value
                            ? `#define ${c.name} ${c.value}`
                            : `#define ${c.name}`;
                        md.appendCodeblock(defineLine, 'acs');
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
