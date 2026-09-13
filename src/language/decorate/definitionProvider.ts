import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { extractScriptRef, findScriptDefinition } from '../acs/definitionProvider';
import { SymbolDatabase } from '../../base/symbolDatabase';
import {
    ActionData,
    ExpressionData,
    InheritanceData,
    PropertyData,
    getExpressionCallables,
} from '../../shared/dataLoader';
import {
    extractSoundArgAtCursor,
    extractSoundPropertyAtCursor,
    resolveSoundDefinition,
} from '../sndinfo/soundResolve';
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
import { resolveActorDefinition } from './actorResolve';

export function registerDefinitionProvider(
    context: vscode.ExtensionContext,
    symbolDb?: SymbolDatabase,
    actionsData?: Record<string, ActionData>,
    expressionsData?: Record<string, ExpressionData>,
    inheritanceData?: Record<string, InheritanceData>,
    propertiesData?: Record<string, PropertyData>
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
                    inheritanceData,
                    propertiesData
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
    inheritanceData?: Record<string, InheritanceData>,
    propertiesData?: Record<string, PropertyData>
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

    const soundArg = extractSoundArgAtCursor(lineText, position.character, actionsData);
    if (soundArg !== null) {
        return resolveSoundDefinition(soundArg.sound, token, symbolDb);
    }

    const soundProp = extractSoundPropertyAtCursor(
        lineText,
        position.character,
        propertiesData
    );
    if (soundProp !== null) {
        return resolveSoundDefinition(soundProp.sound, token, symbolDb);
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
        return undefined;
    }
    const className = document.getText(wordRange);
    if (!className) {
        return undefined;
    }

    return resolveActorDefinition(
        className,
        document.uri,
        token,
        symbolDb,
        document,
        position.line
    );
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
