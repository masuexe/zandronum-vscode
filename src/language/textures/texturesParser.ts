import * as vscode from 'vscode';

export enum TexturesContext {
    Top,
    Texture,
    Patch
}

export enum TexturesNodeKind {
    Definition,
    Patch
}

export interface PatchProperties {
    FlipX?: boolean;
    FlipY?: boolean;
    Rotate?: number;
    Alpha?: number;
    Style?: string;
    UseOffsets?: boolean;
    /** Raw Translation value (quoted remap strings and/or named types). */
    Translation?: string;
    [key: string]: unknown;
}

export interface TextureProperties {
    XScale?: number;
    YScale?: number;
    OffsetX?: number;
    OffsetY?: number;
    WorldPanning?: boolean;
    NoDecals?: boolean;
    NullTexture?: boolean;
}

export interface TextureDefinitionData {
    width: number;
    height: number;
}

export interface PatchPositionData {
    x: number;
    y: number;
}

/** Source ranges for surgically editing texture-level properties. */
export interface TexturePropRanges {
    width?: vscode.Range;
    height?: vscode.Range;
    offsetX?: vscode.Range;
    offsetY?: vscode.Range;
    xScale?: vscode.Range;
    yScale?: vscode.Range;
    /** Full line ranges for bool flags / property lines (for upsert/remove). */
    xScaleLine?: vscode.Range;
    yScaleLine?: vscode.Range;
    offsetLine?: vscode.Range;
    worldPanningLine?: vscode.Range;
    noDecalsLine?: vscode.Range;
    nullTextureLine?: vscode.Range;
}

/** Source ranges for surgically editing patch-level properties. */
export interface PatchPropRanges {
    rotateLine?: vscode.Range;
    alphaLine?: vscode.Range;
    styleLine?: vscode.Range;
    flipXLine?: vscode.Range;
    flipYLine?: vscode.Range;
    useOffsetsLine?: vscode.Range;
    /** Range covering the entire `{ ... }` property block if present. */
    propBlock?: vscode.Range;
}

export interface TexturesNode {
    id: string;
    kind: TexturesNodeKind;
    type: string;
    name: string;
    range: vscode.Range;
    nameRange: vscode.Range;
    parent?: TexturesNode;
    children: TexturesNode[];
    defData?: TextureDefinitionData;
    patchData?: PatchPositionData;
    xRange?: vscode.Range;
    yRange?: vscode.Range;
    patchProps: PatchProperties;
    texProps: TextureProperties;
    texPropRanges: TexturePropRanges;
    patchPropRanges: PatchPropRanges;
}

export interface TexturesParseDiagnostic {
    message: string;
    range: vscode.Range;
    severity: vscode.DiagnosticSeverity;
}

export interface ParseResult {
    rootNodes: TexturesNode[];
    diagnostics: TexturesParseDiagnostic[];
}

export function getPropBoolean(props: PatchProperties, key: string, def: boolean = false): boolean {
    const v = props[key];
    return typeof v === 'boolean' ? v : def;
}

export function getPropNumber(props: PatchProperties, key: string, def: number = 0): number {
    const v = props[key];
    return typeof v === 'number' ? v : def;
}

export function getPropString(props: PatchProperties, key: string, def: string = ''): string {
    const v = props[key];
    return typeof v === 'string' ? v : def;
}

const KEYWORD_CAPTURE_RE = /\b(Texture|WallTexture|Flat|Sprite|Graphic)\s+(?:optional\s+)?(?:"([^"]*)"|([^\s,]+))\s*,\s*(\d+)\s*,\s*(\d+)/i;
const PATCH_CAPTURE_RE = /\b(Patch|Graphic)\s+(?:"([^"]*)"|([^\s,]+))\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i;
const DEFINITION_ONLY_RE = /^(Texture|WallTexture|Flat|Sprite|Graphic)\b/i;
const PROP_BOOL_RE = /^\s*(FlipX|FlipY|UseOffsets)\s*$/i;
const PROP_INT_RE = /^\s*(Rotate)\s+(-?\d+)/i;
const PROP_FLOAT_RE = /^\s*(Alpha)\s+(-?[0-9]+\.?[0-9]*)/i;
const PROP_STR_RE = /^\s*(Style)\s+(\S+)/i;
const TEX_SCALE_RE = /^\s*(XScale|YScale)\s+(-?[0-9]+\.?[0-9]*)/i;
const TEX_OFFSET_RE = /^\s*Offset\s+(-?\d+)\s*,\s*(-?\d+)/i;
const TEX_BOOL_RE = /^\s*(WorldPanning|NoDecals|NullTexture)\s*$/i;

function emptyNodeExtras(): Pick<TexturesNode, 'texProps' | 'texPropRanges' | 'patchPropRanges'> {
    return { texProps: {}, texPropRanges: {}, patchPropRanges: {} };
}

export class TexturesParser {
    private cachedResult: ParseResult = { rootNodes: [], diagnostics: [] };
    private cachedVersion: number = -1;
    private cachedUri: string = '';
    private lineContexts: TexturesContext[] = [];

    update(document: vscode.TextDocument): void {
        const uri = document.uri.toString();
        if (uri === this.cachedUri && document.version === this.cachedVersion) {
            return;
        }
        this.cachedUri = uri;
        this.cachedVersion = document.version;
        this.cachedResult = this.parse(document);
    }

    parse(document: vscode.TextDocument): ParseResult {
        const rootNodes: TexturesNode[] = [];
        const diagnostics: TexturesParseDiagnostic[] = [];
        this.lineContexts = [];

        let context = TexturesContext.Top;
        let inBlockComment = false;
        let currentDef: TexturesNode | undefined;
        let currentPatch: TexturesNode | undefined;
        let pendingDef: TexturesNode | undefined;
        let pendingPatch: TexturesNode | undefined;
        let patchIndexInDef = 0;

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const stripped = this.stripComments(lineText, inBlockComment);
            inBlockComment = stripped.inBlockComment;
            const clean = stripped.text;

            this.lineContexts[i] = context;

            if (context === TexturesContext.Top) {
                const defMatch = KEYWORD_CAPTURE_RE.exec(clean);
                if (defMatch) {
                    if (pendingDef) {
                        rootNodes.push(pendingDef);
                        pendingDef = undefined;
                    }
                    const name = defMatch[2] ?? defMatch[3];
                    const nameRange = this.findNameRange(lineText, i, name, defMatch[2] !== undefined);
                    const sizeRanges = this.findDefinitionSizeRanges(lineText, i, name, defMatch[2] !== undefined);
                    const node: TexturesNode = {
                        id: name,
                        kind: TexturesNodeKind.Definition,
                        type: defMatch[1],
                        name: name,
                        range: new vscode.Range(i, 0, i, lineText.length),
                        nameRange,
                        children: [],
                        defData: { width: parseInt(defMatch[4]), height: parseInt(defMatch[5]) },
                        patchProps: {},
                        ...emptyNodeExtras(),
                        texPropRanges: {
                            width: sizeRanges.width,
                            height: sizeRanges.height
                        }
                    };
                    patchIndexInDef = 0;
                    if (clean.includes('{')) {
                        context = TexturesContext.Texture;
                        currentDef = node;
                        rootNodes.push(node);
                        this.lineContexts[i] = TexturesContext.Texture;
                        this.processInlineTexture(clean, lineText, i, currentDef, patchIndexInDef);
                        patchIndexInDef += currentDef.children.length;
                        if (clean.lastIndexOf('}') > clean.indexOf('{')) {
                            currentDef.range = new vscode.Range(i, 0, i, lineText.length);
                            currentDef = undefined;
                            currentPatch = undefined;
                            context = TexturesContext.Top;
                        }
                    } else {
                        pendingDef = node;
                    }
                } else if (pendingDef && clean.includes('{')) {
                    pendingDef.range = new vscode.Range(pendingDef.range.start.line, 0, i, lineText.length);
                    rootNodes.push(pendingDef);
                    currentDef = pendingDef;
                    pendingDef = undefined;
                    context = TexturesContext.Texture;
                    this.lineContexts[i] = TexturesContext.Texture;
                    this.processInlineTexture(clean, lineText, i, currentDef, patchIndexInDef);
                    patchIndexInDef += currentDef.children.length;
                    if (clean.lastIndexOf('}') > clean.indexOf('{')) {
                        currentDef.range = new vscode.Range(i, 0, i, lineText.length);
                        currentDef = undefined;
                        currentPatch = undefined;
                        context = TexturesContext.Top;
                    }
                }
            } else if (context === TexturesContext.Texture) {
                if (DEFINITION_ONLY_RE.test(clean)) {
                    if (pendingPatch && currentDef) {
                        currentDef.children.push(pendingPatch);
                        pendingPatch = undefined;
                    }
                    if (currentDef) {
                        currentDef.range = new vscode.Range(currentDef.range.start.line, 0, i > 0 ? i - 1 : 0, 0);
                    }
                    currentDef = undefined;
                    currentPatch = undefined;
                    context = TexturesContext.Top;
                    this.lineContexts[i] = TexturesContext.Top;
                    i--;
                    continue;
                }

                const patchMatch = PATCH_CAPTURE_RE.exec(clean);
                if (patchMatch && currentDef) {
                    if (pendingPatch) {
                        currentDef.children.push(pendingPatch);
                        pendingPatch = undefined;
                    }
                    const pName = patchMatch[2] ?? patchMatch[3];
                    const pNameRange = this.findNameRange(lineText, i, pName, patchMatch[2] !== undefined);
                    const ranges = this.findCoordRanges(lineText, i, pName, patchMatch[2] !== undefined);
                    const node: TexturesNode = {
                        id: `${currentDef.name}:${patchMatch[1]}:${patchIndexInDef}`,
                        kind: TexturesNodeKind.Patch,
                        type: patchMatch[1],
                        name: pName,
                        range: new vscode.Range(i, 0, i, lineText.length),
                        nameRange: pNameRange,
                        parent: currentDef,
                        children: [],
                        patchData: { x: parseInt(patchMatch[4]), y: parseInt(patchMatch[5]) },
                        xRange: ranges.xRange,
                        yRange: ranges.yRange,
                        patchProps: {},
                        ...emptyNodeExtras()
                    };
                    patchIndexInDef++;
                    if (clean.includes('{')) {
                        context = TexturesContext.Patch;
                        currentPatch = node;
                        currentDef.children.push(node);
                        this.lineContexts[i] = TexturesContext.Patch;
                        if (clean.lastIndexOf('}') > clean.indexOf('{')) {
                            const pBraceStart = clean.indexOf('{');
                            const pBraceEnd = clean.lastIndexOf('}');
                            this.parseInlineProperties(
                                clean.substring(pBraceStart + 1, pBraceEnd), node
                            );
                            currentPatch.range = new vscode.Range(i, 0, i, lineText.length);
                            currentPatch.patchPropRanges.propBlock = currentPatch.range;
                            currentPatch = undefined;
                            context = TexturesContext.Texture;
                        }
                    } else if (clean.includes('}')) {
                        currentDef.children.push(node);
                        currentDef.range = new vscode.Range(currentDef.range.start.line, 0, i, lineText.length);
                        currentDef = undefined;
                        currentPatch = undefined;
                        context = TexturesContext.Top;
                    } else {
                        pendingPatch = node;
                    }
                } else if (pendingPatch && clean.includes('{') && currentDef) {
                    pendingPatch.range = new vscode.Range(pendingPatch.range.start.line, 0, i, lineText.length);
                    currentDef.children.push(pendingPatch);
                    currentPatch = pendingPatch;
                    pendingPatch = undefined;
                    context = TexturesContext.Patch;
                    this.lineContexts[i] = TexturesContext.Patch;
                } else if (clean.includes('}')) {
                    if (pendingPatch && currentDef) {
                        currentDef.children.push(pendingPatch);
                        pendingPatch = undefined;
                    }
                    if (currentDef) {
                        currentDef.range = new vscode.Range(currentDef.range.start.line, 0, i, lineText.length);
                    }
                    currentDef = undefined;
                    currentPatch = undefined;
                    context = TexturesContext.Top;
                } else if (currentDef && !pendingPatch) {
                    this.parseTextureProperty(clean, lineText, i, currentDef);
                }
            } else if (context === TexturesContext.Patch) {
                if (clean.includes('}')) {
                    if (currentPatch) {
                        currentPatch.range = new vscode.Range(currentPatch.range.start.line, 0, i, lineText.length);
                        if (currentPatch.patchPropRanges.propBlock === undefined) {
                            currentPatch.patchPropRanges.propBlock = new vscode.Range(
                                currentPatch.range.start.line,
                                0,
                                i,
                                lineText.length
                            );
                        }
                    }
                    currentPatch = undefined;
                    context = TexturesContext.Texture;
                } else if (currentPatch) {
                    this.parsePatchProperty(clean, lineText, i, currentPatch);
                }
            }
        }

        if (pendingDef) {
            rootNodes.push(pendingDef);
        }
        if (currentDef) {
            if (pendingPatch) {
                currentDef.children.push(pendingPatch);
            }
            const lastLine = document.lineCount - 1;
            currentDef.range = new vscode.Range(currentDef.range.start.line, 0, lastLine, 0);
            diagnostics.push({
                message: `Unclosed block for ${currentDef.type} "${currentDef.name}"`,
                range: new vscode.Range(currentDef.range.start.line, 0, currentDef.range.start.line, 0),
                severity: vscode.DiagnosticSeverity.Error
            });
        }
        if (currentPatch && currentDef) {
            diagnostics.push({
                message: `Unclosed Patch block "${currentPatch.name}"`,
                range: new vscode.Range(currentPatch.range.start.line, 0, currentPatch.range.start.line, 0),
                severity: vscode.DiagnosticSeverity.Error
            });
        }

        return { rootNodes, diagnostics };
    }

    getContextAtPosition(position: vscode.Position): TexturesContext {
        if (position.line < this.lineContexts.length) {
            return this.lineContexts[position.line];
        }
        return TexturesContext.Top;
    }

    getNodeAtPosition(position: vscode.Position): TexturesNode | undefined {
        for (const node of this.cachedResult.rootNodes) {
            if (node.range.contains(position)) {
                for (const child of node.children) {
                    if (child.range.contains(position)) {
                        return child;
                    }
                }
                return node;
            }
        }
        return undefined;
    }

    getDefinitionAtPosition(position: vscode.Position): TexturesNode | undefined {
        for (const node of this.cachedResult.rootNodes) {
            if (node.range.contains(position)) {
                return node;
            }
        }
        return undefined;
    }

    getNodeById(id: string): TexturesNode | undefined {
        for (const node of this.cachedResult.rootNodes) {
            if (node.id === id) { return node; }
            for (const child of node.children) {
                if (child.id === id) { return child; }
            }
        }
        return undefined;
    }

    getSymbols(): TexturesNode[] {
        return this.cachedResult.rootNodes;
    }

    getFoldingRanges(): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const collect = (nodes: TexturesNode[]) => {
            for (const node of nodes) {
                if (node.range.start.line < node.range.end.line) {
                    ranges.push(new vscode.FoldingRange(node.range.start.line, node.range.end.line));
                }
                collect(node.children);
            }
        };
        collect(this.cachedResult.rootNodes);
        return ranges;
    }

    getDiagnostics(): TexturesParseDiagnostic[] {
        return this.cachedResult.diagnostics;
    }

    /**
     * Parse all patches (and texture-level props) inside a compact one-liner body.
     * Example:
     *   sprite 6H36A0,568,192{Offset 124,-16 Patch 6G36A0,326,87 Patch 6G36A0,94,87{FlipX}}
     */
    private processInlineTexture(
        clean: string,
        lineText: string,
        lineNum: number,
        def: TexturesNode,
        startPatchIndex: number
    ): void {
        const braceIdx = clean.indexOf('{');
        if (braceIdx < 0) { return; }

        // Body between the definition's outer `{` and its matching `}`
        const openColInClean = braceIdx;
        const closeColInClean = this.findMatchingBraceInString(clean, openColInClean);
        const bodyEnd = closeColInClean >= 0 ? closeColInClean : clean.length;
        const afterBrace = clean.substring(braceIdx + 1, bodyEnd);

        // Texture-level props appear before the first Patch/Graphic
        const firstPatchRel = afterBrace.search(/\b(Patch|Graphic)\b/i);
        if (firstPatchRel >= 0) {
            this.parseInlineTextureProperties(afterBrace.substring(0, firstPatchRel), def);
        } else {
            this.parseInlineTextureProperties(afterBrace, def);
            return;
        }

        // Map clean-string columns → lineText columns (usually identical for one-liners)
        const cleanToLine = (cleanCol: number): number => {
            // Prefer exact match; fall back to cleanCol when stripComments didn't change length
            if (clean === lineText) { return cleanCol; }
            // Best-effort: search for a distinctive slice around cleanCol
            const slice = clean.substring(Math.max(0, cleanCol - 8), cleanCol + 8);
            const idx = lineText.indexOf(slice);
            if (idx >= 0) { return idx + Math.min(8, cleanCol); }
            return Math.min(cleanCol, lineText.length);
        };

        const patchRe = /\b(Patch|Graphic)\s+(?:"([^"]*)"|([^\s,{]+))\s*,\s*(-?\d+)\s*,\s*(-?\d+)/gi;
        let patchMatch: RegExpExecArray | null;
        let patchIndex = startPatchIndex;
        while ((patchMatch = patchRe.exec(afterBrace)) !== null) {
            const pName = patchMatch[2] ?? patchMatch[3];
            const quoted = patchMatch[2] !== undefined;
            const matchStartInClean = braceIdx + 1 + patchMatch.index;
            const headerEndInClean = matchStartInClean + patchMatch[0].length;

            // Optional `{ ... }` property block immediately after the patch header
            let propsContent = '';
            let nodeEndInClean = headerEndInClean;
            let scan = headerEndInClean;
            while (scan < bodyEnd && /\s/.test(clean[scan])) { scan++; }
            if (scan < bodyEnd && clean[scan] === '{') {
                const propClose = this.findMatchingBraceInString(clean, scan);
                if (propClose >= 0) {
                    propsContent = clean.substring(scan + 1, propClose);
                    nodeEndInClean = propClose + 1;
                    // Advance regex past the property block so nested text isn't re-scanned
                    patchRe.lastIndex = Math.max(patchRe.lastIndex, propClose - (braceIdx + 1));
                }
            }

            const headerStartInLine = cleanToLine(matchStartInClean);
            const nameRange = this.findNameRangeFrom(
                lineText, lineNum, pName, quoted, headerStartInLine
            );
            // Coords follow the patch name on this occurrence (not the first match on the line)
            const coordRanges = this.readTwoIntRanges(lineText, lineNum, nameRange.end.character);

            const node: TexturesNode = {
                id: `${def.name}:${patchMatch[1]}:${patchIndex}`,
                kind: TexturesNodeKind.Patch,
                type: patchMatch[1],
                name: pName,
                range: new vscode.Range(
                    lineNum,
                    cleanToLine(matchStartInClean),
                    lineNum,
                    cleanToLine(nodeEndInClean)
                ),
                nameRange,
                parent: def,
                children: [],
                patchData: { x: parseInt(patchMatch[4]), y: parseInt(patchMatch[5]) },
                xRange: coordRanges.xRange,
                yRange: coordRanges.yRange,
                patchProps: {},
                ...emptyNodeExtras()
            };
            if (propsContent) {
                this.parseInlineProperties(propsContent, node);
                node.patchPropRanges.propBlock = new vscode.Range(
                    lineNum, cleanToLine(scan), lineNum, cleanToLine(nodeEndInClean)
                );
            }
            def.children.push(node);
            patchIndex++;
        }
    }

    /** Find matching `}` for `{` at `openCol` in a single string (brace depth). */
    private findMatchingBraceInString(text: string, openCol: number): number {
        if (openCol < 0 || openCol >= text.length || text[openCol] !== '{') { return -1; }
        let depth = 0;
        let inString = false;
        for (let i = openCol; i < text.length; i++) {
            const ch = text[i];
            if (inString) {
                if (ch === '\\' && i + 1 < text.length) { i++; continue; }
                if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{') { depth++; }
            else if (ch === '}') {
                depth--;
                if (depth === 0) { return i; }
            }
        }
        return -1;
    }

    private parseInlineTextureProperties(content: string, def: TexturesNode): void {
        // Values only — ranges for compact one-liners are resolved at edit time
        // by rewriteTextureProperties scanning the definition body.
        let m: RegExpExecArray | null;
        const scaleRe = /\b(XScale|YScale)\s+(-?[0-9]+\.?[0-9]*)/gi;
        while ((m = scaleRe.exec(content)) !== null) {
            if (m[1].toLowerCase() === 'xscale') {
                def.texProps.XScale = parseFloat(m[2]);
            } else {
                def.texProps.YScale = parseFloat(m[2]);
            }
        }
        const offsetRe = /\bOffset\s+(-?\d+)\s*,\s*(-?\d+)/gi;
        while ((m = offsetRe.exec(content)) !== null) {
            def.texProps.OffsetX = parseInt(m[1]);
            def.texProps.OffsetY = parseInt(m[2]);
        }
        const boolRe = /\b(WorldPanning|NoDecals|NullTexture)\b/gi;
        while ((m = boolRe.exec(content)) !== null) {
            const lower = m[1].toLowerCase();
            if (lower === 'worldpanning') { def.texProps.WorldPanning = true; }
            else if (lower === 'nodecals') { def.texProps.NoDecals = true; }
            else { def.texProps.NullTexture = true; }
        }
    }

    private parseInlineProperties(content: string, node: TexturesNode): void {
        const boolRe = /\b(FlipX|FlipY|UseOffsets)\b/gi;
        let m: RegExpExecArray | null;
        while ((m = boolRe.exec(content)) !== null) {
            const canon = this.canonicalPatchBool(m[1]);
            node.patchProps[canon] = true;
        }
        const intRe = /\b(Rotate)\s+(-?\d+)/gi;
        while ((m = intRe.exec(content)) !== null) {
            node.patchProps.Rotate = parseInt(m[2]);
        }
        const floatRe = /\b(Alpha)\s+(-?[0-9]+\.?[0-9]*)/gi;
        while ((m = floatRe.exec(content)) !== null) {
            node.patchProps.Alpha = parseFloat(m[2]);
        }
        const strRe = /\b(Style)\s+(\S+)/gi;
        while ((m = strRe.exec(content)) !== null) {
            node.patchProps.Style = m[2];
        }
        this.parseTranslationProperty(content, node);
    }

    /**
     * Parse `Translation "...","..."` or `Translation Inverse` from a property block.
     * Stores the raw argument text (after the keyword) on patchProps.Translation.
     */
    private parseTranslationProperty(content: string, node: TexturesNode): void {
        const m = /\bTranslation\b\s*/i.exec(content);
        if (!m) { return; }
        let rest = content.substring(m.index + m[0].length).trim();
        // Collect consecutive quoted strings: "a","b","c"
        const quotedParts: string[] = [];
        const quotedRe = /"([^"]*)"/g;
        let qm: RegExpExecArray | null;
        let lastEnd = -1;
        while ((qm = quotedRe.exec(rest)) !== null) {
            // Allow only whitespace/commas between quotes at the start of the value
            const between = rest.substring(lastEnd < 0 ? 0 : lastEnd, qm.index);
            if (lastEnd >= 0 && !/^[\s,]*$/.test(between)) { break; }
            if (lastEnd < 0 && between.trim() !== '' && !/^[\s,]*$/.test(between)) {
                // Named translation or bare ranges before quotes — keep whole rest
                break;
            }
            quotedParts.push('"' + qm[1] + '"');
            lastEnd = qm.index + qm[0].length;
        }
        if (quotedParts.length > 0 && lastEnd >= 0) {
            // Ensure nothing but whitespace/commas before the first quote
            const prefix = rest.substring(0, rest.indexOf('"')).trim();
            if (prefix === '' || prefix === ',') {
                node.patchProps.Translation = quotedParts.join(',');
                return;
            }
        }
        // Fallback: take until next keyword
        const stop = rest.search(/\b(FlipX|FlipY|UseOffsets|Rotate|Alpha|Style|Blend)\b/i);
        if (stop >= 0) { rest = rest.substring(0, stop).trim(); }
        rest = rest.replace(/[,;\s]+$/, '');
        if (rest) {
            node.patchProps.Translation = rest;
        }
    }

    private canonicalPatchBool(raw: string): 'FlipX' | 'FlipY' | 'UseOffsets' {
        const lower = raw.toLowerCase();
        if (lower === 'flipx') { return 'FlipX'; }
        if (lower === 'flipy') { return 'FlipY'; }
        return 'UseOffsets';
    }

    private parseTextureProperty(
        clean: string,
        lineText: string,
        lineNum: number,
        def: TexturesNode
    ): void {
        let m: RegExpExecArray | null;
        const lineRange = new vscode.Range(lineNum, 0, lineNum, lineText.length);

        m = TEX_SCALE_RE.exec(clean);
        if (m) {
            const isX = m[1].toLowerCase() === 'xscale';
            const value = parseFloat(m[2]);
            if (isX) {
                def.texProps.XScale = value;
                def.texPropRanges.xScaleLine = lineRange;
                def.texPropRanges.xScale = this.findNumberAfterKeyword(lineText, lineNum, m[1]);
            } else {
                def.texProps.YScale = value;
                def.texPropRanges.yScaleLine = lineRange;
                def.texPropRanges.yScale = this.findNumberAfterKeyword(lineText, lineNum, m[1]);
            }
            return;
        }

        m = TEX_OFFSET_RE.exec(clean);
        if (m) {
            def.texProps.OffsetX = parseInt(m[1]);
            def.texProps.OffsetY = parseInt(m[2]);
            def.texPropRanges.offsetLine = lineRange;
            const coords = this.findOffsetCoordRanges(lineText, lineNum);
            def.texPropRanges.offsetX = coords.xRange;
            def.texPropRanges.offsetY = coords.yRange;
            return;
        }

        m = TEX_BOOL_RE.exec(clean);
        if (m) {
            const lower = m[1].toLowerCase();
            if (lower === 'worldpanning') {
                def.texProps.WorldPanning = true;
                def.texPropRanges.worldPanningLine = lineRange;
            } else if (lower === 'nodecals') {
                def.texProps.NoDecals = true;
                def.texPropRanges.noDecalsLine = lineRange;
            } else {
                def.texProps.NullTexture = true;
                def.texPropRanges.nullTextureLine = lineRange;
            }
        }
    }

    private findNameRange(lineText: string, lineNum: number, name: string, quoted: boolean): vscode.Range {
        return this.findNameRangeFrom(lineText, lineNum, name, quoted, 0);
    }

    private findNameRangeFrom(
        lineText: string,
        lineNum: number,
        name: string,
        quoted: boolean,
        fromCol: number
    ): vscode.Range {
        if (quoted) {
            const idx = lineText.indexOf('"' + name + '"', fromCol);
            if (idx >= 0) {
                return new vscode.Range(lineNum, idx + 1, lineNum, idx + 1 + name.length);
            }
        }
        const idx = lineText.indexOf(name, fromCol);
        return new vscode.Range(lineNum, Math.max(idx, 0), lineNum, Math.max(idx, 0) + name.length);
    }

    private findCoordRanges(
        lineText: string,
        lineNum: number,
        name: string,
        quoted: boolean
    ): { xRange: vscode.Range; yRange: vscode.Range } {
        let pos: number;
        if (quoted) {
            pos = lineText.indexOf('"' + name + '"') + name.length + 2;
        } else {
            pos = lineText.indexOf(name) + name.length;
        }
        return this.readTwoIntRanges(lineText, lineNum, pos);
    }

    private findCoordRangesFrom(
        lineText: string,
        lineNum: number,
        afterNameCol: number
    ): { xRange: vscode.Range; yRange: vscode.Range } {
        return this.readTwoIntRanges(lineText, lineNum, afterNameCol);
    }

    private findDefinitionSizeRanges(
        lineText: string,
        lineNum: number,
        name: string,
        quoted: boolean
    ): { width: vscode.Range; height: vscode.Range } {
        let pos: number;
        if (quoted) {
            pos = lineText.indexOf('"' + name + '"') + name.length + 2;
        } else {
            pos = lineText.indexOf(name) + name.length;
        }
        const ranges = this.readTwoIntRanges(lineText, lineNum, pos);
        return { width: ranges.xRange, height: ranges.yRange };
    }

    private findOffsetCoordRanges(
        lineText: string,
        lineNum: number
    ): { xRange: vscode.Range; yRange: vscode.Range } {
        const idx = lineText.search(/\bOffset\b/i);
        const pos = idx >= 0 ? idx + 6 : 0;
        return this.readTwoIntRanges(lineText, lineNum, pos);
    }

    private findNumberAfterKeyword(
        lineText: string,
        lineNum: number,
        keyword: string
    ): vscode.Range {
        const re = new RegExp('\\b' + keyword + '\\b', 'i');
        const m = re.exec(lineText);
        let pos = m ? m.index + m[0].length : 0;
        while (pos < lineText.length && lineText[pos] !== '-' && !/[0-9]/.test(lineText[pos])) { pos++; }
        const start = pos;
        if (lineText[pos] === '-') { pos++; }
        while (pos < lineText.length && /[0-9.]/.test(lineText[pos])) { pos++; }
        return new vscode.Range(lineNum, start, lineNum, pos);
    }

    private readTwoIntRanges(
        lineText: string,
        lineNum: number,
        startPos: number
    ): { xRange: vscode.Range; yRange: vscode.Range } {
        let pos = startPos;
        while (pos < lineText.length && lineText[pos] !== '-' && !/[0-9]/.test(lineText[pos])) { pos++; }
        const xStart = pos;
        if (lineText[pos] === '-') { pos++; }
        while (pos < lineText.length && /[0-9]/.test(lineText[pos])) { pos++; }
        const xEnd = pos;

        while (pos < lineText.length && lineText[pos] !== '-' && !/[0-9]/.test(lineText[pos])) { pos++; }
        const yStart = pos;
        if (lineText[pos] === '-') { pos++; }
        while (pos < lineText.length && /[0-9]/.test(lineText[pos])) { pos++; }
        const yEnd = pos;

        return {
            xRange: new vscode.Range(lineNum, xStart, lineNum, xEnd),
            yRange: new vscode.Range(lineNum, yStart, lineNum, yEnd)
        };
    }

    private parsePatchProperty(
        clean: string,
        lineText: string,
        lineNum: number,
        patch: TexturesNode
    ): void {
        let m: RegExpExecArray | null;
        const lineRange = new vscode.Range(lineNum, 0, lineNum, lineText.length);

        m = PROP_BOOL_RE.exec(clean);
        if (m) {
            const canon = this.canonicalPatchBool(m[1]);
            patch.patchProps[canon] = true;
            if (canon === 'FlipX') { patch.patchPropRanges.flipXLine = lineRange; }
            else if (canon === 'FlipY') { patch.patchPropRanges.flipYLine = lineRange; }
            else { patch.patchPropRanges.useOffsetsLine = lineRange; }
            return;
        }

        m = PROP_INT_RE.exec(clean);
        if (m) {
            patch.patchProps.Rotate = parseInt(m[2]);
            patch.patchPropRanges.rotateLine = lineRange;
            return;
        }

        m = PROP_FLOAT_RE.exec(clean);
        if (m) {
            patch.patchProps.Alpha = parseFloat(m[2]);
            patch.patchPropRanges.alphaLine = lineRange;
            return;
        }

        m = PROP_STR_RE.exec(clean);
        if (m) {
            patch.patchProps.Style = m[2];
            patch.patchPropRanges.styleLine = lineRange;
            return;
        }

        if (/\bTranslation\b/i.test(clean)) {
            this.parseTranslationProperty(clean, patch);
            return;
        }
    }

    private stripComments(line: string, inBlock: boolean): { text: string; inBlockComment: boolean } {
        let result = '';
        let i = 0;
        let blockState = inBlock;
        let inString = false;

        while (i < line.length) {
            if (blockState) {
                if (i + 1 < line.length && line[i] === '*' && line[i + 1] === '/') {
                    blockState = false;
                    i += 2;
                } else {
                    i++;
                }
            } else if (inString) {
                if (line[i] === '\\' && i + 1 < line.length) {
                    result += line[i] + line[i + 1];
                    i += 2;
                } else if (line[i] === '"') {
                    result += '"';
                    inString = false;
                    i++;
                } else {
                    result += line[i];
                    i++;
                }
            } else {
                if (line[i] === '"') {
                    result += '"';
                    inString = true;
                    i++;
                } else if (i + 1 < line.length && line[i] === '/' && line[i + 1] === '/') {
                    break;
                } else if (i + 1 < line.length && line[i] === '/' && line[i + 1] === '*') {
                    blockState = true;
                    i += 2;
                } else {
                    result += line[i];
                    i++;
                }
            }
        }

        return { text: result, inBlockComment: blockState };
    }
}
