import * as vscode from 'vscode';
import { ActionData, findActionCaseInsensitive } from '../../shared/dataLoader';

function buildSignature(fnName: string, params?: any[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return `${fnName}()`;
    }

    const paramStrs = params
        .filter((p: any) => typeof p === 'object')
        .map((p: any) => {
            if (p.variadic) return `${p.type} ${p.name}...`;
            return p.optional
                ? `[${p.type} ${p.name}]`
                : `${p.type} ${p.name}`;
        });

    return `${fnName}(${paramStrs.join(', ')})`;
}

function calculateActiveParameter(fullLine: string, cursorPosition: number, openParenIndex: number): number {
    const textInParens = fullLine.substring(openParenIndex + 1, cursorPosition);
    let spaceCount = 0;
    let inString = false;
    let stringChar = '';
    let parenDepth = 0;
    let inSpace = false;

    for (const char of textInParens) {
        if (!inString) {
            if (char === '"' || char === "'") {
                inString = true;
                stringChar = char;
                inSpace = false;
            } else if (char === '{') {
                parenDepth++;
                inSpace = false;
            } else if (char === '}') {
                parenDepth--;
                inSpace = false;
            } else if (char === ' ' || char === '\t') {
                if (!inSpace && parenDepth === 0) {
                    spaceCount++;
                    inSpace = true;
                }
            } else {
                inSpace = false;
            }
        } else if (char === stringChar && fullLine[cursorPosition - 1] !== '\\') {
            inString = false;
        }
    }

    return spaceCount;
}

export function registerSndinfoSignatureHelp(
    context: vscode.ExtensionContext,
    commandsData: Record<string, ActionData>
) {
    const provider = vscode.languages.registerSignatureHelpProvider(
        [{ language: 'sndinfo' }],
        {
            provideSignatureHelp(document, position) {
                const line = document.lineAt(position.line);
                const fullLineText = line.text;
                const textBeforeCursor = fullLineText.substring(0, position.character);

                const cmdMatch = /(?:^|\s)\$(?=([A-Za-z]+))/.exec(textBeforeCursor);
                if (!cmdMatch) return null;

                let fnNameStart = cmdMatch.index + 1;
                let i = fnNameStart;
                while (i < textBeforeCursor.length && /[A-Za-z]/.test(textBeforeCursor[i])) {
                    i++;
                }
                const fnName = textBeforeCursor.substring(fnNameStart, i);

                const actionData = findActionCaseInsensitive(commandsData, `$${fnName}`);
                if (!actionData) return null;

                const signature = new vscode.SignatureInformation(
                    buildSignature(`$${fnName}`, actionData.params),
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
                    fullLineText,
                    position.character,
                    i
                );

                return signatureHelp;
            }
        },
        ' '
    );

    context.subscriptions.push(provider);
}
