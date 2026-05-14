import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export interface ParamData {
    name: string;
    type: string;
    optional?: boolean;
    default?: string;
    mode?: 'bitmask' | 'enum';
    enum?: Array<{ name: string; value: number }>;
    variadic?: boolean;
}

export interface ActionData {
    params?: ParamData[] | string[];
    signature?: string;
    desc?: string;
}

export interface PropertyData {
    type: string;
    desc?: string;
    for?: string;
}

export interface FlagData {
    type: string;
    desc?: string;
    for?: string;
}

export interface ExpressionData {
    desc?: string;
}

export interface InheritanceData {
    category?: string;
    desc?: string;
    extends?: string;
}

export function findActionCaseInsensitive(
    actionsData: Record<string, ActionData>,
    name: string
): ActionData | undefined {
    if (actionsData[name]) return actionsData[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(actionsData)) {
        if (key.toLowerCase() === lower) return actionsData[key];
    }
    return undefined;
}

let cache: Record<string, any> = {};

function loadDataJson<T>(context: vscode.ExtensionContext, filename: string): Record<string, T> {
    if (!cache[filename]) {
        const file = path.join(context.extensionPath, 'data/decorate', filename);
        cache[filename] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return cache[filename];
}

export function getActions(context: vscode.ExtensionContext): Record<string, ActionData> {
    return loadDataJson<ActionData>(context, 'actions.json');
}

export function getProperties(context: vscode.ExtensionContext): Record<string, PropertyData> {
    return loadDataJson<PropertyData>(context, 'properties.json');
}

export function getFlags(context: vscode.ExtensionContext): Record<string, FlagData> {
    return loadDataJson<FlagData>(context, 'flags.json');
}

export function getExpressions(context: vscode.ExtensionContext): Record<string, ExpressionData> {
    return loadDataJson<ExpressionData>(context, 'expressions.json');
}

export function getInheritance(context: vscode.ExtensionContext): Record<string, InheritanceData> {
    return loadDataJson<InheritanceData>(context, 'inheritance.json');
}
