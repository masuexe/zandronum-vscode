import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { extractScriptRef, findScriptDefinition } from '../acs/definitionProvider';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SymbolKind, ActorSymbol } from '../../base/types';
import { locationFromSymbol } from '../../base/symbolLocation';
import { getPk3Root } from '../../shared/pk3Root';
import {
    ActionData,
    ExpressionData,
    InheritanceData,
    getExpressionCallables,
} from '../../shared/dataLoader';
import {
    actorIsWeaponDescendant,
    defaultGunFlashLabel,
    extractGunFlashAtCursor,
    extractStateLabelAtCursor,
    resolveStateLabelGoto,
    resolveStateLabelJump,
} from './stateLabelResolve';
import { findActorSpanInLines } from './renameProvider';
import { parseActorHeader } from './actorUserVars';

export function registerDefinitionProvider(
    context: vscode.ExtensionContext,
    symbolDb?: SymbolDatabase,
    actionsData?: Record<string, ActionData>,
    expressionsData?: Record<string, ExpressionData>,
    inheritanceData?: Record<string, InheritanceData>
) {
    const expressionCallables = expressionsData && actionsData
        ? getExpressionCallables(actionsData, expressionsData)
        : {};

    const defProvider = vscode.languages.registerDefinitionProvider(
        [{ language: 'decorate' }],
        {
            provideDefinition(document, position, token) {
                return provideDefinition(
                    document,
                    position,
                    token,
                    symbolDb,
                    actionsData,
                    expressionCallables,
                    inheritanceData
                );
            }
        }
    );
    context.subscriptions.push(defProvider);
}

async function provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    symbolDb?: SymbolDatabase,
    actionsData?: Record<string, ActionData>,
    expressionCallables: Record<string, ActionData> = {},
    inheritanceData?: Record<string, InheritanceData>
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

    if (actionsData) {
        const lines: string[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            lines.push(document.lineAt(i).text);
        }

        // A_GunFlash on callee name — Weapon gate + Flash/AltFlash default
        const gunFlash = extractGunFlashAtCursor(lineText, position.character);
        if (gunFlash) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            const span = findActorSpanInLines(lines, position.line);
            const header = span
                ? parseActorHeader(lines[span.startLine] ?? '')
                : undefined;
            if (
                !header ||
                !actorIsWeaponDescendant(
                    header.name,
                    header.parentClass,
                    symbolDb,
                    inheritanceData
                )
            ) {
                return undefined;
            }

            if (gunFlash.explicitLabel) {
                return resolveStateLabelJump(
                    document,
                    position,
                    gunFlash.explicitLabel,
                    symbolDb,
                    token
                );
            }

            const primary = defaultGunFlashLabel(lines, position.line);
            const hit = await resolveStateLabelJump(
                document,
                position,
                primary,
                symbolDb,
                token
            );
            if (hit) {
                return hit;
            }
            const fallback =
                primary.toLowerCase() === 'altflash' ? 'Flash' : 'AltFlash';
            return resolveStateLabelJump(
                document,
                position,
                fallback,
                symbolDb,
                token
            );
        }

        const stateLabel = extractStateLabelAtCursor(
            lineText,
            position.character,
            actionsData,
            expressionCallables,
            { lines, lineNumber: position.line }
        );
        if (stateLabel) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            if (stateLabel.kind === 'goto') {
                return resolveStateLabelGoto(
                    document,
                    position,
                    stateLabel.label,
                    stateLabel.offset,
                    symbolDb,
                    token
                );
            }
            return resolveStateLabelJump(
                document,
                position,
                stateLabel.label,
                symbolDb,
                token
            );
        }
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

    if (symbolDb) {
        const sym = symbolDb.query<ActorSymbol>(SymbolKind.Actor, className);
        if (sym && sym.packageId !== 'builtin') {
            return locationFromSymbol(sym);
        }
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
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return undefined;
    }

    const pk3RootUri = vscode.Uri.joinPath(workspaceFolders[0].uri, getPk3Root());
    const decFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(pk3RootUri, '**/*.{dec,decorate,txt}')
    );
    const namedFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(pk3RootUri, '**/DECORATE{,.txt}')
    );
    // Dedupe: DECORATE.txt may appear in both globs
    const seen = new Set<string>();
    const allUris: vscode.Uri[] = [];
    for (const uri of [...decFiles, ...namedFiles]) {
        const key = uri.fsPath.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        allUris.push(uri);
    }

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
