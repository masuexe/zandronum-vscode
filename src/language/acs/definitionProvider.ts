import * as vscode from 'vscode';
import * as path from 'path';
import { getPk3Root } from '../../shared/pk3Root';

const SCRIPT_EXEC_FUNCTIONS = new Set([
    'acs_execute', 'acs_executealways',
    'acs_namedexecute', 'acs_namedexecutealways', 'acs_namedexecutewithresult',
    'acs_namedsuspend', 'acs_namedterminate',
    'callacs',
]);

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

async function resolveIncludeLocation(
    includePath: string,
    documentUri: vscode.Uri
): Promise<vscode.Location | undefined> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
        return undefined;
    }

    const srcDir = vscode.Uri.joinPath(workspaceRoot, getPk3Root());
    const includeBase = path.basename(includePath);

    const srcPattern = new vscode.RelativePattern(srcDir, `**/${includeBase}`);
    const srcFiles = await vscode.workspace.findFiles(srcPattern, null, 1);
    if (srcFiles.length > 0) {
        return new vscode.Location(srcFiles[0], new vscode.Position(0, 0));
    }

    const wsPattern = new vscode.RelativePattern(workspaceRoot, `**/${includeBase}`);
    const wsFiles = await vscode.workspace.findFiles(wsPattern, null, 1);
    if (wsFiles.length > 0) {
        return new vscode.Location(wsFiles[0], new vscode.Position(0, 0));
    }

    return undefined;
}

export function extractScriptRef(
    lineText: string,
    cursorCol: number
): string | null {
    let openParen = -1;
    let depth = 0;

    for (let i = cursorCol - 1; i >= 0; i--) {
        if (lineText[i] === ')') {
            depth++;
        } else if (lineText[i] === '(') {
            if (depth === 0) {
                openParen = i;
                break;
            }
            depth--;
        }
    }

    if (openParen === -1) {
        return null;
    }

    let fnEnd = openParen - 1;
    while (fnEnd >= 0 && /\s/.test(lineText[fnEnd])) {
        fnEnd--;
    }

    let fnStart = fnEnd;
    while (fnStart >= 0 && /[A-Za-z0-9_]/.test(lineText[fnStart])) {
        fnStart--;
    }
    fnStart++;

    if (fnStart > fnEnd) {
        return null;
    }

    const fnName = lineText.substring(fnStart, fnEnd + 1).toLowerCase();
    if (!SCRIPT_EXEC_FUNCTIONS.has(fnName)) {
        return null;
    }

    let commaCount = 0;
    let inString = false;

    for (let i = openParen + 1; i < cursorCol; i++) {
        const ch = lineText[i];
        if (ch === '"' && !inString) {
            inString = true;
            continue;
        }
        if (ch === '"' && inString) {
            inString = false;
            continue;
        }
        if (ch === ',' && !inString) {
            commaCount++;
        }
    }

    if (commaCount !== 0) {
        return null;
    }

    let argStart = openParen + 1;
    while (argStart < lineText.length && /\s/.test(lineText[argStart])) {
        argStart++;
    }

    let argEnd = argStart;
    let inStr = false;

    while (argEnd < lineText.length) {
        const ch = lineText[argEnd];
        if (ch === '"') {
            inStr = !inStr;
            argEnd++;
            continue;
        }
        if (inStr) {
            argEnd++;
            continue;
        }
        if (ch === ',' || ch === ')') {
            break;
        }
        argEnd++;
    }

    if (cursorCol < argStart || cursorCol > argEnd) {
        return null;
    }

    const firstArg = lineText.substring(argStart, argEnd).trim();

    if (firstArg.startsWith('"') && firstArg.endsWith('"')) {
        return firstArg.slice(1, -1);
    }

    return firstArg;
}

export async function findScriptDefinition(
    scriptRef: string,
    excludeUri: vscode.Uri,
    token: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
        return undefined;
    }

    const isNumbered = /^\d+$/.test(scriptRef);

    const srcDir = vscode.Uri.joinPath(workspaceRoot, getPk3Root());
    const srcResult = await searchForScript(srcDir, scriptRef, isNumbered, token);
    if (srcResult) {
        return srcResult;
    }

    const wsResult = await searchForScript(workspaceRoot, scriptRef, isNumbered, token);
    if (wsResult) {
        return wsResult;
    }

    return undefined;
}

async function searchForScript(
    dirUri: vscode.Uri,
    scriptRef: string,
    isNumbered: boolean,
    token: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const pattern = new vscode.RelativePattern(dirUri, '**/*.acs');
    const acsFiles = await vscode.workspace.findFiles(pattern, null, 50);
    const scriptsFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(dirUri, '**/SCRIPTS'), null, 50
    );
    const allUris = [...acsFiles, ...scriptsFiles];

    for (const uri of allUris) {
        if (token.isCancellationRequested) {
            return undefined;
        }

        let doc: vscode.TextDocument;
        try {
            doc = await vscode.workspace.openTextDocument(uri);
        } catch {
            continue;
        }

        for (let i = 0; i < doc.lineCount; i++) {
            const line = doc.lineAt(i).text;

            if (isNumbered) {
                const numRe = new RegExp(`\\bscript\\s+${escapeRegex(scriptRef)}\\b`, 'i');
                const match = numRe.exec(line);
                if (match) {
                    const start = line.toLowerCase().indexOf('script');
                    return new vscode.Location(uri, new vscode.Position(i, start));
                }
            } else {
                const nameRe = new RegExp(`\\bscript\\s+"${escapeRegex(scriptRef)}"`, 'i');
                const match = nameRe.exec(line);
                if (match) {
                    const start = line.toLowerCase().indexOf('script');
                    return new vscode.Location(uri, new vscode.Position(i, start));
                }
            }
        }
    }

    return undefined;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function registerAcsDefinitionProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerDefinitionProvider(
        [{ language: 'acs' }],
        {
            async provideDefinition(
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

                return undefined;
            }
        }
    );

    context.subscriptions.push(provider);
}
