import * as os from 'os';
import * as path from 'path';

interface VariableContext {
    workspaceFolder: string;
    buildOutput: string;
}

/**
 * Expand a leading `~` (and `~/` / `~\`) to the user's home directory.
 * VS Code does not expand `~` in extension settings, and the terminal pty host
 * treats it as a literal path segment, so configured executables must be
 * expanded before use.
 */
export function expandUserPath(value: string): string {
    if (value === '~') { return os.homedir(); }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return path.join(os.homedir(), value.slice(2));
    }
    return value;
}

export function resolveVariables(text: string, ctx: VariableContext): string {
    return text
        .replace(/\$\{workspaceFolder\}/g, ctx.workspaceFolder)
        .replace(/\$\{buildOutput\}/g, ctx.buildOutput)
        .replace(/\$\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? '');
}

export function parseArgs(raw: string | string[]): string[] {
    if (Array.isArray(raw)) { return raw; }
    const parts = raw.match(/"([^"]*)"|'([^']*)'|(\S+)/g) ?? [];
    return parts.map(p => p.replace(/^["']|["']$/g, ''));
}
