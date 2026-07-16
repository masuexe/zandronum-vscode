export const ACS_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'break', 'continue', 'return', 'until', 'terminate', 'restart', 'suspend', 'goto',
    'script', 'function', 'void',
    'true', 'false', 'on', 'off',
    'world', 'global',
    'int', 'str', 'bool', 'fixed',
]);

export function scanLineDeclarations(
    effective: string,
    onDefine: (name: string) => void,
    onInclude: (includePath: string) => void,
    onVariable: (name: string) => void
): void {
    const includeMatch = /^\s*#\s*include\s+"([^"]*)"/i.exec(effective);
    if (includeMatch) {
        onInclude(includeMatch[1]);
        return;
    }

    const defineRe = /#\s*(?:libdefine|define)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    let defineMatch: RegExpExecArray | null;
    while ((defineMatch = defineRe.exec(effective)) !== null) {
        const name = defineMatch[1];
        if (!ACS_KEYWORDS.has(name.toLowerCase())) {
            onDefine(name);
        }
    }

    const paramsRe = /\(([^)]*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramsRe.exec(effective)) !== null) {
        const paramVarRe = /\b(int|str|bool|fixed)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
        let pvm: RegExpExecArray | null;
        while ((pvm = paramVarRe.exec(pm[1])) !== null) {
            const varName = pvm[2];
            if (!ACS_KEYWORDS.has(varName.toLowerCase())) {
                onVariable(varName);
            }
        }
    }

    const varDeclRe = /\b(int|str|bool|fixed)\s+([^;]+)(?:;|$)/gi;
    let m: RegExpExecArray | null;
    while ((m = varDeclRe.exec(effective)) !== null) {
        let tail = m[2];
        let prevTail: string;
        do {
            prevTail = tail;
            tail = tail.replace(/\([^()]*\)/g, '');
        } while (tail !== prevTail);
        const parts = tail.split(',');
        for (const part of parts) {
            const trimmed = part.trimStart().replace(/^\d+:\s*/, '');
            // Multi-param lines: "str text, str fontName" — later parts still start with a type.
            // Also support same-type lists: "int a, b, c".
            const typedId = /^(?:int|str|bool|fixed)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(trimmed);
            const idMatch = typedId ?? /^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed);
            if (idMatch) {
                const varName = idMatch[1];
                if (!ACS_KEYWORDS.has(varName.toLowerCase())) {
                    onVariable(varName);
                }
            }
        }
    }
}
