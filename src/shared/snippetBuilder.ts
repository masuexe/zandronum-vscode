import * as vscode from 'vscode';
import { ParamData } from './dataLoader';

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
