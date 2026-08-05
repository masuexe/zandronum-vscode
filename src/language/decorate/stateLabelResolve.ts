import * as vscode from 'vscode';
import {
    ActionData,
    InheritanceData,
    ParamData,
    findActionCaseInsensitive,
    findCallableCaseInsensitive,
    findInheritanceCaseInsensitive,
} from '../../shared/dataLoader';
import { SymbolDatabase } from '../../base/symbolDatabase';
import { ActorSymbol, SymbolKind } from '../../base/types';
import { locationFromSymbol } from '../../base/symbolLocation';
import { findActorSpanInLines } from './renameProvider';
import { parseActorHeader } from './actorUserVars';
import { findLabelAtLine } from './offsetPreviewParser';

const LABEL_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/;
const STATES_RE = /^\s*states\b/i;
const EXCLUDED_LABELS = new Set(['actor', 'states', 'goto', 'loop', 'stop', 'wait', 'fail']);
const STATE_LABEL_PARAM_NAME = /^(label|offset|flash|state)$/i;
const ALT_FIRE_LABELS = new Set(['altfire', 'althold']);
const GUN_FLASH_NAME = /^A_GunFlash$/i;

export interface ActorLineSpan {
    startLine: number;
    endLine: number;
}

export interface LabelPos {
    line: number;
    character: number;
}

export type StateLabelKind = 'goto' | 'jump';

export interface StateLabelAtCursor {
    kind: StateLabelKind;
    label: string;
    /**
     * Set when F12 is on `A_GunFlash` with empty/missing flash arg.
     * Definition provider may try AltFlash↔Flash once if primary miss.
     */
    gunFlashDefault?: boolean;
}

/** Result of cursor-on-`A_GunFlash` name detection. */
export interface GunFlashAtCursor {
    /** Explicit first-arg label, or null when empty/missing (use default). */
    explicitLabel: string | null;
}

function stripLineComment(text: string): string {
    const idx = text.indexOf('//');
    return idx >= 0 ? text.slice(0, idx) : text;
}

/** Whether a callable param is a state-label slot (data-driven). */
export function isStateLabelParam(param: ParamData): boolean {
    if (param.type.toLowerCase() === 'state') {
        return true;
    }
    return STATE_LABEL_PARAM_NAME.test(param.name);
}

/** True when argument index `index` is a state-label slot, including variadic tails. */
export function isStateLabelParamAtIndex(params: ParamData[], index: number): boolean {
    if (params.length === 0 || index < 0) {
        return false;
    }
    if (index < params.length) {
        return isStateLabelParam(params[index]);
    }
    const last = params[params.length - 1];
    return !!(last.variadic && isStateLabelParam(last));
}

/**
 * Collect `Label:` positions inside an actor's States block.
 * Keys are lowercased label names.
 */
export function collectStateLabelsInActor(
    lines: string[],
    actorSpan: ActorLineSpan
): Map<string, LabelPos> {
    const result = new Map<string, LabelPos>();
    let inStates = false;

    for (let l = actorSpan.startLine; l <= actorSpan.endLine && l < lines.length; l++) {
        const text = lines[l];
        const effective = stripLineComment(text);

        if (!inStates) {
            if (STATES_RE.test(effective)) {
                inStates = true;
            }
            continue;
        }

        const lm = LABEL_RE.exec(effective);
        if (!lm) {
            continue;
        }
        const label = lm[1];
        if (EXCLUDED_LABELS.has(label.toLowerCase())) {
            continue;
        }
        const character = text.indexOf(label);
        if (character < 0) {
            continue;
        }
        const key = label.toLowerCase();
        if (!result.has(key)) {
            result.set(key, { line: l, character });
        }
    }

    return result;
}

export function findStateLabelInLines(
    lines: string[],
    actorSpan: ActorLineSpan,
    label: string
): LabelPos | undefined {
    return collectStateLabelsInActor(lines, actorSpan).get(label.toLowerCase());
}

/** Unquoted bare / `"Label"` identifier, or null if not a simple label. */
export function parseSimpleStateLabel(raw: string): string | null {
    const t = raw.trim();
    if (!t) {
        return null;
    }
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
        const inner = t.slice(1, -1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
            return null;
        }
        return inner;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
        return null;
    }
    return t;
}

/**
 * Cursor on `goto Label` / `goto Label+n` (not `Actor::Label` — V1 out of scope).
 */
export function extractGotoLabelAtCursor(lineText: string, cursorCol: number): string | null {
    const m = /^(\s*goto\s+)([A-Za-z_][A-Za-z0-9_]*)/i.exec(lineText);
    if (!m) {
        return null;
    }
    const labelStart = m[1].length;
    const label = m[2];
    const labelEnd = labelStart + label.length;

    const rest = lineText.slice(labelEnd);
    if (/^\s*::/.test(rest)) {
        return null;
    }

    if (cursorCol < labelStart || cursorCol > labelEnd) {
        return null;
    }
    return label;
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

function lookupCallable(
    fnName: string,
    actionsData: Record<string, ActionData>,
    expressionCallables: Record<string, ActionData>
): ActionData | undefined {
    return (
        findCallableCaseInsensitive(expressionCallables, fnName) ??
        findActionCaseInsensitive(actionsData, fnName)
    );
}

/**
 * Cursor on a state-label argument of an action/expression call.
 */
export function extractJumpLabelAtCursor(
    lineText: string,
    cursorCol: number,
    actionsData: Record<string, ActionData>,
    expressionCallables: Record<string, ActionData> = {}
): string | null {
    const call = findEnclosingCall(lineText, cursorCol);
    if (!call) {
        return null;
    }
    const data = lookupCallable(call.fnName, actionsData, expressionCallables);
    if (!data || !Array.isArray(data.params)) {
        return null;
    }
    const params = data.params.filter((p): p is ParamData => typeof p === 'object');
    if (params.length === 0) {
        return null;
    }

    const args = parseTopLevelArgs(lineText, call.openParen);
    let hitIndex = -1;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        // Allow cursor on leading whitespace of the arg up to end
        let start = a.start;
        while (start < a.end && /\s/.test(lineText[start])) {
            start++;
        }
        let end = a.end;
        while (end > start && /\s/.test(lineText[end - 1])) {
            end--;
        }
        if (cursorCol >= start && cursorCol <= end) {
            hitIndex = i;
            break;
        }
        // Also allow cursor in whitespace between args? no
    }
    if (hitIndex < 0) {
        return null;
    }
    if (!isStateLabelParamAtIndex(params, hitIndex)) {
        return null;
    }
    return parseSimpleStateLabel(args[hitIndex].raw);
}

/**
 * Cursor on the `A_GunFlash` identifier (not on an argument).
 * Bare / `()` / `("")` → `explicitLabel: null` (caller uses default Flash/AltFlash).
 */
export function extractGunFlashAtCursor(
    lineText: string,
    cursorCol: number
): GunFlashAtCursor | null {
    let start = cursorCol;
    let end = cursorCol;
    while (start > 0 && /[A-Za-z0-9_]/.test(lineText[start - 1])) {
        start--;
    }
    while (end < lineText.length && /[A-Za-z0-9_]/.test(lineText[end])) {
        end++;
    }
    if (start >= end || cursorCol < start || cursorCol > end) {
        return null;
    }
    const word = lineText.slice(start, end);
    if (!GUN_FLASH_NAME.test(word)) {
        return null;
    }

    let i = end;
    while (i < lineText.length && /\s/.test(lineText[i])) {
        i++;
    }
    if (i >= lineText.length || lineText[i] !== '(') {
        return { explicitLabel: null };
    }

    const args = parseTopLevelArgs(lineText, i);
    if (args.length === 0) {
        return { explicitLabel: null };
    }
    const firstRaw = args[0].raw.trim();
    if (!firstRaw || firstRaw === '""' || firstRaw === "''") {
        return { explicitLabel: null };
    }
    const label = parseSimpleStateLabel(args[0].raw);
    if (!label) {
        return { explicitLabel: null };
    }
    return { explicitLabel: label };
}

/**
 * Default flash label for empty `A_GunFlash`: AltFire/AltHold → AltFlash, else Flash.
 */
export function defaultGunFlashLabel(lines: string[], callLine: number): string {
    const owning = findLabelAtLine(lines, callLine);
    if (owning && ALT_FIRE_LABELS.has(owning.name.toLowerCase())) {
        return 'AltFlash';
    }
    return 'Flash';
}

/**
 * True when the actor's ancestry includes Weapon (document parent + SymbolDatabase + inheritance.json).
 */
export function actorIsWeaponDescendant(
    className: string | undefined,
    parentClass: string | undefined,
    symbolDb?: SymbolDatabase,
    inheritanceData?: Record<string, InheritanceData>
): boolean {
    if (!className && !parentClass) {
        return false;
    }

    const visited = new Set<string>();
    let current: string | undefined = className;
    let usedDocumentParent = false;

    while (current) {
        const key = current.toLowerCase();
        if (visited.has(key)) {
            break;
        }
        visited.add(key);

        if (key === 'weapon') {
            return true;
        }
        if (key === 'actor') {
            break;
        }

        const sym = symbolDb?.query<ActorSymbol>(SymbolKind.Actor, current);
        if (sym?.parentClass) {
            current = sym.parentClass;
            continue;
        }

        if (inheritanceData) {
            const inh = findInheritanceCaseInsensitive(inheritanceData, current);
            if (inh?.extends) {
                current = inh.extends;
                continue;
            }
        }

        if (
            !usedDocumentParent &&
            parentClass &&
            className &&
            key === className.toLowerCase()
        ) {
            usedDocumentParent = true;
            current = parentClass;
            continue;
        }

        break;
    }

    return false;
}

export function extractStateLabelAtCursor(
    lineText: string,
    cursorCol: number,
    actionsData: Record<string, ActionData>,
    expressionCallables: Record<string, ActionData> = {},
    context?: { lines: string[]; lineNumber: number }
): StateLabelAtCursor | null {
    const gotoLabel = extractGotoLabelAtCursor(lineText, cursorCol);
    if (gotoLabel) {
        return { kind: 'goto', label: gotoLabel };
    }
    const jumpLabel = extractJumpLabelAtCursor(
        lineText,
        cursorCol,
        actionsData,
        expressionCallables
    );
    if (jumpLabel) {
        return { kind: 'jump', label: jumpLabel };
    }

    const gunFlash = extractGunFlashAtCursor(lineText, cursorCol);
    if (gunFlash) {
        if (gunFlash.explicitLabel) {
            return { kind: 'jump', label: gunFlash.explicitLabel };
        }
        const label = context
            ? defaultGunFlashLabel(context.lines, context.lineNumber)
            : 'Flash';
        return { kind: 'jump', label, gunFlashDefault: true };
    }

    return null;
}

function documentLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
    }
    return lines;
}

function findActorSpanByName(lines: string[], className: string): ActorLineSpan | null {
    const re = new RegExp(`^\\s*actor\\s+${escapeRegex(className)}\\b`, 'i');
    for (let l = 0; l < lines.length; l++) {
        if (!re.test(lines[l])) {
            continue;
        }
        const span = findActorSpanInLines(lines, l);
        if (span) {
            return span;
        }
    }
    return null;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure same-document resolve: `startClass` then ancestors by header `parentClass`.
 * Never searches descendants (Goto-static / Jump FindState from owning class).
 */
export function resolveStateLabelInLines(
    lines: string[],
    startClass: string,
    startSpan: ActorLineSpan,
    label: string
): LabelPos | undefined {
    const local = findStateLabelInLines(lines, startSpan, label);
    if (local) {
        return local;
    }

    let parent = parseActorHeader(lines[startSpan.startLine] ?? '')?.parentClass;
    const visited = new Set<string>([startClass.toLowerCase()]);

    while (parent && !/^Actor$/i.test(parent)) {
        const key = parent.toLowerCase();
        if (visited.has(key)) {
            break;
        }
        visited.add(key);

        const span = findActorSpanByName(lines, parent);
        if (!span) {
            break;
        }
        const hit = findStateLabelInLines(lines, span, label);
        if (hit) {
            return hit;
        }
        parent = parseActorHeader(lines[span.startLine] ?? '')?.parentClass;
    }

    return undefined;
}

/**
 * Resolve label in `startClass` then ancestors (FindState-style / static Goto owning class).
 * Both Goto and A_Jump* use this walk for IDE F12; never searches descendants.
 */
export async function resolveStateLabelInChain(
    document: vscode.TextDocument,
    startClass: string,
    startSpan: ActorLineSpan,
    label: string,
    symbolDb?: SymbolDatabase,
    token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const lines = documentLines(document);
    const sameDoc = resolveStateLabelInLines(lines, startClass, startSpan, label);
    if (sameDoc) {
        return new vscode.Location(
            document.uri,
            new vscode.Position(sameDoc.line, sameDoc.character)
        );
    }

    if (!symbolDb) {
        return undefined;
    }

    // Ancestors already present in this document were covered; walk DB for other files.
    const visited = new Set<string>([startClass.toLowerCase()]);
    // Mark same-doc ancestors visited so we do not reopen them
    {
        let p = parseActorHeader(lines[startSpan.startLine] ?? '')?.parentClass;
        while (p && !/^Actor$/i.test(p)) {
            const k = p.toLowerCase();
            if (visited.has(k)) {
                break;
            }
            visited.add(k);
            const span = findActorSpanByName(lines, p);
            if (!span) {
                break;
            }
            p = parseActorHeader(lines[span.startLine] ?? '')?.parentClass;
        }
    }

    let current: string | undefined =
        symbolDb.query<ActorSymbol>(SymbolKind.Actor, startClass)?.parentClass ??
        parseActorHeader(lines[startSpan.startLine] ?? '')?.parentClass;

    while (current && !/^Actor$/i.test(current)) {
        if (token?.isCancellationRequested) {
            return undefined;
        }
        const key = current.toLowerCase();
        if (visited.has(key)) {
            const symSkip = symbolDb.query<ActorSymbol>(SymbolKind.Actor, current);
            current = symSkip?.parentClass;
            continue;
        }
        visited.add(key);

        const sym = symbolDb.query<ActorSymbol>(SymbolKind.Actor, current);
        if (!sym || sym.packageId === 'builtin') {
            current = sym?.parentClass;
            continue;
        }

        try {
            const loc = locationFromSymbol(sym);
            const parentDoc = await vscode.workspace.openTextDocument(loc.uri);
            const parentLines = documentLines(parentDoc);
            const span = findActorSpanByName(parentLines, current);
            if (span) {
                const hit = findStateLabelInLines(parentLines, span, label);
                if (hit) {
                    return new vscode.Location(
                        parentDoc.uri,
                        new vscode.Position(hit.line, hit.character)
                    );
                }
            }
            current = sym.parentClass;
        } catch {
            current = sym.parentClass;
        }
    }

    return undefined;
}

export async function resolveStateLabelGoto(
    document: vscode.TextDocument,
    position: vscode.Position,
    label: string,
    symbolDb?: SymbolDatabase,
    token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    return resolveStateLabelFromPosition(document, position, label, symbolDb, token);
}

export async function resolveStateLabelJump(
    document: vscode.TextDocument,
    position: vscode.Position,
    label: string,
    symbolDb?: SymbolDatabase,
    token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    return resolveStateLabelFromPosition(document, position, label, symbolDb, token);
}

async function resolveStateLabelFromPosition(
    document: vscode.TextDocument,
    position: vscode.Position,
    label: string,
    symbolDb?: SymbolDatabase,
    token?: vscode.CancellationToken
): Promise<vscode.Location | undefined> {
    const lines = documentLines(document);
    const span = findActorSpanInLines(lines, position.line);
    if (!span) {
        return undefined;
    }
    const header = parseActorHeader(lines[span.startLine] ?? '');
    if (!header) {
        return undefined;
    }
    return resolveStateLabelInChain(
        document,
        header.name,
        span,
        label,
        symbolDb,
        token
    );
}
