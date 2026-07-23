import { ParamData } from '../../shared/dataLoader';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { AcsScriptSymbol, SymbolKind } from '../../base/types';
import { symbolSourceDetail } from '../../base/symbolLocation';
import {
    SCRIPT_ARG_OVERLAY_FUNCTIONS,
    SCRIPT_EXEC_FUNCTIONS,
    extractScriptArgAtCursor,
} from './definitionProvider';
import * as vscode from 'vscode';

/**
 * First argument of a NamedExecute / CallACS / Execute call, regardless of cursor param index.
 * Accepts a call snippet starting at the function name, e.g.
 * ACS_NamedExecute("GiveAmmo", 0, tid
 */
export function parseFirstScriptArg(callText: string): string | null {
    const trimmed = callText.trimStart();
    const header = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
    if (!header) {
        return null;
    }
    const fnName = header[1].toLowerCase();
    if (!SCRIPT_EXEC_FUNCTIONS.has(fnName)) {
        return null;
    }

    const openParen = trimmed.indexOf('(', header.index!);
    if (openParen < 0) {
        return null;
    }

    let i = openParen + 1;
    while (i < trimmed.length && /\s/.test(trimmed[i])) {
        i++;
    }
    if (i >= trimmed.length) {
        return null;
    }

    if (trimmed[i] === '"') {
        i++;
        let value = '';
        while (i < trimmed.length) {
            const ch = trimmed[i];
            if (ch === '\\' && i + 1 < trimmed.length) {
                value += trimmed[i + 1];
                i += 2;
                continue;
            }
            if (ch === '"') {
                return value;
            }
            value += ch;
            i++;
        }
        return null;
    }

    let end = i;
    while (end < trimmed.length && /[A-Za-z0-9_]/.test(trimmed[end])) {
        end++;
    }
    if (end === i) {
        return null;
    }
    // First arg must end at comma/close or whitespace before those (no expressions)
    let probe = end;
    while (probe < trimmed.length && /\s/.test(trimmed[probe])) {
        probe++;
    }
    if (probe < trimmed.length && trimmed[probe] !== ',' && trimmed[probe] !== ')') {
        return null;
    }
    return trimmed.slice(i, end);
}

export function lookupAcsScript(
    db: SymbolDatabase,
    key: string
): AcsScriptSymbol | undefined {
    if (!key) {
        return undefined;
    }
    return db.query<AcsScriptSymbol>(SymbolKind.AcsScript, key);
}

function isMapSlot(param: ParamData): boolean {
    return /^(map|mapnum)$/i.test(param.name);
}

function isArgOverlaySlot(param: ParamData): boolean {
    return /^(s_)?arg\d+$/i.test(param.name);
}

/**
 * Keep engine wrapper slots; replace generic arg1… with the script’s declared params.
 * Signature arity stays capped to `baseParams.length`.
 */
export function enrichNamedExecuteParams(
    baseParams: ParamData[],
    script: AcsScriptSymbol
): ParamData[] {
    if (!Array.isArray(baseParams) || baseParams.length === 0) {
        return baseParams;
    }

    const result = baseParams.map(p => ({ ...p }));
    let overlayStart = 1;
    if (result.length > 1 && isMapSlot(result[1])) {
        overlayStart = 2;
    } else if (result.length > 1 && !isArgOverlaySlot(result[1]) && !/^script$/i.test(result[1].name)) {
        // Unusual layout: still try to overlay from first s_arg/argN slot
        const idx = result.findIndex((p, i) => i > 0 && isArgOverlaySlot(p));
        if (idx > 0) {
            overlayStart = idx;
        }
    }

    const scriptParams = script.params;
    for (let i = 0; i < result.length - overlayStart; i++) {
        const slot = result[overlayStart + i];
        if (i < scriptParams.length) {
            const sp = scriptParams[i];
            slot.name = sp.name;
            slot.type = sp.type;
            if (!slot.desc) {
                slot.desc = `Script parameter: ${sp.type} ${sp.name}`;
            }
        }
    }

    return result;
}

export function scriptParamsBeyondArity(
    baseParams: ParamData[],
    script: AcsScriptSymbol
): { name: string; type: string }[] {
    let overlayStart = 1;
    if (baseParams.length > 1 && isMapSlot(baseParams[1])) {
        overlayStart = 2;
    } else {
        const idx = baseParams.findIndex((p, i) => i > 0 && isArgOverlaySlot(p));
        if (idx > 0) {
            overlayStart = idx;
        }
    }
    const capacity = Math.max(0, baseParams.length - overlayStart);
    if (script.params.length <= capacity) {
        return [];
    }
    return script.params.slice(capacity);
}

export function isScriptExecFunction(name: string): boolean {
    return SCRIPT_EXEC_FUNCTIONS.has(name.toLowerCase());
}

export function canOverlayScriptArgs(name: string): boolean {
    return SCRIPT_ARG_OVERLAY_FUNCTIONS.has(name.toLowerCase());
}

/** Build call snippet from a line given the function name’s start column. */
export function callTextFromLine(lineText: string, fnNameStart: number): string {
    return lineText.slice(fnNameStart);
}

/**
 * Resolve enriched params + optional script for hover/signature.
 * Returns undefined params enrichment when script not found (caller keeps static JSON).
 */
export function resolveNamedScriptOverlay(
    functionName: string,
    baseParams: ParamData[],
    callText: string | null | undefined,
    symbolDb: SymbolDatabase | undefined
): {
    params: ParamData[];
    script?: AcsScriptSymbol;
    extraScriptParams: { name: string; type: string }[];
} {
    const params = Array.isArray(baseParams) ? baseParams : [];
    if (!symbolDb || !callText || !isScriptExecFunction(functionName)) {
        return { params, extraScriptParams: [] };
    }

    const key = parseFirstScriptArg(callText);
    if (!key) {
        return { params, extraScriptParams: [] };
    }

    const script = lookupAcsScript(symbolDb, key);
    if (!script) {
        return { params, extraScriptParams: [] };
    }

    if (!canOverlayScriptArgs(functionName)) {
        return { params, script, extraScriptParams: [] };
    }

    return {
        params: enrichNamedExecuteParams(params, script),
        script,
        extraScriptParams: scriptParamsBeyondArity(params, script),
    };
}

/**
 * Hover when the cursor is on the first script argument of a SCRIPT_EXEC call.
 * Returns null when not in that context.
 */
export function tryScriptNameHover(
    lineText: string,
    line: number,
    cursorCol: number,
    symbolDb: SymbolDatabase | undefined,
    languageId: 'acs' | 'decorate'
): vscode.Hover | null {
    if (!symbolDb) {
        return null;
    }

    const hit = extractScriptArgAtCursor(lineText, cursorCol);
    if (!hit) {
        return null;
    }

    const script = lookupAcsScript(symbolDb, hit.key);
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    if (script) {
        const paramSig =
            script.params.length > 0
                ? script.params.map(p => `${p.type} ${p.name}`).join(', ')
                : 'void';
        const displayKey = /^\d+$/.test(script.scriptKey)
            ? script.scriptKey
            : `"${script.scriptKey}"`;
        md.appendCodeblock(`script ${displayKey}(${paramSig})`, 'acs');
        md.appendMarkdown(`\n\n**Source:** ${symbolSourceDetail(script)}`);
        if (script.entryPath) {
            md.appendMarkdown(`\n\n\`${script.entryPath}\``);
        }
        if (script.params.length > 0) {
            md.appendMarkdown('\n\n**Parameters:**\n\n');
            for (const p of script.params) {
                md.appendMarkdown(`- \`${p.type} ${p.name}\`\n`);
            }
        }
    } else {
        const displayKey = /^\d+$/.test(hit.key) ? hit.key : `"${hit.key}"`;
        md.appendCodeblock(`script ${displayKey}`, languageId);
        md.appendMarkdown('\n\nScript not found in the symbol index (workspace / base resources).');
    }

    md.appendMarkdown(`\n\nUsed as argument of \`${hit.calleeName}\`.`);

    const range = new vscode.Range(line, hit.argStart, line, hit.argEnd);
    return new vscode.Hover(md, range);
}
