import * as vscode from 'vscode';
import { PackageManager } from './packageManager';

export const BASE_RESOURCE_SCHEME = 'zandronum-base';

/**
 * URI form: zandronum-base://<encodeURIComponent(packageId)>/<entryPath>
 */
export function makeBaseResourceUri(packageId: string, entryPath: string): vscode.Uri {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return vscode.Uri.from({
        scheme: BASE_RESOURCE_SCHEME,
        authority: encodeURIComponent(packageId),
        path: '/' + normalized
    });
}

export function parseBaseResourceUri(uri: vscode.Uri): { packageId: string; entryPath: string } | undefined {
    if (uri.scheme !== BASE_RESOURCE_SCHEME) { return undefined; }
    const packageId = decodeURIComponent(uri.authority);
    const entryPath = uri.path.replace(/^\/+/, '');
    if (!packageId || !entryPath) { return undefined; }
    return { packageId, entryPath };
}

export class BaseResourceContentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly packageManager: PackageManager) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const parsed = parseBaseResourceUri(uri);
        if (!parsed) { return ''; }
        const pkg = this.packageManager.findPackage(parsed.packageId);
        if (!pkg) { return `// Base resource package not found: ${parsed.packageId}`; }
        const bytes = await pkg.openEntry(parsed.entryPath);
        if (bytes.length === 0) {
            return `// Entry not found: ${parsed.entryPath} in ${parsed.packageId}`;
        }
        return Buffer.from(bytes).toString('utf-8');
    }

    /** Notify open editors that package contents may have changed. */
    invalidateAll(): void {
        // Fire a generic change; VS Code reloads individual docs on next access.
        // We cannot enumerate all URIs cheaply, so consumers reopen via definition.
        this._onDidChange.fire(vscode.Uri.from({ scheme: BASE_RESOURCE_SCHEME, path: '/' }));
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}

export async function openBaseResourceDocument(
    packageId: string,
    entryPath: string,
    languageId?: string
): Promise<vscode.TextDocument> {
    const uri = makeBaseResourceUri(packageId, entryPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    if (languageId && doc.languageId !== languageId) {
        return vscode.languages.setTextDocumentLanguage(doc, languageId);
    }
    return doc;
}
