import * as vscode from 'vscode';
import { PackageBuildWarning } from './types';

let output: vscode.OutputChannel | undefined;

export function getBaseResourceOutput(): vscode.OutputChannel {
    if (!output) {
        output = vscode.window.createOutputChannel('Zandronum Base Resources');
    }
    return output;
}

export function reportBaseResourceWarnings(
    warnings: readonly PackageBuildWarning[],
    options?: { notify?: boolean }
): void {
    if (warnings.length === 0) { return; }
    const channel = getBaseResourceOutput();
    channel.appendLine(`[${new Date().toISOString()}] Base resource warnings:`);
    for (const w of warnings) {
        channel.appendLine(`  ${w.path}: ${w.message}`);
    }
    if (options?.notify !== false) {
        vscode.window.showWarningMessage(
            `Base resources: ${warnings[0].message}` +
            (warnings.length > 1 ? ` (+${warnings.length - 1} more — see Output)` : '')
        );
    }
}
