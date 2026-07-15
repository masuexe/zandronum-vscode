/** Extra include roots from base resources (folder roots + extracted PK3 ACS). */
let baseAcsIncludeDirs: string[] = [];

export function setBaseAcsIncludeDirs(dirs: string[]): void {
    baseAcsIncludeDirs = dirs.slice();
}

export function getBaseAcsIncludeDirs(): readonly string[] {
    return baseAcsIncludeDirs;
}
