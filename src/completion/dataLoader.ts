import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export interface ActionData {
    params?: Array<{ name: string; type: string; optional?: boolean }> | string[];
    signature?: string;
    desc?: string;
}

export interface PropertyData {
    type: string;
    desc?: string;
}

export interface FlagData {
    type: string;
    desc?: string;
}

export interface ExpressionData {
    desc?: string;
}

let cache: Record<string, any> = {};

function loadDataJson<T>(context: vscode.ExtensionContext, filename: string): Record<string, T> {
    if (!cache[filename]) {
        const file = path.join(context.extensionPath, 'src/data/decorate', filename);
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
