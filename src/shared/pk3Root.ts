import * as vscode from 'vscode';

export function getPk3Root(): string {
    const config = vscode.workspace.getConfiguration('zandronum-vscode');
    return config.get<string>('pk3Root') || 'src';
}

export function joinPk3Path(...segments: string[]): string {
    return [getPk3Root(), ...segments].join('/');
}
