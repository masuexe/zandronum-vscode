import * as vscode from 'vscode';
import { SpriteImageProvider, SpriteImageInfo, SpriteOffset } from '../spriteImage';
import { findChunk, readPngSize } from '../../tools/png/pngChunkReader';
import { readGrabOffset, writeGrabOffset } from '../../tools/png/pngGrabChunk';

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

        const size = readPngSize(data);
        if (!size) {
            throw new Error('Invalid PNG: missing or corrupted IHDR');
        }
        this.width = size.width;
        this.height = size.height;

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
