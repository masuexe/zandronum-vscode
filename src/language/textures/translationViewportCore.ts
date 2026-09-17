import * as vscode from 'vscode';
import {
    TranslationPropertySpan,
    collectTranslationColorsForSpan,
} from '../shared/translationColorScan';
import { RgbColor } from '../../tools/playpalReader';

/** Stable document-aligned blocks shared by visible queries and preload. */
export const COLOR_BLOCK_LINES = 32;
export const PRELOAD_COLOR_BUDGET = 5000;
/** Max custom swatches applied to one editor at a time (visible ranges only). */
export const VIEWPORT_RENDER_COLOR_BUDGET = 2500;
export const COLOR_CACHE_MAX_COLORS = 50000;
export const COLOR_CACHE_MAX_ENTRIES = 128;
export const VISIBLE_FLUSH_MS = 16;
export const PRELOAD_FLUSH_MS = 80;
export const PRELOAD_SCREEN_COUNT = 2;
export const MIN_SCREEN_LINES = 40;

export function translationPreviewMode(value: unknown): 'native' | 'viewport' {
    return value === 'viewport' ? 'viewport' : 'native';
}

export function isAsyncResultCurrent(args: {
    requestId: number;
    currentRequestId: number;
    documentVersion: number;
    currentVersion: number;
    paletteGeneration: number;
    currentPaletteGeneration: number;
}): boolean {
    return args.requestId === args.currentRequestId
        && args.documentVersion === args.currentVersion
        && args.paletteGeneration === args.currentPaletteGeneration;
}

export function preloadLinePad(visibleLineHeight: number, screens = PRELOAD_SCREEN_COUNT): number {
    return Math.max(MIN_SCREEN_LINES, visibleLineHeight) * screens;
}

export function expandRangesWithPad(
    ranges: readonly vscode.Range[],
    padLines: number,
    lineCount: number
): vscode.Range[] {
    if (ranges.length === 0 || lineCount <= 0) {
        return [];
    }
    const last = lineCount - 1;
    return ranges.map(range => {
        const start = Math.max(0, range.start.line - padLines);
        const end = Math.min(last, range.end.line + padLines);
        return new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
    });
}

export function mergeLineWindows(ranges: readonly vscode.Range[]): { fromLine: number; toLine: number }[] {
    if (ranges.length === 0) {
        return [];
    }
    const sorted = [...ranges].sort((a, b) => a.start.line - b.start.line);
    const merged: { fromLine: number; toLine: number }[] = [];
    for (const range of sorted) {
        const fromLine = range.start.line;
        const toLine = range.end.line;
        const prev = merged[merged.length - 1];
        if (!prev || fromLine > prev.toLine + 1) {
            merged.push({ fromLine, toLine });
        } else if (toLine > prev.toLine) {
            prev.toLine = toLine;
        }
    }
    return merged;
}

export function colorIntersectsVisible(
    color: vscode.ColorInformation,
    visible: readonly vscode.Range[]
): boolean {
    for (const range of visible) {
        if (color.range.intersection(range)) {
            return true;
        }
    }
    return false;
}

/** Only decorate currently visible colors, capped at `budget`. */
export function selectColorsForDisplay(
    colors: readonly vscode.ColorInformation[],
    visible: readonly vscode.Range[],
    budget: number
): vscode.ColorInformation[] {
    if (budget <= 0) {
        return [];
    }
    const preferred: vscode.ColorInformation[] = [];
    for (const color of colors) {
        if (colorIntersectsVisible(color, visible)) {
            preferred.push(color);
            if (preferred.length >= budget) { break; }
        }
    }
    return preferred;
}

export function cacheChunkKey(
    uri: string,
    version: number,
    paletteGeneration: number,
    span: TranslationPropertySpan,
    fromLine: number,
    toLine: number
): string {
    return `${uri}\0${version}\0${paletteGeneration}\0${span.startLine}\0${span.endLine}\0${fromLine}\0${toLine}`;
}

export class BoundedColorCache {
    private readonly map = new Map<string, vscode.ColorInformation[]>();
    private colorCount = 0;

    constructor(
        private readonly maxEntries = COLOR_CACHE_MAX_ENTRIES,
        private readonly maxColors = COLOR_CACHE_MAX_COLORS
    ) {}

    get(key: string): vscode.ColorInformation[] | undefined {
        const hit = this.map.get(key);
        if (!hit) {
            return undefined;
        }
        this.map.delete(key);
        this.map.set(key, hit);
        return hit;
    }

    set(key: string, value: vscode.ColorInformation[]): void {
        // Reject before touching useful entries (including an existing value for this key).
        if (this.maxEntries <= 0 || value.length > this.maxColors) { return; }
        const existing = this.map.get(key);
        if (existing) {
            this.colorCount -= existing.length;
            this.map.delete(key);
        }
        while (
            this.map.size >= this.maxEntries
            || this.colorCount + value.length > this.maxColors
        ) {
            const oldest = this.map.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            const evicted = this.map.get(oldest);
            this.map.delete(oldest);
            this.colorCount -= evicted?.length ?? 0;
            if (oldest === key) {
                break;
            }
        }
        this.map.set(key, value);
        this.colorCount += value.length;
    }

    invalidateUri(uri: string): void {
        for (const key of [...this.map.keys()]) {
            if (key.startsWith(`${uri}\0`)) {
                const evicted = this.map.get(key);
                this.map.delete(key);
                this.colorCount -= evicted?.length ?? 0;
            }
        }
    }

    clear(): void {
        this.map.clear();
        this.colorCount = 0;
    }

    stats(): { entries: number; colors: number } {
        return { entries: this.map.size, colors: this.colorCount };
    }
}

export function collectColorsForWindows(
    document: vscode.TextDocument,
    spans: readonly TranslationPropertySpan[],
    palette: RgbColor[] | null,
    windows: readonly { fromLine: number; toLine: number }[],
    cache: BoundedColorCache,
    paletteGeneration: number,
    token?: vscode.CancellationToken,
    options: { preload?: boolean; budget?: number } = {}
): WindowColorResult {
    const budget = Math.max(0, options.budget ?? (options.preload ? PRELOAD_COLOR_BUDGET : VIEWPORT_RENDER_COLOR_BUDGET));
    const result: WindowColorResult = { colors: [], complete: true, generatedColors: 0, cacheHits: 0, cacheMisses: 0 };
    const uri = document.uri.toString();
    // Preload fills whole blocks; visible misses scan only requested lines so a dense
    // offscreen prefix cannot consume the visible generation budget.
    const ranges = windows.map(w => new vscode.Range(
        options.preload ? Math.floor(w.fromLine / COLOR_BLOCK_LINES) * COLOR_BLOCK_LINES : w.fromLine, 0,
        options.preload ? Math.min(document.lineCount - 1, (Math.floor(w.toLine / COLOR_BLOCK_LINES) + 1) * COLOR_BLOCK_LINES - 1) : w.toLine, 0
    ));
    for (const window of mergeLineWindows(ranges)) {
        for (const span of overlappingSpans(spans, window.fromLine, window.toLine)) {
            const startBlock = Math.floor(Math.max(span.startLine, window.fromLine) / COLOR_BLOCK_LINES);
            const endBlock = Math.floor(Math.min(span.endLine, window.toLine) / COLOR_BLOCK_LINES);
            for (let block = startBlock; block <= endBlock; block++) {
                if (token?.isCancellationRequested || result.colors.length >= budget) {
                    result.complete = false;
                    return result;
                }
                const blockStart = Math.max(span.startLine, block * COLOR_BLOCK_LINES);
                const blockEnd = Math.min(span.endLine, (block + 1) * COLOR_BLOCK_LINES - 1);
                const fromLine = Math.max(blockStart, window.fromLine);
                const toLine = Math.min(blockEnd, window.toLine);
                const key = cacheChunkKey(uri, document.version, paletteGeneration, span, blockStart, blockEnd);
                let chunk = cache.get(key);
                if (chunk) {
                    result.cacheHits++;
                } else {
                    result.cacheMisses++;
                    const remaining = budget - result.colors.length;
                    chunk = collectTranslationColorsForSpan(document, span, palette, fromLine, toLine, remaining, token);
                    result.generatedColors += chunk.length;
                    // Reaching the exact limit is conservatively partial: never cache a
                    // prefix as a complete block, even on an extremely long single line.
                    const complete = chunk.length < remaining && !token?.isCancellationRequested;
                    if (complete && fromLine === blockStart && toLine === blockEnd) {
                        cache.set(key, chunk);
                    }
                    if (!complete) { result.complete = false; }
                }
                for (const color of chunk) {
                    if (color.range.start.line < fromLine || color.range.start.line > toLine) { continue; }
                    if (result.colors.length >= budget) {
                        result.complete = false;
                        return result;
                    }
                    result.colors.push(color);
                }
            }
        }
    }
    return result;
}

export interface WindowColorResult {
    colors: vscode.ColorInformation[];
    /** False on cancellation or budget exhaustion; partial blocks are never cached. */
    complete: boolean;
    generatedColors: number;
    cacheHits: number;
    cacheMisses: number;
}

function overlappingSpans(
    spans: readonly TranslationPropertySpan[],
    fromLine: number,
    toLine: number
): TranslationPropertySpan[] {
    const out: TranslationPropertySpan[] = [];
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (spans[mid].endLine < fromLine) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    for (let i = lo; i < spans.length; i++) {
        const span = spans[i];
        if (span.startLine > toLine) {
            break;
        }
        out.push(span);
    }
    return out;
}

export function colorToCssRgba(color: vscode.Color): string {
    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    const a = color.alpha;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function colorToHex(color: vscode.Color): string {
    const r = Math.round(color.red * 255).toString(16).padStart(2, '0');
    const g = Math.round(color.green * 255).toString(16).padStart(2, '0');
    const b = Math.round(color.blue * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

export function hexToColor(hex: string): vscode.Color | undefined {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        return undefined;
    }
    const n = parseInt(m[1], 16);
    return new vscode.Color(
        ((n >> 16) & 255) / 255,
        ((n >> 8) & 255) / 255,
        (n & 255) / 255,
        1
    );
}

export interface ViewportPreviewStats {
    visibleUpdateMs: number[];
    cacheHits: number;
    cacheMisses: number;
    lastJumpMs: number | undefined;
}

export function median(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

export function percentile(values: readonly number[], p: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}
