/**
 * ZDoom/Zandronum TEXTURES Translation helpers (palette remap ranges).
 * Supports custom remap strings: "fromStart:fromEnd=toStart:toEnd"
 * Named translations (Inverse, Gold, …) are left as identity for now.
 */

export interface RemapRange {
    fromStart: number;
    fromEnd: number;
    toStart: number;
    toEnd: number;
}

const RANGE_RE = /(\d+)\s*:\s*(\d+)\s*=\s*(\d+)\s*:\s*(\d+)/g;
const NAMED_RE = /^(Inverse|Gold|Red|Green|Ice|Desaturate)\b/i;

/** Extract remap ranges from a Translation property value (quoted strings and/or bare ranges). */
export function parseTranslationValue(raw: string): RemapRange[] {
    const ranges: RemapRange[] = [];
    if (!raw) { return ranges; }

    // Prefer quoted segments
    const quoted = [...raw.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    const parts = quoted.length > 0 ? quoted : [raw];

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed || NAMED_RE.test(trimmed)) {
            // Named translations not expanded here (need full ZDoom tables)
            continue;
        }
        RANGE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = RANGE_RE.exec(trimmed)) !== null) {
            const fromStart = clampByte(parseInt(m[1], 10));
            const fromEnd = clampByte(parseInt(m[2], 10));
            const toStart = clampByte(parseInt(m[3], 10));
            const toEnd = clampByte(parseInt(m[4], 10));
            ranges.push({ fromStart, fromEnd, toStart, toEnd });
        }
    }
    return ranges;
}

function clampByte(n: number): number {
    if (!Number.isFinite(n)) { return 0; }
    return Math.max(0, Math.min(255, n | 0));
}

/** Build a 256-entry remap table (identity + applied ranges). */
export function buildRemapTable(ranges: RemapRange[]): Uint8Array {
    const table = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { table[i] = i; }

    for (const r of ranges) {
        const fromLo = Math.min(r.fromStart, r.fromEnd);
        const fromHi = Math.max(r.fromStart, r.fromEnd);
        const fromSpan = fromHi - fromLo;
        const toSpan = r.toEnd - r.toStart;
        for (let i = fromLo; i <= fromHi; i++) {
            if (fromSpan === 0) {
                table[i] = r.toStart;
            } else {
                const t = (i - fromLo) / fromSpan;
                table[i] = clampByte(Math.round(r.toStart + t * toSpan));
            }
        }
    }
    return table;
}

export interface Rgb {
    r: number;
    g: number;
    b: number;
}

/** Nearest PLAYPAL index for an RGB triple (Euclidean). */
export function nearestPaletteIndex(r: number, g: number, b: number, palette: Rgb[]): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const dr = r - palette[i].r;
        const dg = g - palette[i].g;
        const db = b - palette[i].b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
            if (dist === 0) { break; }
        }
    }
    return best;
}
