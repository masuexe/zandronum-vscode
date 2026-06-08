import * as vscode from 'vscode';

export interface RgbColor {
    r: number;
    g: number;
    b: number;
}

let paletteCache: RgbColor[] | null | undefined;

export async function loadPlaypal(): Promise<RgbColor[] | null> {
    if (paletteCache !== undefined) {
        return paletteCache;
    }

    const files = await vscode.workspace.findFiles('**/PLAYPAL*');
    if (files.length === 0) {
        paletteCache = null;
        return null;
    }

    try {
        const data = await vscode.workspace.fs.readFile(files[0]);
        if (data.length < 768) {
            paletteCache = null;
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
        paletteCache = palette;
        return palette;
    } catch {
        paletteCache = null;
        return null;
    }
}
