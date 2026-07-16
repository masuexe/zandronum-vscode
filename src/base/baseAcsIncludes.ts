import { PackageSource } from './types';

/** Extra include roots from base resources (folder roots + extracted PK3 ACS). */
let baseAcsIncludeDirs: string[] = [];

/** Base packages available for LOADACS discovery during Build Project. */
let basePackagesForCompile: readonly PackageSource[] = [];

export function setBaseAcsIncludeDirs(dirs: string[]): void {
    baseAcsIncludeDirs = dirs.slice();
}

export function getBaseAcsIncludeDirs(): readonly string[] {
    return baseAcsIncludeDirs;
}

export function setBasePackagesForCompile(packages: readonly PackageSource[]): void {
    basePackagesForCompile = packages;
}

export function getBasePackagesForCompile(): readonly PackageSource[] {
    return basePackagesForCompile;
}
