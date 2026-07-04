import * as vscode from 'vscode';
import * as path from 'path';
import { resolveVariables, parseArgs } from '../shared/variables';
import { getBuildOutputPath } from '../shared/buildOutput';

interface RunConfig {
    name: string;
    program?: string;
    preArgs?: string | string[];
    postArgs?: string | string[];
}

interface RunConfigFile {
    configurations?: RunConfig[];
}

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

async function loadConfigs(): Promise<RunConfig[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return []; }
    const configPath = vscode.Uri.joinPath(folder.uri, '.vscode', 'zandronum.json');
    try {
        const data = await vscode.workspace.fs.readFile(configPath);
        const parsed = JSON.parse(Buffer.from(data).toString('utf-8')) as RunConfigFile;
        return parsed.configurations ?? [];
    } catch {
        return [];
    }
}

function getProgram(config: RunConfig): string {
    if (config.program) { return config.program; }
    const settings = vscode.workspace.getConfiguration('zandronum-vscode');
    return settings.get<string>('zandronumPath') || 'zandronum';
}

function runConfig(config: RunConfig): void {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const buildOutput = getBuildOutputPath();
    const ctx = { workspaceFolder, buildOutput };

    const program = resolveVariables(getProgram(config), ctx);
    const preArgs = parseArgs(config.preArgs ?? []).map(a => resolveVariables(a, ctx));
    const postArgs = parseArgs(config.postArgs ?? []).map(a => resolveVariables(a, ctx));

    const command = buildCommandLine(program, preArgs, postArgs, buildOutput);

    const terminal = vscode.window.createTerminal('Zandronum');
    terminal.sendText(`& ${command}`);
    terminal.show();
}

export async function runZandronum(): Promise<void> {
    const configs = await loadConfigs();

    if (configs.length === 0) {
        runConfig({ name: 'Zandronum' });
        return;
    }

    if (configs.length === 1) {
        runConfig(configs[0]);
        return;
    }

    const picked = await vscode.window.showQuickPick(
        configs.map(c => c.name),
        { placeHolder: 'Select run configuration' }
    );
    const config = configs.find(c => c.name === picked);
    if (config) { runConfig(config); }
}
