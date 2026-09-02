import * as vscode from 'vscode';

export interface LineRange {
    startLine: number;
    endLine: number;
    /** When 0 and endLine > startLine, endLine is treated as exclusive (VS Code selection quirk). */
    endCharacter?: number;
}

function leadingWhitespaceLength(line: string): number {
    const m = /^[ \t]*/.exec(line);
    return m ? m[0].length : 0;
}

function rtrimHorizontal(text: string): string {
    return text.replace(/[ \t]+$/, '');
}

function lineHasCode(text: string): boolean {
    return text.slice(leadingWhitespaceLength(text)).length > 0;
}

function endsWithSpace(text: string): boolean {
    const ch = text[text.length - 1];
    return ch === ' ' || ch === '\t';
}

function ensureSpaceBefore(text: string): string {
    if (text.length === 0 || endsWithSpace(text)) {
        return text;
    }
    return `${text} `;
}

function isIdentChar(ch: string): boolean {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '_';
}

/** `Translation"192:192=4:4"` → `Translation "192:192=4:4"`. */
function emitOpeningQuote(out: string): string {
    const last = out[out.length - 1];
    if (last !== undefined && isIdentChar(last)) {
        return `${ensureSpaceBefore(out)}"`;
    }
    return `${out}"`;
}

function resolveLineRange(
    lineCount: number,
    range?: LineRange
): { startLine: number; endLine: number } {
    if (!range) {
        return { startLine: 0, endLine: lineCount - 1 };
    }
    let startLine = Math.max(0, range.startLine);
    let endLine = Math.min(lineCount - 1, range.endLine);
    if (range.endCharacter === 0 && endLine > startLine) {
        endLine--;
    }
    if (startLine > endLine) {
        return { startLine: 0, endLine: -1 };
    }
    return { startLine, endLine };
}

function inRange(line: number, startLine: number, endLine: number): boolean {
    return line >= startLine && line <= endLine;
}

function isCommentStart(line: string, index: number): boolean {
    return line[index] === '/' && (line[index + 1] === '/' || line[index + 1] === '*');
}

function formatSpaceAfterCommaLine(
    line: string,
    inBlockComment: boolean
): { text: string; inBlockComment: boolean } {
    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let inString = false;

    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];

        if (inBlock) {
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            out += line.slice(i);
            break;
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        if (ch === ',') {
            out += ',';
            i++;
            let j = i;
            while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
                j++;
            }
            const atEnd = j >= line.length;
            const startsComment = j < line.length && isCommentStart(line, j);
            if (atEnd || startsComment) {
                out += line.slice(i, j);
                i = j;
                continue;
            }
            out += ' ';
            i = j;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function formatSpaceBeforeOpenBraceLine(
    line: string,
    inBlockComment: boolean
): { text: string; inBlockComment: boolean } {
    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let inString = false;

    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];

        if (inBlock) {
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            out += line.slice(i);
            break;
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        if (ch === '{') {
            out = ensureSpaceBefore(out);
            out += '{';
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function formatSlashSlashComment(comment: string): string {
    let markerLen = 2;
    if (comment[2] === '/' || comment[2] === '!') {
        markerLen = 3;
    }
    const marker = comment.slice(0, markerLen);
    const rest = comment.slice(markerLen);
    const leadWs = /^[ \t]*/.exec(rest)?.[0] ?? '';
    if (leadWs.length >= 2) {
        return comment;
    }
    const body = rest.slice(leadWs.length);
    return body.length === 0 ? marker : `${marker} ${body}`;
}

function emitSlashSlashComment(out: string, comment: string): string {
    const formatted = formatSlashSlashComment(comment);
    if (lineHasCode(rtrimHorizontal(out))) {
        return `${rtrimHorizontal(out)}  ${formatted}`;
    }
    return `${out}${formatted}`;
}

function formatLineCommentSpacingLine(
    line: string,
    inBlockComment: boolean
): { text: string; inBlockComment: boolean } {
    let out = '';
    let i = 0;
    let inBlock = inBlockComment;
    let inString = false;

    while (i < line.length) {
        const ch = line[i];
        const next = line[i + 1];

        if (inBlock) {
            out += ch;
            if (ch === '*' && next === '/') {
                out += next;
                inBlock = false;
                i += 2;
                continue;
            }
            i++;
            continue;
        }

        if (inString) {
            out += ch;
            if (ch === '\\' && next !== undefined) {
                out += next;
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }

        if (ch === '/' && next === '/') {
            return { text: emitSlashSlashComment(out, line.slice(i)), inBlockComment: inBlock };
        }
        if (ch === '/' && next === '*') {
            out += '/*';
            inBlock = true;
            i += 2;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out = emitOpeningQuote(out);
            i++;
            continue;
        }

        out += ch;
        i++;
    }

    return { text: out, inBlockComment: inBlock };
}

function applyLinePass(
    lines: readonly string[],
    startLine: number,
    endLine: number,
    formatLine: (line: string, inBlockComment: boolean) => { text: string; inBlockComment: boolean }
): string[] {
    const out = lines.slice();
    let inBlockComment = false;
    for (let i = 0; i < out.length; i++) {
        const formatted = formatLine(out[i], inBlockComment);
        inBlockComment = formatted.inBlockComment;
        if (inRange(i, startLine, endLine)) {
            out[i] = formatted.text;
        }
    }
    return out;
}

export function formatTexturesLines(
    lines: readonly string[],
    range?: LineRange
): string[] {
    const resolved = resolveLineRange(lines.length, range);
    if (resolved.endLine < resolved.startLine) {
        return lines.slice();
    }
    const commaed = applyLinePass(
        lines,
        resolved.startLine,
        resolved.endLine,
        formatSpaceAfterCommaLine
    );
    const braced = applyLinePass(
        commaed,
        resolved.startLine,
        resolved.endLine,
        formatSpaceBeforeOpenBraceLine
    );
    return applyLinePass(
        braced,
        resolved.startLine,
        resolved.endLine,
        formatLineCommentSpacingLine
    );
}

export function trimTrailingBlankLines(lines: readonly string[]): string[] {
    const out = lines.slice();
    while (out.length > 0 && out[out.length - 1].trim().length === 0) {
        out.pop();
    }
    return out;
}

export function buildFormattedDocumentText(lines: readonly string[], eol: string): string {
    const trimmed = trimTrailingBlankLines(lines);
    if (trimmed.length === 0) {
        return eol;
    }
    return trimmed.join(eol) + eol;
}

function documentEol(document: vscode.TextDocument): string {
    return document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function editsFromDocument(document: vscode.TextDocument, range?: vscode.Range): vscode.TextEdit[] {
    const original: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        original.push(document.lineAt(i).text);
    }

    const lineRange: LineRange | undefined = range
        ? {
            startLine: range.start.line,
            endLine: range.end.line,
            endCharacter: range.end.character,
        }
        : undefined;

    const formatted = formatTexturesLines(original, lineRange);
    const eol = documentEol(document);

    if (!lineRange) {
        const oldText = document.getText();
        const newText = buildFormattedDocumentText(formatted, eol);
        if (newText === oldText) {
            return [];
        }
        return [
            vscode.TextEdit.replace(
                new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(oldText.length)
                ),
                newText
            ),
        ];
    }

    const resolved = resolveLineRange(original.length, lineRange);
    if (resolved.endLine < resolved.startLine) {
        return [];
    }
    const replacement = formatted.slice(resolved.startLine, resolved.endLine + 1).join(eol);
    const prior = original.slice(resolved.startLine, resolved.endLine + 1).join(eol);
    if (replacement === prior) {
        return [];
    }
    return [
        vscode.TextEdit.replace(
            new vscode.Range(
                resolved.startLine,
                0,
                resolved.endLine,
                original[resolved.endLine].length
            ),
            replacement
        ),
    ];
}

export function registerTexturesFormattingProvider(context: vscode.ExtensionContext): void {
    const selector: vscode.DocumentSelector = [{ language: 'textures' }];
    const provider: vscode.DocumentFormattingEditProvider & vscode.DocumentRangeFormattingEditProvider = {
        provideDocumentFormattingEdits(document) {
            return editsFromDocument(document);
        },
        provideDocumentRangeFormattingEdits(document, range) {
            return editsFromDocument(document, range);
        },
    };

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider(selector, provider),
        vscode.languages.registerDocumentRangeFormattingEditProvider(selector, provider)
    );
}
