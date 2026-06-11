import * as vscode from 'vscode';
import { SpriteImageProvider, SpriteImageInfo, SpriteOffset } from '../spriteImage';
import { findChunk } from '../../tools/png/pngChunkReader';
import { readGrabOffset, writeGrabOffset } from '../../tools/png/pngGrabChunk';

function readUint32BE(data: Uint8Array, offset: number): number {
    return ((data[offset] << 24) | (data[offset + 1] << 16) |
            (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

export class PngSpriteProvider implements SpriteImageProvider {
    private data: Uint8Array;
    private readonly fileUri: vscode.Uri;
    private readonly width: number;
    private readonly height: number;
    private readonly hasOffsetData: boolean;
    private currentOffset: SpriteOffset;

    constructor(data: Uint8Array, fileUri: vscode.Uri) {
        this.data = data;
        this.fileUri = fileUri;

        const ihdr = findChunk(data, 'IHDR');
        if (!ihdr || ihdr.data.length < 8) {
            throw new Error('Invalid PNG: missing or corrupted IHDR');
        }
        this.width = readUint32BE(ihdr.data, 0);
        this.height = readUint32BE(ihdr.data, 4);

        const grab = readGrabOffset(data);
        this.hasOffsetData = grab !== null;
        this.currentOffset = grab ?? { x: 0, y: 0 };
    }

    getInfo(): SpriteImageInfo {
        return {
            width: this.width,
            height: this.height,
            offset: { ...this.currentOffset },
            hasOffsetData: this.hasOffsetData
        };
    }

    getImageSource(webview: vscode.Webview): string {
        return webview.asWebviewUri(this.fileUri).toString();
    }

    getOffset(): SpriteOffset {
        return { ...this.currentOffset };
    }

    setOffset(offset: SpriteOffset): void {
        this.currentOffset = { ...offset };
    }

    serialize(): Uint8Array {
        return writeGrabOffset(this.data, this.currentOffset);
    }

    reload(data: Uint8Array): void {
        this.data = data;
        const grab = readGrabOffset(data);
        this.currentOffset = grab ?? { x: 0, y: 0 };
    }
}
