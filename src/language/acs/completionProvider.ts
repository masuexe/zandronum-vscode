import * as vscode from 'vscode';
import { ActionData, AcsConstantData, findActionCaseInsensitive } from '../../shared/dataLoader';
import { buildSnippetString } from '../../shared/snippetBuilder';

type AcsContextType = 'function' | 'script';

function getWordPrefix(lineText: string, position: vscode.Position): string {
    let prefix = '';
    let i = position.character - 1;
    while (i >= 0 && /[A-Za-z0-9_]/.test(lineText[i])) {
        prefix = lineText[i] + prefix;
        i--;
    }
    return prefix;
}

interface CallInfo {
    functionName: string;
    openParenIndex: number;
    paramIndex: number;
}

function findCallInfo(
    document: vscode.TextDocument,
    position: vscode.Position
): CallInfo | null {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    let openParenIndex = -1;
    let parenDepth = 0;

    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
        const char = textBeforeCursor[i];
        if (char === ')') {
            parenDepth++;
        } else if (char === '(') {
            if (parenDepth === 0) {
                openParenIndex = i;
                break;
            }
            parenDepth--;
        }
    }

    if (openParenIndex === -1) {
        return null;
    }

    let fnNameEnd = openParenIndex - 1;
    while (fnNameEnd >= 0 && /\s/.test(textBeforeCursor[fnNameEnd])) {
        fnNameEnd--;
    }

    let fnNameStart = fnNameEnd;
    while (fnNameStart >= 0 && /[A-Za-z0-9_]/.test(textBeforeCursor[fnNameStart])) {
        fnNameStart--;
    }
    fnNameStart++;

    if (fnNameStart > fnNameEnd) {
        return null;
    }

    const functionName = textBeforeCursor.substring(fnNameStart, fnNameEnd + 1);

    let commaCount = 0;
    let inString = false;
    let stringChar = '';
    let depth = 0;

    for (let i = openParenIndex + 1; i < textBeforeCursor.length; i++) {
        const char = textBeforeCursor[i];
        if (!inString) {
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
            } else if (char === '(') {
                depth++;
            } else if (char === ')') {
                depth--;
            } else if (char === ',' && depth === 0) {
                commaCount++;
            }
        } else if (char === stringChar) {
            inString = false;
        }
    }

    return { functionName, openParenIndex, paramIndex: commaCount };
}

function getAcsContextType(
    lineText: string,
    position: vscode.Position
): AcsContextType {
    const textBeforeCursor = lineText.substring(0, position.character);
    let openParens = 0;

    for (const char of textBeforeCursor) {
        if (char === '(') {
            openParens++;
        } else if (char === ')') {
            openParens--;
        }
    }

    if (openParens > 0) {
        return 'function';
    }

    return 'script';
}

function provideEnumItems(
    enumValues: Array<{ name: string; value: number }>,
    prefix: string,
    mode: 'bitmask' | 'enum'
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const entry of enumValues) {
        if (prefix && !entry.name.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.EnumMember);
        item.detail = `Value: ${entry.value}`;
        items.push(item);
    }

    return items;
}

function provideAcsFunctionItems(
    functionsData: Record<string, ActionData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [fn, data] of Object.entries(functionsData)) {
        if (prefix && !fn.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
        item.detail = data.desc || `ACS built-in function`;
        item.insertText = buildSnippetString(fn, data.params as any);

        items.push(item);
    }

    return items;
}

function provideAcsConstantItems(
    constantsData: Record<string, AcsConstantData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [name, data] of Object.entries(constantsData)) {
        if (prefix && !name.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
        item.detail = data.desc || `Value: ${data.value ?? '?'}`;
        items.push(item);
    }

    return items;
}

export function registerAcsCompletionProvider(
    context: vscode.ExtensionContext,
    functionsData: Record<string, ActionData>,
    constantsData: Record<string, AcsConstantData>
) {
    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'acs' }],
        {
            provideCompletionItems(document, position) {
                const line = document.lineAt(position.line);
                const lineText = line.text;
                const contextType = getAcsContextType(lineText, position);
                const wordPrefix = getWordPrefix(lineText, position);

                switch (contextType) {
                    case 'function': {
                        const callInfo = findCallInfo(document, position);
                        if (callInfo) {
                            const action = findActionCaseInsensitive(functionsData, callInfo.functionName);
                            if (action && Array.isArray(action.params)) {
                                const param = action.params[callInfo.paramIndex] as any;
                                if (param && param.mode && Array.isArray(param.enum)) {
                                    return provideEnumItems(param.enum, wordPrefix, param.mode);
                                }
                            }
                        }
                        return provideAcsConstantItems(constantsData, wordPrefix);
                    }

                    case 'script':
                        return provideAcsFunctionItems(functionsData, wordPrefix);

                    default:
                        return [];
                }
            }
        },
        '(',
        ',',
        '|'
    );

    context.subscriptions.push(provider);
}
