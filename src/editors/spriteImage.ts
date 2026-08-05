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
    /** Pending mirror state applied on the next serialize(). */
    flipped: { h: boolean; v: boolean };
}

export interface SpriteImageProvider {
    getInfo(): SpriteImageInfo;
    getImageSource(webview: vscode.Webview): string;
    getOffset(): SpriteOffset;
    setOffset(offset: SpriteOffset): void;
    /**
     * Toggle a pending mirror about the given axis; the pixel flip is applied at
     * serialize() time. The offset itself is computed by the webview (mirror axis is
     * the image centre in Sprite mode and the screen centre in Weapon mode) and sent
     * to the host with the mirrorImage message.
     */
    mirror(axis: 'h' | 'v'): void;
    serialize(): Uint8Array;
    /** Replace the backing byte data (e.g. after a save); resets pending mirror state. */
    reload(data: Uint8Array): void;
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

// Heuristic used by the "Weapon" auto-offset preset only.
// NOT the engine anchor: Zandronum places the grAb pixel at screen (sx, sy),
// resting at (0, WEAPONTOP = 32.375) — see media/spriteOffsetEditor.js.
export const WEAPON_ANCHOR_X = 160;
export const WEAPON_ANCHOR_Y = 168;
export const WEAPON_REFERENCE_WIDTH = 320;
export const WEAPON_REFERENCE_HEIGHT = 200;
