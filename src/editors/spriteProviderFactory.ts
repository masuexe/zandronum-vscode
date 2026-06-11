import * as vscode from 'vscode';
import { SpriteImageProvider } from './spriteImage';
import { isPng } from '../tools/png/pngChunkReader';
import { PngSpriteProvider } from './providers/pngSpriteProvider';

export function createSpriteProvider(data: Uint8Array, uri: vscode.Uri): SpriteImageProvider | null {
    if (isPng(data)) {
        return new PngSpriteProvider(data, uri);
    }
    return null;
}
