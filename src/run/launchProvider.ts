import * as vscode from 'vscode';
import { resolveVariables, parseArgs } from '../shared/variables';
import { getBuildOutputPath } from '../shared/buildOutput';
import { buildPK3, buildProject } from '../tools/build';
import { compileAllAndBuild } from '../tools/compileAcs';

export interface RunConfig {
    name: string;
    program?: string;
    preArgs?: string | string[];
    postArgs?: string | string[];
}

export interface RunCompound {
    name: string;
    /** Exactly two configuration names: [host, client]. */
    configurations: string[];
}

export interface RunConfigFile {
    configurations?: RunConfig[];
    compounds?: RunCompound[];
}

export interface LoadedRunFile {
    configurations: RunConfig[];
    compounds: RunCompound[];
}

const HOST_CLIENT_DELAY_MS = 2000;
const TERMINAL_SINGLE = 'Zandronum';
const TERMINAL_HOST = 'Zandronum Host';
const TERMINAL_CLIENT = 'Zandronum Client';

function buildCommandLine(
    program: string,
    preArgs: string[],
    postArgs: string[],
    buildOutput: string
): string {
    const allArgs = [...preArgs, '-file', buildOutput, ...postArgs];
    const quoted = allArgs.map(a => a.includes(' ') ? `"${a}"` : a);
    return `"${program}" ${quoted.join(' ')}`;
}

/**
 * Resolve a compound to host + client configs.
 * Requires exactly two names that each match a configuration.
 */
export function resolveCompound(
    compound: RunCompound,
    configurations: readonly RunConfig[]
): { ok: true; host: RunConfig; client: RunConfig } | { ok: false; error: string } {
    const names = compound.configurations;
    if (!Array.isArray(names) || names.length !== 2) {
        return {
            ok: false,
            error: `Compound "${compound.name}" must list exactly 2 configurations (host, then client).`,
        };
    }
    const [hostName, clientName] = names;
    if (typeof hostName !== 'string' || typeof clientName !== 'string'
        || !hostName.trim() || !clientName.trim()) {
        return {
            ok: false,
            error: `Compound "${compound.name}" has invalid configuration names.`,
        };
    }
    const host = configurations.find(c => c.name === hostName);
    const client = configurations.find(c => c.name === clientName);
    if (!host) {
        return {
            ok: false,
            error: `Compound "${compound.name}": configuration "${hostName}" not found.`,
        };
    }
    if (!client) {
        return {
            ok: false,
            error: `Compound "${compound.name}": configuration "${clientName}" not found.`,
        };
    }
    return { ok: true, host, client };
}

async function loadRunFile(): Promise<LoadedRunFile> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return { configurations: [], compounds: [] };
    }
    const configPath = vscode.Uri.joinPath(folder.uri, '.vscode', 'zandronum.json');
    try {
        const data = await vscode.workspace.fs.readFile(configPath);
        const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as RunConfigFile;
        return {
            configurations: parsed.configurations ?? [],
            compounds: parsed.compounds ?? [],
        };
    } catch {
        return { configurations: [], compounds: [] };
    }
}

function getProgram(config: RunConfig): string {
    if (config.program) { return config.program; }
    const settings = vscode.workspace.getConfiguration('zandronum-vscode');
    return settings.get<string>('zandronumPath') || 'zandronum';
}

function runConfigToTerminal(config: RunConfig, terminalName: string): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const buildOutput = getBuildOutputPath();
    const ctx = { workspaceFolder, buildOutput };

    const program = resolveVariables(getProgram(config), ctx);
    const preArgs = parseArgs(config.preArgs ?? []).map(a => resolveVariables(a, ctx));
    const postArgs = parseArgs(config.postArgs ?? []).map(a => resolveVariables(a, ctx));

    const command = buildCommandLine(program, preArgs, postArgs, buildOutput);

    const existing = vscode.window.terminals.find(t => t.name === terminalName);
    if (existing) { existing.dispose(); }
    const terminal = vscode.window.createTerminal(terminalName);
    terminal.sendText(`& ${command}`);
    terminal.show();
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runCompound(compound: RunCompound, configurations: RunConfig[]): Promise<void> {
    const resolved = resolveCompound(compound, configurations);
    if (!resolved.ok) {
        vscode.window.showErrorMessage(resolved.error);
        return;
    }
    runConfigToTerminal(resolved.host, TERMINAL_HOST);
    await delay(HOST_CLIENT_DELAY_MS);
    runConfigToTerminal(resolved.client, TERMINAL_CLIENT);
}

type LaunchPick =
    | { kind: 'config'; config: RunConfig; label: string; detail?: string }
    | { kind: 'compound'; compound: RunCompound; label: string; detail: string };

function buildLaunchPicks(file: LoadedRunFile): LaunchPick[] {
    const picks: LaunchPick[] = [];
    for (const config of file.configurations) {
        picks.push({ kind: 'config', config, label: config.name });
    }
    for (const compound of file.compounds) {
        picks.push({
            kind: 'compound',
            compound,
            label: compound.name,
            detail: 'Host + Client',
        });
    }
    return picks;
}

async function launchPick(pick: LaunchPick, configurations: RunConfig[]): Promise<void> {
    if (pick.kind === 'config') {
        runConfigToTerminal(pick.config, TERMINAL_SINGLE);
        return;
    }
    await runCompound(pick.compound, configurations);
}

export async function runZandronum(): Promise<void> {
    const file = await loadRunFile();
    const picks = buildLaunchPicks(file);

    if (picks.length === 0) {
        runConfigToTerminal({ name: 'Zandronum' }, TERMINAL_SINGLE);
        return;
    }

    if (picks.length === 1) {
        await launchPick(picks[0], file.configurations);
        return;
    }

    const selected = await vscode.window.showQuickPick(
        picks.map(p => ({
            label: p.label,
            detail: p.detail,
            pick: p,
        })),
        { placeHolder: 'Select run configuration' }
    );
    if (!selected) { return; }
    await launchPick(selected.pick, file.configurations);
}

/** Build Project (ACS if configured + PK3), then launch only on success. */
export async function runProject(): Promise<void> {
    const ok = await buildProject();
    if (!ok) { return; }
    await runZandronum();
}

/** @deprecated Prefer Run Project. Packages PK3 only (no ACS), then launches. */
export async function buildAndRunZandronum(): Promise<void> {
    const ok = await buildPK3();
    if (!ok) { return; }
    await runZandronum();
}

/** @deprecated Prefer Run Project. Kept for keybindings. */
export async function compileAllBuildAndRunZandronum(): Promise<void> {
    const ok = await compileAllAndBuild();
    if (!ok) { return; }
    await runZandronum();
}
