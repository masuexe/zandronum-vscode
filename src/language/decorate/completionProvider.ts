import * as vscode from 'vscode';
import {
    ActionData,
    PropertyData,
    FlagData,
    ExpressionData,
    InheritanceData,
    findActionCaseInsensitive,
    StateKeywordData,
    getStateCallables,
    getExpressionCallables,
    getExpressionVariables,
    DecorateCallableData,
} from '../../shared/dataLoader';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SymbolKind } from '../../base/types';

type ContextType = 'flag' | 'state' | 'function' | 'property' | 'inherit' | 'none';

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

function getContextType(
    document: vscode.TextDocument,
    position: vscode.Position,
    lineText: string
): ContextType {
    const isInFunctionCall = (): boolean => {
        let openParens = 0;
        const textBeforeCursor = lineText.substring(0, position.character);
        for (const char of textBeforeCursor) {
            if (char === '(') openParens++;
            if (char === ')') openParens--;
        }
        return openParens > 0;
    };

    const isInStateBlockGlobally = (): boolean => {
        let inStates = false;
        let statesBraceCount = 0;

        for (let i = 0; i < position.line; i++) {
            const currentLine = document.lineAt(i).text;
            if (/\bStates\b/.test(currentLine)) {
                inStates = true;
                statesBraceCount = 0;
            }
            if (inStates) {
                for (const char of currentLine) {
                    if (char === '{') {
                        statesBraceCount++;
                    } else if (char === '}') {
                        statesBraceCount--;
                        if (statesBraceCount <= 0) {
                            inStates = false;
                            statesBraceCount = 0;
                            break;
                        }
                    }
                }
            }
        }

        return inStates && statesBraceCount > 0;
    };

    const isInActorButNotInStates = (): boolean => {
        if (isInStateBlockGlobally()) {
            return false;
        }
        let braceCount = 0;
        for (let i = 0; i < position.line; i++) {
            const currentLine = document.lineAt(i).text;
            for (const char of currentLine) {
                if (char === '{') braceCount++;
                else if (char === '}') braceCount--;
            }
        }
        return braceCount > 0;
    };

    const isInStateBlock = (): boolean => {
        if (!isInStateBlockGlobally()) {
            return false;
        }
        return /^(\s*)(\w+)\s+([A-Za-z0-9\[\]\\]+)\s+(\d+)(\s+|$)/.test(lineText);
    };

    const isFlagTrigger = (): boolean => {
        if (!isInActorButNotInStates()) {
            return false;
        }
        const beforeCursor = lineText.substring(0, position.character);
        return /[+-]/.test(beforeCursor.slice(-1));
    };

    const isInheritTrigger = (): boolean => {
        const beforeCursor = lineText.substring(0, position.character);
        const actorMatch = /\bactor\b\s+(\w+)\s*:\s*(.*)$/i.exec(beforeCursor);
        if (!actorMatch) {
            return false;
        }
        let openParens = 0;
        for (const char of beforeCursor) {
            if (char === '(') {
                openParens++;
            }
            if (char === ')') {
                openParens--;
            }
        }
        return openParens === 0;
    };

    if (isFlagTrigger()) {
        return 'flag';
    }

    if (isInheritTrigger()) {
        return 'inherit';
    }

    if (isInFunctionCall()) {
        return 'function';
    }

    if (isInStateBlock()) {
        return 'state';
    }

    if (isInActorButNotInStates()) {
        return 'property';
    }

    return 'none';
}

function provideFlagItems(
    flagsData: Record<string, FlagData>,
    prefix: string,
    allowedClasses?: Set<string>
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [flag, data] of Object.entries(flagsData)) {
        if (prefix && !flag.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        if (allowedClasses && data.for && !allowedClasses.has(data.for)) {
            continue;
        }
        const item = new vscode.CompletionItem(flag, vscode.CompletionItemKind.Constant);
        const forLabel = data.for ? ` [${data.for}]` : ' [Actor]';
        item.detail = `${data.desc || "Actor flag"}${forLabel}`;
        items.push(item);
    }

    return items;
}

function provideActionItems(actionsData: Record<string, ActionData>, prefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const stateCallables = getStateCallables(actionsData);

    for (const [fn, data] of Object.entries(stateCallables)) {
        if (prefix && !fn.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
        item.detail = data.desc || 'DECORATE Action Function';
        item.insertText = new vscode.SnippetString(`${fn}($0)`);
        item.command = {
            title: 'Trigger Signature Help',
            command: 'editor.action.triggerParameterHints'
        };
        items.push(item);
    }

    return items;
}

function provideStateKeywordItems(
    keywords: Record<string, StateKeywordData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [name, data] of Object.entries(keywords)) {
        if (prefix && !name.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        const hasParams = Array.isArray(data.params) && data.params.length > 0;
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Keyword);
        item.detail = data.desc || 'DECORATE State Keyword';
        if (hasParams) {
            item.insertText = new vscode.SnippetString(`${name}($0)`);
            item.command = {
                title: 'Trigger Signature Help',
                command: 'editor.action.triggerParameterHints'
            };
        } else {
            item.insertText = name;
        }
        items.push(item);
    }

    return items;
}

function provideExpressionItems(
    actionsData: Record<string, ActionData>,
    expressionsData: Record<string, ExpressionData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const callables = getExpressionCallables(actionsData, expressionsData);
    const variables = getExpressionVariables(expressionsData);

    for (const [fn, data] of Object.entries(callables)) {
        if (prefix && !fn.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
        item.detail = data.desc || 'DECORATE Expression Function';
        item.insertText = new vscode.SnippetString(`${fn}($0)`);
        item.command = {
            title: 'Trigger Signature Help',
            command: 'editor.action.triggerParameterHints'
        };
        items.push(item);
    }

    for (const [expr, data] of Object.entries(variables)) {
        if (prefix && !expr.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        const item = new vscode.CompletionItem(expr, vscode.CompletionItemKind.Variable);
        item.detail = data.desc || 'DECORATE Expression Variable';
        items.push(item);
    }

    return items;
}

function findExpressionParamEnum(
    actionsData: Record<string, ActionData>,
    expressionsData: Record<string, ExpressionData>,
    functionName: string,
    paramIndex: number
): { mode: 'bitmask' | 'enum'; enum: Array<{ name: string; value: number }> } | null {
    const callables: Record<string, DecorateCallableData> = {
        ...getStateCallables(actionsData),
        ...getExpressionCallables(actionsData, expressionsData),
    };
    const data = findActionCaseInsensitive(callables, functionName);
    if (!data || !Array.isArray(data.params)) {
        return null;
    }
    const param = data.params[paramIndex] as any;
    if (param && param.mode && Array.isArray(param.enum)) {
        return { mode: param.mode, enum: param.enum };
    }
    return null;
}

function findActorParent(
    document: vscode.TextDocument,
    position: vscode.Position
): string | null {
    let braceDepth = 0;
    const parentAtDepth: (string | null)[] = [];

    for (let i = 0; i <= position.line; i++) {
        const lineText = document.lineAt(i).text;

        const match = /\bactor\b\s+\w+\s*:\s*(\w+)/i.exec(lineText);
        if (match) {
            parentAtDepth[braceDepth] = match[1];
        }

        for (const char of lineText) {
            if (char === '{') {
                braceDepth++;
            } else if (char === '}') {
                braceDepth--;
                if (braceDepth < 0) {
                    braceDepth = 0;
                }
            }
        }

        if (i === position.line && braceDepth > 0) {
            return parentAtDepth[braceDepth - 1] || null;
        }
    }

    return null;
}

function resolveChain(
    parent: string,
    inheritanceData: Record<string, InheritanceData>
): Set<string> | undefined {
    if (!inheritanceData[parent]) {
        return undefined;
    }
    const chain = new Set<string>();
    chain.add(parent);
    let current = parent;
    while (true) {
        const data = inheritanceData[current];
        if (!data || !data.extends || chain.has(data.extends)) {
            break;
        }
        chain.add(data.extends);
        current = data.extends;
    }
    return chain;
}

function providePropertyItems(
    propertiesData: Record<string, PropertyData>,
    prefix: string,
    allowedClasses?: Set<string>
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [prop, data] of Object.entries(propertiesData)) {
        if (prefix && !prop.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }
        if (allowedClasses && data.for && !allowedClasses.has(data.for)) {
            continue;
        }
        const item = new vscode.CompletionItem(prop, vscode.CompletionItemKind.Property);
        const forLabel = data.for ? ` [${data.for}]` : '';
        item.detail = `${data.type} - ${data.desc || ""}${forLabel}`;
        items.push(item);
    }

    return items;
}

function provideInheritanceItems(
    inheritanceData: Record<string, InheritanceData>,
    symbolDb: SymbolDatabase | undefined,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    const addItem = (name: string, detail: string) => {
        const key = name.toLowerCase();
        if (seen.has(key)) { return; }
        seen.add(key);
        if (prefix && !name.toUpperCase().startsWith(prefix.toUpperCase())) { return; }
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Class);
        item.detail = detail;
        item.sortText = '0_' + name;
        items.push(item);
    };

    for (const [cls, data] of Object.entries(inheritanceData)) {
        addItem(cls, data.category ? `${data.category}` : "Built-in Actor");
    }

    if (symbolDb) {
        for (const sym of symbolDb.queryAll(SymbolKind.Actor)) {
            const detail = sym.packageId === 'workspace'
                ? `Workspace: ${sym.entryPath}`
                : `Base: ${sym.source}`;
            addItem(sym.name, detail);
        }
    }

    return items;
}

export function registerCompletionProvider(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>,
    propertiesData: Record<string, PropertyData>,
    flagsData: Record<string, FlagData>,
    expressionsData: Record<string, ExpressionData>,
    inheritanceData: Record<string, InheritanceData>,
    symbolDb?: SymbolDatabase,
    stateKeywords?: Record<string, StateKeywordData>
) {
    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'decorate' }],
        {
            provideCompletionItems(document, position) {
                const line = document.lineAt(position.line);
                const lineText = line.text;
                const contextType = getContextType(document, position, lineText);
                const wordPrefix = getWordPrefix(lineText, position);

                switch (contextType) {
                    case 'flag': {
                        const parent = findActorParent(document, position);
                        const chain = parent ? resolveChain(parent, inheritanceData) : undefined;
                        return provideFlagItems(flagsData, wordPrefix, chain);
                    }

                    case 'inherit':
                        return provideInheritanceItems(inheritanceData, symbolDb, wordPrefix);

                    case 'state': {
                        const items = provideActionItems(actionsData, wordPrefix);
                        if (stateKeywords) {
                            items.push(...provideStateKeywordItems(stateKeywords, wordPrefix));
                        }
                        return items;
                    }

                    case 'function': {
                        const callInfo = findCallInfo(document, position);
                        if (callInfo) {
                            const enumInfo = findExpressionParamEnum(
                                actionsData,
                                expressionsData,
                                callInfo.functionName,
                                callInfo.paramIndex
                            );
                            if (enumInfo) {
                                return provideEnumItems(enumInfo.enum, wordPrefix, enumInfo.mode);
                            }
                        }
                        return provideExpressionItems(actionsData, expressionsData, wordPrefix);
                    }

                    case 'property': {
                        const parent = findActorParent(document, position);
                        const chain = parent ? resolveChain(parent, inheritanceData) : undefined;
                        return providePropertyItems(propertiesData, wordPrefix, chain);
                    }

                    case 'none':
                    default:
                        return [];
                }
            }
        },
        '(', '+', '-', '|'
    );

    context.subscriptions.push(provider);
}
