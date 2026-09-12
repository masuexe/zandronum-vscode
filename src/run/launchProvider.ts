import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { resolveVariables, parseArgs, expandUserPath } from '../shared/variables';
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
const LAST_RUN_KEY = 'zandronum.lastRun';

export interface RememberedRun {
    kind: 'config' | 'compound';
    name: string;
}

let workspaceState: vscode.Memento | undefined;

export function initLaunchProvider(context: vscode.ExtensionContext): void {
    workspaceState = context.workspaceState;
}

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

/**
 * Resolve `${...}` variables and expand a leading `~` in one configured value.
 * VS Code does not expand `~` in settings, so a value such as
 * `~/appfiles/zandronum/zandronum` must be expanded here or the terminal
 * launch fails with "Path to shell executable ... does not exist".
 */
export function resolveLaunchValue(
    value: string,
    workspaceFolder: string,
    buildOutput: string
): string {
    return expandUserPath(resolveVariables(value, { workspaceFolder, buildOutput }));
}

/**
 * Resolve a configuration's `preArgs` / `postArgs`, expanding `${...}`
 * variables and a leading `~`. Arguments are passed straight to the executable
 * without a shell, so `~/wads/doom2.wad` would otherwise stay literal.
 */
export function resolveRunArguments(
    raw: string | string[] | undefined,
    workspaceFolder: string,
    buildOutput: string
): string[] {
    return parseArgs(raw ?? []).map(a => resolveLaunchValue(a, workspaceFolder, buildOutput));
}

function runConfigToTerminal(config: RunConfig, terminalName: string): boolean {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const buildOutput = getBuildOutputPath();
    const platformConfig = resolvePlatformRunConfig(config, process.platform);

    const program = resolveLaunchValue(getProgram(platformConfig), workspaceFolder, buildOutput);
    const preArgs = resolveRunArguments(platformConfig.preArgs, workspaceFolder, buildOutput);
    const postArgs = resolveRunArguments(platformConfig.postArgs, workspaceFolder, buildOutput);
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

export type LaunchPick =
    | { kind: 'config'; config: RunConfig; label: string; detail?: string }
    | { kind: 'compound'; compound: RunCompound; label: string; detail: string };

type ResolvedLaunch =
    | { status: 'default' }
    | { status: 'ready'; pick: LaunchPick; configurations: RunConfig[] }
    | { status: 'cancelled' };

export function pickToRemembered(pick: LaunchPick): RememberedRun {
    if (pick.kind === 'config') {
        return { kind: 'config', name: pick.config.name };
    }
    return { kind: 'compound', name: pick.compound.name };
}

export function resolveRememberedPick(
    picks: readonly LaunchPick[],
    remembered: RememberedRun | undefined
): LaunchPick | undefined {
    if (!remembered) { return undefined; }
    return picks.find(p => {
        if (remembered.kind === 'config' && p.kind === 'config') {
            return p.config.name === remembered.name;
        }
        if (remembered.kind === 'compound' && p.kind === 'compound') {
            return p.compound.name === remembered.name;
        }
        return false;
    });
}

function getRememberedRun(): RememberedRun | undefined {
    return workspaceState?.get<RememberedRun>(LAST_RUN_KEY);
}

function setRememberedRun(remembered: RememberedRun): void {
    void workspaceState?.update(LAST_RUN_KEY, remembered);
}

export function buildLaunchPicks(file: LoadedRunFile): LaunchPick[] {
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

async function promptLaunchPick(
    picks: readonly LaunchPick[],
    active?: LaunchPick
): Promise<LaunchPick | undefined> {
    const items = picks.map(p => ({
        label: p.label,
        detail: p === active
            ? [p.detail, '(last used)'].filter(Boolean).join(' · ')
            : p.detail,
        pick: p,
    }));
    if (active) {
        items.sort((a, b) => (a.pick === active ? -1 : b.pick === active ? 1 : 0));
    }
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select run configuration',
    });
    return selected?.pick;
}

async function resolveLaunchTarget(forcePrompt: boolean): Promise<ResolvedLaunch> {
    const file = await loadRunFile();
    const picks = buildLaunchPicks(file);

    if (picks.length === 0) {
        return { status: 'default' };
    }

    if (picks.length === 1 && !forcePrompt) {
        const pick = picks[0];
        setRememberedRun(pickToRemembered(pick));
        return { status: 'ready', pick, configurations: file.configurations };
    }

    const remembered = getRememberedRun();
    const matched = resolveRememberedPick(picks, remembered);
    if (!forcePrompt && matched) {
        return { status: 'ready', pick: matched, configurations: file.configurations };
    }

    const selected = await promptLaunchPick(picks, matched);
    if (!selected) {
        return { status: 'cancelled' };
    }
    setRememberedRun(pickToRemembered(selected));
    return { status: 'ready', pick: selected, configurations: file.configurations };
}

async function launchResolved(resolved: ResolvedLaunch): Promise<void> {
    if (resolved.status === 'cancelled') { return; }
    if (resolved.status === 'default') {
        runConfigToTerminal({ name: 'Zandronum' }, TERMINAL_SINGLE);
        return;
    }
    await launchPick(resolved.pick, resolved.configurations);
}

export async function selectRunConfiguration(): Promise<void> {
    const file = await loadRunFile();
    const picks = buildLaunchPicks(file);
    if (picks.length === 0) {
        vscode.window.showInformationMessage(
            'No run configurations found. Add configurations to .vscode/zandronum.json.'
        );
        return;
    }
    const remembered = getRememberedRun();
    const matched = resolveRememberedPick(picks, remembered);
    const selected = await promptLaunchPick(picks, matched);
    if (!selected) { return; }
    setRememberedRun(pickToRemembered(selected));
    vscode.window.showInformationMessage(`Run configuration set to "${selected.label}".`);
}

export async function runZandronum(): Promise<void> {
    const resolved = await resolveLaunchTarget(false);
    await launchResolved(resolved);
}

/** Build Project (ACS if configured + PK3), then launch only on success. */
export async function runProject(): Promise<void> {
    const resolved = await resolveLaunchTarget(false);
    if (resolved.status === 'cancelled') { return; }

    const saved = await vscode.workspace.saveAll(false);
    if (!saved) {
        vscode.window.showErrorMessage('Run cancelled: save workspace files before building.');
        return;
    }
    const ok = await buildProject({ skipUnchangedPk3: true });
    if (!ok) { return; }
    await launchResolved(resolved);
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
