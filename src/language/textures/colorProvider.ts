import * as vscode from 'vscode';
import { loadPlaypal, RgbColor } from '../../tools/playpalReader';

const TRANSLATION_RE = /\bTranslation\b/i;
const QUOTED_STRING_RE = /"([^"]*)"/g;
const PALETTE_IDX_RE = /\b(\d{1,3})\b/g;
const RGB_BRACKET_RE = /(%?)\[(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/g;

/** True when match is inside a desaturated translation (`=%[...]:[...]`). Both RGB triplets are floats 0.0–2.0. */
function isDesatFloatContext(strContent: string, matchIndex: number): boolean {
    return strContent.lastIndexOf('%', matchIndex) >= 0;
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

function clampFloat2(n: number): number {
    return Math.max(0, Math.min(2, n));
}

function formatDesatFloat(n: number): string {
    return String(+n.toFixed(4));
}

function parseRgbBracket(rangeText: string): { hasPercent: boolean; r: number; g: number; b: number } | null {
    const m = /^(%?)\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]$/.exec(rangeText.trim());
    if (!m) { return null; }
    return {
        hasPercent: m[1] === '%',
        r: parseFloat(m[2]),
        g: parseFloat(m[3]),
        b: parseFloat(m[4])
    };
}

/** VS Code Color is 0–1; ZDoom desat floats are 0–2. Linear map both ways. */
function desatFloatToColorChannel(v: number): number {
    return clamp01(v / 2);
}

function colorChannelToDesatFloat(c: number): number {
    return clampFloat2(c * 2);
}

function colorMatchesDesatFloats(color: vscode.Color, r: number, g: number, b: number): boolean {
    const eps = 0.002;
    return Math.abs(color.red - desatFloatToColorChannel(r)) < eps
        && Math.abs(color.green - desatFloatToColorChannel(g)) < eps
        && Math.abs(color.blue - desatFloatToColorChannel(b)) < eps;
}

function colorToDesatFloats(color: vscode.Color): { r: number; g: number; b: number } {
    return {
        r: colorChannelToDesatFloat(color.red),
        g: colorChannelToDesatFloat(color.green),
        b: colorChannelToDesatFloat(color.blue)
    };
}

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
                            const hasPercentPrefix = rgbMatch[1] === '%';
                            const floatMode = hasPercentPrefix || isDesatFloatContext(strContent, rgbMatch.index);
                            const rv = parseFloat(rgbMatch[2]);
                            const gv = parseFloat(rgbMatch[3]);
                            const bv = parseFloat(rgbMatch[4]);
                            let r: number, g: number, b: number;
                            if (floatMode) {
                                // ZDoom desat floats 0–2 ↔ VS Code Color 0–1 via /2 (full range round-trip)
                                if (rv < 0 || rv > 2 || gv < 0 || gv > 2 || bv < 0 || bv > 2) { continue; }
                                r = desatFloatToColorChannel(rv);
                                g = desatFloatToColorChannel(gv);
                                b = desatFloatToColorChannel(bv);
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
                const lineText = ctx.document.lineAt(ctx.range.start.line).text;
                const quoteStart = lineText.lastIndexOf('"', ctx.range.start.character);
                const quoteEnd = lineText.indexOf('"', ctx.range.end.character);
                const quoted = quoteStart >= 0 && quoteEnd > quoteStart
                    ? lineText.substring(quoteStart + 1, quoteEnd)
                    : lineText;
                const idxInQuoted = quoteStart >= 0
                    ? ctx.range.start.character - quoteStart - 1
                    : ctx.range.start.character;
                const floatMode = isDesatFloatContext(quoted, Math.max(0, idxInQuoted));

                if (/^%\[/.test(rangeText) || (floatMode && /^\[/.test(rangeText))) {
                    const parsed = parseRgbBracket(rangeText);
                    const hasPct = /^%\[/.test(rangeText);
                    let label: string;
                    let mapped: { r: number; g: number; b: number };
                    if (parsed && colorMatchesDesatFloats(color, parsed.r, parsed.g, parsed.b)) {
                        mapped = { r: parsed.r, g: parsed.g, b: parsed.b };
                    } else {
                        mapped = colorToDesatFloats(color);
                    }
                    label = `${hasPct ? '%' : ''}[${formatDesatFloat(mapped.r)},${formatDesatFloat(mapped.g)},${formatDesatFloat(mapped.b)}]`;
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
