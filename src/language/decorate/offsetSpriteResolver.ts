import * as vscode from 'vscode';
import { ResourceIndex } from '../textures/resourceIndex';
import { TexturesParser } from '../textures/texturesParser';
import {
    TextureDocumentModel,
    CompositeSubPatch,
    ResolvedResource
} from '../textures/textureDocumentModel';
import { spriteResourceCandidates } from './offsetPreviewParser';

/** Empty TEXTURES stand-in so TextureDocumentModel can resolve cross-file defs. */
function makeEmptyTexturesDocument(): vscode.TextDocument {
    const text = '';
    const uri = vscode.Uri.parse('untitled:offset-preview-textures');
    return {
        uri,
        version: 1,
        lineCount: 1,
        lineAt(n: number) {
            return {
                text: '',
                lineNumber: n,
                range: new vscode.Range(n, 0, n, 0),
                rangeIncludingLineBreak: new vscode.Range(n, 0, n, 0),
                firstNonWhitespaceCharacterIndex: 0,
                isEmptyOrWhitespace: true
            };
        },
        getText() {
            return text;
        }
    } as unknown as vscode.TextDocument;
}

export interface ResolvedSpriteImage {
    resourceType: 'image' | 'composite';
    /** Webview URI for a direct PNG/JPEG. */
    imageUri: string | null;
    width: number;
    height: number;
    grabX: number;
    grabY: number;
    hasGrab: boolean;
    /** TEXTURES composite patches (already webview-uri resolved). */
    subPatches: CompositeSubPatch[] | null;
    /** Resolved lump name (e.g. 8H05C0). */
    resolvedName: string;
}

/**
 * Resolve DECORATE sprite+frame to a PNG/JPEG or a TEXTURES Sprite/Graphic definition.
 * Prefers the highest-priority ResourceIndex hit among Doom rotation candidates.
 */
export function resolveDecorateSprite(
    resourceIndex: ResourceIndex,
    webview: vscode.Webview,
    sprite: string,
    frameLetters: string
): ResolvedSpriteImage | null {
    const parser = new TexturesParser();
    const emptyDoc = makeEmptyTexturesDocument();
    parser.update(emptyDoc);
    const model = new TextureDocumentModel(emptyDoc, parser, resourceIndex);

    const candidates = spriteResourceCandidates(sprite, frameLetters);
    for (const name of candidates) {
        const resolved = model.resolveResourceFull(`sprite:${name}`, webview);
        if (resolved.resourceType === 'missing') {
            continue;
        }
        if (resolved.resourceType === 'image' && resolved.uri) {
            const grab = resolved.grabOffset;
            return {
                resourceType: 'image',
                imageUri: resolved.uri,
                width: resolved.width,
                height: resolved.height,
                grabX: grab?.x ?? 0,
                grabY: grab?.y ?? 0,
                hasGrab: !!grab,
                subPatches: null,
                resolvedName: name
            };
        }
        if (resolved.resourceType === 'composite') {
            const patches = resolved.subPatches ?? [];
            // Need at least one drawable patch — bare size from the index is not enough
            if (patches.length === 0) {
                continue;
            }
            const grab = resolved.grabOffset;
            return {
                resourceType: 'composite',
                imageUri: null,
                width: resolved.width,
                height: resolved.height,
                grabX: grab?.x ?? 0,
                grabY: grab?.y ?? 0,
                // TEXTURES Offset is the sprite origin (grAb equivalent)
                hasGrab: true,
                subPatches: patches,
                resolvedName: name
            };
        }
    }
    return null;
}

export type { CompositeSubPatch, ResolvedResource };
