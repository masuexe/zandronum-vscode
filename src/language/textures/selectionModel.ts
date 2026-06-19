import * as vscode from 'vscode';

export class SelectionModel {
    private _selectedTextureName: string | null = null;
    private _selectedPatchId: string | null = null;
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    get selectedTextureName(): string | null { return this._selectedTextureName; }
    set selectedTextureName(name: string | null) {
        if (this._selectedTextureName !== name) {
            this._selectedTextureName = name;
            this._onDidChange.fire();
        }
    }

    get selectedPatchId(): string | null { return this._selectedPatchId; }
    set selectedPatchId(id: string | null) {
        if (this._selectedPatchId !== id) {
            this._selectedPatchId = id;
            this._onDidChange.fire();
        }
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
