import * as vscode from 'vscode';
import { ParamData } from './dataLoader';

/**
 * DECORATE state actions: only insert `Name($0)` when the first parameter is required.
 * Zero-arg and first-optional actions must be bare `Name` — `Name()` errors for zero-arg.
 */
export function actionNeedsParenSnippet(params?: ParamData[] | string[]): boolean {
    if (!Array.isArray(params) || params.length === 0) {
        return false;
    }
    const first = params[0];
    if (typeof first !== 'object' || first == null) {
        return true;
    }
    return !first.optional;
}

/**
 * True when `(` already follows the identifier being completed
 * (e.g. completing `ACS_NamedExecuteWithRe` in `ACS_NamedExecuteWithRe("x")`).
 */
export function hasExistingCallParen(lineText: string, cursorCharacter: number): boolean {
    let i = cursorCharacter;
    while (i < lineText.length && /[A-Za-z0-9_]/.test(lineText[i])) {
        i++;
    }
    while (i < lineText.length && /\s/.test(lineText[i])) {
        i++;
    }
    return lineText[i] === '(';
}

/** Insert text + whether to trigger signature help after accept. */
export function buildActionInsertText(
    functionName: string,
    params?: ParamData[] | string[],
    options?: { existingCallParen?: boolean }
): { insertText: string | vscode.SnippetString; triggerSignatureHelp: boolean } {
    if (options?.existingCallParen) {
        return { insertText: functionName, triggerSignatureHelp: false };
    }
    if (actionNeedsParenSnippet(params)) {
        return {
            insertText: new vscode.SnippetString(`${functionName}($0)`),
            triggerSignatureHelp: true,
        };
    }
    return { insertText: functionName, triggerSignatureHelp: false };
}

function buildParamSnippet(param: ParamData, index: number): string {
    const paramLabel = param.optional ? `${param.name}?` : param.name;

    if (param.mode === 'bitmask' && Array.isArray(param.enum) && param.enum.length > 0) {
        const valueNames = param.enum.map((v) => v.name).join(' | ');
        return `\${${index}:${valueNames}}`;
    }

    if (param.mode === 'enum' && Array.isArray(param.enum) && param.enum.length > 0) {
        const valueNames = param.enum.map((v) => v.name).join('|');
        return `\${${index}|${valueNames}|}`;
    }

    return `\${${index}:${paramLabel}}`;
}

export function buildSnippetString(functionName: string, params?: ParamData[]): vscode.SnippetString {
    if (!Array.isArray(params) || params.length === 0) {
        return new vscode.SnippetString(`${functionName}($0)`);
    }

    const snippetParts = params.map((param, index) => buildParamSnippet(param, index + 1));
    return new vscode.SnippetString(`${functionName}(${snippetParts.join(', ')})`);
}

export function calculateMinParamCount(params?: ParamData[]): number {
    if (!Array.isArray(params)) {
        return 0;
    }
    return params.filter((p) => !p.optional).length;
}

export function calculateMaxParamCount(params?: ParamData[]): number {
    return Array.isArray(params) ? params.length : 0;
}
