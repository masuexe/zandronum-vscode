import { SymbolDatabase } from '../../base/symbolDatabase';
import { ActorSymbol, SymbolKind } from '../../base/types';

/**
 * Collect `user_*` names visible on `className`, walking `parentClass` via the symbol DB.
 * Names are lowercased. Missing parents / cycles are ignored safely.
 */
export function collectActorUserVars(
    db: SymbolDatabase | undefined,
    className: string | undefined
): Set<string> {
    const result = new Set<string>();
    if (!db || !className) {
        return result;
    }

    const visited = new Set<string>();
    let current: string | undefined = className;

    while (current) {
        const key = current.toLowerCase();
        if (visited.has(key)) {
            break;
        }
        visited.add(key);

        const sym: ActorSymbol | undefined = db.query(SymbolKind.Actor, current);
        if (!sym) {
            break;
        }

        if (Array.isArray(sym.userVars)) {
            for (const name of sym.userVars) {
                result.add(name.toLowerCase());
            }
        }

        const parent: string | undefined = sym.parentClass;
        current = parent;
        if (current && /^Actor$/i.test(current)) {
            break;
        }
    }

    return result;
}

/** Local `var int user_*` names in an actor line range (lowercase). */
export function collectLocalUserVarsInLines(
    lines: string[],
    startLine: number,
    endLine: number
): Set<string> {
    const result = new Set<string>();
    const varRe = /\bvar\s+int\s+(user_\w+)\b/gi;

    for (let line = startLine; line <= endLine && line < lines.length; line++) {
        const text = lines[line];
        const commentIdx = text.indexOf('//');
        const effective = commentIdx >= 0 ? text.slice(0, commentIdx) : text;
        varRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = varRe.exec(effective)) !== null) {
            result.add(m[1].toLowerCase());
        }
    }

    return result;
}

/**
 * Visible user vars for an actor in the open document:
 * local decls (unsaved-friendly) ∪ inherited chain from DB.
 */
export function visibleUserVarsForActor(
    db: SymbolDatabase | undefined,
    className: string,
    parentClass: string | undefined,
    localVars: Set<string>
): Set<string> {
    const visible = new Set<string>(localVars);
    const chainStart =
        db?.query<ActorSymbol>(SymbolKind.Actor, className) ? className : parentClass;
    for (const name of collectActorUserVars(db, chainStart)) {
        visible.add(name);
    }
    return visible;
}

/** Parse `actor Name : Parent` from a header line. */
export function parseActorHeader(line: string): { name: string; parentClass?: string } | undefined {
    const m = /^\s*actor\s+(\w+)\s*(?::\s*(\w+))?/i.exec(line);
    if (!m || !m[1]) {
        return undefined;
    }
    return { name: m[1], parentClass: m[2] || undefined };
}
