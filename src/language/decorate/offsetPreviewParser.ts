/**
 * Parse DECORATE state lines for weapon Offset(x, y) preview.
 *
 * Offset semantics (ZDoom / Zandronum):
 * - Default weapon layer position is (0, 32)
 * - Offset(0, 0) means "keep previous" on both axes
 * - Offset(0, y) / Offset(x, 0): zero on one axis keeps that axis; non-zero applies
 * - A_WeaponReady resets the weapon layer to (0, 32)
 * - Positive X = right; larger Y = lower on screen
 */

export const WEAPON_OFFSET_DEFAULT_X = 0;
export const WEAPON_OFFSET_DEFAULT_Y = 32;

export interface WeaponOffset {
    x: number;
    y: number;
}

export interface OffsetStateFrame {
    line: number;
    sprite: string;
    frame: string;
    duration: string;
    /** Raw Offset(x,y) if present on this line. */
    declaredOffset: WeaponOffset | null;
    /** Declared X is 0 → keep previous effective X (true for Offset(0,0) and Offset(0,y)). */
    keepX: boolean;
    /** Declared Y is 0 → keep previous effective Y (true for Offset(0,0) and Offset(x,0)). */
    keepY: boolean;
    /** True when Offset(0, 0) — keep both axes. */
    offsetIsKeep: boolean;
    /** Line calls A_WeaponReady (resets to (0, 32) after Offset apply). */
    resetsToWeaponReady: boolean;
    /** Effective HUD offset after keep / WeaponReady rules. */
    effectiveOffset: WeaponOffset;
    hasOffsetKeyword: boolean;
    rest: string;
}

export interface OffsetSequence {
    label: string;
    labelLine: number;
    /** All sprite state frames in the label (with effective offsets). */
    frames: OffsetStateFrame[];
    /** Indices into `frames` for the consecutive offset-affecting run containing `activeFrameIndex`. */
    sequenceIndices: number[];
    /** Index into `frames` for the active line. */
    activeFrameIndex: number;
}

const LABEL_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/;
const STATE_LINE_RE =
    /^\s*([A-Za-z0-9_]{1,8})\s+(\"[^\"]+\"|[A-Za-z0-9\[\]\\]+)\s+(-?\d+|[Rr][Aa][Nn][Dd][Oo][Mm]\s*\([^)]*\))\s*(.*)$/;
const OFFSET_RE = /\bOffset\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i;
const WEAPON_READY_RE = /\bA_WeaponReady\b/i;
const FLOW_RE = /^\s*(goto|loop|stop|wait|fail)\b/i;
const STATES_RE = /^\s*States\b/i;
const ACTOR_RE = /^\s*Actor\b/i;

function stripComment(line: string): string {
    const idx = line.indexOf('//');
    return idx >= 0 ? line.substring(0, idx) : line;
}

function isOffsetAffecting(f: Pick<OffsetStateFrame, 'hasOffsetKeyword' | 'resetsToWeaponReady'>): boolean {
    return f.hasOffsetKeyword || f.resetsToWeaponReady;
}

/**
 * Find the state label that owns `lineNumber`, scanning upward for `Label:`.
 */
export function findLabelAtLine(lines: string[], lineNumber: number): { name: string; line: number } | null {
    for (let i = lineNumber; i >= 0; i--) {
        const text = stripComment(lines[i]);
        if (FLOW_RE.test(text)) {
            continue;
        }
        if (STATES_RE.test(text) || ACTOR_RE.test(text)) {
            break;
        }
        const m = LABEL_RE.exec(text);
        if (m) {
            return { name: m[1], line: i };
        }
    }
    return null;
}

/**
 * Collect sprite state frames from a label until the next label / flow / States end.
 */
export function parseLabelFrames(lines: string[], labelLine: number): OffsetStateFrame[] {
    const raw: Omit<OffsetStateFrame, 'effectiveOffset'>[] = [];

    for (let i = labelLine + 1; i < lines.length; i++) {
        const text = stripComment(lines[i]);
        const trimmed = text.trim();
        if (!trimmed) {
            continue;
        }
        if (LABEL_RE.test(text) || FLOW_RE.test(text) || STATES_RE.test(text) || ACTOR_RE.test(text)) {
            break;
        }
        if (trimmed === '{' || trimmed === '}') {
            if (trimmed === '}') {
                break;
            }
            continue;
        }

        const m = STATE_LINE_RE.exec(text);
        if (!m) {
            continue;
        }

        const sprite = m[1];
        const frame = m[2];
        const duration = m[3];
        const rest = m[4] ?? '';
        const om = OFFSET_RE.exec(rest);
        let declaredOffset: WeaponOffset | null = null;
        let keepX = false;
        let keepY = false;
        let offsetIsKeep = false;
        let hasOffsetKeyword = false;

        if (om) {
            hasOffsetKeyword = true;
            declaredOffset = { x: parseInt(om[1], 10), y: parseInt(om[2], 10) };
            keepX = declaredOffset.x === 0;
            keepY = declaredOffset.y === 0;
            offsetIsKeep = keepX && keepY;
        }

        raw.push({
            line: i,
            sprite,
            frame,
            duration,
            declaredOffset,
            keepX,
            keepY,
            offsetIsKeep,
            resetsToWeaponReady: WEAPON_READY_RE.test(rest),
            hasOffsetKeyword,
            rest
        });
    }

    let current: WeaponOffset = {
        x: WEAPON_OFFSET_DEFAULT_X,
        y: WEAPON_OFFSET_DEFAULT_Y
    };

    const frames: OffsetStateFrame[] = [];
    for (const f of raw) {
        if (f.hasOffsetKeyword && f.declaredOffset) {
            const d = f.declaredOffset;
            if (!(d.x === 0 && d.y === 0)) {
                if (d.x !== 0) {
                    current.x = d.x;
                }
                if (d.y !== 0) {
                    current.y = d.y;
                }
            }
            // Offset(0,0): keep both axes (no change to current)
        }
        if (f.resetsToWeaponReady) {
            current = {
                x: WEAPON_OFFSET_DEFAULT_X,
                y: WEAPON_OFFSET_DEFAULT_Y
            };
        }
        frames.push({
            ...f,
            effectiveOffset: { ...current }
        });
    }

    return frames;
}

/**
 * Maximal consecutive run of Offset and/or A_WeaponReady frames that includes `frameIndex`.
 */
export function consecutiveOffsetRun(frames: OffsetStateFrame[], frameIndex: number): number[] {
    if (frameIndex < 0 || frameIndex >= frames.length) {
        return [];
    }
    if (!isOffsetAffecting(frames[frameIndex])) {
        return [frameIndex];
    }

    let start = frameIndex;
    while (start > 0 && isOffsetAffecting(frames[start - 1])) {
        start--;
    }
    let end = frameIndex;
    while (end + 1 < frames.length && isOffsetAffecting(frames[end + 1])) {
        end++;
    }

    const indices: number[] = [];
    for (let i = start; i <= end; i++) {
        indices.push(i);
    }
    return indices;
}

/**
 * Build an OffsetSequence for the document line under the cursor.
 * Returns null if no state frame / label context is found.
 */
export function buildOffsetSequence(documentText: string, lineNumber: number): OffsetSequence | null {
    const lines = documentText.split(/\r?\n/);
    if (lineNumber < 0 || lineNumber >= lines.length) {
        return null;
    }

    const label = findLabelAtLine(lines, lineNumber);
    if (!label) {
        return null;
    }

    const frames = parseLabelFrames(lines, label.line);
    if (frames.length === 0) {
        return null;
    }

    let activeFrameIndex = frames.findIndex(f => f.line === lineNumber);
    if (activeFrameIndex < 0) {
        // Nearest frame at or before the cursor within the label
        activeFrameIndex = -1;
        for (let i = 0; i < frames.length; i++) {
            if (frames[i].line <= lineNumber) {
                activeFrameIndex = i;
            } else {
                break;
            }
        }
        if (activeFrameIndex < 0) {
            activeFrameIndex = 0;
        }
    }

    const sequenceIndices = consecutiveOffsetRun(frames, activeFrameIndex);

    return {
        label: label.name,
        labelLine: label.line,
        frames,
        sequenceIndices,
        activeFrameIndex
    };
}

/** True if the line text contains an Offset(...) state keyword. */
export function lineHasOffsetKeyword(lineText: string): boolean {
    return OFFSET_RE.test(stripComment(lineText));
}

/**
 * Document line numbers that should show a Preview Offset CodeLens:
 * the first Offset(...) line in each consecutive offset-affecting run
 * (Offset and/or A_WeaponReady), per state label.
 */
export function offsetCodeLensLines(documentText: string): number[] {
    const lines = documentText.split(/\r?\n/);
    const result: number[] = [];
    const seen = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
        const text = stripComment(lines[i]);
        if (!LABEL_RE.test(text)) {
            continue;
        }

        const frames = parseLabelFrames(lines, i);
        let fi = 0;
        while (fi < frames.length) {
            if (!isOffsetAffecting(frames[fi])) {
                fi++;
                continue;
            }
            let firstOffsetLine: number | null = null;
            while (fi < frames.length && isOffsetAffecting(frames[fi])) {
                if (frames[fi].hasOffsetKeyword && firstOffsetLine === null) {
                    firstOffsetLine = frames[fi].line;
                }
                fi++;
            }
            if (firstOffsetLine !== null && !seen.has(firstOffsetLine)) {
                seen.add(firstOffsetLine);
                result.push(firstOffsetLine);
            }
        }
    }

    return result;
}

/**
 * Candidate Doom sprite lump basenames for sprite+frame (rotation variants).
 * ResourceIndex keys are lowercased basenames without extension.
 */
export function spriteResourceCandidates(sprite: string, frameLetters: string): string[] {
    const spr = sprite.toLowerCase();
    const candidates: string[] = [];
    const seen = new Set<string>();

    const add = (name: string) => {
        if (!seen.has(name)) {
            seen.add(name);
            candidates.push(name);
        }
    };

    // Multi-frame letters (e.g. "AB") → try each letter, prefer first
    const letters = frameLetters.length > 0 ? frameLetters.split('') : ['a'];
    for (const letter of letters) {
        const fr = letter.toLowerCase();
        // Common: SPRT A0 / SPRTA0
        for (const rot of ['0', '1', '2', '3', '4', '5', '6', '7', '8']) {
            add(`${spr}${fr}${rot}`);
        }
        add(`${spr}${fr}`);
        // Rare: no rotation digit
        add(`${spr}${fr}0`);
    }
    // Do not fall back to bare sprite name — that can match an unrelated TEXTURES/PNG entry.

    return candidates;
}
