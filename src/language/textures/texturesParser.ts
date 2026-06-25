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
    [key: string]: unknown;
}

export interface TextureDefinitionData {
    width: number;
    height: number;
}

export interface PatchPositionData {
    x: number;
    y: number;
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

export class TexturesParser {
    private cachedResult: ParseResult = { rootNodes: [], diagnostics: [] };
    private cachedVersion: number = -1;
    private cachedUri: string = '';
    private lineContexts: TexturesContext[] = [];

    update(document: vscode.TextDocument): void {
        const uri = document.uri.toString();
        if (uri === this.cachedUri && document.version === this.cachedVersion) { return; }
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
                    const node: TexturesNode = {
                        id: name,
                        kind: TexturesNodeKind.Definition,
                        type: defMatch[1],
                        name: name,
                        range: new vscode.Range(i, 0, i, lineText.length),
                        nameRange,
                        children: [],
                        defData: { width: parseInt(defMatch[4]), height: parseInt(defMatch[5]) },
                        patchProps: {}
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
                        patchProps: {}
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
                            this.parseInlineProperties(clean.substring(pBraceStart + 1, pBraceEnd), node);
                            currentPatch.range = new vscode.Range(i, 0, i, lineText.length);
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
                }
            } else if (context === TexturesContext.Patch) {
                if (clean.includes('}')) {
                    if (currentPatch) {
                        currentPatch.range = new vscode.Range(currentPatch.range.start.line, 0, i, lineText.length);
                    }
                    currentPatch = undefined;
                    context = TexturesContext.Texture;
                } else if (currentPatch) {
                    this.parsePatchProperty(clean, currentPatch);
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

    private processInlineTexture(
        clean: string,
        lineText: string,
        lineNum: number,
        def: TexturesNode,
        startPatchIndex: number
    ): void {
        const braceIdx = clean.indexOf('{');
        if (braceIdx < 0) { return; }
        const afterBrace = clean.substring(braceIdx + 1);
        const patchMatch = PATCH_CAPTURE_RE.exec(afterBrace);
        if (!patchMatch) { return; }
        const pName = patchMatch[2] ?? patchMatch[3];
        const pNameRange = this.findNameRange(lineText, lineNum, pName, patchMatch[2] !== undefined);
        const ranges = this.findCoordRanges(lineText, lineNum, pName, patchMatch[2] !== undefined);
        const node: TexturesNode = {
            id: `${def.name}:${patchMatch[1]}:${startPatchIndex}`,
            kind: TexturesNodeKind.Patch,
            type: patchMatch[1],
            name: pName,
            range: new vscode.Range(lineNum, 0, lineNum, lineText.length),
            nameRange: pNameRange,
            parent: def,
            children: [],
            patchData: { x: parseInt(patchMatch[4]), y: parseInt(patchMatch[5]) },
            xRange: ranges.xRange,
            yRange: ranges.yRange,
            patchProps: {}
        };
        const patchBlockStart = afterBrace.indexOf('{', patchMatch.index + patchMatch[0].length);
        if (patchBlockStart >= 0) {
            const patchBlockEnd = afterBrace.indexOf('}', patchBlockStart);
            if (patchBlockEnd >= 0) {
                this.parseInlineProperties(afterBrace.substring(patchBlockStart + 1, patchBlockEnd), node);
            }
        }
        def.children.push(node);
    }

    private parseInlineProperties(content: string, node: TexturesNode): void {
        const boolRe = /\b(FlipX|FlipY|UseOffsets)\b/gi;
        let m: RegExpExecArray | null;
        while ((m = boolRe.exec(content)) !== null) {
            node.patchProps[m[1]] = true;
        }
        const intRe = /\b(Rotate)\s+(-?\d+)/gi;
        while ((m = intRe.exec(content)) !== null) {
            node.patchProps[m[1]] = parseInt(m[2]);
        }
        const floatRe = /\b(Alpha)\s+(-?[0-9]+\.?[0-9]*)/gi;
        while ((m = floatRe.exec(content)) !== null) {
            node.patchProps[m[1]] = parseFloat(m[2]);
        }
        const strRe = /\b(Style)\s+(\S+)/gi;
        while ((m = strRe.exec(content)) !== null) {
            node.patchProps[m[1]] = m[2];
        }
    }

    private findNameRange(lineText: string, lineNum: number, name: string, quoted: boolean): vscode.Range {
        if (quoted) {
            const idx = lineText.indexOf('"' + name + '"');
            if (idx >= 0) {
                return new vscode.Range(lineNum, idx + 1, lineNum, idx + 1 + name.length);
            }
        }
        const idx = lineText.indexOf(name);
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

    private parsePatchProperty(clean: string, patch: TexturesNode): void {
        let m: RegExpExecArray | null;

        m = PROP_BOOL_RE.exec(clean);
        if (m) {
            patch.patchProps[m[1]] = true;
            return;
        }

        m = PROP_INT_RE.exec(clean);
        if (m) {
            patch.patchProps[m[1]] = parseInt(m[2]);
            return;
        }

        m = PROP_FLOAT_RE.exec(clean);
        if (m) {
            patch.patchProps[m[1]] = parseFloat(m[2]);
            return;
        }

        m = PROP_STR_RE.exec(clean);
        if (m) {
            patch.patchProps[m[1]] = m[2];
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
