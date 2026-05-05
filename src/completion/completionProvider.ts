import * as vscode from 'vscode';
import { ActionData, PropertyData, FlagData, ExpressionData } from './dataLoader';

type ContextType = 'flag' | 'state' | 'function' | 'property' | 'none';

/**
 * 获取当前光标所在单词的前缀（用于前缀过滤）
 * 例如：光标在 "A_Fire|" 时返回 "A_Fire"
 */
function getWordPrefix(lineText: string, position: vscode.Position): string {
    let prefix = '';
    let i = position.character - 1;

    // 从光标位置向后扫描，获取连续的单词字符（字母、数字、下划线）
    while (i >= 0 && /[A-Za-z0-9_]/.test(lineText[i])) {
        prefix = lineText[i] + prefix;
        i--;
    }

    return prefix;
}

/**
 * 从 ActionData 生成参数 snippet 字符串
 * 例如: params=[{name: 'x', type: 'int'}, {name: 'y', type: 'int'}]
 * 返回: "${1:x}, ${2:y}"
 */
function generateParamSnippet(params?: any[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return '$0';
    }

    return params
        .filter((p: any) => typeof p === 'object' && p.name)
        .map((p: any, index: number) => {
            const label = p.optional ? `${p.name}?` : p.name;
            return `\${${index + 1}:${label}}`;
        })
        .join(', ');
}

/**
 * 判断当前光标所处的上下文类型
 * 优先级：flag > state > function > property > none
 */
function getContextType(
    document: vscode.TextDocument,
    position: vscode.Position,
    lineText: string
): ContextType {
    // 1. 检查是否在函数调用内
    const isInFunctionCall = (): boolean => {
        let openParens = 0;
        const textBeforeCursor = lineText.substring(0, position.character);
        for (const char of textBeforeCursor) {
            if (char === '(') openParens++;
            if (char === ')') openParens--;
        }
        return openParens > 0;
    };

    // 2. 检查是否在 States 块内（全局检查，不限于状态行）
    const isInStateBlockGlobally = (): boolean => {
        let inStates = false;
        let statesBraceCount = 0;

        for (let i = 0; i < position.line; i++) {
            const currentLine = document.lineAt(i).text;

            // 检查 States 关键字（不要求与 { 在同一行）
            if (/\bStates\b/.test(currentLine)) {
                inStates = true;
                statesBraceCount = 0; // 重置计数，因为 { 可能在后续行
            }

            // 计算括号（仅在 States 块内有意义）
            if (inStates) {
                for (const char of currentLine) {
                    if (char === '{') {
                        statesBraceCount++;
                    } else if (char === '}') {
                        statesBraceCount--;
                        if (statesBraceCount <= 0) {
                            inStates = false;
                            statesBraceCount = 0;
                            break; // 退出 States 块
                        }
                    }
                }
            }
        }

        return inStates && statesBraceCount > 0;
    };

    // 3. 检查是否在 actor 块内但不在 States 块内
    const isInActorButNotInStates = (): boolean => {
        // 首先检查是否在 States 块内
        if (isInStateBlockGlobally()) {
            return false;
        }

        // 再检查是否在某个块内
        let braceCount = 0;
        for (let i = 0; i < position.line; i++) {
            const currentLine = document.lineAt(i).text;
            for (const char of currentLine) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                }
            }
        }

        return braceCount > 0;
    };

    // 4. 检查是否在 States 块内的状态行（action 定义）
    const isInStateBlock = (): boolean => {
        // 必须在 States 块内
        if (!isInStateBlockGlobally()) {
            return false;
        }

        // 检查当前行是否与 sprite name frame tics 模式匹配
        const isStateLinePattern = /^(\s*)(\w+)\s+([A-Za-z0-9]+)\s+(\d+)(\s+|$)/.test(lineText);
        return isStateLinePattern;
    };

    // 5. 检查 flag 触发（优先级高，仅在 actor 块但非 States 块内触发）
    const isFlagTrigger = (): boolean => {
        if (!isInActorButNotInStates()) {
            return false;
        }
        // 支持前缀输入：+F、-Flag 等
        const beforeCursor = lineText.substring(0, position.character);
        return /[+-]/.test(beforeCursor.slice(-1));
    };

    // 按优先级返回
    if (isFlagTrigger()) {
        return 'flag';
    }

    if (isInStateBlock()) {
        return 'state';
    }

    if (isInFunctionCall()) {
        return 'function';
    }

    if (isInActorButNotInStates()) {
        return 'property';
    }

    return 'none';
}

/**
 * 获取 flag 补全项
 * 支持前缀过滤，例如 +F 只显示以 F 开头的 flags
 */
function provideFlagItems(
    flagsData: Record<string, FlagData>,
    prefix: string
): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [flag, data] of Object.entries(flagsData)) {
        // 前缀过滤（忽略大小写）
        if (prefix && !flag.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(flag, vscode.CompletionItemKind.Constant);
        item.detail = data.desc || "Actor flag";
        items.push(item);
    }

    return items;
}

/**
 * 获取 action 补全项
 * @param prefix 用于过滤 actions 列表
 */
function provideActionItems(actionsData: Record<string, ActionData>, prefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [fn, data] of Object.entries(actionsData)) {
        // 前缀过滤（忽略大小写）
        if (prefix && !fn.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(fn, vscode.CompletionItemKind.Function);
        item.detail = data.desc || "DECORATE Action Function";
        
        // 生成动态参数 snippet
        const paramSnippet = generateParamSnippet(data.params);
        item.insertText = new vscode.SnippetString(`${fn}(${paramSnippet})`);
        
        item.command = {
            title: 'Trigger Signature Help',
            command: 'editor.action.triggerParameterHints'
        };
        items.push(item);
    }

    return items;
}

/**
 * 获取 expression 补全项
 * @param prefix 用于过滤 expressions 列表
 */
function provideExpressionItems(expressionsData: Record<string, ExpressionData>, prefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [expr, data] of Object.entries(expressionsData)) {
        // 前缀过滤（忽略大小写）
        if (prefix && !expr.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(expr, vscode.CompletionItemKind.Variable);
        item.detail = data.desc || "DECORATE Expression";
        items.push(item);
    }

    return items;
}

/**
 * 获取 property 补全项
 * @param prefix 用于过滤 properties 列表
 */
function providePropertyItems(propertiesData: Record<string, PropertyData>, prefix: string): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    for (const [prop, data] of Object.entries(propertiesData)) {
        // 前缀过滤（忽略大小写）
        if (prefix && !prop.toUpperCase().startsWith(prefix.toUpperCase())) {
            continue;
        }

        const item = new vscode.CompletionItem(prop, vscode.CompletionItemKind.Property);
        item.detail = `${data.type} - ${data.desc || ""}`;
        items.push(item);
    }

    return items;
}

export function registerCompletionProvider(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>,
    propertiesData: Record<string, PropertyData>,
    flagsData: Record<string, FlagData>,
    expressionsData: Record<string, ExpressionData>
) {
    const provider = vscode.languages.registerCompletionItemProvider(
        [{ language: 'decorate' }],
        {
            provideCompletionItems(document, position) {
                const line = document.lineAt(position.line);
                const lineText = line.text;

                // 获取当前上下文类型
                const contextType = getContextType(document, position, lineText);

                // 获取当前单词前缀（用于过滤补全项）
                const wordPrefix = getWordPrefix(lineText, position);

                // 根据上下文类型返回对应补全项
                switch (contextType) {
                    case 'flag':
                        return provideFlagItems(flagsData, wordPrefix);

                    case 'state':
                        return provideActionItems(actionsData, wordPrefix);

                    case 'function':
                        return provideExpressionItems(expressionsData, wordPrefix);

                    case 'property':
                        return providePropertyItems(propertiesData, wordPrefix);

                    case 'none':
                    default:
                        return [];
                }
            }
        },
        '(', '+', '-'
    );

    context.subscriptions.push(provider);
}
