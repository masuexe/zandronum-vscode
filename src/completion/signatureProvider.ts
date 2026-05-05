import * as vscode from 'vscode';
import { ActionData } from './dataLoader';

/**
 * 计算函数调用中的当前参数索引
 * 规则：统计光标之前的逗号数量
 * @param fullLine 完整行文本
 * @param cursorPosition 光标位置
 * @param openParenIndex 函数开括号的位置
 * @returns 当前参数索引（0-based）
 */
function calculateActiveParameter(fullLine: string, cursorPosition: number, openParenIndex: number): number {
    const textInParens = fullLine.substring(openParenIndex + 1, cursorPosition);
    let commaCount = 0;
    let inString = false;
    let stringChar = '';
    let parenDepth = 0;

    for (const char of textInParens) {
        if (!inString) {
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
            } else if (char === '(') {
                parenDepth++;
            } else if (char === ')') {
                parenDepth--;
            } else if (char === ',' && parenDepth === 0) {
                commaCount++;
            }
        } else if (char === stringChar && fullLine[cursorPosition - 1] !== '\\') {
            inString = false;
        }
    }

    return commaCount;
}

export function registerSignatureHelp(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>
) {
    const signatureProvider = vscode.languages.registerSignatureHelpProvider(
        [{ language: 'decorate' }],
        {
            provideSignatureHelp(document, position) {
                const line = document.lineAt(position.line);
                const fullLineText = line.text; // 完整行文本（包括光标后的内容）
                const textBeforeCursor = fullLineText.substring(0, position.character);

                // 查找最近的函数名和左括号
                // 支持嵌套函数调用，找到最近的未闭合括号
                let openParenIndex = -1;
                let parenDepth = 0;

                // 从光标向后扫描，找到配匹的开括号
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

                // 从开括号向后找函数名
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
                const actionData = actionsData[functionName];

                if (!actionData || !actionData.signature) {
                    return null;
                }

                // 构建 SignatureInformation
                const signature = new vscode.SignatureInformation(
                    actionData.signature,
                    actionData.desc
                );

                // 添加参数信息
                if (Array.isArray(actionData.params)) {
                    signature.parameters = actionData.params
                        .filter((p: any) => typeof p === 'object')
                        .map((p: any) => {
                            const label = p.optional 
                                ? `[${p.name}: ${p.type}]`
                                : `${p.name}: ${p.type}`;
                            return new vscode.ParameterInformation(
                                label,
                                `Parameter: ${p.name} (${p.type})`
                            );
                        });
                }

                const signatureHelp = new vscode.SignatureHelp();
                signatureHelp.signatures = [signature];
                signatureHelp.activeSignature = 0;
                
                // 计算当前参数索引
                signatureHelp.activeParameter = calculateActiveParameter(
                    textBeforeCursor,
                    textBeforeCursor.length,
                    openParenIndex
                );

                return signatureHelp;
            }
        },
        '(',
        ','
    );

    context.subscriptions.push(signatureProvider);
}
