import * as vscode from 'vscode';
import { getAcsFunctions } from '../../shared/dataLoader';

const CONFIG_SECTION = 'zandronum-vscode';
const DEPRECATION_SETTING = 'acs.linting.deprecated';
const CHANGE_DEBOUNCE_MS = 300;

export interface AcsLintDiagnostic {
    /** Zero-based line. */
    line: number;
    startCharacter: number;
    endCharacter: number;
    message: string;
}

export interface AcsDeprecatedFunction {
    /** Name as stored in metadata. */
    name: string;
    /** Replacement function name, when the engine or wiki names one. */
    replacement?: string;
    /** Short explanation shown after the deprecation message. */
    note?: string;
}

/**
 * Replace comment and string content with spaces.
 * The result has the same length as the input, so indices stay valid.
 */
export function stripAcsCommentsAndStrings(text: string): string {
    const chars = text.split('');
    let state: 'code' | 'line' | 'block' | 'string' = 'code';
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const next = chars[i + 1];
        if (state === 'code') {
            if (ch === '/' && next === '/') {
                chars[i] = ' ';
                chars[i + 1] = ' ';
                state = 'line';
                i++;
            } else if (ch === '/' && next === '*') {
                chars[i] = ' ';
                chars[i + 1] = ' ';
                state = 'block';
                i++;
            } else if (ch === '"') {
                chars[i] = ' ';
                state = 'string';
            }
            continue;
        }
        if (state === 'line') {
            if (ch === '\n') {
                state = 'code';
            } else {
                chars[i] = ' ';
            }
            continue;
        }
        if (state === 'block') {
            if (ch === '*' && next === '/') {
                chars[i] = ' ';
                chars[i + 1] = ' ';
                state = 'code';
                i++;
            } else if (ch !== '\n') {
                chars[i] = ' ';
            }
            continue;
        }
        // string
        if (ch === '\\') {
            chars[i] = ' ';
            if (i + 1 < chars.length) {
                chars[i + 1] = ' ';
                i++;
            }
        } else if (ch === '"') {
            chars[i] = ' ';
            state = 'code';
        } else if (ch !== '\n') {
            chars[i] = ' ';
        }
    }
    return chars.join('');
}

const CALL_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

/** Find calls to deprecated ACS built-in functions. */
export function lintAcsDeprecatedCalls(
    lines: string[],
    deprecated: Map<string, AcsDeprecatedFunction>
): AcsLintDiagnostic[] {
    const diagnostics: AcsLintDiagnostic[] = [];
    for (let line = 0; line < lines.length; line++) {
        const cleaned = stripAcsCommentsAndStrings(lines[line]);
        CALL_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CALL_RE.exec(cleaned)) !== null) {
            const name = match[1];
            const info = deprecated.get(name.toLowerCase());
            if (!info) {
                continue;
            }
            const start = match.index;
            const replacement = info.replacement ? ` Use '${info.replacement}' instead.` : '';
            const note = info.note ? ` ${info.note}` : '';
            diagnostics.push({
                line,
                startCharacter: start,
                endCharacter: start + name.length,
                message: `ACS function '${name}' is deprecated.${replacement}${note}`,
            });
        }
    }
    return diagnostics;
}

function isDeprecationWarningsEnabled(): boolean {
    return vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(DEPRECATION_SETTING, true);
}

export function registerAcsDeprecationDiagnostics(context: vscode.ExtensionContext): void {
    const functions = getAcsFunctions(context);
    const deprecated = new Map<string, AcsDeprecatedFunction>();
    for (const [name, data] of Object.entries(functions)) {
        if (!data.deprecated) {
            continue;
        }
        deprecated.set(name.toLowerCase(), {
            name,
            replacement: data.deprecatedBy,
            note: data.deprecatedNote,
        });
    }
    if (deprecated.size === 0) {
        return;
    }

    const collection = vscode.languages.createDiagnosticCollection('acs-deprecated');
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const lint = (document: vscode.TextDocument): void => {
        if (document.languageId !== 'acs') {
            return;
        }
        if (!isDeprecationWarningsEnabled()) {
            collection.delete(document.uri);
            return;
        }
        const lines: string[] = [];
        for (let index = 0; index < document.lineCount; index++) {
            lines.push(document.lineAt(index).text);
        }
        const diagnostics = lintAcsDeprecatedCalls(lines, deprecated).map(diagnostic => {
            const lineLength = document.lineAt(diagnostic.line).text.length;
            const start = Math.max(0, Math.min(diagnostic.startCharacter, lineLength));
            const end = Math.max(start, Math.min(diagnostic.endCharacter, lineLength));
            const result = new vscode.Diagnostic(
                new vscode.Range(diagnostic.line, start, diagnostic.line, end),
                diagnostic.message,
                vscode.DiagnosticSeverity.Warning
            );
            result.source = 'acs';
            return result;
        });
        collection.set(document.uri, diagnostics);
    };

    const schedule = (document: vscode.TextDocument): void => {
        if (document.languageId !== 'acs') {
            return;
        }
        const key = document.uri.toString();
        const pending = timers.get(key);
        if (pending) {
            clearTimeout(pending);
        }
        timers.set(key, setTimeout(() => {
            timers.delete(key);
            lint(document);
        }, CHANGE_DEBOUNCE_MS));
    };

    const clear = (uri: vscode.Uri): void => {
        const key = uri.toString();
        const pending = timers.get(key);
        if (pending) {
            clearTimeout(pending);
            timers.delete(key);
        }
        collection.delete(uri);
    };

    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument(document => lint(document)),
        vscode.workspace.onDidSaveTextDocument(document => lint(document)),
        vscode.workspace.onDidChangeTextDocument(event => schedule(event.document)),
        vscode.workspace.onDidCloseTextDocument(document => clear(document.uri)),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration(`${CONFIG_SECTION}.${DEPRECATION_SETTING}`)) {
                for (const document of vscode.workspace.textDocuments) {
                    lint(document);
                }
            }
        })
    );

    for (const document of vscode.workspace.textDocuments) {
        lint(document);
    }
}
