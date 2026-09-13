import * as vscode from 'vscode';
import * as path from 'path';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { SoundSymbol, SymbolKind } from '../../base/types';
import { locationFromSymbol } from '../../base/symbolLocation';
import { getPk3Root } from '../../shared/pk3Root';
import {
    findSoundDefinitionInText,
    isSndinfoFileName,
} from '../../base/sndinfoParse';
import {
    ActionData,
    ParamData,
    PropertyData,
    findActionCaseInsensitive,
} from '../../shared/dataLoader';

/** ACS playback callables whose string args are SNDINFO logical names (0-based). */
export const ACS_SOUND_ARG_INDEX: Readonly<Record<string, readonly number[]>> = {
    activatorsound: [0],
    ambientsound: [0],
    announcersound: [0],
    localambientsound: [0],
    playsound: [1],
    sectorsound: [0],
    thingsound: [1],
};

export interface SoundArgAtCursor {
    sound: string;
    calleeName: string;
}

export interface SoundPropertyAtCursor {
    sound: string;
    propertyName: string;
}

export function isSoundStringParam(param: ParamData): boolean {
    if (param.type.toLowerCase() !== 'string') {
        return false;
    }
    const n = param.name.toLowerCase();
    return n === 'whattoplay' || n.endsWith('sound');
}

export function isSoundPropertyName(
    propertyName: string,
    propertiesData?: Record<string, PropertyData>
): boolean {
    if (/soundclass$/i.test(propertyName)) {
        return false;
    }
    if (!/(?:^|\.)[A-Za-z_]*Sound$/i.test(propertyName)) {
        return false;
    }
    if (!propertiesData) {
        return true;
    }
    const data = findPropertyCaseInsensitive(propertiesData, propertyName);
    if (!data) {
        return true;
    }
    return data.type.toLowerCase() === 'string';
}

function findPropertyCaseInsensitive(
    propertiesData: Record<string, PropertyData>,
    name: string
): PropertyData | undefined {
    if (propertiesData[name]) {
        return propertiesData[name];
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(propertiesData)) {
        if (key.toLowerCase() === lower) {
            return propertiesData[key];
        }
    }
    return undefined;
}

function soundArgIndices(
    fnName: string,
    actionsData?: Record<string, ActionData>
): number[] | undefined {
    const acs = ACS_SOUND_ARG_INDEX[fnName.toLowerCase()];
    if (acs) {
        return [...acs];
    }
    if (!actionsData) {
        return undefined;
    }
    const data = findActionCaseInsensitive(actionsData, fnName);
    if (!data || !Array.isArray(data.params)) {
        return undefined;
    }
    const params = data.params.filter((p): p is ParamData => typeof p === 'object');
    const indices: number[] = [];
    for (let i = 0; i < params.length; i++) {
        if (isSoundStringParam(params[i])) {
            indices.push(i);
        }
    }
    return indices.length > 0 ? indices : undefined;
}

interface ArgSpan {
    start: number;
    end: number;
    raw: string;
}

function findEnclosingCall(
    lineText: string,
    cursorCol: number
): { fnName: string; openParen: number } | null {
    let openParen = -1;
    let depth = 0;

    for (let i = cursorCol - 1; i >= 0; i--) {
        const ch = lineText[i];
        if (ch === ')') {
            depth++;
        } else if (ch === '(') {
            if (depth === 0) {
                openParen = i;
                break;
            }
            depth--;
        }
    }
    if (openParen < 0) {
        return null;
    }

    let fnEnd = openParen - 1;
    while (fnEnd >= 0 && /\s/.test(lineText[fnEnd])) {
        fnEnd--;
    }
    let fnStart = fnEnd;
    while (fnStart >= 0 && /[A-Za-z0-9_]/.test(lineText[fnStart])) {
        fnStart--;
    }
    fnStart++;
    if (fnStart > fnEnd) {
        return null;
    }
    return { fnName: lineText.slice(fnStart, fnEnd + 1), openParen };
}

function parseTopLevelArgs(lineText: string, openParen: number): ArgSpan[] {
    const args: ArgSpan[] = [];
    let i = openParen + 1;
    let depth = 0;
    let inString = false;
    let argStart = i;

    const pushArg = (end: number) => {
        args.push({ start: argStart, end, raw: lineText.slice(argStart, end) });
    };

    while (i < lineText.length) {
        const ch = lineText[i];
        if (inString) {
            if (ch === '\\' && i + 1 < lineText.length) {
                i += 2;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            i++;
            continue;
        }
        if (ch === '(') {
            depth++;
            i++;
            continue;
        }
        if (ch === ')') {
            if (depth === 0) {
                pushArg(i);
                return args;
            }
            depth--;
            i++;
            continue;
        }
        if (ch === ',' && depth === 0) {
            pushArg(i);
            i++;
            argStart = i;
            continue;
        }
        i++;
    }
    pushArg(i);
    return args;
}

function parseSoundName(raw: string): string | null {
    const t = raw.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        const inner = t.slice(1, -1);
        return inner.length > 0 ? inner : null;
    }
    if (/^[A-Za-z0-9_*][A-Za-z0-9_*-]*$/.test(t)) {
        return t;
    }
    return null;
}

function trimArgRange(
    lineText: string,
    arg: ArgSpan
): { start: number; end: number } {
    let start = arg.start;
    while (start < arg.end && /\s/.test(lineText[start])) {
        start++;
    }
    let end = arg.end;
    while (end > start && /\s/.test(lineText[end - 1])) {
        end--;
    }
    return { start, end };
}

/**
 * Cursor on a SNDINFO logical-name argument of a playback call.
 */
export function extractSoundArgAtCursor(
    lineText: string,
    cursorCol: number,
    actionsData?: Record<string, ActionData>
): SoundArgAtCursor | null {
    const call = findEnclosingCall(lineText, cursorCol);
    if (!call) {
        return null;
    }
    const indices = soundArgIndices(call.fnName, actionsData);
    if (!indices) {
        return null;
    }

    const args = parseTopLevelArgs(lineText, call.openParen);
    for (const index of indices) {
        if (index >= args.length) {
            continue;
        }
        const arg = args[index];
        const range = trimArgRange(lineText, arg);
        if (cursorCol < range.start || cursorCol > range.end) {
            continue;
        }
        const sound = parseSoundName(arg.raw);
        if (!sound) {
            return null;
        }
        return { sound, calleeName: call.fnName };
    }
    return null;
}

/**
 * Cursor on a DECORATE sound property value (`SeeSound "weapons/pistol"`).
 */
export function extractSoundPropertyAtCursor(
    lineText: string,
    cursorCol: number,
    propertiesData?: Record<string, PropertyData>
): SoundPropertyAtCursor | null {
    const m = /^(\s*)((?:[A-Za-z_][\w]*\.)?[A-Za-z_]*Sound)\s+("([^"]*)"|([A-Za-z0-9_*][A-Za-z0-9_*-]*))/i.exec(
        lineText
    );
    if (!m) {
        return null;
    }
    const propertyName = m[2];
    if (!isSoundPropertyName(propertyName, propertiesData)) {
        return null;
    }

    const valueToken = m[3];
    const propEnd = (m.index ?? 0) + m[1].length + propertyName.length;
    const rel = lineText.slice(propEnd).indexOf(valueToken);
    if (rel < 0) {
        return null;
    }
    const valueStart = propEnd + rel;
    const valueEnd = valueStart + valueToken.length;
    if (cursorCol < valueStart || cursorCol > valueEnd) {
        return null;
    }

    const sound = m[4] ?? m[5] ?? '';
    if (!sound) {
        return null;
    }
    return { sound, propertyName };
}

async function findSoundInWorkspace(
    soundName: string,
    token: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return undefined;
    }

    const pk3RootUri = vscode.Uri.joinPath(workspaceFolders[0].uri, getPk3Root());
    const globs = ['**/SNDINFO', '**/SNDINFO.*', '**/sndinfo', '**/sndinfo.*'];
    const found: vscode.Uri[] = [];
    for (const glob of globs) {
        found.push(...await vscode.workspace.findFiles(new vscode.RelativePattern(pk3RootUri, glob)));
    }
    const seen = new Set<string>();
    const uris: vscode.Uri[] = [];
    for (const uri of found) {
        const key = uri.fsPath.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        if (!isSndinfoFileName(path.basename(uri.fsPath))) {
            continue;
        }
        seen.add(key);
        uris.push(uri);
    }

    for (const uri of uris) {
        if (token.isCancellationRequested) {
            return undefined;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const hit = findSoundDefinitionInText(doc.getText(), soundName);
            if (hit) {
                return new vscode.Location(uri, new vscode.Position(hit.line, hit.character));
            }
        } catch {
            // skip unreadable files
        }
    }
    return undefined;
}

/**
 * Resolve a SNDINFO logical name: workspace lumps first, then SymbolDatabase (base PK3).
 */
export async function resolveSoundDefinition(
    soundName: string,
    token: vscode.CancellationToken,
    symbolDb?: SymbolDatabase
): Promise<vscode.Location | undefined> {
    const local = await findSoundInWorkspace(soundName, token);
    if (local) {
        return local;
    }
    if (token.isCancellationRequested) {
        return undefined;
    }
    if (symbolDb) {
        const sym = symbolDb.query<SoundSymbol>(SymbolKind.Sound, soundName);
        if (sym && sym.packageId !== 'builtin') {
            return locationFromSymbol(sym);
        }
    }
    return undefined;
}
