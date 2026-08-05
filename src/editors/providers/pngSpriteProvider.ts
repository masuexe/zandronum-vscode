import * as vscode from 'vscode';
import { SpriteImageProvider, SpriteImageInfo, SpriteOffset } from '../spriteImage';
import { findChunk, readPngSize } from '../../tools/png/pngChunkReader';
import { readGrabOffset, writeGrabOffset } from '../../tools/png/pngGrabChunk';
import { mirrorPng } from '../../tools/png/pngMirror';

export class PngSpriteProvider implements SpriteImageProvider {
    private data: Uint8Array;
    private readonly fileUri: vscode.Uri;
    private readonly width: number;
    private readonly height: number;
    private readonly hasOffsetData: boolean;
    private currentOffset: SpriteOffset;
    private pendingMirror: { h: boolean; v: boolean } = { h: false, v: false };

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
            hasOffsetData: this.hasOffsetData,
            flipped: { ...this.pendingMirror }
        };
    }

    getImageSource(webview: vscode.Webview): string {
        // Cache-bust: after a mirror save the file content changes under the same URI.
        return webview.asWebviewUri(
            this.fileUri.with({ query: `v=${Date.now()}` })
        ).toString();
    }

    getOffset(): SpriteOffset {
        return { ...this.currentOffset };
    }

    setOffset(offset: SpriteOffset): void {
        this.currentOffset = { ...offset };
    }

    mirror(axis: 'h' | 'v'): void {
        if (axis === 'h') {
            this.pendingMirror.h = !this.pendingMirror.h;
        } else {
            this.pendingMirror.v = !this.pendingMirror.v;
        }
        // The grAb offset is not touched here: the webview computes the mode-aware
        // mirrored offset (image centre in Sprite mode, screen centre in Weapon mode)
        // and delivers it with the mirrorImage message; the host stores it in
        // document.currentOffset, which serialize() writes to grAb unchanged.
    }

    serialize(): Uint8Array {
        let final = this.data;
        if (this.pendingMirror.h) {
            final = mirrorPng(final, 'h');
        }
        if (this.pendingMirror.v) {
            final = mirrorPng(final, 'v');
        }
        // currentOffset is the mirrored-space value set by the host from the webview's
        // mirrorImage message — written to grAb as-is so pre-save display matches.
        return writeGrabOffset(final, this.currentOffset);
    }

    reload(data: Uint8Array): void {
        this.data = data;
        this.pendingMirror = { h: false, v: false };
        const grab = readGrabOffset(data);
        this.currentOffset = grab ?? { x: 0, y: 0 };
    }
}
