import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { extractScriptRef, findScriptDefinition } from '../acs/definitionProvider';

export function registerDefinitionProvider(context: vscode.ExtensionContext) {
    const defProvider = vscode.languages.registerDefinitionProvider(
        [{ language: 'decorate' }],
        { provideDefinition }
    );
    context.subscriptions.push(defProvider);
}

async function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<vscode.Definition | undefined> {
    const lineText = document.lineAt(position.line).text;

    const includePath = extractIncludePath(lineText, position.character);
    if (includePath !== null) {
        return resolveIncludeLocation(includePath, document.uri);
    }

    const scriptRef = extractScriptRef(lineText, position.character);
    if (scriptRef !== null) {
        return findScriptDefinition(scriptRef, document.uri, token);
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
        return undefined;
    }
    const className = document.getText(wordRange);
    if (!className) {
        return undefined;
    }

    const currentFileResult = findActorInDocument(document, className, position.line);
    if (currentFileResult) {
        return currentFileResult;
    }

    if (token.isCancellationRequested) {
        return undefined;
    }

    return await findActorInWorkspace(className, document.uri, token);
}

function extractIncludePath(lineText: string, cursorCol: number): string | null {
    const match = lineText.match(/^\s*#include\s+"([^"]*)"/);
    if (!match) {
        return null;
    }

    const fullMatch = match[0];
    const quoteOpen = fullMatch.indexOf('"');
    const quoteClose = fullMatch.lastIndexOf('"');
    if (quoteOpen === -1 || quoteClose === -1 || quoteOpen === quoteClose) {
        return null;
    }

    if (cursorCol <= match.index! + quoteOpen || cursorCol >= match.index! + quoteClose) {
        return null;
    }

    return match[1];
}

function resolveIncludeLocation(includePath: string, documentUri: vscode.Uri): vscode.Location | undefined {
    let searchDir = path.dirname(documentUri.fsPath);

    while (true) {
        const targetPath = path.resolve(searchDir, includePath);
        if (fs.existsSync(targetPath)) {
            return new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(0, 0));
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) {
            break;
        }
        searchDir = parent;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        for (const folder of workspaceFolders) {
            const targetPath = path.resolve(folder.uri.fsPath, includePath);
            if (fs.existsSync(targetPath)) {
                return new vscode.Location(vscode.Uri.file(targetPath), new vscode.Position(0, 0));
            }
        }
    }

    return undefined;
}

function findActorInDocument(
    document: vscode.TextDocument,
    className: string,
    currentLine: number
): vscode.Location | null {
    const re = new RegExp(`\\bactor\\s+(${escapeRegex(className)})\\b`, 'i');

    for (let i = 0; i < document.lineCount; i++) {
        if (i === currentLine) {
            continue;
        }
        const line = document.lineAt(i).text;
        const match = re.exec(line);
        if (match && match[1]) {
            const nameStartInMatch = match[0].toLowerCase().indexOf(className.toLowerCase());
            if (nameStartInMatch === -1) {
                continue;
            }
            const charIndex = match.index + nameStartInMatch;
            return new vscode.Location(document.uri, new vscode.Position(i, charIndex));
        }
    }

    return null;
}

async function findActorInWorkspace(
    className: string,
    excludeUri: vscode.Uri,
    token: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const decFiles = await vscode.workspace.findFiles('**/*.{dec,decorate}');
    const namedFiles = await vscode.workspace.findFiles('**/DECORATE');
    const allUris = [...decFiles, ...namedFiles];

    const re = new RegExp(`\\bactor\\s+(${escapeRegex(className)})\\b`, 'i');

    for (const uri of allUris) {
        if (uri.fsPath === excludeUri.fsPath) {
            continue;
        }
        if (token.isCancellationRequested) {
            return undefined;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text;
                const match = re.exec(line);
                if (match && match[1]) {
                    const nameStartInMatch = match[0].toLowerCase().indexOf(className.toLowerCase());
                    if (nameStartInMatch === -1) {
                        continue;
                    }
                    const charIndex = match.index + nameStartInMatch;
                    return new vscode.Location(uri, new vscode.Position(i, charIndex));
                }
            }
        } catch {
            // skip unreadable files
        }
    }

    return undefined;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
