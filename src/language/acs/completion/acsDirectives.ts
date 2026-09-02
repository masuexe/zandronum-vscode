/**
 * ACC file-scope `#` directives from parse.c `Outside()` / `TK_NUMBERSIGN`.
 * Zandronum ACC has no C preprocessor (`#ifdef` / `#ifndef` / `#undef` / `#pragma`).
 * `#region` / `#endregion` are later ZDoom ACC folding markers — omitted.
 */
export interface AcsDirective {
    name: string;
    /** Inserted after `#`; omit to insert the name only. */
    snippet?: string;
    detail: string;
}

export const ACS_DIRECTIVES: readonly AcsDirective[] = [
    { name: 'include', snippet: 'include "$0"', detail: 'Insert ACS source file' },
    { name: 'import', snippet: 'import "$0"', detail: 'Import a compiled library interface' },
    { name: 'library', snippet: 'library "$0"', detail: 'Mark this file as an export library (must be first)' },
    { name: 'define', snippet: 'define ${1:NAME} ${2:0}', detail: 'File-local constant' },
    { name: 'libdefine', snippet: 'libdefine ${1:NAME} ${2:0}', detail: 'Constant kept when this file is imported as a library' },
    { name: 'nocompact', detail: 'Disable bytecode shrinking' },
    { name: 'wadauthor', detail: 'Write a WadAuthor-compatible object' },
    { name: 'nowadauthor', detail: 'Write a WadAuthor-incompatible object' },
    { name: 'encryptstrings', detail: 'Encrypt the string table' },
];

/** True when the cursor is completing the identifier after `#` (not a path or argument). */
export function hashDirectiveNameMatch(
    textBeforeCursor: string
): { hashCol: number; name: string } | null {
    const m = /^(\s*)#(\s*)([A-Za-z_][A-Za-z0-9_]*)?$/.exec(textBeforeCursor);
    if (!m) {
        return null;
    }
    return { hashCol: m[1].length, name: m[3] ?? '' };
}

export function directivesMatchingPrefix(prefix: string): AcsDirective[] {
    const lower = prefix.toLowerCase();
    if (!lower) {
        return [...ACS_DIRECTIVES];
    }
    return ACS_DIRECTIVES.filter((d) => d.name.startsWith(lower));
}
