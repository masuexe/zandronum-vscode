import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { resolveVariables, parseArgs } from '../shared/variables';
import { getBuildOutputPath } from '../shared/buildOutput';
import { buildPK3, buildProject } from '../tools/build';
import { compileAllAndBuild } from '../tools/compileAcs';

export interface RunConfigOverride {
    program?: string;
    preArgs?: string | string[];
    postArgs?: string | string[];
}

export interface RunConfig extends RunConfigOverride {
    name: string;
    windows?: RunConfigOverride;
    linux?: RunConfigOverride;
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

export function buildRunArguments(
    preArgs: string[],
    postArgs: string[],
    buildOutput: string
): string[] {
    return [...preArgs, '-file', buildOutput, ...postArgs];
}

export function resolvePlatformRunConfig(
    config: RunConfig,
    platform: NodeJS.Platform
): RunConfig {
    const override = platform === 'win32'
        ? config.windows
        : platform === 'linux'
            ? config.linux
            : undefined;
    if (!override) { return config; }
    return { ...config, ...override, name: config.name };
}

export function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value);
}

export function isWslWindowsExecutable(
    program: string,
    platform: NodeJS.Platform,
    release: string,
    wslDistroName?: string
): boolean {
    const isWsl = platform === 'linux'
        && (Boolean(wslDistroName) || release.toLowerCase().includes('microsoft'));
    return isWsl && program.toLowerCase().endsWith('.exe');
}

export function convertWslPathArguments(
    args: readonly string[],
    convertPath: (value: string) => string
): string[] {
    return args.map(arg => path.posix.isAbsolute(arg) ? convertPath(arg) : arg);
}

function wslPathToWindows(value: string): string {
    return cp.execFileSync('wslpath', ['-w', value], { encoding: 'utf8' }).trim();
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

function runConfigToTerminal(config: RunConfig, terminalName: string): boolean {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const buildOutput = getBuildOutputPath();
    const ctx = { workspaceFolder, buildOutput };
    const platformConfig = resolvePlatformRunConfig(config, process.platform);

    const program = resolveVariables(getProgram(platformConfig), ctx);
    const preArgs = parseArgs(platformConfig.preArgs ?? []).map(a => resolveVariables(a, ctx));
    const postArgs = parseArgs(platformConfig.postArgs ?? []).map(a => resolveVariables(a, ctx));
    let args = buildRunArguments(preArgs, postArgs, buildOutput);

    if (process.platform === 'linux' && isWindowsAbsolutePath(program)) {
        vscode.window.showErrorMessage(
            `Cannot run Windows program path "${program}" on Linux. ` +
            'Configure linux.program in .vscode/zandronum.json with a native Linux Zandronum executable.'
        );
        return false;
    }

    if (isWslWindowsExecutable(
        program,
        process.platform,
        os.release(),
        process.env.WSL_DISTRO_NAME
    )) {
        try {
            args = convertWslPathArguments(args, wslPathToWindows);
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to convert WSL paths for Windows Zandronum: ${String(err)}`
            );
            return false;
        }
    }

    const existing = vscode.window.terminals.find(t => t.name === terminalName);
    if (existing) { existing.dispose(); }
    try {
        const terminal = vscode.window.createTerminal({
            name: terminalName,
            shellPath: program,
            shellArgs: args,
            cwd: workspaceFolder || undefined,
        });
        terminal.show();
        return true;
    } catch (err) {
        vscode.window.showErrorMessage(
            `Failed to run Zandronum executable "${program}": ${String(err)}`
        );
        return false;
    }
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
    if (!runConfigToTerminal(resolved.host, TERMINAL_HOST)) { return; }
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
