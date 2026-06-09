import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface RgbColor {
    r: number;
    g: number;
    b: number;
}

let paletteCache: RgbColor[] | null | undefined;
let cacheKey: string | undefined;

export async function loadPlaypal(): Promise<RgbColor[] | null> {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    const playpalPath = config.get<string>('playpalPath') || '';
    const key = playpalPath || '_workspace';

    if (paletteCache !== undefined && cacheKey === key) {
        return paletteCache;
    }
    cacheKey = key;

    if (playpalPath) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        const resolved = path.isAbsolute(playpalPath)
            ? playpalPath
            : path.resolve(root, playpalPath);

        if (fs.existsSync(resolved)) {
            const stat = fs.statSync(resolved);
            if (stat.isFile()) {
                const data = await readPlaypalFile(vscode.Uri.file(resolved));
                if (data) {
                    paletteCache = data;
                    return data;
                }
            } else if (stat.isDirectory()) {
                const files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(resolved, 'PLAYPAL*')
                );
                if (files.length > 0) {
                    const data = await readPlaypalFile(files[0]);
                    if (data) {
                        paletteCache = data;
                        return data;
                    }
                }
            }
        }
    }

    const files = await vscode.workspace.findFiles('**/PLAYPAL*');
    if (files.length === 0) {
        paletteCache = null;
        return null;
    }

    const data = await readPlaypalFile(files[0]);
    paletteCache = data;
    return data;
}

async function readPlaypalFile(uri: vscode.Uri): Promise<RgbColor[] | null> {
    try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (data.length < 768) {
            return null;
        }

        const palette: RgbColor[] = [];
        for (let i = 0; i < 256; i++) {
            palette.push({
                r: data[i * 3],
                g: data[i * 3 + 1],
                b: data[i * 3 + 2]
            });
        }
        return palette;
    } catch {
        return null;
    }
}
