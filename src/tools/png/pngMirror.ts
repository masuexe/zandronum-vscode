import { zlibSync, unzlibSync } from 'fflate';
import { buildChunkBytes, isPng, iterateChunks, PNG_SIGNATURE } from './pngChunkReader';

export type MirrorAxis = 'h' | 'v';

export class PngMirrorError extends Error {}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const VALID_BIT_DEPTHS: Record<number, number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16]
};

interface IhdrInfo {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    interlace: number;
}

function readIhdr(data: Uint8Array): IhdrInfo {
    const chunks = iterateChunks(data);
    const ihdr = chunks.find(c => c.type === 'IHDR');
    if (!ihdr || ihdr.data.length < 13) {
        throw new PngMirrorError('Invalid PNG: missing or corrupted IHDR');
    }
    const d = ihdr.data;
    const width = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    const height = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
    const info: IhdrInfo = {
        width,
        height,
        bitDepth: d[8],
        colorType: d[9],
        interlace: d[12]
    };
    const allowed = VALID_BIT_DEPTHS[info.colorType];
    if (!allowed || allowed.indexOf(info.bitDepth) === -1) {
        throw new PngMirrorError(
            `Unsupported PNG format: colorType ${info.colorType}, bitDepth ${info.bitDepth}`
        );
    }
    if (width === 0 || height === 0) {
        throw new PngMirrorError('Invalid PNG: zero dimensions');
    }
    return info;
}

function concatParts(parts: Uint8Array[]): Uint8Array {
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

/** Unfilter a PNG scanline stream into raw per-row pixel data. */
function unfilterRows(
    raw: Uint8Array,
    height: number,
    rowBytes: number,
    bpp: number
): Uint8Array[] {
    const rows: Uint8Array[] = [];
    let prior = new Uint8Array(rowBytes);
    for (let y = 0; y < height; y++) {
        const scanline = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
        const recon = new Uint8Array(rowBytes);
        const filterType = raw[y * (rowBytes + 1)];
        for (let i = 0; i < rowBytes; i++) {
            const x = scanline[i];
            switch (filterType) {
                case 0:
                    recon[i] = x;
                    break;
                case 1: {
                    const left = i >= bpp ? recon[i - bpp] : 0;
                    recon[i] = (x + left) & 0xff;
                    break;
                }
                case 2: {
                    recon[i] = (x + prior[i]) & 0xff;
                    break;
                }
                case 3: {
                    const left = i >= bpp ? recon[i - bpp] : 0;
                    recon[i] = (x + ((left + prior[i]) >> 1)) & 0xff;
                    break;
                }
                case 4: {
                    const left = i >= bpp ? recon[i - bpp] : 0;
                    const upLeft = i >= bpp ? prior[i - bpp] : 0;
                    recon[i] = (x + paethPredictor(left, prior[i], upLeft)) & 0xff;
                    break;
                }
                default:
                    throw new PngMirrorError(`Invalid PNG filter type ${filterType}`);
            }
        }
        rows.push(recon);
        prior = recon;
    }
    return rows;
}

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) { return a; }
    if (pb <= pc) { return b; }
    return c;
}

/** Reverse packed sub-byte pixels (1/2/4-bit) within a scanline. */
function reversePackedBits(row: Uint8Array, width: number, bitsPerPixel: number): Uint8Array {
    const mask = (1 << bitsPerPixel) - 1;
    const pixels: number[] = new Array(width);
    for (let i = 0; i < width; i++) {
        const bitPos = i * bitsPerPixel;
        pixels[i] = (row[bitPos >> 3] >> (8 - bitsPerPixel - (bitPos & 7))) & mask;
    }
    pixels.reverse();
    const out = new Uint8Array(row.length);
    for (let i = 0; i < width; i++) {
        const bitPos = i * bitsPerPixel;
        out[bitPos >> 3] |= (pixels[i] & mask) << (8 - bitsPerPixel - (bitPos & 7));
    }
    return out;
}

function flipRowHorizontal(row: Uint8Array, width: number, bitDepth: number, channels: number): Uint8Array {
    if (bitDepth === 1 || bitDepth === 2 || bitDepth === 4) {
        return reversePackedBits(row, width, bitDepth);
    }
    const bytesPerPixel = channels * (bitDepth / 8);
    const out = new Uint8Array(row);
    for (let x = 0; x < Math.floor(width / 2); x++) {
        const a = x * bytesPerPixel;
        const b = (width - 1 - x) * bytesPerPixel;
        for (let c = 0; c < bytesPerPixel; c++) {
            const tmp = out[a + c];
            out[a + c] = out[b + c];
            out[b + c] = tmp;
        }
    }
    return out;
}

/**
 * Physically flip a PNG image about its horizontal ('h') or vertical ('v') center line.
 * Non-IDAT chunks (PLTE, tRNS, gAMA, grAb, ...) are preserved byte-for-byte.
 * The grAb offset is NOT modified here — callers transform it separately.
 * Throws PngMirrorError for interlaced or unsupported PNGs.
 */
export function mirrorPng(data: Uint8Array, axis: MirrorAxis): Uint8Array {
    if (!isPng(data)) {
        throw new PngMirrorError('Not a PNG file');
    }
    const info = readIhdr(data);

    if (info.interlace !== 0) {
        throw new PngMirrorError('Interlaced PNG is not supported');
    }

    const channels = CHANNELS_BY_COLOR_TYPE[info.colorType];
    const bitsPerPixel = channels * info.bitDepth;
    const rowBytes = Math.ceil((info.width * bitsPerPixel) / 8);
    const bpp = info.bitDepth < 8 ? 1 : channels * (info.bitDepth / 8);

    const idatParts: Uint8Array[] = [];
    const chunks = iterateChunks(data);
    for (const c of chunks) {
        if (c.type === 'IDAT') {
            idatParts.push(c.data);
        }
    }
    if (idatParts.length === 0) {
        throw new PngMirrorError('PNG has no image data (IDAT)');
    }

    const compressed = unzlibSync(concatParts(idatParts));
    const rows = unfilterRows(compressed, info.height, rowBytes, bpp);

    const outRows: Uint8Array[] = [];
    for (let y = 0; y < info.height; y++) {
        const srcRow = rows[axis === 'v' ? info.height - 1 - y : y];
        const row = axis === 'h'
            ? flipRowHorizontal(srcRow, info.width, info.bitDepth, channels)
            : srcRow;
        outRows.push(row);
    }

    const scanlines = new Uint8Array(info.height * (rowBytes + 1));
    for (let y = 0; y < info.height; y++) {
        scanlines[y * (rowBytes + 1)] = 0;
        scanlines.set(outRows[y], y * (rowBytes + 1) + 1);
    }

    const newIdat = zlibSync(scanlines, { level: 9 });

    const parts: Uint8Array[] = [PNG_SIGNATURE];
    let inserted = false;
    for (const c of chunks) {
        if (c.type === 'IDAT') {
            if (!inserted) {
                parts.push(buildChunkBytes('IDAT', newIdat));
                inserted = true;
            }
            continue;
        }
        parts.push(data.subarray(c.offset, c.offset + c.totalLength));
    }
    if (!inserted) {
        throw new PngMirrorError('PNG has no image data (IDAT)');
    }

    return concatParts(parts);
}
