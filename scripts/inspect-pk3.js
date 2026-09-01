#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const archivePath = process.argv[2];
const requested = process.argv.slice(3).map(name => name.toLowerCase());
if (!archivePath) {
    console.error('Usage: node scripts/inspect-pk3.js <archive.pk3> [entry-name ...]');
    process.exitCode = 1;
    return;
}

const data = fs.readFileSync(archivePath);
let eocd = -1;
for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
    }
}
if (eocd < 0) {
    throw new Error('ZIP end-of-central-directory not found');
}

const defaults = ['6p1ea0.png', 'u_hag0.png', 'decorate'];
const targets = requested.length > 0 ? requested : defaults;
const entryCount = data.readUInt16LE(eocd + 10);
let centralOffset = data.readUInt32LE(eocd + 16);
let matched = 0;

console.log(`archive=${path.resolve(archivePath)} entries=${entryCount}`);
for (let index = 0; index < entryCount; index++) {
    if (data.readUInt32LE(centralOffset) !== 0x02014b50) {
        throw new Error(`Invalid central directory entry at ${centralOffset}`);
    }
    const nameLength = data.readUInt16LE(centralOffset + 28);
    const extraLength = data.readUInt16LE(centralOffset + 30);
    const commentLength = data.readUInt16LE(centralOffset + 32);
    const name = data.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
    const lowerName = name.toLowerCase();
    if (targets.some(target => lowerName === target || lowerName.endsWith(`/${target}`))) {
        const localOffset = data.readUInt32LE(centralOffset + 42);
        if (data.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`Invalid local header for ${name}`);
        }
        const method = data.readUInt16LE(centralOffset + 10);
        const flags = data.readUInt16LE(centralOffset + 8);
        console.log([
            name,
            `method=${method === 8 ? 'deflate' : method === 0 ? 'store' : method}`,
            `flags=0x${flags.toString(16).padStart(4, '0')}`,
            `localFlags=0x${data.readUInt16LE(localOffset + 6).toString(16).padStart(4, '0')}`,
            `crc=0x${data.readUInt32LE(centralOffset + 16).toString(16).padStart(8, '0')}`,
            `localCrc=0x${data.readUInt32LE(localOffset + 14).toString(16).padStart(8, '0')}`,
            `size=${data.readUInt32LE(centralOffset + 24)}`,
            `localSize=${data.readUInt32LE(localOffset + 22)}`,
            `compressed=${data.readUInt32LE(centralOffset + 20)}`,
            `localCompressed=${data.readUInt32LE(localOffset + 18)}`,
            `localExtra=${data.readUInt16LE(localOffset + 28)}`,
        ].join(' '));
        matched++;
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
}

if (matched === 0) {
    console.error(`No matching entries found: ${targets.join(', ')}`);
    process.exitCode = 2;
}
