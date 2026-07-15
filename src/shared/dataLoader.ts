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
    desc?: string;
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

export interface AcsConstantData {
    value?: number;
    desc?: string;
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

export function findInheritanceCaseInsensitive(
    inheritanceData: Record<string, InheritanceData>,
    name: string
): InheritanceData | undefined {
    if (inheritanceData[name]) return inheritanceData[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(inheritanceData)) {
        if (key.toLowerCase() === lower) return inheritanceData[key];
    }
    return undefined;
}

export type StateKeywordData = ActionData;

export function getStateKeywords(context: vscode.ExtensionContext): Record<string, StateKeywordData> {
    return loadDataJson<StateKeywordData>(context, 'stateKeywords.json');
}

export function findStateKeywordCaseInsensitive(
    keywords: Record<string, StateKeywordData>,
    name: string
): StateKeywordData | undefined {
    if (keywords[name]) return keywords[name];
    const lower = name.toLowerCase();
    for (const key of Object.keys(keywords)) {
        if (key.toLowerCase() === lower) return keywords[key];
    }
    return undefined;
}

function loadAcsDataJson<T>(context: vscode.ExtensionContext, filename: string): Record<string, T> {
    const key = 'acs/' + filename;
    if (!cache[key]) {
        const file = path.join(context.extensionPath, 'data/acs', filename);
        cache[key] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return cache[key];
}

export function getAcsFunctions(context: vscode.ExtensionContext): Record<string, ActionData> {
    return loadAcsDataJson<ActionData>(context, 'functions.json');
}

export function getAcsConstants(context: vscode.ExtensionContext): Record<string, AcsConstantData> {
    return loadAcsDataJson<AcsConstantData>(context, 'constants.json');
}

function loadLangDataJson<T>(context: vscode.ExtensionContext, subdir: string, filename: string): Record<string, T> {
    const key = subdir + '/' + filename;
    if (!cache[key]) {
        const file = path.join(context.extensionPath, 'data', subdir, filename);
        cache[key] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
    return cache[key];
}

export function getSndinfoCommands(context: vscode.ExtensionContext): Record<string, ActionData> {
    return loadLangDataJson<ActionData>(context, 'sndinfo', 'commands.json');
}

export interface TexturesKeywordData {
    category: 'definition' | 'textureProperty' | 'patchProperty';
    params?: ParamData[];
    desc?: string;
    children?: string[];
    example?: string;
}

export function getTexturesKeywords(context: vscode.ExtensionContext): Record<string, TexturesKeywordData> {
    const key = 'textures/keywords';
    if (!cache[key]) {
        const file = path.join(context.extensionPath, 'data/textures', 'keywords.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        cache[key] = raw.keywords;
    }
    return cache[key];
}
