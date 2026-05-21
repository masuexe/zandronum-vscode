import * as vscode from 'vscode';

export function registerEnterCompleteCommand(context: vscode.ExtensionContext) {
    const enterDisposable = vscode.commands.registerTextEditorCommand(
        'decorate.enterComplete',
        async (textEditor, edit) => {
            const position = textEditor.selection.active;
            const line = textEditor.document.lineAt(position.line);
            const lineText = line.text;

            // 检查行是否以 sprite name frame tics 开头
            const match = lineText.match(/^(\s*)(\w+)\s+([A-Za-z0-9])\s+(\d+)(\s+|$)/);

            if (match) {
                const indent = match[1];
                const spriteName = match[2];
                const frame = match[3];
                const tics = match[4];

                // 获取下一个frame字母
                const nextFrameCode = frame.charCodeAt(0);
                if (
                    nextFrameCode <= 'Z'.charCodeAt(0) ||
                    (frame.charCodeAt(0) >= 'a'.charCodeAt(0) && nextFrameCode <= 'z'.charCodeAt(0))
                ) {
                    const newFrame = String.fromCharCode(nextFrameCode);
                    const newText = `\n${indent}${spriteName} ${newFrame} ${tics}`;

                    edit.insert(position, newText);

                    const newLine = position.line + 1;
                    const newChar =
                        indent.length +
                        spriteName.length + 1 +
                        newFrame.length + 1 +
                        tics.length;

                    const newPos = new vscode.Position(newLine, newChar);

                    setTimeout(() => {
                        textEditor.selection = new vscode.Selection(newPos, newPos);
                    }, 0);
                }
            } else {
                await vscode.commands.executeCommand('type', { text: '\n' });
            }
        }
    );

    context.subscriptions.push(enterDisposable);
}
