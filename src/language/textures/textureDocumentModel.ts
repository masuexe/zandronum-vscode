import * as vscode from 'vscode';
import * as fs from 'fs';
import { TexturesParser, TexturesNode, TexturesContext, TexturesParseDiagnostic, PatchProperties } from './texturesParser';
import { ResourceIndex, ResourceType, ResourceMetadata } from './resourceIndex';
import { readGrabOffset } from '../../tools/png/pngGrabChunk';
import { readPngSize } from '../../tools/png/pngChunkReader';

export interface CompositeSubPatch {
    uri: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    flipX: boolean;
    flipY: boolean;
    rotate: number;
    alpha: number;
    /** Raw Translation string from TEXTURES (applied in webview with PLAYPAL). */
    translation?: string;
    children?: CompositeSubPatch[];
}

export interface ResolvedResource {
    uri: string | null;
    width: number;
    height: number;
    resourceType: 'image' | 'composite' | 'missing';
    grabOffset?: { x: number; y: number } | null;
    subPatches?: CompositeSubPatch[];
}

export interface PatchPropUpdate {
    x?: number;
    y?: number;
    FlipX?: boolean;
    FlipY?: boolean;
    Rotate?: number;
    Alpha?: number;
    UseOffsets?: boolean;
}

export interface TexturePropUpdate {
    width?: number;
    height?: number;
    offsetX?: number;
    offsetY?: number;
    xScale?: number;
    yScale?: number;
}

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

export class TextureDocumentModel {
    readonly document: vscode.TextDocument;
    private readonly parser: TexturesParser;
    private readonly resourceIndex: ResourceIndex;
    private readonly grabCache = new Map<string, { x: number; y: number } | null>();

    constructor(
        document: vscode.TextDocument,
        parser: TexturesParser,
        resourceIndex: ResourceIndex
    ) {
        this.document = document;
        this.parser = parser;
        this.resourceIndex = resourceIndex;
    }

    get version(): number {
        return this.document.version;
    }

    update(): void {
        this.parser.update(this.document);
    }

    getTextures(): TexturesNode[] {
        return this.parser.getSymbols();
    }

    getTextureByName(name: string): TexturesNode | undefined {
        const lower = name.toLowerCase();
        return this.parser.getSymbols().find(n => n.name.toLowerCase() === lower);
    }

    getNodeById(id: string): TexturesNode | undefined {
        return this.parser.getNodeById(id);
    }

    getNodeAtPosition(position: vscode.Position): TexturesNode | undefined {
        return this.parser.getNodeAtPosition(position);
    }

    getContext(position: vscode.Position): TexturesContext {
        return this.parser.getContextAtPosition(position);
    }

    listImageNames(): string[] {
        return this.resourceIndex.listImageNames();
    }

    resolveResource(resourceId: string, webview: vscode.Webview): string | null {
        const resolved = this.resolveResourceFull(resourceId, webview);
        return resolved.uri;
    }

    getResourceSize(resourceId: string): { width: number; height: number } | null {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return null; }
        const name = parts[1].toLowerCase();
        const localDef = this.parser.getSymbols().find(
            n => n.name.toLowerCase() === name
        );
        if (localDef && localDef.defData) {
            return { width: localDef.defData.width, height: localDef.defData.height };
        }
        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta) { return null; }
        this.ensureMetaImageSize(meta);
        if (meta.width === undefined || meta.height === undefined) { return null; }
        return { width: meta.width, height: meta.height };
    }

    /**
     * Lazily read PNG IHDR into ResourceMetadata and cache on the index entry.
     * Index build intentionally skips sizes for startup speed.
     */
    private ensureMetaImageSize(meta: ResourceMetadata): void {
        if (meta.width !== undefined && meta.height !== undefined) { return; }
        if (meta.type !== ResourceType.Png) { return; }
        try {
            if (meta.uri.scheme === 'file' && fs.existsSync(meta.uri.fsPath)) {
                const data = new Uint8Array(fs.readFileSync(meta.uri.fsPath));
                const size = readPngSize(data);
                if (size) {
                    meta.width = size.width;
                    meta.height = size.height;
                }
            }
        } catch { /* ignore */ }
    }

    resolveResourceFull(resourceId: string, webview: vscode.Webview, visited?: Set<string>): ResolvedResource {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }
        const name = parts[1].toLowerCase();

        const v = visited ?? new Set<string>();
        if (v.has(name)) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }

        const localDef = this.parser.getSymbols().find(
            n => n.name.toLowerCase() === name
        );
        if (localDef && localDef.defData && localDef.children.length > 0) {
            // Cycle guard only for the current resolution stack. Pop after so
            // sibling patches can reuse the same composite (e.g. two Patch 6G36A0).
            v.add(name);
            const subPatches = this.resolveSubPatches(localDef, webview, v);
            v.delete(name);
            return {
                uri: null,
                width: localDef.defData.width,
                height: localDef.defData.height,
                resourceType: 'composite',
                subPatches,
                // TEXTURES Offset on Sprite/Graphic defs acts like PNG grAb
                grabOffset: {
                    x: localDef.texProps.OffsetX ?? 0,
                    y: localDef.texProps.OffsetY ?? 0
                }
            };
        }

        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta) { return { uri: null, width: 0, height: 0, resourceType: 'missing' }; }

        if (meta.type === ResourceType.TextureDefinition) {
            // Cross-file definition: try on-demand parse for patches (sync open-doc path)
            v.add(name);
            const external = this.resolveExternalDefinitionSync(meta.uri, name, webview, v);
            v.delete(name);
            if (external) { return external; }
            return {
                uri: null,
                width: meta.width ?? 0,
                height: meta.height ?? 0,
                resourceType: 'composite',
                subPatches: []
            };
        }

        this.ensureMetaImageSize(meta);
        const uriStr = webview.asWebviewUri(meta.uri).toString();
        const grab = this.readGrabForUri(meta.uri);
        return {
            uri: uriStr,
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            resourceType: 'image',
            grabOffset: grab
        };
    }

    private resolveExternalDefinitionSync(
        uri: vscode.Uri,
        name: string,
        webview: vscode.Webview,
        visited: Set<string>
    ): ResolvedResource | null {
        try {
            const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
            if (openDoc) {
                const parser = new TexturesParser();
                parser.update(openDoc);
                const def = parser.getSymbols().find(n => n.name.toLowerCase() === name);
                if (!def || !def.defData) { return null; }
                const subPatches = this.resolveSubPatchesFromNodes(def.children, webview, visited);
                return {
                    uri: null,
                    width: def.defData.width,
                    height: def.defData.height,
                    resourceType: 'composite',
                    subPatches,
                    grabOffset: {
                        x: def.texProps.OffsetX ?? 0,
                        y: def.texProps.OffsetY ?? 0
                    }
                };
            }
            if (uri.scheme === 'file' && fs.existsSync(uri.fsPath)) {
                const text = fs.readFileSync(uri.fsPath, 'utf-8');
                return this.parseExternalText(text, name, webview, visited, uri);
            }
            return null;
        } catch {
            return null;
        }
    }

    private parseExternalText(
        text: string,
        name: string,
        webview: vscode.Webview,
        visited: Set<string>,
        uri: vscode.Uri
    ): ResolvedResource | null {
        // Create an untitled document content for the shared parser
        const lines = text.split(/\r?\n/);
        const fakeDoc = {
            uri,
            version: 1,
            lineCount: lines.length,
            lineAt(n: number) {
                return {
                    text: lines[n] ?? '',
                    lineNumber: n,
                    range: new vscode.Range(n, 0, n, (lines[n] ?? '').length),
                    rangeIncludingLineBreak: new vscode.Range(n, 0, n, (lines[n] ?? '').length),
                    firstNonWhitespaceCharacterIndex: 0,
                    isEmptyOrWhitespace: !(lines[n] ?? '').trim()
                };
            },
            getText(range?: vscode.Range) {
                if (!range) { return text; }
                // Simplified: full text only used by edits, not parse
                return text;
            }
        } as unknown as vscode.TextDocument;

        const parser = new TexturesParser();
        parser.update(fakeDoc);
        const def = parser.getSymbols().find(n => n.name.toLowerCase() === name);
        if (!def || !def.defData) { return null; }
        const subPatches = this.resolveSubPatchesFromNodes(def.children, webview, visited);
        return {
            uri: null,
            width: def.defData.width,
            height: def.defData.height,
            resourceType: 'composite',
            subPatches,
            grabOffset: {
                x: def.texProps.OffsetX ?? 0,
                y: def.texProps.OffsetY ?? 0
            }
        };
    }

    private resolveSubPatches(
        def: TexturesNode,
        webview: vscode.Webview,
        visited: Set<string>
    ): CompositeSubPatch[] {
        return this.resolveSubPatchesFromNodes(def.children, webview, visited);
    }

    private resolveSubPatchesFromNodes(
        children: TexturesNode[],
        webview: vscode.Webview,
        visited: Set<string>
    ): CompositeSubPatch[] {
        const results: CompositeSubPatch[] = [];
        for (const child of children) {
            const childResource = this.resolveResourceFull(`patch:${child.name}`, webview, visited);
            const translation = typeof child.patchProps.Translation === 'string'
                ? child.patchProps.Translation
                : undefined;
            const base: CompositeSubPatch = {
                uri: childResource.uri,
                x: child.patchData?.x ?? 0,
                y: child.patchData?.y ?? 0,
                width: childResource.width,
                height: childResource.height,
                flipX: !!child.patchProps.FlipX,
                flipY: !!child.patchProps.FlipY,
                rotate: (child.patchProps.Rotate as number) ?? 0,
                alpha: (child.patchProps.Alpha as number) ?? 1,
                translation
            };

            if (childResource.resourceType === 'image' && childResource.uri) {
                if (child.patchProps.UseOffsets && childResource.grabOffset) {
                    base.x -= childResource.grabOffset.x;
                    base.y -= childResource.grabOffset.y;
                }
                results.push(base);
            } else if (childResource.resourceType === 'composite' && childResource.subPatches) {
                // Keep children in composite-local coordinates. The webview draws this
                // wrapper into an offscreen of (width×height), then applies Flip/Rotate
                // around the composite center when placing it at (x,y).
                results.push({
                    ...base,
                    uri: null,
                    children: childResource.subPatches.map(sp => ({ ...sp }))
                });
            }
        }
        return results;
    }

    private readGrabForUri(uri: vscode.Uri): { x: number; y: number } | null {
        const key = uri.toString();
        if (this.grabCache.has(key)) {
            return this.grabCache.get(key)!;
        }
        try {
            if (uri.scheme === 'file' && fs.existsSync(uri.fsPath)) {
                const data = new Uint8Array(fs.readFileSync(uri.fsPath));
                const grab = readGrabOffset(data);
                this.grabCache.set(key, grab);
                return grab;
            }
        } catch { /* ignore */ }
        this.grabCache.set(key, null);
        return null;
    }

    async getGrabOffset(resourceId: string): Promise<{ x: number; y: number } | null> {
        const parts = resourceId.split(':');
        if (parts.length < 2) { return null; }
        const meta = this.resourceIndex.resolve(parts[0], parts[1]);
        if (!meta || meta.type === ResourceType.TextureDefinition) { return null; }
        return this.readGrabForUri(meta.uri);
    }

    async applyPatchMove(
        patchId: string,
        x: number,
        y: number,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }

        const node = this.parser.getNodeById(patchId);
        if (!node || !node.xRange || !node.yRange) { return false; }

        const edit = new vscode.WorkspaceEdit();
        edit.replace(this.document.uri, node.xRange, String(x));
        edit.replace(this.document.uri, node.yRange, String(y));
        return vscode.workspace.applyEdit(edit);
    }

    async applyTextureOffset(
        textureName: string,
        offsetX: number,
        offsetY: number,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        return this.applyTextureProps(textureName, { offsetX, offsetY }, expectedVersion);
    }

    async applyTextureProps(
        textureName: string,
        props: TexturePropUpdate,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.getTextureByName(textureName);
        if (!node || !node.defData) { return false; }

        const edit = new vscode.WorkspaceEdit();
        const uri = this.document.uri;

        if (props.width !== undefined && node.texPropRanges.width) {
            edit.replace(uri, node.texPropRanges.width, String(Math.round(props.width)));
        }
        if (props.height !== undefined && node.texPropRanges.height) {
            edit.replace(uri, node.texPropRanges.height, String(Math.round(props.height)));
        }

        const needsTexProps =
            props.offsetX !== undefined ||
            props.offsetY !== undefined ||
            props.xScale !== undefined ||
            props.yScale !== undefined;

        if (needsTexProps) {
            const ok = this.rewriteTextureProperties(edit, node, props);
            if (!ok) { return false; }
        }

        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Atomically resize a texture: update W/H, optionally shift all patches and Offset.
     * Used by border-drag resize (left/top edges shift content to keep it visually fixed).
     */
    async resizeTexture(
        textureName: string,
        opts: {
            width: number;
            height: number;
            offsetX?: number;
            offsetY?: number;
            patchDx?: number;
            patchDy?: number;
        },
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.getTextureByName(textureName);
        if (!node || !node.defData) { return false; }

        const width = Math.max(1, Math.round(opts.width));
        const height = Math.max(1, Math.round(opts.height));
        const dx = Math.round(opts.patchDx ?? 0);
        const dy = Math.round(opts.patchDy ?? 0);

        const edit = new vscode.WorkspaceEdit();
        const uri = this.document.uri;

        if (node.texPropRanges.width) {
            edit.replace(uri, node.texPropRanges.width, String(width));
        }
        if (node.texPropRanges.height) {
            edit.replace(uri, node.texPropRanges.height, String(height));
        }

        if (dx !== 0 || dy !== 0) {
            for (const child of node.children) {
                if (dx !== 0 && child.xRange && child.patchData) {
                    edit.replace(uri, child.xRange, String(Math.round(child.patchData.x + dx)));
                }
                if (dy !== 0 && child.yRange && child.patchData) {
                    edit.replace(uri, child.yRange, String(Math.round(child.patchData.y + dy)));
                }
            }
        }

        const needsOffset = opts.offsetX !== undefined || opts.offsetY !== undefined;
        if (needsOffset) {
            const ok = this.rewriteTextureProperties(edit, node, {
                offsetX: opts.offsetX,
                offsetY: opts.offsetY
            });
            if (!ok) { return false; }
        }

        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Shrink/expand the texture canvas to the axis-aligned bounding box of all patches.
     * Shifts patches so the bbox origin is (0,0) and adjusts Offset so on-screen content stays put.
     */
    async trimTextureToPatches(
        textureName: string,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.getTextureByName(textureName);
        if (!node || !node.defData) { return false; }
        if (node.children.length === 0) { return false; }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;

        for (const child of node.children) {
            const x = child.patchData?.x ?? 0;
            const y = child.patchData?.y ?? 0;
            const { w, h } = this.getPatchEffectiveSize(child);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        }

        if (!Number.isFinite(minX) || !Number.isFinite(minY)) { return false; }

        const width = Math.max(1, Math.round(maxX - minX));
        const height = Math.max(1, Math.round(maxY - minY));
        const patchDx = -Math.round(minX);
        const patchDy = -Math.round(minY);

        const curOx = node.texProps.OffsetX ?? 0;
        const curOy = node.texProps.OffsetY ?? 0;
        const needsShift = patchDx !== 0 || patchDy !== 0;

        return this.resizeTexture(textureName, {
            width,
            height,
            patchDx,
            patchDy,
            ...(needsShift
                ? { offsetX: curOx + patchDx, offsetY: curOy + patchDy }
                : {})
        }, expectedVersion);
    }

    /**
     * Rewrite Offset / XScale / YScale for a definition.
     * Handles compact one-line forms and cleans duplicate orphan lines.
     */
    private rewriteTextureProperties(
        edit: vscode.WorkspaceEdit,
        def: TexturesNode,
        props: TexturePropUpdate
    ): boolean {
        const nextOffsetX = props.offsetX !== undefined
            ? Math.round(props.offsetX)
            : (def.texProps.OffsetX ?? 0);
        const nextOffsetY = props.offsetY !== undefined
            ? Math.round(props.offsetY)
            : (def.texProps.OffsetY ?? 0);
        const nextXScale = props.xScale !== undefined
            ? props.xScale
            : (def.texProps.XScale ?? 1);
        const nextYScale = props.yScale !== undefined
            ? props.yScale
            : (def.texProps.YScale ?? 1);

        // Keep Offset if it was set or is being set (including 0,0 after user edit)
        const keepOffset = props.offsetX !== undefined || props.offsetY !== undefined
            || def.texProps.OffsetX !== undefined || def.texProps.OffsetY !== undefined;
        const keepXScale = Math.abs(nextXScale - 1) >= 1e-6;
        const keepYScale = Math.abs(nextYScale - 1) >= 1e-6;

        // 1) Remove all existing Offset / XScale / YScale in the def body + orphan
        //    lines left after previous buggy inserts (often after a one-liner `}`).
        this.deleteTextureKeywordOccurrences(edit, def, /\bOffset\s+-?\d+\s*,\s*-?\d+/gi);
        this.deleteTextureKeywordOccurrences(edit, def, /\bXScale\s+-?[0-9]+\.?[0-9]*/gi);
        this.deleteTextureKeywordOccurrences(edit, def, /\bYScale\s+-?[0-9]+\.?[0-9]*/gi);
        this.deleteOrphanTexturePropLines(edit, def);

        // 2) Build replacement property text
        const parts: string[] = [];
        if (keepOffset) {
            parts.push(`Offset ${nextOffsetX}, ${nextOffsetY}`);
        }
        if (keepXScale) {
            parts.push(`XScale ${nextXScale}`);
        }
        if (keepYScale) {
            parts.push(`YScale ${nextYScale}`);
        }
        if (parts.length === 0) {
            return true;
        }

        // 3) Insert after the definition's opening `{`
        const insert = this.findTextureBodyInsert(def);
        if (!insert) { return false; }

        if (insert.inline) {
            edit.insert(this.document.uri, insert.pos, parts.join(' ') + ' ');
        } else {
            edit.insert(this.document.uri, insert.pos, parts.map(p => `\t${p}\n`).join(''));
        }
        return true;
    }

    /** Delete every match of `re` inside the definition body (between outer `{` `}`). */
    private deleteTextureKeywordOccurrences(
        edit: vscode.WorkspaceEdit,
        def: TexturesNode,
        re: RegExp
    ): void {
        const startLine = def.range.start.line;
        const endLine = def.range.end.line;
        const deletions: vscode.Range[] = [];
        for (let line = startLine; line <= endLine; line++) {
            const text = this.document.lineAt(line).text;
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                deletions.push(new vscode.Range(line, m.index, line, m.index + m[0].length));
            }
        }
        for (let i = deletions.length - 1; i >= 0; i--) {
            const d = deletions[i];
            const lineText = this.document.lineAt(d.start.line).text;
            const before = lineText.substring(0, d.start.character).trim();
            const after = lineText.substring(d.end.character).trim();
            if (before === '' && after === '' && d.start.line !== startLine) {
                edit.delete(this.document.uri, this.expandToFullLine(d));
            } else {
                let end = d.end.character;
                if (end < lineText.length && /\s/.test(lineText[end])) { end++; }
                edit.delete(this.document.uri, new vscode.Range(d.start.line, d.start.character, d.end.line, end));
            }
        }
    }

    /**
     * Remove stray Offset/XScale/YScale lines that sit after a closed definition
     * (produced by older insert bugs). Stops at the next definition keyword.
     */
    private deleteOrphanTexturePropLines(
        edit: vscode.WorkspaceEdit,
        def: TexturesNode
    ): void {
        const orphanRe = /^\s*(Offset\s+-?\d+\s*,\s*-?\d+|XScale\s+-?[0-9]+\.?[0-9]*|YScale\s+-?[0-9]+\.?[0-9]*|WorldPanning|NoDecals|NullTexture)\s*$/i;
        const defStartRe = /^\s*(Texture|WallTexture|Flat|Sprite|Graphic)\b/i;
        const linesToDelete: number[] = [];
        for (let line = def.range.end.line + 1; line < this.document.lineCount; line++) {
            const text = this.document.lineAt(line).text;
            if (text.trim() === '') { continue; }
            if (defStartRe.test(text)) { break; }
            if (orphanRe.test(text)) {
                linesToDelete.push(line);
            } else {
                break;
            }
        }
        for (let i = linesToDelete.length - 1; i >= 0; i--) {
            const line = linesToDelete[i];
            edit.delete(this.document.uri, this.expandToFullLine(new vscode.Range(line, 0, line, 0)));
        }
    }

    private findTextureBodyInsert(def: TexturesNode): { pos: vscode.Position; inline: boolean } | null {
        const startLine = def.range.start.line;
        const startText = this.document.lineAt(startLine).text;
        const braceIdx = startText.indexOf('{');
        if (braceIdx >= 0) {
            // Compact one-liner if closing `}` is on the same line
            const closeIdx = startText.lastIndexOf('}');
            const inline = closeIdx > braceIdx;
            return {
                pos: new vscode.Position(startLine, braceIdx + 1),
                inline
            };
        }
        // `{` on the next line
        if (startLine + 1 < this.document.lineCount) {
            const next = this.document.lineAt(startLine + 1).text;
            const nextBrace = next.indexOf('{');
            if (nextBrace >= 0) {
                return {
                    pos: new vscode.Position(startLine + 2, 0),
                    inline: false
                };
            }
        }
        return {
            pos: new vscode.Position(startLine + 1, 0),
            inline: false
        };
    }

    private expandToFullLine(range: vscode.Range): vscode.Range {
        const line = range.start.line;
        const nextLine = line + 1;
        if (nextLine < this.document.lineCount) {
            return new vscode.Range(line, 0, nextLine, 0);
        }
        const text = this.document.lineAt(line).text;
        return new vscode.Range(line, 0, line, text.length);
    }

    async applyPatchProps(
        patchId: string,
        props: PatchPropUpdate,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.parser.getNodeById(patchId);
        if (!node || node.parent === undefined) { return false; }

        const edit = new vscode.WorkspaceEdit();
        const uri = this.document.uri;

        if (props.x !== undefined && node.xRange) {
            edit.replace(uri, node.xRange, String(Math.round(props.x)));
        }
        if (props.y !== undefined && node.yRange) {
            edit.replace(uri, node.yRange, String(Math.round(props.y)));
        }

        // Bool / value patch props are rewritten as a unit so compact inline
        // forms like `Patch X,0,0{FlipX}` toggle cleanly without nested blocks.
        const boolKeys: Array<'FlipX' | 'FlipY' | 'UseOffsets'> = [];
        if (props.FlipX !== undefined) { boolKeys.push('FlipX'); }
        if (props.FlipY !== undefined) { boolKeys.push('FlipY'); }
        if (props.UseOffsets !== undefined) { boolKeys.push('UseOffsets'); }

        const hasValueProps = props.Rotate !== undefined || props.Alpha !== undefined;
        if (boolKeys.length > 0 || hasValueProps) {
            const ok = this.rewritePatchProperties(edit, node, props);
            if (!ok) { return false; }
        }

        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Rewrite a patch's property block in-place.
     * Desired state = current props merged with `props` update.
     */
    private rewritePatchProperties(
        edit: vscode.WorkspaceEdit,
        node: TexturesNode,
        props: PatchPropUpdate
    ): boolean {
        const loc = this.findPatchPropertySpan(node);
        if (!loc) { return false; }

        const next: PatchProperties = { ...node.patchProps };
        if (props.FlipX !== undefined) {
            if (props.FlipX) { next.FlipX = true; } else { delete next.FlipX; }
        }
        if (props.FlipY !== undefined) {
            if (props.FlipY) { next.FlipY = true; } else { delete next.FlipY; }
        }
        if (props.UseOffsets !== undefined) {
            if (props.UseOffsets) { next.UseOffsets = true; } else { delete next.UseOffsets; }
        }
        if (props.Rotate !== undefined) {
            const rot = VALID_ROTATIONS.has(props.Rotate) ? props.Rotate : 0;
            if (rot === 0) { delete next.Rotate; } else { next.Rotate = rot; }
        }
        if (props.Alpha !== undefined) {
            const alpha = Math.min(1, Math.max(0, props.Alpha));
            if (Math.abs(alpha - 1) < 1e-6) { delete next.Alpha; } else { next.Alpha = alpha; }
        }

        const blockText = this.formatPatchPropertyBlock(next, loc.inline);
        if (loc.hasBlock) {
            edit.replace(this.document.uri, loc.blockRange, blockText);
        } else if (blockText.length > 0) {
            const insertText = loc.inline ? blockText : `\n\t${blockText}`;
            edit.insert(this.document.uri, loc.insertPos, insertText);
        }
        return true;
    }

    private formatPatchPropertyBlock(
        props: PatchProperties,
        inline: boolean
    ): string {
        const lines: string[] = [];
        if (props.FlipX) { lines.push('FlipX'); }
        if (props.FlipY) { lines.push('FlipY'); }
        if (props.UseOffsets) { lines.push('UseOffsets'); }
        if (typeof props.Rotate === 'number') { lines.push(`Rotate ${props.Rotate}`); }
        if (typeof props.Alpha === 'number') { lines.push(`Alpha ${props.Alpha}`); }
        if (typeof props.Style === 'string') { lines.push(`Style ${props.Style}`); }
        if (typeof props.Translation === 'string') { lines.push(`Translation ${props.Translation}`); }

        if (lines.length === 0) { return ''; }
        if (inline) {
            return `{${lines.join(' ')}}`;
        }
        return `{\n\t\t${lines.join('\n\t\t')}\n\t}`;
    }

    /**
     * Locate the patch header end and optional `{ ... }` property block.
     * Handles both multi-line patches and compact inline forms.
     */
    private findPatchPropertySpan(node: TexturesNode): {
        hasBlock: boolean;
        blockRange: vscode.Range;
        insertPos: vscode.Position;
        inline: boolean;
    } | null {
        const startLine = node.range.start.line;
        const endLine = node.range.end.line;
        const startText = this.document.lineAt(startLine).text;

        // Find "Patch|Graphic name, x, y" on the start line
        const headerRe = /\b(Patch|Graphic)\s+(?:"[^"]*"|[^\s,]+)\s*,\s*-?\d+\s*,\s*-?\d+/i;
        const headerMatch = headerRe.exec(startText);
        if (!headerMatch) { return null; }
        const headerEndCol = headerMatch.index + headerMatch[0].length;

        // Prefer a `{` that belongs to this patch (after the header on the same line,
        // or on the following lines before the next sibling / parent close).
        const afterHeader = startText.substring(headerEndCol);
        const inlineBrace = afterHeader.indexOf('{');
        if (inlineBrace >= 0) {
            const openCol = headerEndCol + inlineBrace;
            const close = this.findMatchingBrace(startLine, openCol);
            if (!close) { return null; }
            const inline = close.line === startLine;
            return {
                hasBlock: true,
                blockRange: new vscode.Range(startLine, openCol, close.line, close.col + 1),
                insertPos: new vscode.Position(startLine, headerEndCol),
                inline
            };
        }

        // Multi-line: `{` on a later line within the patch range
        for (let line = startLine + 1; line <= endLine; line++) {
            const text = this.document.lineAt(line).text;
            const braceCol = text.indexOf('{');
            if (braceCol >= 0) {
                const close = this.findMatchingBrace(line, braceCol);
                if (!close) { return null; }
                return {
                    hasBlock: true,
                    blockRange: new vscode.Range(line, braceCol, close.line, close.col + 1),
                    insertPos: new vscode.Position(startLine, headerEndCol),
                    inline: close.line === line
                };
            }
        }

        // No property block yet — insert after header
        const preferInline = startLine === endLine && startText.includes('}');
        return {
            hasBlock: false,
            blockRange: new vscode.Range(startLine, headerEndCol, startLine, headerEndCol),
            insertPos: new vscode.Position(startLine, headerEndCol),
            inline: preferInline
        };
    }

    private findMatchingBrace(
        openLine: number,
        openCol: number
    ): { line: number; col: number } | null {
        let depth = 0;
        for (let line = openLine; line < this.document.lineCount; line++) {
            const text = this.document.lineAt(line).text;
            const startCol = line === openLine ? openCol : 0;
            for (let col = startCol; col < text.length; col++) {
                const ch = text[col];
                if (ch === '{') { depth++; }
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) { return { line, col }; }
                }
            }
            // Safety: don't scan forever past a reasonable window
            if (line > openLine + 200) { break; }
        }
        return null;
    }

    async addPatch(
        textureName: string,
        patchName: string,
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const def = this.getTextureByName(textureName);
        if (!def) { return false; }

        const edit = new vscode.WorkspaceEdit();
        const line = `\tPatch "${patchName}", 0, 0\n`;
        const insertPos = this.findPatchInsertPosition(def);
        edit.insert(this.document.uri, insertPos, line);
        return vscode.workspace.applyEdit(edit);
    }

    private findPatchInsertPosition(def: TexturesNode): vscode.Position {
        // Insert before the closing `}` of the definition
        const endLine = def.range.end.line;
        const endText = this.document.lineAt(endLine).text;
        const closeIdx = endText.lastIndexOf('}');
        if (closeIdx >= 0) {
            return new vscode.Position(endLine, closeIdx);
        }
        return new vscode.Position(endLine, endText.length);
    }

    /** True when the texture definition is a compact one-liner. */
    private isInlineDefinition(def: TexturesNode): boolean {
        return def.range.start.line === def.range.end.line;
    }

    /**
     * Insert patch source text inside the parent definition (before closing `}`).
     * Inline defs stay on one line; multiline defs get a tab-indented new line.
     */
    private insertPatchIntoDefinition(
        edit: vscode.WorkspaceEdit,
        parent: TexturesNode,
        patchSourceText: string
    ): void {
        const insertPos = this.findPatchInsertPosition(parent);
        let text = patchSourceText.trim();
        if (this.isInlineDefinition(parent)) {
            // e.g. `...{ Patch A,0,0{...} Patch B,1,0{...}}`
            text = ' ' + text;
        } else {
            if (!/^[ \t]/.test(text)) {
                text = '\t' + text;
            }
            if (!text.endsWith('\n')) {
                text += '\n';
            }
        }
        edit.insert(this.document.uri, insertPos, text);
    }

    async removePatch(patchId: string, expectedVersion: number): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.parser.getNodeById(patchId);
        if (!node) { return false; }

        // Delete only the patch span — never the whole line from column 0.
        // Inline one-liners share a line with the texture header; full-line delete
        // would wipe the entire definition.
        let start = node.range.start;
        let end = node.range.end;

        // Drop one leading space/tab so " Patch A Patch B" stays tidy
        if (start.character > 0) {
            const lineText = this.document.lineAt(start.line).text;
            const prev = lineText[start.character - 1];
            if (prev === ' ' || prev === '\t') {
                start = new vscode.Position(start.line, start.character - 1);
            }
        }

        // Multiline patches that own whole lines: include trailing newline
        const endLineText = this.document.lineAt(end.line).text;
        const startsAtLineBegin = node.range.start.character === 0;
        const endsAtOrPastLineEnd = end.character >= endLineText.length;
        if (startsAtLineBegin && endsAtOrPastLineEnd && end.line + 1 < this.document.lineCount) {
            end = new vscode.Position(end.line + 1, 0);
        }

        const edit = new vscode.WorkspaceEdit();
        edit.delete(this.document.uri, new vscode.Range(start, end));
        return vscode.workspace.applyEdit(edit);
    }

    async reorderPatch(
        patchId: string,
        direction: 'up' | 'down',
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.parser.getNodeById(patchId);
        if (!node || !node.parent) { return false; }
        const siblings = node.parent.children;
        const idx = siblings.findIndex(c => c.id === patchId);
        if (idx < 0) { return false; }
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= siblings.length) { return false; }

        const a = siblings[idx];
        const b = siblings[swapIdx];
        const textA = this.getNodeText(a);
        const textB = this.getNodeText(b);

        // Replace later range first to preserve positions
        const first = a.range.start.line <= b.range.start.line ? a : b;
        const second = first === a ? b : a;
        const firstText = first === a ? textA : textB;
        const secondText = first === a ? textB : textA;

        const edit = new vscode.WorkspaceEdit();
        // Swap by replacing both ranges with each other's text
        // Work from bottom to top
        const rangeSecond = this.nodeFullRange(second);
        const rangeFirst = this.nodeFullRange(first);
        edit.replace(this.document.uri, rangeSecond, firstText);
        edit.replace(this.document.uri, rangeFirst, secondText);
        return vscode.workspace.applyEdit(edit);
    }

    async duplicatePatch(patchId: string, expectedVersion: number): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.parser.getNodeById(patchId);
        if (!node || !node.parent) { return false; }

        // Use exact patch span (not full line) so inline defs don't clone the whole sprite line
        let text = this.document.getText(node.range);
        // Offset +8,+8 like SLADE
        const x = (node.patchData?.x ?? 0) + 8;
        const y = (node.patchData?.y ?? 0) + 8;
        text = text.replace(
            new RegExp(`(${node.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*,\\s*)(-?\\d+)(\\s*,\\s*)(-?\\d+)`),
            `$1${x}$3${y}`
        );

        const edit = new vscode.WorkspaceEdit();
        this.insertPatchIntoDefinition(edit, node.parent, text);
        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Duplicate a patch mirrored about the texture center axis, toggling FlipX/FlipY.
     * @deprecated Prefer symmetryPatch({ mode: 'copy', ref: 'texture' }).
     */
    async mirrorPatch(
        patchId: string,
        axis: 'h' | 'v',
        expectedVersion: number
    ): Promise<boolean> {
        return this.symmetryPatch(patchId, {
            direction: axis,
            ref: 'texture',
            mode: 'copy',
            offsetType: 'none'
        }, expectedVersion);
    }

    /**
     * Reflect or mirror-copy a patch about texture mid or screen mid.
     * - texture mid: x = width/2, y = height/2
     * - screen mid (sprite): (OffsetX, OffsetY)
     * - screen mid (hud): (OffsetX+160, OffsetY+100)
     */
    async symmetryPatch(
        patchId: string,
        opts: {
            direction: 'h' | 'v';
            ref: 'texture' | 'screen';
            mode: 'reflect' | 'copy';
            offsetType: 'none' | 'sprite' | 'hud';
        },
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        if (opts.ref === 'screen' && opts.offsetType === 'none') { return false; }

        const node = this.parser.getNodeById(patchId);
        const parent = node?.parent;
        const defData = parent?.defData;
        if (!node || !parent || !defData) { return false; }

        const computed = this.computePatchSymmetry(node, parent, opts.direction, opts.ref, opts.offsetType);
        if (!computed) { return false; }

        if (opts.mode === 'reflect') {
            const props: PatchPropUpdate = {};
            if (opts.direction === 'h') {
                props.x = computed.newX;
                props.FlipX = computed.flipX;
            } else {
                props.y = computed.newY;
                props.FlipY = computed.flipY;
            }
            return this.applyPatchProps(patchId, props, expectedVersion);
        }

        // Mirror copy — insert a new patch
        const nextProps: PatchProperties = { ...node.patchProps };
        if (opts.direction === 'h') {
            if (computed.flipX) { nextProps.FlipX = true; } else { delete nextProps.FlipX; }
        } else {
            if (computed.flipY) { nextProps.FlipY = true; } else { delete nextProps.FlipY; }
        }

        const keyword = node.type || 'Patch';
        const namePart = this.document.getText(node.nameRange);
        const parentInline = this.isInlineDefinition(parent);
        const block = this.formatPatchPropertyBlock(nextProps, parentInline);
        const newX = computed.newX;
        const newY = computed.newY;

        let patchText: string;
        if (parentInline) {
            patchText = `${keyword} ${namePart}, ${newX}, ${newY}${block}`;
        } else if (block.length > 0) {
            patchText = `${keyword} ${namePart}, ${newX}, ${newY}\n\t${block}`;
        } else {
            patchText = `${keyword} ${namePart}, ${newX}, ${newY}`;
        }

        const edit = new vscode.WorkspaceEdit();
        this.insertPatchIntoDefinition(edit, parent, patchText);
        return vscode.workspace.applyEdit(edit);
    }

    /**
     * Reflect every patch about the screen mid (sprite/HUD). Offset stays put so the
     * on-screen flip is exactly about the reference midline (changing Offset would double-move).
     */
    async reflectTextureAboutScreen(
        textureName: string,
        direction: 'h' | 'v',
        offsetType: 'sprite' | 'hud',
        expectedVersion: number
    ): Promise<boolean> {
        if (expectedVersion !== this.version) { return false; }
        const node = this.getTextureByName(textureName);
        if (!node || !node.defData) { return false; }

        const edit = new vscode.WorkspaceEdit();
        const uri = this.document.uri;

        for (const child of node.children) {
            const computed = this.computePatchSymmetry(child, node, direction, 'screen', offsetType);
            if (!computed) { continue; }
            if (direction === 'h') {
                if (child.xRange) {
                    edit.replace(uri, child.xRange, String(computed.newX));
                }
                const flipProps: PatchPropUpdate = { FlipX: computed.flipX };
                const ok = this.rewritePatchProperties(edit, child, flipProps);
                if (!ok) { return false; }
            } else {
                if (child.yRange) {
                    edit.replace(uri, child.yRange, String(computed.newY));
                }
                const flipProps: PatchPropUpdate = { FlipY: computed.flipY };
                const ok = this.rewritePatchProperties(edit, child, flipProps);
                if (!ok) { return false; }
            }
        }

        return vscode.workspace.applyEdit(edit);
    }

    private getPatchEffectiveSize(node: TexturesNode): { w: number; h: number } {
        const size = this.getResourceSize(`patch:${node.name}`);
        let w = size?.width ?? 32;
        let h = size?.height ?? 32;
        const rot = typeof node.patchProps.Rotate === 'number' ? node.patchProps.Rotate : 0;
        if (Math.abs(rot) % 180 === 90) {
            return { w: h, h: w };
        }
        return { w, h };
    }

    /** Screen / texture symmetry axis in texture coordinates. */
    private getSymmetryAxis(
        def: TexturesNode,
        direction: 'h' | 'v',
        ref: 'texture' | 'screen',
        offsetType: 'none' | 'sprite' | 'hud'
    ): number | null {
        const defData = def.defData;
        if (!defData) { return null; }
        if (ref === 'texture') {
            return direction === 'h' ? defData.width / 2 : defData.height / 2;
        }
        const ox = def.texProps.OffsetX ?? 0;
        const oy = def.texProps.OffsetY ?? 0;
        if (offsetType === 'sprite') {
            return direction === 'h' ? ox : oy;
        }
        if (offsetType === 'hud') {
            // HUD screen center in texture space
            return direction === 'h' ? ox + 160 : oy + 100;
        }
        return null;
    }

    private computePatchSymmetry(
        node: TexturesNode,
        parent: TexturesNode,
        direction: 'h' | 'v',
        ref: 'texture' | 'screen',
        offsetType: 'none' | 'sprite' | 'hud'
    ): { newX: number; newY: number; flipX: boolean; flipY: boolean } | null {
        const axis = this.getSymmetryAxis(parent, direction, ref, offsetType);
        if (axis === null) { return null; }
        const oldX = node.patchData?.x ?? 0;
        const oldY = node.patchData?.y ?? 0;
        const { w: effW, h: effH } = this.getPatchEffectiveSize(node);
        const hasFlipX = !!node.patchProps.FlipX;
        const hasFlipY = !!node.patchProps.FlipY;

        let newX = oldX;
        let newY = oldY;
        let flipX = hasFlipX;
        let flipY = hasFlipY;
        if (direction === 'h') {
            newX = Math.round(2 * axis - oldX - effW);
            flipX = !hasFlipX;
        } else {
            newY = Math.round(2 * axis - oldY - effH);
            flipY = !hasFlipY;
        }
        return { newX, newY, flipX, flipY };
    }

    private getNodeText(node: TexturesNode): string {
        return this.document.getText(this.nodeFullRange(node));
    }

    private nodeFullRange(node: TexturesNode): vscode.Range {
        const start = node.range.start.line;
        const end = node.range.end.line;
        if (end + 1 < this.document.lineCount) {
            // Prefer including the newline by using next line start when possible for swaps
            const endText = this.document.lineAt(end).text;
            return new vscode.Range(start, 0, end, endText.length);
        }
        const endText = this.document.lineAt(end).text;
        return new vscode.Range(start, 0, end, endText.length);
    }

    validate(): TexturesParseDiagnostic[] {
        return this.parser.getDiagnostics();
    }
}
