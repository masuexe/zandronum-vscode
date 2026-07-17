import * as vscode from 'vscode';
import {
    ActionData,
    ExpressionData,
    findActionCaseInsensitive,
    findCallableCaseInsensitive,
    getExpressionCallables,
    StateKeywordData,
    findStateKeywordCaseInsensitive,
} from '../../shared/dataLoader';

function calculateActiveParameter(fullLine: string, cursorPosition: number, openParenIndex: number): number {
    const textInParens = fullLine.substring(openParenIndex + 1, cursorPosition);
    let commaCount = 0;
    let inString = false;
    let stringChar = '';
    let parenDepth = 0;

    for (let i = 0; i < textInParens.length; i++) {
        const char = textInParens[i];
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
        } else if (char === stringChar && textInParens[i - 1] !== '\\') {
            inString = false;
        }
    }

    return commaCount;
}

interface SignatureParts {
    label: string;
    paramRanges: Array<[number, number]>;
    docs: string[];
}

function buildSignatureParts(fnName: string, params?: any[]): SignatureParts {
    if (!Array.isArray(params) || params.length === 0) {
        return { label: `${fnName}()`, paramRanges: [], docs: [] };
    }

    const objectParams = params.filter((p: any) => typeof p === 'object');
    const paramRanges: Array<[number, number]> = [];
    const docs: string[] = [];
    let inner = '';

    for (let i = 0; i < objectParams.length; i++) {
        const p = objectParams[i];
        let segment: string;
        if (p.variadic) {
            segment = `${p.type} ${p.name}...`;
        } else if (p.optional) {
            segment = `[${p.type} ${p.name}]`;
        } else {
            segment = `${p.type} ${p.name}`;
        }

        if (i > 0) {
            inner += ', ';
        }
        const start = fnName.length + 1 + inner.length;
        inner += segment;
        paramRanges.push([start, start + segment.length]);
        docs.push(p.desc || `Parameter: ${p.name} (${p.type})`);
    }

    return {
        label: `${fnName}(${inner})`,
        paramRanges,
        docs
    };
}

export function registerSignatureHelp(
    context: vscode.ExtensionContext,
    actionsData: Record<string, ActionData>,
    stateKeywords?: Record<string, StateKeywordData>,
    expressionsData?: Record<string, ExpressionData>
) {
    const expressionCallables = expressionsData
        ? getExpressionCallables(actionsData, expressionsData)
        : {};

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

                let data: ActionData | undefined;
                if (stateKeywords) {
                    data = findStateKeywordCaseInsensitive(stateKeywords, functionName);
                }
                // Prefer expression callables for nested calls (CheckClass, CallACS, …)
                if (!data) {
                    data = findCallableCaseInsensitive(expressionCallables, functionName);
                }
                if (!data) {
                    data = findActionCaseInsensitive(actionsData, functionName);
                }
                if (!data) {
                    return null;
                }

                const { label, paramRanges, docs } = buildSignatureParts(functionName, data.params);
                const signature = new vscode.SignatureInformation(label, data.desc);
                signature.parameters = paramRanges.map(
                    (range, i) => new vscode.ParameterInformation(range, docs[i])
                );

                const signatureHelp = new vscode.SignatureHelp();
                signatureHelp.signatures = [signature];
                signatureHelp.activeSignature = 0;
                let active = calculateActiveParameter(
                    textBeforeCursor,
                    textBeforeCursor.length,
                    openParenIndex
                );
                if (paramRanges.length > 0 && active >= paramRanges.length) {
                    active = paramRanges.length - 1;
                }
                signatureHelp.activeParameter = active;

                return signatureHelp;
            }
        },
        '(',
        ','
    );

    context.subscriptions.push(signatureProvider);
}
