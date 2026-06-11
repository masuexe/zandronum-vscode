/**
 * Doom/ZDoom offset semantics.
 *
 * Offset represents the pixel inside the image
 * that should be aligned with world origin.
 *
 * Screen position:
 *   screenX = originX - offset.x
 *   screenY = originY - offset.y
 *
 * Drag behavior:
 *   drag right → offset.x decreases
 *   drag left  → offset.x increases
 *   drag down  → offset.y decreases
 *   drag up    → offset.y increases
 */

import * as vscode from 'vscode';

export interface SpriteOffset {
    x: number;
    y: number;
}

export interface SpriteImageInfo {
    width: number;
    height: number;
    offset: SpriteOffset;
    hasOffsetData: boolean;
}

export interface SpriteImageProvider {
    getInfo(): SpriteImageInfo;
    getImageSource(webview: vscode.Webview): string;
    getOffset(): SpriteOffset;
    setOffset(offset: SpriteOffset): void;
    serialize(): Uint8Array;
}

export interface AutoOffsetPreset {
    id: string;
    displayName: string;
    calculate(width: number, height: number): SpriteOffset;
}

export const AUTO_OFFSET_PRESETS: AutoOffsetPreset[] = [
    {
        id: 'monster',
        displayName: 'Monster',
        calculate: (w, h) => ({ x: Math.floor(w / 2), y: h })
    },
    {
        id: 'weapon',
        displayName: 'Weapon',
        calculate: (w, h) => ({ x: WEAPON_ANCHOR_X, y: WEAPON_ANCHOR_Y })
    },
    {
        id: 'center',
        displayName: 'Center',
        calculate: (w, h) => ({ x: Math.floor(w / 2), y: Math.floor(h / 2) })
    }
];

export const WEAPON_ANCHOR_X = 160;
export const WEAPON_ANCHOR_Y = 168;
export const WEAPON_REFERENCE_WIDTH = 320;
export const WEAPON_REFERENCE_HEIGHT = 200;
