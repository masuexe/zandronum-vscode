import * as vscode from 'vscode';
import { ActionData, ParamData } from '../../shared/dataLoader';

type ColorMap = Record<string, [number, number, number]>;
export type ColorParameterIndex = ReadonlyMap<string, ReadonlySet<number>>;

interface ArgumentSpan {
    start: number;
    end: number;
}

export function buildColorParameterIndex(
    actionsData: Record<string, ActionData>
): ColorParameterIndex {
    const result = new Map<string, Set<number>>();
    for (const [name, action] of Object.entries(actionsData)) {
        if (!Array.isArray(action.params)) {
            continue;
        }
        const params = action.params.filter((param): param is ParamData => typeof param === 'object');
        const indexes = new Set<number>();
        for (let i = 0; i < params.length; i++) {
            if (params[i].type.toLowerCase() === 'color') {
                indexes.add(i);
            }
        }
        if (indexes.size > 0) {
            result.set(name.toLowerCase(), indexes);
        }
    }
    return result;
}

function skipQuotedString(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '\\') {
            i++;
            continue;
        }
        if (text[i] === '"') {
            return i + 1;
        }
    }
    return text.length;
}

function skipComment(text: string, start: number): number {
    if (text[start + 1] === '/') {
        const end = text.indexOf('\n', start + 2);
        return end < 0 ? text.length : end + 1;
    }
    if (text[start + 1] === '*') {
        const end = text.indexOf('*/', start + 2);
        return end < 0 ? text.length : end + 2;
    }
    return start;
}

function parseArguments(text: string, openParen: number): ArgumentSpan[] | null {
    const args: ArgumentSpan[] = [];
    let start = openParen + 1;
    let depth = 0;

    for (let i = start; i < text.length;) {
        const ch = text[i];
        if (ch === '"') {
            i = skipQuotedString(text, i);
            continue;
        }
        if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            i = skipComment(text, i);
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            i++;
            continue;
        }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (ch === ')' && depth === 0) {
                args.push({ start, end: i });
                return args;
            }
            depth = Math.max(0, depth - 1);
            i++;
            continue;
        }
        if (ch === ',' && depth === 0) {
            args.push({ start, end: i });
            start = i + 1;
        }
        i++;
    }
    return null;
}

function trimSpan(text: string, span: ArgumentSpan): ArgumentSpan {
    let { start, end } = span;
    while (start < end && /\s/.test(text[start])) {
        start++;
    }
    while (end > start && /\s/.test(text[end - 1])) {
        end--;
    }
    return { start, end };
}

function parseHexColor(value: string): [number, number, number] | null {
    let match = /^#([0-9a-f]{3})$/i.exec(value);
    if (match) {
        return [...match[1]].map(component => parseInt(component + component, 16)) as [number, number, number];
    }
    match = /^#?([0-9a-f]{6})$/i.exec(value);
    if (match) {
        return [
            parseInt(match[1].slice(0, 2), 16),
            parseInt(match[1].slice(2, 4), 16),
            parseInt(match[1].slice(4, 6), 16),
        ];
    }
    match = /^([0-9a-f]{1,2})\s+([0-9a-f]{1,2})\s+([0-9a-f]{1,2})$/i.exec(value);
    if (!match) {
        return null;
    }
    return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

export function resolveNamedColor(
    value: string,
    colors: ColorMap
): [number, number, number] | null {
    const named = colors[value.toLowerCase()];
    return named ?? parseHexColor(value);
}

function collectColorArgument(
    document: vscode.TextDocument,
    text: string,
    span: ArgumentSpan,
    colors: ColorMap
): vscode.ColorInformation | null {
    const trimmed = trimSpan(text, span);
    if (trimmed.start >= trimmed.end) {
        return null;
    }

    let valueStart = trimmed.start;
    let valueEnd = trimmed.end;
    if (text[valueStart] === '"' && text[valueEnd - 1] === '"') {
        valueStart++;
        valueEnd--;
    } else if (!/^[A-Za-z][A-Za-z0-9]*$/.test(text.slice(valueStart, valueEnd))) {
        return null;
    }

    const value = text.slice(valueStart, valueEnd);
    if (!value || /^none$/i.test(value)) {
        return null;
    }
    const rgb = resolveNamedColor(value, colors);
    if (!rgb) {
        return null;
    }
    const range = new vscode.Range(document.positionAt(valueStart), document.positionAt(valueEnd));
    const color = new vscode.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
    return new vscode.ColorInformation(range, color);
}

export function collectDecorateFunctionColors(
    document: vscode.TextDocument,
    parameterIndexes: ColorParameterIndex,
    colors: ColorMap,
    token?: vscode.CancellationToken
): vscode.ColorInformation[] {
    const text = document.getText();
    const result: vscode.ColorInformation[] = [];

    for (let i = 0; i < text.length;) {
        if (token?.isCancellationRequested) {
            break;
        }
        if (text[i] === '"') {
            i = skipQuotedString(text, i);
            continue;
        }
        if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            i = skipComment(text, i);
            continue;
        }
        if (!/[A-Za-z_]/.test(text[i])) {
            i++;
            continue;
        }

        const nameStart = i;
        while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) {
            i++;
        }
        const name = text.slice(nameStart, i).toLowerCase();
        const indexes = parameterIndexes.get(name);
        if (!indexes) {
            continue;
        }
        let openParen = i;
        while (openParen < text.length && /\s/.test(text[openParen])) {
            openParen++;
        }
        if (text[openParen] !== '(') {
            continue;
        }
        const args = parseArguments(text, openParen);
        if (!args) {
            continue;
        }
        for (const index of indexes) {
            if (index >= args.length) {
                continue;
            }
            const color = collectColorArgument(document, text, args[index], colors);
            if (color) {
                result.push(color);
            }
        }
    }
    return result;
}

export function provideNamedColorPresentations(
    color: vscode.Color,
    context: { document: vscode.TextDocument; range: vscode.Range }
): vscode.ColorPresentation[] {
    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    const presentation = new vscode.ColorPresentation(hex);

    const startOffset = context.document.offsetAt(context.range.start);
    const endOffset = context.document.offsetAt(context.range.end);
    const text = context.document.getText();
    const isQuoted = startOffset > 0 && text[startOffset - 1] === '"' && text[endOffset] === '"';
    const replacement = isQuoted ? hex : `"${hex}"`;
    presentation.textEdit = vscode.TextEdit.replace(context.range, replacement);
    return [presentation];
}
