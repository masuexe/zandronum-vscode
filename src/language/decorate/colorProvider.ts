import * as vscode from 'vscode';
import { loadPlaypal, RgbColor } from '../../tools/playpalReader';

const TRANSLATION_LINE_RE = /\bTranslation\b/i;
const COLOR_VALUE_RE = /(%)?\[(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]|\b(\d{1,3})\b/g;

function isFloatContext(lineText: string, matchIndex: number): boolean {
    let quotePos = -1;
    for (let i = matchIndex - 1; i >= 0; i--) {
        if (lineText[i] === '"') {
            quotePos = i;
            break;
        }
    }
    const segment = quotePos >= 0
        ? lineText.substring(quotePos, matchIndex)
        : lineText.substring(0, matchIndex);
    return segment.includes('%');
}

function isPaletteMatch(match: RegExpExecArray): boolean {
    return match[5] !== undefined;
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

export function registerColorProvider(context: vscode.ExtensionContext) {
    const provider = vscode.languages.registerColorProvider(
        [{ language: 'decorate' }],
        {
            async provideDocumentColors(document, token) {
                const colors: vscode.ColorInformation[] = [];
                const palette = await loadPlaypal();

                for (let i = 0; i < document.lineCount; i++) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    const line = document.lineAt(i);
                    if (!TRANSLATION_LINE_RE.test(line.text)) {
                        continue;
                    }

                    let match: RegExpExecArray | null;
                    COLOR_VALUE_RE.lastIndex = 0;
                    while ((match = COLOR_VALUE_RE.exec(line.text)) !== null) {
                        if (isPaletteMatch(match)) {
                            if (!palette) {
                                continue;
                            }
                            const idx = parseInt(match[5], 10);
                            if (idx > 255) {
                                continue;
                            }
                            const pal = palette[idx];
                            const color = new vscode.Color(pal.r / 255, pal.g / 255, pal.b / 255, 1);
                            const startPos = new vscode.Position(i, match.index);
                            const endPos = new vscode.Position(i, match.index + match[0].length);
                            const range = new vscode.Range(startPos, endPos);
                            colors.push(new vscode.ColorInformation(range, color));
                            continue;
                        }

                        const r = parseFloat(match[2]);
                        const g = parseFloat(match[3]);
                        const b = parseFloat(match[4]);

                        if (isNaN(r) || isNaN(g) || isNaN(b)) {
                            continue;
                        }

                        const floatMode = isFloatContext(line.text, match.index);

                        if (floatMode) {
                            if (r < 0 || r > 2 || g < 0 || g > 2 || b < 0 || b > 2) {
                                continue;
                            }
                        } else {
                            if (r > 255 || g > 255 || b > 255) {
                                continue;
                            }
                        }

                        const hasPercent = match[1] === '%';
                        const colorStart = match.index + (hasPercent ? 1 : 0);
                        const startPos = new vscode.Position(i, colorStart);
                        const endPos = new vscode.Position(i, match.index + match[0].length);
                        const range = new vscode.Range(startPos, endPos);
                        const color = floatMode
                            ? new vscode.Color(Math.min(r / 2, 1), Math.min(g / 2, 1), Math.min(b / 2, 1), 1)
                            : new vscode.Color(r / 255, g / 255, b / 255, 1);

                        colors.push(new vscode.ColorInformation(range, color));
                    }
                }

                return colors;
            },

            async provideColorPresentations(color, context) {
                const palette = await loadPlaypal();
                const rangeText = context.document.getText(context.range);

                if (/^\d{1,3}$/.test(rangeText)) {
                    if (!palette) {
                        return [new vscode.ColorPresentation(rangeText)];
                    }

                    const ri = Math.round(color.red * 255);
                    const gi = Math.round(color.green * 255);
                    const bi = Math.round(color.blue * 255);
                    const p1 = new vscode.ColorPresentation(`[${ri},${gi},${bi}]`);
                    p1.textEdit = vscode.TextEdit.replace(context.range, `[${ri},${gi},${bi}]`);

                    const nearestIdx = findNearestPaletteIndex(color, palette);
                    const p2 = new vscode.ColorPresentation(String(nearestIdx));
                    p2.textEdit = vscode.TextEdit.replace(context.range, String(nearestIdx));

                    return [p1, p2];
                }

                const lineText = context.document.lineAt(context.range.start.line).text;
                const floatMode = isFloatContext(lineText, context.range.start.character);

                if (floatMode) {
                    const m = /^\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]$/.exec(rangeText.trim());
                    const orig = m
                        ? { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) }
                        : null;
                    const eps = 0.002;
                    let fr: number, fg: number, fb: number;
                    if (orig
                        && Math.abs(color.red - Math.min(orig.r / 2, 1)) < eps
                        && Math.abs(color.green - Math.min(orig.g / 2, 1)) < eps
                        && Math.abs(color.blue - Math.min(orig.b / 2, 1)) < eps) {
                        fr = orig.r; fg = orig.g; fb = orig.b;
                    } else {
                        fr = Math.max(0, Math.min(2, color.red * 2));
                        fg = Math.max(0, Math.min(2, color.green * 2));
                        fb = Math.max(0, Math.min(2, color.blue * 2));
                    }
                    const label = `[${+fr.toFixed(4)},${+fg.toFixed(4)},${+fb.toFixed(4)}]`;
                    const p1 = new vscode.ColorPresentation(label);
                    p1.textEdit = vscode.TextEdit.replace(context.range, label);
                    return [p1];
                }

                const r = Math.round(color.red * 255);
                const g = Math.round(color.green * 255);
                const b = Math.round(color.blue * 255);
                const label = `[${r},${g},${b}]`;
                const p1 = new vscode.ColorPresentation(label);
                p1.textEdit = vscode.TextEdit.replace(context.range, label);

                const pres = [p1];

                if (palette) {
                    const idx = findNearestPaletteIndex(color, palette);
                    const p2 = new vscode.ColorPresentation(String(idx));
                    p2.textEdit = vscode.TextEdit.replace(context.range, String(idx));
                    pres.push(p2);
                }

                return pres;
            }
        }
    );

    context.subscriptions.push(provider);
}
