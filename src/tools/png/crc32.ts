const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
    let crc = 0xFFFFFFFF;
    for (let i = start; i < end; i++) {
        crc = TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
