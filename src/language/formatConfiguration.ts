import * as vscode from 'vscode';

/** Brace placement shared by the DECORATE, ACS and SBARINFO formatters. */
export type BraceStyle = 'nextLine' | 'sameLine';

/**
 * Resolve the configuration for shared formatter settings.
 *
 * Pass the TextDocument (not just its Uri) so `language-overridable` settings
 * pick up `[decorate]` / `[acs]` / `[sbarinfo]` overrides from the language id.
 * Call this once per `toFormatOptions()` and hand the result to the readers
 * below instead of calling `getConfiguration()` per field.
 */
export function getFormatConfiguration(
    document: vscode.TextDocument
): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('zandronum-vscode', document);
}

/**
 * `zandronum-vscode.format.braceStyle`.
 * Any value other than `sameLine` falls back to `nextLine`.
 */
export function readBraceStyle(config: vscode.WorkspaceConfiguration): BraceStyle {
    return config.get<string>('format.braceStyle', 'nextLine') === 'sameLine'
        ? 'sameLine'
        : 'nextLine';
}

/**
 * `zandronum-vscode.format.spaceAfterComma`.
 * Invalid (non-`false`) values fall back to the default `true`.
 */
export function readSpaceAfterComma(config: vscode.WorkspaceConfiguration): boolean {
    return config.get<boolean>('format.spaceAfterComma', true) !== false;
}
