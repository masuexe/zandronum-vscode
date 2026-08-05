import * as assert from 'assert';
import { zlibSync, unzlibSync } from 'fflate';
import { buildChunkBytes, iterateChunks, PNG_SIGNATURE } from '../tools/png/pngChunkReader';
import { mirrorPng, PngMirrorError } from '../tools/png/pngMirror';

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function concat(parts: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const p of parts) { total += p.length; }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
        out.set(p, pos);
        pos += p.length;
    }
    return out;
}

function writeUint32BE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >>> 24) & 0xff;
    data[offset + 1] = (value >>> 16) & 0xff;
    data[offset + 2] = (value >>> 8) & 0xff;
    data[offset + 3] = value & 0xff;
}

interface BuildPngOptions {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace?: number;
    extraChunks?: { type: string; data: Uint8Array }[];
    /** Per-row filter types (0-4); defaults to all None. */
    rowFilters?: number[];
}

/** Build a valid PNG whose scanlines use the given filter types (default 0). */
function buildPng(rows: number[][], opts: BuildPngOptions): Uint8Array {
    const bpp = opts.bitDepth < 8 ? 1 : CHANNELS[opts.colorType] * (opts.bitDepth / 8);
    const rowBytes = rows[0].length;
    const scanlines = new Uint8Array(opts.height * (rowBytes + 1));
    let priorRaw = new Uint8Array(rowBytes);
    for (let y = 0; y < opts.height; y++) {
        const type = opts.rowFilters?.[y] ?? 0;
        scanlines[y * (rowBytes + 1)] = type;
        const raw = Uint8Array.from(rows[y]);
        const out = new Uint8Array(rowBytes);
        for (let i = 0; i < rowBytes; i++) {
            const left = i >= bpp ? raw[i - bpp] : 0;
            const up = priorRaw[i];
            const upLeft = i >= bpp ? priorRaw[i - bpp] : 0;
            let v: number;
            switch (type) {
                case 0: v = raw[i]; break;
                case 1: v = raw[i] - left; break;
                case 2: v = raw[i] - up; break;
                case 3: v = raw[i] - Math.floor((left + up) / 2); break;
                case 4: v = raw[i] - paeth(left, up, upLeft); break;
                default: throw new Error(`bad filter ${type}`);
            }
            out[i] = v & 0xff;
        }
        scanlines.set(out, y * (rowBytes + 1) + 1);
        priorRaw = raw;
    }

    const ihdr = new Uint8Array(13);
    writeUint32BE(ihdr, 0, opts.width);
    writeUint32BE(ihdr, 4, opts.height);
    ihdr[8] = opts.bitDepth;
    ihdr[9] = opts.colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = opts.interlace ?? 0;

    const parts: Uint8Array[] = [PNG_SIGNATURE, buildChunkBytes('IHDR', ihdr)];
    for (const c of opts.extraChunks ?? []) {
        parts.push(buildChunkBytes(c.type, c.data));
    }
    parts.push(buildChunkBytes('IDAT', zlibSync(scanlines)));
    parts.push(buildChunkBytes('IEND', new Uint8Array(0)));
    return concat(parts);
}

function paeth(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) { return a; }
    if (pb <= pc) { return b; }
    return c;
}

interface DecodedPng {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    rows: Uint8Array[];
}

/** Decode a PNG produced by mirrorPng (all rows use filter 0). */
function decodePng(data: Uint8Array): DecodedPng {
    const chunks = iterateChunks(data);
    const ihdr = chunks.find(c => c.type === 'IHDR');
    assert.ok(ihdr, 'IHDR missing');
    const d = ihdr.data;
    const width = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    const height = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
    const bitDepth = d[8];
    const colorType = d[9];

    const idat = chunks.filter(c => c.type === 'IDAT').map(c => c.data);
    const raw = unzlibSync(concat(idat));
    const channels = CHANNELS[colorType];
    const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
    const rows: Uint8Array[] = [];
    for (let y = 0; y < height; y++) {
        assert.strictEqual(raw[y * (rowBytes + 1)], 0, `row ${y} must use filter 0`);
        rows.push(raw.slice(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1)));
    }
    return { width, height, bitDepth, colorType, rows };
}

function assertRowsEqual(actual: ArrayLike<number>[], expected: ArrayLike<number>[]): void {
    assert.strictEqual(actual.length, expected.length, 'row count');
    for (let y = 0; y < expected.length; y++) {
        assert.deepStrictEqual(Array.from(actual[y]), Array.from(expected[y]), `row ${y}`);
    }
}

function assertRoundTrip(data: Uint8Array): void {
    const hh = mirrorPng(mirrorPng(data, 'h'), 'h');
    const vv = mirrorPng(mirrorPng(data, 'v'), 'v');
    assertRowsEqual(decodePng(hh).rows, decodePng(data).rows);
    assertRowsEqual(decodePng(vv).rows, decodePng(data).rows);
}

suite('pngMirror', () => {
    test('mirrors RGBA 8-bit horizontally', () => {
        // 4x2 distinct pixels: row0 = [R1,G1,B1,A1, ...]
        const row0 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const row1 = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
        const data = buildPng([row0, row1], { width: 4, height: 2, bitDepth: 8, colorType: 6 });
        const out = mirrorPng(data, 'h');
        const dec = decodePng(out);
        assert.strictEqual(dec.width, 4);
        assert.strictEqual(dec.height, 2);
        assertRowsEqual(dec.rows, [
            // pixel order reversed within each row
            [13, 14, 15, 16, 9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4],
            [33, 34, 35, 36, 29, 30, 31, 32, 25, 26, 27, 28, 21, 22, 23, 24]
        ]);
    });

    test('mirrors RGBA 8-bit vertically', () => {
        const row0 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        const row1 = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
        const data = buildPng([row0, row1], { width: 4, height: 2, bitDepth: 8, colorType: 6 });
        const out = mirrorPng(data, 'v');
        const dec = decodePng(out);
        assertRowsEqual(dec.rows, [row1, row0]);
    });

    test('mirroring twice restores original pixels', () => {
        const rows = [
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
            [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36],
            [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56]
        ];
        const data = buildPng(rows, { width: 4, height: 3, bitDepth: 8, colorType: 6 });
        assertRoundTrip(data);
    });

    test('handles odd width (center pixel stays)', () => {
        // 3x1 RGB: pixels A(1,2,3) B(4,5,6) C(7,8,9) -> reversed C B A
        const row = [1, 2, 3, 4, 5, 6, 7, 8, 9];
        const data = buildPng([row], { width: 3, height: 1, bitDepth: 8, colorType: 2 });
        const out = mirrorPng(data, 'h');
        assertRowsEqual(decodePng(out).rows, [[7, 8, 9, 4, 5, 6, 1, 2, 3]]);
    });

    test('palette 8-bit mirrors pixels and preserves PLTE/tRNS/grAb chunks', () => {
        const row = [0, 1, 2, 3];
        const palette = new Uint8Array(3 * 3);
        const trns = new Uint8Array(3);
        const grab = new Uint8Array(8);
        const data = buildPng([row], {
            width: 4, height: 1, bitDepth: 8, colorType: 3,
            extraChunks: [
                { type: 'PLTE', data: palette },
                { type: 'tRNS', data: trns },
                { type: 'grAb', data: grab }
            ]
        });
        const out = mirrorPng(data, 'h');
        const dec = decodePng(out);
        assertRowsEqual(dec.rows, [[3, 2, 1, 0]]);

        const chunks = iterateChunks(out);
        const find = (type: string) => chunks.find(c => c.type === type)?.data;
        assert.deepStrictEqual(Array.from(find('PLTE')!), Array.from(palette));
        assert.deepStrictEqual(Array.from(find('tRNS')!), Array.from(trns));
        assert.deepStrictEqual(Array.from(find('grAb')!), Array.from(grab));
    });

    test('palette 2-bit reverses packed pixels', () => {
        // 5 pixels [0,1,2,3,0], 2 bits each, packed into 2 bytes
        const row = [0x1b, 0x00]; // 00 01 10 11 00
        const data = buildPng([row], {
            width: 5, height: 1, bitDepth: 2, colorType: 3,
            extraChunks: [{ type: 'PLTE', data: new Uint8Array(4 * 3) }]
        });
        const out = mirrorPng(data, 'h');
        // reversed pixels [0,3,2,1,0] -> 00 11 10 01 00 = 0x39, 0x00
        assertRowsEqual(decodePng(out).rows, [[0x39, 0x00]]);
    });

    test('16-bit grayscale mirrors by 2-byte pixels', () => {
        // 3 pixels: (0x0102) (0x0304) (0x0506) -> reversed (0x0506) (0x0304) (0x0102)
        const row = [0x01, 0x02, 0x03, 0x04, 0x05, 0x06];
        const data = buildPng([row], { width: 3, height: 1, bitDepth: 16, colorType: 0 });
        const out = mirrorPng(data, 'h');
        assertRowsEqual(decodePng(out).rows, [[0x05, 0x06, 0x03, 0x04, 0x01, 0x02]]);
    });

    test('unfilters all filter types (None/Sub/Up/Average/Paeth) correctly', () => {
        const mk = (base: number) => Array.from({ length: 16 }, (_, i) => base + i);
        const row0 = mk(1);   // None
        const row1 = mk(21);  // Sub
        const row2 = mk(41);  // Up
        const row3 = mk(61);  // Average
        const row4 = mk(81);  // Paeth
        const data = buildPng([row0, row1, row2, row3, row4], {
            width: 4, height: 5, bitDepth: 8, colorType: 6,
            rowFilters: [0, 1, 2, 3, 4]
        });
        // decodePng requires filter 0 — original is filtered, so decode the mirror output only
        const out = mirrorPng(data, 'h');
        const dec = decodePng(out);
        assertRowsEqual(dec.rows, [
            [13, 14, 15, 16, 9, 10, 11, 12, 5, 6, 7, 8, 1, 2, 3, 4],
            [33, 34, 35, 36, 29, 30, 31, 32, 25, 26, 27, 28, 21, 22, 23, 24],
            [53, 54, 55, 56, 49, 50, 51, 52, 45, 46, 47, 48, 41, 42, 43, 44],
            [73, 74, 75, 76, 69, 70, 71, 72, 65, 66, 67, 68, 61, 62, 63, 64],
            [93, 94, 95, 96, 89, 90, 91, 92, 85, 86, 87, 88, 81, 82, 83, 84]
        ]);
    });

    test('throws on interlaced PNG', () => {
        const row = [0, 0, 0, 0];
        const data = buildPng([row], { width: 1, height: 1, bitDepth: 8, colorType: 6, interlace: 1 });
        assert.throws(() => mirrorPng(data, 'h'), PngMirrorError);
    });

    test('throws on non-PNG input', () => {
        assert.throws(() => mirrorPng(new Uint8Array([1, 2, 3]), 'h'), PngMirrorError);
    });

    test('rejects unsupported color type / bit depth combination', () => {
        const row = [0, 0, 0];
        const data = buildPng([row], { width: 1, height: 1, bitDepth: 1, colorType: 6 });
        assert.throws(() => mirrorPng(data, 'h'), PngMirrorError);
    });
});
