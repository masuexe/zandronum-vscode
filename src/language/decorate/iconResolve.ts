import * as vscode from 'vscode';
import { ResourceIndex, ResourceMetadata, ResourceType } from '../textures/resourceIndex';

export const INVENTORY_ICON_COMMAND = 'zandronum.goToInventoryIcon';
const ICON_CONTEXT = 'zandronum.inventoryIconAtCursor';

interface IconReference {
    name: string;
    start: number;
    end: number;
}

const references = new WeakMap<vscode.TextDocument, { version: number; icons: IconReference[] }>();

/** Skip comments and other strings so text mentioning Inventory.Icon is not a reference. */
export function inventoryIconAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    let cached = references.get(document);
    if (!cached || cached.version !== document.version) {
        const text = document.getText();
        const icons: IconReference[] = [];
        const tokens = /"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|\bInventory\.Icon\b/gi;
        let token: RegExpExecArray | null;
        while ((token = tokens.exec(text)) !== null) {
            if (token[0].toLowerCase() !== 'inventory.icon') { continue; }
            if (token.index > 0 && /[\w.]/.test(text[token.index - 1])) { continue; }
            const value = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))+("(?:\\.|[^"\\])*"|[A-Za-z0-9_]+)/.exec(text.slice(tokens.lastIndex));
            if (!value) { continue; }
            const quoted = value[1].startsWith('"');
            const name = quoted ? value[1].slice(1, -1) : value[1];
            const start = tokens.lastIndex + value[0].length - value[1].length + (quoted ? 1 : 0);
            if (name) { icons.push({ name, start, end: start + name.length }); }
            tokens.lastIndex += value[0].length;
        }
        cached = { version: document.version, icons };
        references.set(document, cached);
    }
    const offset = document.offsetAt(position);
    return cached.icons.find(icon => icon.start <= offset && offset < icon.end)?.name;
}

/** Definitions take precedence over same-name images; package priority breaks ties. */
export async function resolveInventoryIcon(
    name: string,
    index: ResourceIndex,
    token: vscode.CancellationToken
): Promise<ResourceMetadata | undefined> {
    if (token.isCancellationRequested) { return undefined; }
    await index.whenReady(true);
    if (token.isCancellationRequested) { return undefined; }
    let definition: ResourceMetadata | undefined;
    let image: ResourceMetadata | undefined;
    for (const resource of index.resolveAll(name)) {
        if (resource.type === ResourceType.TextureDefinition) {
            if (!definition || resource.priority >= definition.priority) { definition = resource; }
        } else if (resource.type === ResourceType.Png || resource.type === ResourceType.Jpeg) {
            if (!image || resource.priority >= image.priority) { image = resource; }
        }
    }
    return definition ?? image;
}

export function iconDefinitionLocation(resource: ResourceMetadata): vscode.Location | undefined {
    if (resource.type !== ResourceType.TextureDefinition || !resource.definitionRange) { return undefined; }
    return new vscode.Location(resource.uri, resource.definitionRange);
}

export async function openInventoryIcon(editor: vscode.TextEditor, index: ResourceIndex): Promise<void> {
    const position = editor.selection.active;
    const version = editor.document.version;
    const name = inventoryIconAtPosition(editor.document, position);
    if (!name) { return; }
    const cancellation = new vscode.CancellationTokenSource();
    const listener = vscode.window.onDidChangeActiveTextEditor(() => cancellation.cancel());
    try {
        const resource = await resolveInventoryIcon(name, index, cancellation.token);
        if (!resource || cancellation.token.isCancellationRequested
            || editor.document.version !== version || !editor.selection.active.isEqual(position)) { return; }
        const location = iconDefinitionLocation(resource);
        if (location) {
            await vscode.window.showTextDocument(location.uri, { selection: location.range });
        } else {
            await vscode.commands.executeCommand('vscode.open', resource.uri);
        }
    } finally {
        listener.dispose();
        cancellation.dispose();
    }
}

/** F12 can open binary resources; the native definition command only opens text editors. */
export function registerInventoryIconNavigation(context: vscode.ExtensionContext, index: ResourceIndex): void {
    const updateContext = () => {
        const editor = vscode.window.activeTextEditor;
        const active = editor?.document.languageId === 'decorate'
            && inventoryIconAtPosition(editor.document, editor.selection.active) !== undefined;
        void vscode.commands.executeCommand('setContext', ICON_CONTEXT, !!active);
    };
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateContext),
        vscode.window.onDidChangeTextEditorSelection(updateContext),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === vscode.window.activeTextEditor?.document) { updateContext(); }
        }),
        vscode.commands.registerCommand(INVENTORY_ICON_COMMAND, async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== 'decorate') { return; }
            const name = inventoryIconAtPosition(editor.document, editor.selection.active);
            if (!name) {
                await vscode.commands.executeCommand('editor.action.revealDefinition');
                return;
            }
            await openInventoryIcon(editor, index);
        }),
        new vscode.Disposable(() => { void vscode.commands.executeCommand('setContext', ICON_CONTEXT, false); })
    );
    updateContext();
}
