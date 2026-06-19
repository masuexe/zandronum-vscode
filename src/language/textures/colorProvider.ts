import * as vscode from 'vscode';
import { loadPlaypal, RgbColor } from '../../tools/playpalReader';

const TRANSLATION_RE = /\bTranslation\b/i;
const QUOTED_STRING_RE = /"([^"]*)"/g;
const PALETTE_IDX_RE = /\b(\d{1,3})\b/g;
const RGB_BRACKET_RE = /(%?)\[(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/g;

function findNearestPaletteIndex(color: vscode.Color, palette: RgbColor[]): number {
    let best = 0;
    let bestDist = Infinity;
    const cr = color.red * 255;
    const cg = color.green * 255;
    const cb = color.blue * 255;
    for (let i = 0; i < palette.length; i++) {
        const dr = cr - palette[i].r;
        const dg = cg - palette[i].g;
        const db = cb - palette[i].b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
}

export function registerTexturesColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'textures' }],
        {
            async provideDocumentColors(document, token) {
                const colors: vscode.ColorInformation[] = [];
                const palette = await loadPlaypal();

                for (let i = 0; i < document.lineCount; i++) {
                    if (token.isCancellationRequested) { break; }
                    const lineText = document.lineAt(i).text;
                    if (!TRANSLATION_RE.test(lineText)) { continue; }

                    const translationIdx = lineText.search(TRANSLATION_RE);
                    const afterTranslation = lineText.substring(translationIdx);

                    QUOTED_STRING_RE.lastIndex = 0;
                    let strMatch: RegExpExecArray | null;
                    while ((strMatch = QUOTED_STRING_RE.exec(afterTranslation)) !== null) {
                        const strContent = strMatch[1];
                        const strStartInLine = translationIdx + strMatch.index + 1;

                        RGB_BRACKET_RE.lastIndex = 0;
                        let rgbMatch: RegExpExecArray | null;
                        const rgbRanges: [number, number][] = [];
                        while ((rgbMatch = RGB_BRACKET_RE.exec(strContent)) !== null) {
                            const isFloat = rgbMatch[1] === '%';
                            const rv = parseFloat(rgbMatch[2]);
                            const gv = parseFloat(rgbMatch[3]);
                            const bv = parseFloat(rgbMatch[4]);
                            let r: number, g: number, b: number;
                            if (isFloat) {
                                r = Math.min(rv, 1.0);
                                g = Math.min(gv, 1.0);
                                b = Math.min(bv, 1.0);
                            } else {
                                if (rv > 255 || gv > 255 || bv > 255) { continue; }
                                r = rv / 255;
                                g = gv / 255;
                                b = bv / 255;
                            }
                            const startCol = strStartInLine + rgbMatch.index;
                            const endCol = startCol + rgbMatch[0].length;
                            rgbRanges.push([rgbMatch.index, rgbMatch.index + rgbMatch[0].length]);
                            const range = new vscode.Range(i, startCol, i, endCol);
                            colors.push(new vscode.ColorInformation(
                                range,
                                new vscode.Color(r, g, b, 1)
                            ));
                        }

                        if (!palette) { continue; }

                        PALETTE_IDX_RE.lastIndex = 0;
                        let palMatch: RegExpExecArray | null;
                        while ((palMatch = PALETTE_IDX_RE.exec(strContent)) !== null) {
                            const idx = parseInt(palMatch[1]);
                            if (idx > 255) { continue; }
                            const matchStart = palMatch.index;
                            const matchEnd = matchStart + palMatch[0].length;
                            let insideRgb = false;
                            for (const [rs, re] of rgbRanges) {
                                if (matchStart >= rs && matchEnd <= re) {
                                    insideRgb = true;
                                    break;
                                }
                            }
                            if (insideRgb) { continue; }
                            const pal = palette[idx];
                            const startCol = strStartInLine + matchStart;
                            const endCol = strStartInLine + matchEnd;
                            const range = new vscode.Range(i, startCol, i, endCol);
                            colors.push(new vscode.ColorInformation(
                                range,
                                new vscode.Color(pal.r / 255, pal.g / 255, pal.b / 255, 1)
                            ));
                        }
                    }
                }

                return colors;
            },

            async provideColorPresentations(color, ctx) {
                const palette = await loadPlaypal();
                const rangeText = ctx.document.getText(ctx.range);

                if (/^%\[/.test(rangeText)) {
                    const rf = +(color.red.toFixed(3));
                    const gf = +(color.green.toFixed(3));
                    const bf = +(color.blue.toFixed(3));
                    const label = `%[${rf},${gf},${bf}]`;
                    const p = new vscode.ColorPresentation(label);
                    p.textEdit = vscode.TextEdit.replace(ctx.range, label);
                    return [p];
                }

                if (/^\[/.test(rangeText)) {
                    const r = Math.round(color.red * 255);
                    const g = Math.round(color.green * 255);
                    const b = Math.round(color.blue * 255);
                    const label = `[${r},${g},${b}]`;
                    const p = new vscode.ColorPresentation(label);
                    p.textEdit = vscode.TextEdit.replace(ctx.range, label);
                    return [p];
                }

                const r = Math.round(color.red * 255);
                const g = Math.round(color.green * 255);
                const b = Math.round(color.blue * 255);

                const pres: vscode.ColorPresentation[] = [];

                const p1 = new vscode.ColorPresentation(`[${r},${g},${b}]`);
                p1.textEdit = vscode.TextEdit.replace(ctx.range, `[${r},${g},${b}]`);
                pres.push(p1);

                if (palette) {
                    const idx = findNearestPaletteIndex(color, palette);
                    const p2 = new vscode.ColorPresentation(String(idx));
                    p2.textEdit = vscode.TextEdit.replace(ctx.range, String(idx));
                    pres.push(p2);
                }

                return pres;
            }
        }
    );

    context.subscriptions.push(provider);
}
