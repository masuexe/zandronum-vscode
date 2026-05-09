import * as vscode from 'vscode';
import { ActionData } from './dataLoader';

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

function buildSignature(fnName: string, params?: any[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return `${fnName}()`;
    }

    const paramStrs = params
        .filter((p: any) => typeof p === 'object')
        .map((p: any) => {
            if (p.variadic) return `${p.type} ${p.name}...`;
            const optional = p.optional;
            return optional
                ? `[${p.type} ${p.name}]`
                : `${p.type} ${p.name}`;
        });

    return `${fnName}(${paramStrs.join(', ')})`;
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
                const fullLineText = line.text;
                const textBeforeCursor = fullLineText.substring(0, position.character);

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
                const actionData = actionsData[functionName];

                if (!actionData) {
                    return null;
                }

                const signature = new vscode.SignatureInformation(
                    actionData.signature || buildSignature(functionName, actionData.params),
                    actionData.desc
                );

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
