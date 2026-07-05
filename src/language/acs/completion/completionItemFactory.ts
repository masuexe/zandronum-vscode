import * as vscode from 'vscode';
import { CompletionPriority, makeSortText } from './completionPriority';

export function makeFunctionItem(
    name: string,
    insertText: vscode.SnippetString
): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
    item.detail = 'ACS Function';
    item.sortText = makeSortText(CompletionPriority.Function, name);
    item.commitCharacters = ['('];
    item.insertText = insertText;
    return item;
}

export function makeVariableItem(name: string, detail?: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
    item.detail = detail || 'Variable';
    item.sortText = makeSortText(CompletionPriority.LocalVariable, name);
    return item;
}

export function makeConstantItem(name: string, kind: 'builtin' | 'user'): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Constant);
    item.detail = kind === 'builtin' ? 'ACS Constant' : 'Constant (#define)';
    item.sortText = makeSortText(CompletionPriority.Constant, name);
    return item;
}

export function makeEnumItem(name: string, value: number): vscode.CompletionItem {
    const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
    item.detail = `Value: ${value}`;
    item.sortText = makeSortText(CompletionPriority.Enum, name);
    return item;
}

export function makeKeywordItem(keyword: string): vscode.CompletionItem {
    const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
    item.detail = 'ACS Keyword';
    item.sortText = makeSortText(CompletionPriority.Keyword, keyword);
    return item;
}

export function makeSnippetItem(
    label: string,
    insertText: vscode.SnippetString,
    description: string
): vscode.CompletionItem {
    const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
    item.detail = description;
    item.sortText = makeSortText(CompletionPriority.Snippet, label);
    item.insertText = insertText;
    return item;
}
