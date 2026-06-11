import { crc32 } from './crc32';

export const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngChunk {
    type: string;
    data: Uint8Array;
    offset: number;
    totalLength: number;
}

export function isPng(data: Uint8Array): boolean {
    if (data.length < 8) { return false; }
    for (let i = 0; i < 8; i++) {
        if (data[i] !== PNG_SIGNATURE[i]) { return false; }
    }
    return true;
}

function readUint32BE(data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) | (data[offset + 1] << 16) |
            (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function writeUint32BE(data: Uint8Array, offset: number, value: number): void {
    data[offset] = (value >>> 24) & 0xFF;
    data[offset + 1] = (value >>> 16) & 0xFF;
    data[offset + 2] = (value >>> 8) & 0xFF;
    data[offset + 3] = value & 0xFF;
}

function chunkTypeString(data: Uint8Array, offset: number): string {
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

export function iterateChunks(data: Uint8Array): PngChunk[] {
    if (!isPng(data)) { return []; }
    const chunks: PngChunk[] = [];
    let pos = 8;
    while (pos + 12 <= data.length) {
        const length = readUint32BE(data, pos);
        const type = chunkTypeString(data, pos + 4);
        const chunkData = data.slice(pos + 8, pos + 8 + length);
        const totalLength = 12 + length;
        chunks.push({ type, data: chunkData, offset: pos, totalLength });
        pos += totalLength;
        if (type === 'IEND') { break; }
    }
    return chunks;
}

export function findChunk(data: Uint8Array, type: string): PngChunk | null {
    const chunks = iterateChunks(data);
    return chunks.find(c => c.type === type) || null;
}

export function buildChunkBytes(type: string, chunkData: Uint8Array): Uint8Array {
    const total = 12 + chunkData.length;
    const result = new Uint8Array(total);
    writeUint32BE(result, 0, chunkData.length);
    result[4] = type.charCodeAt(0);
    result[5] = type.charCodeAt(1);
    result[6] = type.charCodeAt(2);
    result[7] = type.charCodeAt(3);
    result.set(chunkData, 8);
    const crcValue = crc32(result, 4, 8 + chunkData.length);
    writeUint32BE(result, 8 + chunkData.length, crcValue);
    return result;
}

export function insertChunkAfter(
    data: Uint8Array,
    afterType: string,
    newType: string,
    newData: Uint8Array
): Uint8Array {
    const chunks = iterateChunks(data);
    const target = chunks.find(c => c.type === afterType);
    if (!target) { return data; }

    const insertPos = target.offset + target.totalLength;
    const chunkBytes = buildChunkBytes(newType, newData);
    const result = new Uint8Array(data.length + chunkBytes.length);
    result.set(data.slice(0, insertPos), 0);
    result.set(chunkBytes, insertPos);
    result.set(data.slice(insertPos), insertPos + chunkBytes.length);
    return result;
}

export function replaceChunk(
    data: Uint8Array,
    type: string,
    newData: Uint8Array
): Uint8Array {
    const chunk = findChunk(data, type);
    if (!chunk) { return data; }

    const chunkBytes = buildChunkBytes(type, newData);
    const result = new Uint8Array(data.length - chunk.totalLength + chunkBytes.length);
    result.set(data.slice(0, chunk.offset), 0);
    result.set(chunkBytes, chunk.offset);
    result.set(data.slice(chunk.offset + chunk.totalLength), chunk.offset + chunkBytes.length);
    return result;
}
