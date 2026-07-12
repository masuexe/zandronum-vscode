import * as vscode from 'vscode';

const OFFSET_ARGS_RE = /\bOffset\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i;

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
