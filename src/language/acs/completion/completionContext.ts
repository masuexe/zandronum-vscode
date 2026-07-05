import * as vscode from 'vscode';

export interface CompletionContext {
    inFunctionCall: boolean;
    functionName?: string;
    paramIndex?: number;
    scope: 'global' | 'script' | 'function' | 'nestedBlock';
    insideString: boolean;
    insideComment: boolean;
    insideInclude: boolean;
    wordPrefix: string;
    braceDepth: number;
}

export function buildCompletionContext(
    document: vscode.TextDocument,
    position: vscode.Position
): CompletionContext {
    const lineText = document.lineAt(position.line).text;
    const textBeforeCursor = lineText.substring(0, position.character);

    let inFunctionCall = false;
    let functionName: string | undefined;
    let paramIndex: number | undefined;
    let insideString = false;
    let insideComment = false;
    let insideInclude = false;

    // Check if inside include path
    const includeMatch = /^\s*#\s*include\s+"([^"]*)$/i.exec(textBeforeCursor);
    if (includeMatch) {
        insideInclude = true;
    }

    // Check if inside string
    let inStr = false;
    let commentStart = false;
    let inBlockComment = false;

    for (let i = 0; i < textBeforeCursor.length; i++) {
        if (inBlockComment) {
            if (textBeforeCursor[i] === '*' && textBeforeCursor[i + 1] === '/') {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (commentStart) {
            continue;
        }
        if (textBeforeCursor[i] === '/' && textBeforeCursor[i + 1] === '*') {
            inBlockComment = true;
            i++;
            continue;
        }
        if (textBeforeCursor[i] === '/' && textBeforeCursor[i + 1] === '/') {
            commentStart = true;
            continue;
        }
        if (textBeforeCursor[i] === '"') {
            inStr = !inStr;
        }
    }

    insideString = inStr;
    insideComment = commentStart || inBlockComment;

    // Find function call info
    let openParen = -1;
    let parenDepth = 0;

    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
        const ch = textBeforeCursor[i];
        if (ch === ')') parenDepth++;
        else if (ch === '(') {
            if (parenDepth === 0) { openParen = i; break; }
            parenDepth--;
        }
    }

    if (openParen >= 0) {
        inFunctionCall = true;

        let fnEnd = openParen - 1;
        while (fnEnd >= 0 && /\s/.test(textBeforeCursor[fnEnd])) fnEnd--;

        let fnStart = fnEnd;
        while (fnStart >= 0 && /\w/.test(textBeforeCursor[fnStart])) fnStart--;
        fnStart++;

        if (fnStart <= fnEnd) {
            functionName = textBeforeCursor.substring(fnStart, fnEnd + 1);

            let commaCount = 0;
            let inStr2 = false;
            let depth = 0;

            for (let i = openParen + 1; i < textBeforeCursor.length; i++) {
                const ch = textBeforeCursor[i];
                if (ch === '"' && !inStr2) { inStr2 = true; continue; }
                if (ch === '"' && inStr2) { inStr2 = false; continue; }
                if (ch === ',' && !inStr2 && depth === 0) commaCount++;
                else if (ch === '(' && !inStr2) depth++;
                else if (ch === ')' && !inStr2) depth--;
            }

            paramIndex = commaCount;
        }
    }

    // Determine scope
    let braceDepth = 0;
    let lastKeyword: string | null = null;

    for (let l = 0; l <= position.line; l++) {
        const t = document.lineAt(l).text;
        for (const ch of t) {
            if (ch === '{') braceDepth++;
            else if (ch === '}') braceDepth--;
            if (braceDepth < 0) braceDepth = 0;
        }

        if (/^\s*function\b/i.test(t)) lastKeyword = 'function';
        if (/^\s*script\b/i.test(t)) lastKeyword = 'script';
    }

    const depthBefore = braceDepth;
    for (const ch of textBeforeCursor) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        if (braceDepth < 0) braceDepth = 0;
    }

    let scope: CompletionContext['scope'] = 'global';
    if (depthBefore > 0 && lastKeyword === 'function') scope = 'function';
    else if (depthBefore > 0 && lastKeyword === 'script') scope = 'script';
    else if (depthBefore > 1) scope = 'nestedBlock';

    // Get word prefix
    let prefix = '';
    let i = position.character - 1;
    while (i >= 0 && /[A-Za-z0-9_]/.test(lineText[i])) {
        prefix = lineText[i] + prefix;
        i--;
    }

    return {
        inFunctionCall,
        functionName,
        paramIndex,
        scope,
        insideString,
        insideComment,
        insideInclude,
        wordPrefix: prefix,
        braceDepth: depthBefore,
    };
}
