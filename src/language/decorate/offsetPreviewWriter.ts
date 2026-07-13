import * as vscode from 'vscode';

const OFFSET_ARGS_RE = /\bOffset\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i;

export interface OffsetWriteArgs {
    x: number;
    y: number;
}

/**
 * Choose Offset(x,y) numbers to write while preserving keep-axis encoding when possible.
 * `effectiveX/Y` are the desired HUD offsets after the edit.
 * `prevEffectiveX/Y` are the frame's effective offsets before the edit.
 */
export function encodeOffsetWriteback(
    declared: OffsetWriteArgs | null,
    keepX: boolean,
    keepY: boolean,
    effectiveX: number,
    effectiveY: number,
    prevEffectiveX: number,
    prevEffectiveY: number
): OffsetWriteArgs {
    const nx = Math.round(effectiveX);
    const ny = Math.round(effectiveY);

    // Full keep Offset(0,0) is not editable — caller should refuse.
    if (keepX && keepY) {
        return { x: 0, y: 0 };
    }

    // Keep-X only: Offset(0, y) — preserve 0 on X if user did not move X.
    if (keepX && !keepY) {
        if (nx === Math.round(prevEffectiveX)) {
            return { x: 0, y: ny };
        }
        return { x: nx, y: ny };
    }

    // Keep-Y only: Offset(x, 0)
    if (keepY && !keepX) {
        if (ny === Math.round(prevEffectiveY)) {
            return { x: nx, y: 0 };
        }
        return { x: nx, y: ny };
    }

    // Absolute (or no declared — should not happen for edits)
    if (declared) {
        return { x: nx, y: ny };
    }
    return { x: nx, y: ny };
}

/**
 * Replace Offset(x, y) numbers on a DECORATE state line.
 * Only edits lines that already contain Offset(...). Returns false if not found.
 */
export async function applyOffsetEdit(
    document: vscode.TextDocument,
    line: number,
    x: number,
    y: number
): Promise<boolean> {
    if (line < 0 || line >= document.lineCount) {
        return false;
    }

    const lineText = document.lineAt(line).text;
    const match = OFFSET_ARGS_RE.exec(lineText);
    if (!match || match.index === undefined) {
        return false;
    }

    const xi = Math.round(x);
    const yi = Math.round(y);
    const fullStart = match.index;
    const fullEnd = fullStart + match[0].length;
    // Preserve "Offset" casing from source; only rewrite the argument list
    const keywordMatch = /^Offset/i.exec(match[0]);
    const keyword = keywordMatch ? match[0].substring(0, keywordMatch[0].length) : 'Offset';
    const replacement = `${keyword}(${xi}, ${yi})`;

    const range = new vscode.Range(line, fullStart, line, fullEnd);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, replacement);
    return vscode.workspace.applyEdit(edit);
}
