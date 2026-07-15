/** Pure helpers for base-resource path classification (unit-testable). */

export function getArchiveExt(reference: string): string {
    const base = reference.replace(/^.*[/\\]/, '');
    const dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot).toLowerCase() : '';
}

export function isSupportedArchive(reference: string): boolean {
    const ext = getArchiveExt(reference);
    return ext === '.pk3' || ext === '.zip';
}

export function unsupportedArchiveMessage(reference: string): string | undefined {
    const ext = getArchiveExt(reference);
    if (ext === '.wad') {
        return 'WAD files are not supported yet (special compression). Use a PK3 or a directory instead.';
    }
    if (ext === '.pk7') {
        return 'PK7 (7-Zip) archives are not supported yet. Use a PK3/ZIP archive or a directory instead.';
    }
    return undefined;
}
