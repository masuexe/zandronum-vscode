import { findChunk, insertChunkAfter, replaceChunk } from './pngChunkReader';

export interface GrabOffset {
    x: number;
    y: number;
}

function readInt32BE(data: Uint8Array, offset: number): number {
    const val = ((data[offset] << 24) | (data[offset + 1] << 16) |
                 (data[offset + 2] << 8) | data[offset + 3]);
    return val | 0;
}

function writeInt32BE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >>> 24) & 0xFF;
    data[offset + 1] = (value >>> 16) & 0xFF;
    data[offset + 2] = (value >>> 8) & 0xFF;
    data[offset + 3] = value & 0xFF;
}

export function readGrabOffset(pngData: Uint8Array): GrabOffset | null {
    const chunk = findChunk(pngData, 'grAb');
    if (!chunk || chunk.data.length < 8) { return null; }
    return {
        x: readInt32BE(chunk.data, 0),
        y: readInt32BE(chunk.data, 4)
    };
}

export function writeGrabOffset(pngData: Uint8Array, offset: GrabOffset): Uint8Array {
    const grabData = new Uint8Array(8);
    writeInt32BE(grabData, 0, offset.x);
    writeInt32BE(grabData, 4, offset.y);

    const existing = findChunk(pngData, 'grAb');
    if (existing) {
        return replaceChunk(pngData, 'grAb', grabData);
    }
    return insertChunkAfter(pngData, 'IHDR', 'grAb', grabData);
}
