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

export interface TexturesNode {
    kind: TexturesNodeKind;
    type: string;
    name: string;
    range: vscode.Range;
    nameRange: vscode.Range;
    parent?: TexturesNode;
    children: TexturesNode[];
    params: number[];
}

const DEFINITION_RE = /(?:^|\s)(?:Texture|WallTexture|Flat|Sprite|Graphic)\b/i;
const PATCH_RE = /(?:^|\s)(?:Patch|Graphic)\b/i;
const KEYWORD_CAPTURE_RE = /\b(Texture|WallTexture|Flat|Sprite|Graphic)\s+(?:optional\s+)?(?:"([^"]*)")\s*,\s*(\d+)\s*,\s*(\d+)/i;
const PATCH_CAPTURE_RE = /\b(Patch|Graphic)\s+(?:"([^"]*)")\s*,\s*(-?\d+)\s*,\s*(-?\d+)/i;

export class TexturesParser {
    private nodes: TexturesNode[] = [];
    private version: number = -1;
    private lineContexts: TexturesContext[] = [];

    update(document: vscode.TextDocument): void {
        if (document.version === this.version) { return; }
        this.version = document.version;
        this.parse(document);
    }

    getContextAtPosition(position: vscode.Position): TexturesContext {
        if (position.line < this.lineContexts.length) {
            return this.lineContexts[position.line];
        }
        return TexturesContext.Top;
    }

    getNodeAtPosition(position: vscode.Position): TexturesNode | undefined {
        for (const node of this.nodes) {
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
        for (const node of this.nodes) {
            if (node.range.contains(position)) {
                return node;
            }
        }
        return undefined;
    }

    getSymbols(): TexturesNode[] {
        return this.nodes;
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
        collect(this.nodes);
        return ranges;
    }

    private parse(document: vscode.TextDocument): void {
        this.nodes = [];
        this.lineContexts = [];

        let context = TexturesContext.Top;
        let inBlockComment = false;
        let currentDef: TexturesNode | undefined;
        let currentPatch: TexturesNode | undefined;
        let pendingDef: Omit<TexturesNode, 'range'> & { startLine: number } | undefined;
        let pendingPatch: Omit<TexturesNode, 'range'> & { startLine: number } | undefined;

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const stripped = this.stripComments(lineText, inBlockComment);
            inBlockComment = stripped.inBlockComment;
            const clean = stripped.text;

            this.lineContexts[i] = context;

            if (context === TexturesContext.Top) {
                const defMatch = KEYWORD_CAPTURE_RE.exec(clean);
                if (defMatch) {
                    const nameStart = lineText.indexOf('"' + defMatch[2] + '"');
                    const node: TexturesNode = {
                        kind: TexturesNodeKind.Definition,
                        type: defMatch[1],
                        name: defMatch[2],
                        range: new vscode.Range(i, 0, i, 0),
                        nameRange: new vscode.Range(i, nameStart + 1, i, nameStart + 1 + defMatch[2].length),
                        children: [],
                        params: [parseInt(defMatch[3]), parseInt(defMatch[4])]
                    };
                    if (clean.includes('{')) {
                        context = TexturesContext.Texture;
                        currentDef = node;
                        this.lineContexts[i] = TexturesContext.Texture;
                    } else {
                        pendingDef = { ...node, startLine: i };
                    }
                    if (!pendingDef) {
                        this.nodes.push(node);
                        currentDef = node;
                    }
                } else if (pendingDef && clean.includes('{')) {
                    const node: TexturesNode = {
                        ...pendingDef,
                        range: new vscode.Range(pendingDef.startLine, 0, i, 0)
                    };
                    this.nodes.push(node);
                    currentDef = node;
                    pendingDef = undefined;
                    context = TexturesContext.Texture;
                    this.lineContexts[i] = TexturesContext.Texture;
                }
            } else if (context === TexturesContext.Texture) {
                const patchMatch = PATCH_CAPTURE_RE.exec(clean);
                if (patchMatch && currentDef) {
                    const nameStart = lineText.indexOf('"' + patchMatch[2] + '"');
                    const node: TexturesNode = {
                        kind: TexturesNodeKind.Patch,
                        type: patchMatch[1],
                        name: patchMatch[2],
                        range: new vscode.Range(i, 0, i, 0),
                        nameRange: new vscode.Range(i, nameStart + 1, i, nameStart + 1 + patchMatch[2].length),
                        parent: currentDef,
                        children: [],
                        params: [parseInt(patchMatch[3]), parseInt(patchMatch[4])]
                    };
                    if (clean.includes('{')) {
                        context = TexturesContext.Patch;
                        currentPatch = node;
                        currentDef.children.push(node);
                        this.lineContexts[i] = TexturesContext.Patch;
                    } else {
                        pendingPatch = { ...node, startLine: i };
                    }
                    if (!pendingPatch) {
                        currentDef.children.push(node);
                        currentPatch = node;
                    }
                } else if (pendingPatch && clean.includes('{') && currentDef) {
                    const node: TexturesNode = {
                        ...pendingPatch,
                        range: new vscode.Range(pendingPatch.startLine, 0, i, 0)
                    };
                    currentDef.children.push(node);
                    currentPatch = node;
                    pendingPatch = undefined;
                    context = TexturesContext.Patch;
                    this.lineContexts[i] = TexturesContext.Patch;
                } else if (clean.includes('}')) {
                    if (currentDef) {
                        currentDef.range = new vscode.Range(currentDef.range.start.line, 0, i, document.lineAt(i).text.length);
                    }
                    currentDef = undefined;
                    currentPatch = undefined;
                    pendingPatch = undefined;
                    context = TexturesContext.Top;
                }
            } else if (context === TexturesContext.Patch) {
                if (clean.includes('}')) {
                    if (currentPatch) {
                        currentPatch.range = new vscode.Range(currentPatch.range.start.line, 0, i, document.lineAt(i).text.length);
                    }
                    currentPatch = undefined;
                    context = TexturesContext.Texture;
                }
            }
        }

        if (currentDef) {
            const lastLine = this.lineContexts.length - 1;
            currentDef.range = new vscode.Range(currentDef.range.start.line, 0, lastLine, 0);
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
