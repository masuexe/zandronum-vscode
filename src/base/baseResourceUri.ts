import * as vscode from 'vscode';
import { PackageManager } from './packageManager';

export const BASE_RESOURCE_SCHEME = 'zandronum-base';

/**
 * Encode packageId as a single path segment. Windows paths contain `:` and `/`,
 * which break Uri path parsing if left as encodeURIComponent (VS Code may decode
 * `%2F` back to `/`, then parseBaseResourceUri splits on the wrong slash).
 */
export function encodePackageIdSegment(packageId: string): string {
    return Buffer.from(packageId, 'utf8').toString('base64url');
}

export function decodePackageIdSegment(segment: string): string {
    try {
        const decoded = Buffer.from(segment, 'base64url').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('base64url') === segment) {
            return decoded;
        }
    } catch { /* fall through to legacy */ }
    // Legacy: encodeURIComponent(packageId) in the path segment
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * URI form (path-based, avoids VS Code lowercasing authority):
 *   zandronum-base:/p/<base64url(packageId)>/<entryPath>
 *
 * Legacy form still parsed for open editors:
 *   zandronum-base://<encodeURIComponent(packageId)>/<entryPath>
 *   zandronum-base:/p/<encodeURIComponent(packageId)>/<entryPath>
 */
export function makeBaseResourceUri(packageId: string, entryPath: string): vscode.Uri {
    const normalized = entryPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const encPkg = encodePackageIdSegment(packageId);
    // Encode each entry path segment so spaces/unicode are safe; keep `/` separators.
    const encEntry = normalized.split('/').map(s => encodeURIComponent(s)).join('/');
    return vscode.Uri.from({
        scheme: BASE_RESOURCE_SCHEME,
        path: `/p/${encPkg}/${encEntry}`
    });
}

export function parseBaseResourceUri(uri: vscode.Uri): { packageId: string; entryPath: string } | undefined {
    if (uri.scheme !== BASE_RESOURCE_SCHEME) { return undefined; }

    const rawPath = uri.path.replace(/^\/+/, '');
    if (rawPath.startsWith('p/')) {
        const rest = rawPath.slice(2);
        const slash = rest.indexOf('/');
        if (slash <= 0) { return undefined; }
        const packageId = decodePackageIdSegment(rest.slice(0, slash));
        // entryPath may still be percent-encoded per segment
        const entryRaw = rest.slice(slash + 1);
        let entryPath: string;
        try {
            entryPath = entryRaw.split('/').map(s => decodeURIComponent(s)).join('/');
        } catch {
            entryPath = entryRaw;
        }
        if (!packageId || !entryPath) { return undefined; }
        return { packageId, entryPath };
    }

    // Legacy authority-based URIs
    if (uri.authority) {
        const packageId = decodeURIComponent(uri.authority);
        const entryPath = rawPath;
        if (!packageId || !entryPath) { return undefined; }
        return { packageId, entryPath };
    }

    return undefined;
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
