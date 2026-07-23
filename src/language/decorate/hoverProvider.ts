import * as vscode from 'vscode';
import {
    ActionData,
    ExpressionData,
    findActionCaseInsensitive,
    findCallableCaseInsensitive,
    getExpressionCallables,
    getExpressionVariables,
    ParamData,
    StateKeywordData,
    findStateKeywordCaseInsensitive,
    InheritanceData,
    findInheritanceCaseInsensitive,
} from '../../shared/dataLoader';
import { buildSignatureLabel, buildParamLabel } from '../../shared/signatureBuilder';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SymbolKind, ActorSymbol, AcsScriptSymbol } from '../../base/types';
import { symbolSourceDetail } from '../../base/symbolLocation';
import {
    callTextFromLine,
    resolveNamedScriptOverlay,
    tryScriptNameHover,
} from '../acs/namedScriptResolve';

function buildHoverContent(
    functionName: string,
    actionData: ActionData,
    options?: {
        params?: ParamData[];
        script?: AcsScriptSymbol;
        extraScriptParams?: { name: string; type: string }[];
    }
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = options?.params
        ?? (Array.isArray(actionData.params)
            ? actionData.params.filter((p): p is ParamData => typeof p === 'object')
            : []);

    const signature = buildSignatureLabel(functionName, params);
    md.appendCodeblock(signature, 'decorate');

    if (options?.script) {
        md.appendMarkdown(
            `\n\n**Script:** \`${options.script.scriptKey}\` (${symbolSourceDetail(options.script)})\n\n`
        );
    }

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
            } else if (param.desc) {
                md.appendMarkdown(`  - ${param.desc}\n`);
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

function hoverForCallable(
    functionName: string,
    actionData: ActionData,
    lineText: string,
    wordStart: number,
    symbolDb?: SymbolDatabase
): vscode.Hover {
    const baseParams = Array.isArray(actionData.params)
        ? actionData.params.filter((p): p is ParamData => typeof p === 'object')
        : [];
    const overlay = resolveNamedScriptOverlay(
        functionName,
        baseParams,
        callTextFromLine(lineText, wordStart),
        symbolDb
    );
    return new vscode.Hover(
        buildHoverContent(functionName, actionData, {
            params: overlay.params,
            script: overlay.script,
            extraScriptParams: overlay.extraScriptParams,
        })
    );
}

function buildActorHover(
    name: string,
    actor: ActorSymbol | undefined,
    builtin: InheritanceData | undefined
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    if (actor) {
        const parent = actor.parentClass ? ` : ${actor.parentClass}` : '';
        md.appendCodeblock(`actor ${actor.name}${parent}`, 'decorate');
        md.appendMarkdown(`\n\n**Source:** ${symbolSourceDetail(actor)}`);
        if (actor.entryPath) {
            md.appendMarkdown(`\n\n\`${actor.entryPath}\``);
        }
        return md;
    }

    if (builtin) {
        md.appendCodeblock(`actor ${name}`, 'decorate');
        if (builtin.category) {
            md.appendMarkdown(`\n\n**Category:** ${builtin.category}`);
        } else {
            md.appendMarkdown('\n\nBuilt-in Actor');
        }
        if (builtin.desc) {
            md.appendMarkdown(`\n\n${builtin.desc}`);
        }
    }

    return md;
}

export function registerHoverProvider(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>,
    stateKeywords?: Record<string, StateKeywordData>,
    symbolDb?: SymbolDatabase,
    inheritanceData?: Record<string, InheritanceData>,
    expressionsData?: Record<string, ExpressionData>
) {
    const expressionCallables = expressionsData
        ? getExpressionCallables(actionsData, expressionsData)
        : {};
    const expressionVariables = expressionsData
        ? getExpressionVariables(expressionsData)
        : {};

    const provider = vscode.languages.registerHoverProvider(
        [{ language: 'decorate' }],
        {
            provideHover(document, position) {
                const lineText = document.lineAt(position.line).text;
                const scriptHover = tryScriptNameHover(
                    lineText,
                    position.line,
                    position.character,
                    symbolDb,
                    'decorate'
                );
                if (scriptHover) {
                    return scriptHover;
                }

                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z0-9_]+/);
                if (!wordRange) {
                    return null;
                }

                const word = document.getText(wordRange);
                const wordStart = wordRange.start.character;

                if (stateKeywords) {
                    const keywordData = findStateKeywordCaseInsensitive(stateKeywords, word);
                    if (keywordData) {
                        return hoverForCallable(word, keywordData, lineText, wordStart, symbolDb);
                    }
                }

                // Expression-only functions (CheckClass, CallACS, …) before state actions
                const exprFn = findCallableCaseInsensitive(expressionCallables, word);
                if (exprFn && !findActionCaseInsensitive(actionsData, word)) {
                    return hoverForCallable(word, exprFn, lineText, wordStart, symbolDb);
                }

                const actionData = findActionCaseInsensitive(actionsData, word);
                if (actionData) {
                    return hoverForCallable(word, actionData, lineText, wordStart, symbolDb);
                }

                if (exprFn) {
                    return hoverForCallable(word, exprFn, lineText, wordStart, symbolDb);
                }

                const exprVar = findCallableCaseInsensitive(expressionVariables, word);
                if (exprVar) {
                    const md = new vscode.MarkdownString();
                    md.isTrusted = true;
                    md.appendCodeblock(word, 'decorate');
                    if (exprVar.desc) {
                        md.appendMarkdown(`\n\n${exprVar.desc}`);
                    }
                    return new vscode.Hover(md);
                }

                const actor = symbolDb?.query<ActorSymbol>(SymbolKind.Actor, word);
                const builtin = inheritanceData
                    ? findInheritanceCaseInsensitive(inheritanceData, word)
                    : undefined;
                if (actor || builtin) {
                    return new vscode.Hover(buildActorHover(word, actor, builtin));
                }

                return null;
            }
        }
    );

    context.subscriptions.push(provider);
}
