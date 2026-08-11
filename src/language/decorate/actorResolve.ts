import * as vscode from 'vscode';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SymbolKind, ActorSymbol } from '../../base/types';
import { locationFromSymbol } from '../../base/symbolLocation';
import { getPk3Root } from '../../shared/pk3Root';

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find `actor ClassName` in the same document (skipping currentLine when provided). */
export function findActorInDocument(
    document: vscode.TextDocument,
    className: string,
    currentLine?: number
): vscode.Location | null {
    const re = new RegExp(`\\bactor\\s+(${escapeRegex(className)})\\b`, 'i');

    for (let i = 0; i < document.lineCount; i++) {
        if (currentLine !== undefined && i === currentLine) {
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

/** Scan pk3Root DECORATE-like files for `actor ClassName`. */
export async function findActorInWorkspace(
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

/**
 * Resolve an actor class name: current document → SymbolDatabase (non-builtin) → workspace scan.
 * When `document` is omitted (e.g. ACS → DECORATE), skip the current-file pass.
 */
export async function resolveActorDefinition(
    className: string,
    excludeUri: vscode.Uri,
    token: vscode.CancellationToken,
    symbolDb?: SymbolDatabase,
    document?: vscode.TextDocument,
    currentLine?: number
): Promise<vscode.Location | undefined> {
    if (document) {
        const currentFileResult = findActorInDocument(document, className, currentLine);
        if (currentFileResult) {
            return currentFileResult;
        }
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

    return findActorInWorkspace(className, excludeUri, token);
}
