import * as vscode from 'vscode';
import {
    ActionData,
    FlagData,
    ParamData,
    PropertyData,
    StateKeywordData,
    getActionUsage,
    getActions,
    getFlagCombos,
    getFlags,
    getProperties,
    getStateKeywords,
} from '../../shared/dataLoader';
import {
    ActorLineSpan,
    collectStateLabelsInActor,
    isStateLabelParamAtIndex,
} from './stateLabelResolve';
import { FLOW_RE, STATE_LINE_RE } from './offsetPreviewParser';

/**
 * Lightweight static linter for DECORATE (Zandronum / ZDoom 2.8).
 *
 * The linter is a line scanner, not an AST: it tracks actor / States blocks with
 * brace depth and validates every token against the authoritative JSON metadata
 * in `data/decorate/`. All metadata lookups are cached as lowercased Sets/Maps so
 * each token costs O(1). Zandronum DECORATE is case-insensitive.
 */

export type DecorateLintSeverity = 'error' | 'warning';

export interface DecorateLintDiagnostic {
    /** Zero-based line. */
    line: number;
    startCharacter: number;
    endCharacter: number;
    severity: DecorateLintSeverity;
    message: string;
}

export interface DecorateLintSourceData {
    actions: Record<string, ActionData>;
    properties: Record<string, PropertyData>;
    flags: Record<string, FlagData>;
    flagCombos: Record<string, unknown>;
    stateKeywords: Record<string, StateKeywordData>;
}

export interface DecorateLintMeta {
    /** Lowercased actor property names. */
    properties: Set<string>;
    /** Lowercased actor flags and flag combos. */
    flags: Set<string>;
    /** Lowercased state callables (actions + line specials). */
    actions: Map<string, ActionData>;
    /** Lowercased state modifier keywords (Bright, Offset, ...). */
    stateKeywords: Set<string>;
}

export function buildLintMeta(data: DecorateLintSourceData): DecorateLintMeta {
    const properties = new Set<string>();
    for (const name of Object.keys(data.properties)) {
        properties.add(name.toLowerCase());
    }

    const flags = new Set<string>();
    // flags.json stores class-scoped flags as `CLASS.FLAG` (INVENTORY.INVBAR), but
    // DECORATE writes the bare name in `+FLAG`. Accept both spellings.
    const addFlag = (name: string) => {
        const lower = name.toLowerCase();
        flags.add(lower);
        const dot = lower.lastIndexOf('.');
        if (dot >= 0) {
            flags.add(lower.slice(dot + 1));
        }
    };
    for (const name of Object.keys(data.flags)) {
        addFlag(name);
    }
    for (const name of Object.keys(data.flagCombos)) {
        addFlag(name);
    }

    const actions = new Map<string, ActionData>();
    for (const [name, actionData] of Object.entries(data.actions)) {
        actions.set(name.toLowerCase(), actionData);
    }

    const stateKeywords = new Set<string>();
    for (const name of Object.keys(data.stateKeywords)) {
        stateKeywords.add(name.toLowerCase());
    }

    return { properties, flags, actions, stateKeywords };
}

// Actor names in real mods may contain punctuation (MM8BDM uses `FlameSword2?`) and a
// legacy DoomEdNum may follow the header (`actor CutmanProp 11643`).
const ACTOR_HEADER_RE = /^\s*actor\s+([^\s{:]+)(?:\s*:\s*([^\s{]+))?/i;
const ZSCRIPT_CLASS_RE = /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*/i;
const FLAG_RE = /^\s*([+-])([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const PROPERTY_RE = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\b/;
/** `Label:`, optionally followed by the first state frame on the same line. */
const LABEL_LINE_RE = /^(\s*)([^\s{}:]+)\s*:([\s\S]*)$/;
const GOTO_RE = /^\s*goto\b\s*(.*)$/i;
const DECLARATION_RE = /^\s*(?:var|const)\b/i;
const JUMP_ACTION_RE = /^a_jump/i;

/**
 * Unquoted state label path. Zandronum's CMode scanner (sc_man_scanner.re TOKC2)
 * allows only A-Z a-z 0-9 _ ' inside a segment; '.' joins segments.
 */
const VALID_LABEL_RE = /^[A-Za-z0-9_']+(?:\.[A-Za-z0-9_']+)*$/;

/** Target words that are flow keywords rather than labels. */
const RESERVED_FLOW_TARGETS = new Set(['stop', 'wait', 'fail', 'loop', 'none', '*']);

const LINT_ENABLED_SETTING = 'decorate.linting.enabled';
const CONFIG_SECTION = 'zandronum-vscode';
const CHANGE_DEBOUNCE_MS = 300;

interface ParsedActor {
    name: string;
    parent: string;
    /** Line of the actor header. */
    startLine: number;
    /** Line that contains the opening '{'. */
    bodyStart: number;
    /** Column of the opening '{' on `bodyStart`. */
    bodyStartColumn: number;
    /** Line of the matching closing '}'. */
    endLine: number;
}

interface PendingTarget {
    label: string;
    line: number;
    startCharacter: number;
    endCharacter: number;
}

interface ScannedCall {
    name: string;
    /** Offset of the identifier inside the scanned text. */
    nameStart: number;
    hasParens: boolean;
    /** Raw text between the parentheses, or null when the call has none. */
    argsText: string | null;
    /** Offset of the first argument inside the scanned text. */
    argsStart: number;
}

interface CallArgument {
    text: string;
    start: number;
    end: number;
}

/**
 * Blank out `//` line comments and `/* ... *\/` block comments while keeping
 * columns intact, so diagnostic ranges still point at the original text.
 *
 * DECORATE has no `;` comment: the engine scanner treats `;` as a token (it ends
 * `var`/`const` declarations), so it is not stripped here.
 */
export function stripDecorateComments(lines: string[]): string[] {
    const result: string[] = [];
    let inBlockComment = false;

    for (const line of lines) {
        const chars = line.split('');
        let index = 0;
        let quote: string | null = null;

        while (index < chars.length) {
            const char = chars[index];

            if (inBlockComment) {
                const end = line.indexOf('*/', index);
                if (end < 0) {
                    blankRange(chars, index, chars.length);
                    index = chars.length;
                } else {
                    blankRange(chars, index, end + 2);
                    index = end + 2;
                    inBlockComment = false;
                }
                continue;
            }

            if (quote) {
                if (char === quote) {
                    quote = null;
                }
                index++;
                continue;
            }

            // DECORATE strings use double quotes only; a single quote is a valid
            // unquoted state-label character, so it must not open a string here.
            if (char === '"') {
                quote = char;
                index++;
                continue;
            }

            if (char === '/' && line.startsWith('/*', index)) {
                blankRange(chars, index, index + 2);
                index += 2;
                inBlockComment = true;
                continue;
            }

            if (char === '/' && line.startsWith('//', index)) {
                blankRange(chars, index, chars.length);
                index = chars.length;
                continue;
            }

            index++;
        }

        result.push(chars.join(''));
    }

    return result;
}

function blankRange(chars: string[], from: number, to: number): void {
    for (let i = from; i < to && i < chars.length; i++) {
        chars[i] = ' ';
    }
}

/** Enter at an opening quote; return the index after the closing quote. */
function skipQuoted(text: string, start: number): number {
    const quote = text[start];
    let index = start + 1;
    while (index < text.length) {
        if (text[index] === quote) {
            return index + 1;
        }
        index++;
    }
    return text.length;
}

/** Index of the ')' that matches the '(' at `openIndex`, or -1. */
function findMatchingParen(text: string, openIndex: number): number {
    let depth = 0;
    for (let index = openIndex; index < text.length; index++) {
        const char = text[index];
        if (char === '"') {
            index = skipQuoted(text, index) - 1;
            continue;
        }
        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

/** Identifiers that start a call at parenthesis depth 0 (nested calls are skipped). */
function scanTopLevelCalls(text: string): ScannedCall[] {
    const calls: ScannedCall[] = [];
    let index = 0;

    while (index < text.length) {
        const char = text[index];

        if (char === '"') {
            index = skipQuoted(text, index);
            continue;
        }

        if (!isIdentifierStart(char)) {
            index++;
            continue;
        }

        let end = index + 1;
        while (end < text.length && isIdentifierPart(text[end])) {
            end++;
        }
        const name = text.slice(index, end);

        let afterName = end;
        while (afterName < text.length && isWhitespace(text[afterName])) {
            afterName++;
        }

        if (text[afterName] === '(') {
            const close = findMatchingParen(text, afterName);
            calls.push({
                name,
                nameStart: index,
                hasParens: true,
                argsText: close >= 0 ? text.slice(afterName + 1, close) : text.slice(afterName + 1),
                argsStart: afterName + 1,
            });
            index = close >= 0 ? close + 1 : text.length;
            continue;
        }

        calls.push({
            name,
            nameStart: index,
            hasParens: false,
            argsText: null,
            argsStart: afterName,
        });
        index = end;
    }

    return calls;
}

function isIdentifierStart(char: string): boolean {
    return (char >= 'A' && char <= 'Z')
        || (char >= 'a' && char <= 'z')
        || char === '_';
}

function isIdentifierPart(char: string): boolean {
    return isIdentifierStart(char) || (char >= '0' && char <= '9');
}

function isWhitespace(char: string): boolean {
    return char === ' ' || char === '\t';
}

/** Split a call argument list on top-level commas only. */
function splitTopLevelArgs(argsText: string): CallArgument[] {
    const args: CallArgument[] = [];
    let depth = 0;
    let argStart = 0;

    const pushArg = (end: number) => {
        const raw = argsText.slice(argStart, end);
        if (raw.trim().length > 0) {
            const leading = raw.length - raw.trimStart().length;
            args.push({ text: raw.trim(), start: argStart + leading, end });
        }
        argStart = end + 1;
    };

    for (let index = 0; index < argsText.length; index++) {
        const char = argsText[index];
        if (char === '"') {
            index = skipQuoted(argsText, index) - 1;
            continue;
        }
        if (char === '(') {
            depth++;
            continue;
        }
        if (char === ')') {
            depth--;
            continue;
        }
        if (char === ',' && depth === 0) {
            pushArg(index);
        }
    }

    pushArg(argsText.length);
    return args;
}

function unquoteArgument(text: string): string | null {
    const match = /^"([^"]*)"$/.exec(text.trim());
    return match ? match[1] : null;
}

/** Normalize a goto / jump target: strip the +N offset, reject sentinels. */
function normalizeTargetLabel(label: string): string | null {
    const trimmed = label.trim();
    if (!trimmed) {
        return null;
    }
    const base = trimmed.replace(/\s*\+\s*\d+$/, '');
    if (!base || base.includes('::')) {
        return null;
    }
    if (RESERVED_FLOW_TARGETS.has(base.toLowerCase())) {
        return null;
    }
    if (!VALID_LABEL_RE.test(base)) {
        return null;
    }
    return base;
}

/** Skip a quoted string if the text at `index` starts one. */
function skipStringAt(text: string, index: number): number {
    return text[index] === '"' ? skipQuoted(text, index) : index;
}

/** Find all actor blocks; report their brace spans. */
function findActorBlocks(lines: string[]): ParsedActor[] {
    const actors: ParsedActor[] = [];
    let lineIndex = 0;

    while (lineIndex < lines.length) {
        const header = ACTOR_HEADER_RE.exec(lines[lineIndex]);
        if (!header) {
            lineIndex++;
            continue;
        }

        const actor: ParsedActor = {
            name: header[1],
            parent: header[2] ?? '',
            startLine: lineIndex,
            bodyStart: -1,
            bodyStartColumn: 0,
            endLine: lineIndex,
        };

        let depth = 0;
        let opened = false;
        let firstBraceColumn = header[0].length;
        let done = false;

        for (let line = lineIndex; line < lines.length && !done; line++) {
            const text = lines[line];
            const startColumn = line === lineIndex ? firstBraceColumn : 0;

            for (let column = startColumn; column < text.length; column++) {
                const char = text[column];
                if (char === '"') {
                    column = skipStringAt(text, column) - 1;
                    continue;
                }
                if (char === '{') {
                    if (!opened) {
                        opened = true;
                        actor.bodyStart = line;
                        actor.bodyStartColumn = column;
                    }
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (opened && depth <= 0) {
                        actor.endLine = line;
                        done = true;
                        break;
                    }
                }
            }
        }

        if (!opened) {
            lineIndex++;
            continue;
        }

        actors.push(actor);
        lineIndex = actor.endLine + 1;
    }

    return actors;
}

export function lintDecorateLines(lines: string[], meta: DecorateLintMeta): DecorateLintDiagnostic[] {
    const cleaned = stripDecorateComments(lines);
    const diagnostics: DecorateLintDiagnostic[] = [];
    const targetsByActor = new Map<ParsedActor, PendingTarget[]>();
    const labelsByActor = new Map<ParsedActor, Set<string>>();
    const actors = findActorBlocks(cleaned);

    checkZScriptDeclarations(cleaned, diagnostics);

    for (const actor of actors) {
        const targets: PendingTarget[] = [];
        const labels = new Set<string>();
        targetsByActor.set(actor, targets);
        labelsByActor.set(actor, labels);
        scanActorBody(cleaned, actor, meta, diagnostics, targets, labels);
    }

    resolveTargets(cleaned, actors, diagnostics, targetsByActor, labelsByActor);
    return diagnostics;
}

function checkZScriptDeclarations(lines: string[], diagnostics: DecorateLintDiagnostic[]): void {
    for (let line = 0; line < lines.length; line++) {
        const match = ZSCRIPT_CLASS_RE.exec(lines[line]);
        if (!match) {
            continue;
        }
        const text = lines[line];
        const start = text.toLowerCase().indexOf('class');
        diagnostics.push({
            line,
            startCharacter: start,
            endCharacter: start + match[0].trim().length,
            severity: 'warning',
            message: "ZScript is not supported in Zandronum. Use DECORATE 'actor <Name> [: <Parent>]' instead.",
        });
    }
}

function scanActorBody(
    lines: string[],
    actor: ParsedActor,
    meta: DecorateLintMeta,
    diagnostics: DecorateLintDiagnostic[],
    targets: PendingTarget[],
    labels: Set<string>
): void {
    let inStates = false;

    for (let line = actor.bodyStart; line <= actor.endLine; line++) {
        const source = lines[line];
        const text = line === actor.bodyStart
            ? ' '.repeat(actor.bodyStartColumn + 1) + source.slice(actor.bodyStartColumn + 1)
            : source;
        const trimmed = text.trim();
        if (!trimmed) {
            continue;
        }

        if (!inStates) {
            // Compact actors may open States on a line that already holds properties
            // (`Scale 2.0 States { Spawn: ...`), so search the whole line.
            const statesIndex = findKeywordOutsideQuotes(text, 'states');
            if (statesIndex >= 0) {
                inStates = true;
                const contentStart = skipKeywordBraces(text, statesIndex + 'states'.length);
                if (text.slice(contentStart).trim()) {
                    scanStateLine(
                        ' '.repeat(contentStart) + text.slice(contentStart),
                        line,
                        meta,
                        diagnostics,
                        targets,
                        labels
                    );
                }
                continue;
            }
            if (trimmed.startsWith('{') || trimmed.startsWith('}')) {
                continue;
            }
            checkActorBodyLine(text, trimmed, line, meta, diagnostics);
            continue;
        }

        if (trimmed.startsWith('}')) {
            inStates = false;
            continue;
        }

        scanStateLine(text, line, meta, diagnostics, targets, labels);
    }
}

/** Index of the first `keyword` word outside quoted strings, or -1. */
function findKeywordOutsideQuotes(text: string, keyword: string): number {
    const wanted = keyword.toLowerCase();
    let index = 0;
    while (index < text.length) {
        const char = text[index];
        if (char === '"') {
            index = skipQuoted(text, index);
            continue;
        }
        if (!isIdentifierStart(char)) {
            index++;
            continue;
        }
        let end = index + 1;
        while (end < text.length && isIdentifierPart(text[end])) {
            end++;
        }
        if (text.slice(index, end).toLowerCase() === wanted) {
            return index;
        }
        index = end;
    }
    return -1;
}

/** Skip spaces and one optional `{` after a `States` keyword. */
function skipKeywordBraces(text: string, from: number): number {
    let index = from;
    while (index < text.length && isWhitespace(text[index])) {
        index++;
    }
    if (text[index] === '{') {
        index++;
    }
    return index;
}

function checkActorBodyLine(
    text: string,
    trimmed: string,
    line: number,
    meta: DecorateLintMeta,
    diagnostics: DecorateLintDiagnostic[]
): void {
    if (trimmed.startsWith('#') || DECLARATION_RE.test(trimmed)) {
        return;
    }

    const flagMatch = FLAG_RE.exec(trimmed);
    if (flagMatch) {
        const flagName = flagMatch[2];
        if (!meta.flags.has(flagName.toLowerCase())) {
            const start = text.indexOf(flagName);
            diagnostics.push({
                line,
                startCharacter: start,
                endCharacter: start + flagName.length,
                severity: 'warning',
                message: `Unknown actor flag '${flagName}'.`,
            });
        }
        return;
    }

    const propertyMatch = PROPERTY_RE.exec(trimmed);
    if (!propertyMatch) {
        return;
    }

    const propertyName = propertyMatch[1];
    if (!meta.properties.has(propertyName.toLowerCase())) {
        const start = text.indexOf(propertyName);
        diagnostics.push({
            line,
            startCharacter: start,
            endCharacter: start + propertyName.length,
            severity: 'warning',
            message: `Unknown actor property '${propertyName}'.`,
        });
    }
}

function scanStateLine(
    text: string,
    line: number,
    meta: DecorateLintMeta,
    diagnostics: DecorateLintDiagnostic[],
    targets: PendingTarget[],
    labels: Set<string>
): void {
    const trimmed = text.trim();

    const flow = FLOW_RE.exec(trimmed);
    if (flow && isFlowLine(flow[1], trimmed.slice(flow[0].length))) {
        if (flow[1].toLowerCase() === 'goto') {
            collectGotoTarget(text, line, targets);
        }
        return;
    }

    const labelMatch = LABEL_LINE_RE.exec(text);
    if (labelMatch) {
        const label = labelMatch[2];
        const start = labelMatch[1].length;
        if (VALID_LABEL_RE.test(label)) {
            labels.add(label.toLowerCase());
        } else {
            diagnostics.push({
                line,
                startCharacter: start,
                endCharacter: start + label.length,
                severity: 'error',
                message: `Invalid state label name '${label}'. In Zandronum CMode, unquoted labels may only contain A-Z, a-z, 0-9, underscore, and apostrophe.`,
            });
        }
        const tail = labelMatch[3];
        if (tail.trim()) {
            const tailStart = text.length - tail.length;
            scanFrameLine(' '.repeat(tailStart) + tail, line, meta, diagnostics, targets);
        }
        return;
    }

    scanFrameLine(text, line, meta, diagnostics, targets);
}

/** `stop`/`loop`/`wait`/`fail` may be followed only by closing braces. */
function isFlowLine(keyword: string, rest: string): boolean {
    const tail = rest.trim();
    if (keyword.toLowerCase() === 'goto') {
        return true;
    }
    return tail.length === 0 || /^}+$/.test(tail);
}

function scanFrameLine(
    text: string,
    line: number,
    meta: DecorateLintMeta,
    diagnostics: DecorateLintDiagnostic[],
    targets: PendingTarget[]
): void {
    const frameMatch = STATE_LINE_RE.exec(text);
    if (!frameMatch) {
        return;
    }

    const sprite = stripQuotes(frameMatch[1]);
    if (sprite.length !== 4) {
        const start = text.indexOf(frameMatch[1]);
        diagnostics.push({
            line,
            startCharacter: start,
            endCharacter: start + frameMatch[1].length,
            severity: 'warning',
            message: `Invalid sprite name '${sprite}'. DECORATE sprite names must be exactly 4 characters.`,
        });
    }

    const rest = frameMatch[4] ?? '';
    if (!rest.trim()) {
        return;
    }
    const restStart = frameMatch.index + frameMatch[0].length - rest.length;

    for (const call of scanTopLevelCalls(rest)) {
        validateActionCall(call, rest, restStart, line, meta, diagnostics, targets);
    }
}

function stripQuotes(token: string): string {
    if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
        return token.slice(1, -1);
    }
    return token;
}

function validateActionCall(
    call: ScannedCall,
    rest: string,
    restStart: number,
    line: number,
    meta: DecorateLintMeta,
    diagnostics: DecorateLintDiagnostic[],
    targets: PendingTarget[]
): void {
    const lower = call.name.toLowerCase();
    if (meta.stateKeywords.has(lower)) {
        return;
    }

    const data = meta.actions.get(lower);
    const looksLikeAction = lower.startsWith('a_') || data !== undefined || call.hasParens;
    if (!looksLikeAction) {
        return;
    }

    const actionStart = restStart + call.nameStart;
    if (!data) {
        diagnostics.push({
            line,
            startCharacter: actionStart,
            endCharacter: actionStart + call.name.length,
            severity: 'warning',
            message: `Unknown action function '${call.name}'.`,
        });
        return;
    }

    if (!getActionUsage(data).includes('state')) {
        diagnostics.push({
            line,
            startCharacter: actionStart,
            endCharacter: actionStart + call.name.length,
            severity: 'warning',
            message: `Action function '${call.name}' is only valid in expressions, not as a state action.`,
        });
        return;
    }

    const params = toParamList(data);
    const argCount = call.argsText === null ? 0 : splitTopLevelArgs(call.argsText).length;
    const requiredCount = params.filter(param => !param.optional && !param.variadic).length;
    const variadic = params.some(param => param.variadic);
    const maxCount = variadic ? Infinity : params.length;

    if (argCount < requiredCount) {
        diagnostics.push({
            line,
            startCharacter: actionStart,
            endCharacter: actionStart + call.name.length,
            severity: 'warning',
            message: `Action '${call.name}' expects at least ${requiredCount} argument(s), got ${argCount}.`,
        });
    } else if (argCount > maxCount) {
        diagnostics.push({
            line,
            startCharacter: actionStart,
            endCharacter: actionStart + call.name.length,
            severity: 'warning',
            message: `Action '${call.name}' expects at most ${maxCount} argument(s), got ${argCount}.`,
        });
    }

    if (JUMP_ACTION_RE.test(lower) && call.argsText !== null) {
        collectJumpTargets(call, rest, restStart, params, line, targets);
    }
}

function toParamList(data: ActionData): ParamData[] {
    if (!Array.isArray(data.params)) {
        return [];
    }
    return data.params.filter((param): param is ParamData => typeof param === 'object' && param !== null);
}

function collectGotoTarget(text: string, line: number, targets: PendingTarget[]): void {
    const match = GOTO_RE.exec(text);
    if (!match) {
        return;
    }
    const rest = match[1];
    const restStart = match[0].length - rest.length;

    const quoted = /^"([^"]+)"/.exec(rest);
    const unquoted = quoted ? null : /^([^\s;]+)/.exec(rest);
    const raw = quoted ? quoted[1] : unquoted ? unquoted[1] : null;
    if (!raw) {
        return;
    }

    const label = normalizeTargetLabel(raw);
    if (!label) {
        return;
    }

    const rawStart = restStart + (quoted ? 1 : 0);
    const start = text.indexOf(raw, rawStart);
    targets.push({
        label,
        line,
        startCharacter: start,
        endCharacter: start + raw.length,
    });
}

function collectJumpTargets(
    call: ScannedCall,
    rest: string,
    restStart: number,
    params: ParamData[],
    line: number,
    targets: PendingTarget[]
): void {
    if (call.argsText === null) {
        return;
    }

    const args = splitTopLevelArgs(call.argsText);
    for (let index = 0; index < args.length; index++) {
        if (!isStateLabelParamAtIndex(params, index)) {
            continue;
        }
        const literal = unquoteArgument(args[index].text);
        if (literal === null) {
            continue;
        }
        const label = normalizeTargetLabel(literal);
        if (!label) {
            continue;
        }
        const searchFrom = call.argsStart + args[index].start;
        const start = rest.indexOf(literal, searchFrom);
        if (start < 0) {
            continue;
        }
        targets.push({
            label,
            line,
            startCharacter: restStart + start,
            endCharacter: restStart + start + literal.length,
        });
    }
}

function resolveTargets(
    lines: string[],
    actors: ParsedActor[],
    diagnostics: DecorateLintDiagnostic[],
    targetsByActor: Map<ParsedActor, PendingTarget[]>,
    labelsByActor: Map<ParsedActor, Set<string>>
): void {
    if (actors.length === 0) {
        return;
    }

    const actorByName = new Map<string, ParsedActor>();
    for (const actor of actors) {
        const key = actor.name.toLowerCase();
        if (!actorByName.has(key)) {
            actorByName.set(key, actor);
        }
    }

    const labelCache = new Map<ParsedActor, Set<string>>();
    const labelsOf = (actor: ParsedActor): Set<string> => {
        let labels = labelCache.get(actor);
        if (!labels) {
            const span: ActorLineSpan = { startLine: actor.startLine, endLine: actor.endLine };
            labels = new Set(collectStateLabelsInActor(lines, span).keys());
            for (const scanned of labelsByActor.get(actor) ?? []) {
                labels.add(scanned);
            }
            labelCache.set(actor, labels);
        }
        return labels;
    };

    for (const actor of actors) {
        const targets = targetsByActor.get(actor);
        if (!targets) {
            continue;
        }
        for (const target of targets) {
            const found = resolveTargetLabel(actor, target.label, actorByName, labelsOf);
            if (found === false) {
                diagnostics.push({
                    line: target.line,
                    startCharacter: target.startCharacter,
                    endCharacter: target.endCharacter,
                    severity: 'warning',
                    message: `State label '${target.label}' not found in current actor.`,
                });
            }
        }
    }
}

/**
 * true = found, false = missing, undefined = cannot verify (parent class lives
 * outside this document, so inherited labels are unknown).
 */
function resolveTargetLabel(
    actor: ParsedActor,
    label: string,
    actorByName: Map<string, ParsedActor>,
    labelsOf: (actor: ParsedActor) => Set<string>
): boolean | undefined {
    let current: ParsedActor | undefined = actor;
    const visited = new Set<string>();

    while (current) {
        const key = current.name.toLowerCase();
        if (visited.has(key)) {
            return false;
        }
        visited.add(key);

        if (labelsOf(current).has(label.toLowerCase())) {
            return true;
        }

        const parent = current.parent;
        if (!parent || /^actor$/i.test(parent)) {
            return false;
        }

        const parentActor = actorByName.get(parent.toLowerCase());
        if (!parentActor) {
            return undefined;
        }
        current = parentActor;
    }

    return false;
}

function toVsCodeDiagnostic(
    document: vscode.TextDocument,
    diagnostic: DecorateLintDiagnostic
): vscode.Diagnostic {
    const line = Math.max(0, Math.min(diagnostic.line, document.lineCount - 1));
    const lineLength = document.lineAt(line).text.length;
    const start = Math.max(0, Math.min(diagnostic.startCharacter, lineLength));
    const end = Math.max(start, Math.min(diagnostic.endCharacter, lineLength));
    const result = new vscode.Diagnostic(
        new vscode.Range(line, start, line, end),
        diagnostic.message,
        diagnostic.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : vscode.DiagnosticSeverity.Warning
    );
    result.source = 'decorate';
    return result;
}

function isLintEnabled(): boolean {
    return vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(LINT_ENABLED_SETTING, true);
}

class DecorateLinter implements vscode.Disposable {
    private readonly collection: vscode.DiagnosticCollection;
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly meta: DecorateLintMeta) {
        this.collection = vscode.languages.createDiagnosticCollection('decorate');
    }

    activate(): void {
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(document => this.lint(document)),
            vscode.workspace.onDidSaveTextDocument(document => this.lint(document)),
            vscode.workspace.onDidChangeTextDocument(event => this.schedule(event.document)),
            vscode.workspace.onDidCloseTextDocument(document => this.clear(document.uri)),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(`${CONFIG_SECTION}.${LINT_ENABLED_SETTING}`)) {
                    this.refreshOpenDocuments();
                }
            })
        );

        for (const document of vscode.workspace.textDocuments) {
            this.lint(document);
        }
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        this.collection.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

    private schedule(document: vscode.TextDocument): void {
        if (document.languageId !== 'decorate') {
            return;
        }
        const key = document.uri.toString();
        const existing = this.timers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.timers.delete(key);
            this.lint(document);
        }, CHANGE_DEBOUNCE_MS);
        this.timers.set(key, timer);
    }

    private clear(uri: vscode.Uri): void {
        const key = uri.toString();
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
        this.collection.delete(uri);
    }

    private refreshOpenDocuments(): void {
        for (const document of vscode.workspace.textDocuments) {
            if (!isLintEnabled()) {
                this.clear(document.uri);
                continue;
            }
            this.lint(document);
        }
    }

    private lint(document: vscode.TextDocument): void {
        if (document.languageId !== 'decorate') {
            return;
        }
        if (!isLintEnabled()) {
            this.clear(document.uri);
            return;
        }

        const lines: string[] = [];
        for (let index = 0; index < document.lineCount; index++) {
            lines.push(document.lineAt(index).text);
        }

        const diagnostics = lintDecorateLines(lines, this.meta)
            .map(diagnostic => toVsCodeDiagnostic(document, diagnostic));
        this.collection.set(document.uri, diagnostics);
    }
}

export function registerDecorateDiagnostics(context: vscode.ExtensionContext): void {
    const meta = buildLintMeta({
        actions: getActions(context),
        properties: getProperties(context),
        flags: getFlags(context),
        flagCombos: getFlagCombos(context),
        stateKeywords: getStateKeywords(context),
    });

    const linter = new DecorateLinter(meta);
    linter.activate();
    context.subscriptions.push(linter);
}
