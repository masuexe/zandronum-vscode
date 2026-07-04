interface VariableContext {
    workspaceFolder: string;
    buildOutput: string;
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
