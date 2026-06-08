import * as vscode from 'vscode';
import { loadPlaypal } from '../../tools/playpalReader';

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
                            if (r < 0 || r > 1 || g < 0 || g > 1 || b < 0 || b > 1) {
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
                            ? new vscode.Color(r, g, b, 1)
                            : new vscode.Color(r / 255, g / 255, b / 255, 1);

                        colors.push(new vscode.ColorInformation(range, color));
                    }
                }

                return colors;
            },

            provideColorPresentations(color, context) {
                const rangeText = context.document.getText(context.range);
                if (/^\d{1,3}$/.test(rangeText)) {
                    return [new vscode.ColorPresentation(rangeText)];
                }

                const lineText = context.document.lineAt(context.range.start.line).text;
                const floatMode = isFloatContext(lineText, context.range.start.character);

                if (floatMode) {
                    const rf = +(color.red.toFixed(3));
                    const gf = +(color.green.toFixed(3));
                    const bf = +(color.blue.toFixed(3));
                    const label = `[${rf},${gf},${bf}]`;
                    const presentation = new vscode.ColorPresentation(label);
                    presentation.textEdit = vscode.TextEdit.replace(context.range, label);
                    return [presentation];
                }

                const r = Math.round(color.red * 255);
                const g = Math.round(color.green * 255);
                const b = Math.round(color.blue * 255);
                const label = `[${r},${g},${b}]`;
                const presentation = new vscode.ColorPresentation(label);
                presentation.textEdit = vscode.TextEdit.replace(context.range, label);
                return [presentation];
            }
        }
    );

    context.subscriptions.push(provider);
}
