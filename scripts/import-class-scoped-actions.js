/**
 * Import class-scoped action natives from Zandronum actor DECORATE sources.
 * Also merges declaring-class ancestry into inheritance.json.
 *
 * Usage:
 *   node scripts/import-class-scoped-actions.js           # report only
 *   node scripts/import-class-scoped-actions.js --apply   # write JSON
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = path.join(ROOT, 'ref', 'zandronum-stable-branch-default');
const ACTORS_DIR = path.join(REF, 'wadsrc', 'static', 'actors');
const ACTIONS_PATH = path.join(ROOT, 'data', 'decorate', 'actions.json');
const INHERITANCE_PATH = path.join(ROOT, 'data', 'decorate', 'inheritance.json');

function mapType(raw) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (/^class</i.test(t)) return 'string';
    if (/^coerce\s+name$/i.test(t) || /^name$/i.test(t) || /^string$/i.test(t)) return 'string';
    if (/^sound$/i.test(t) || /^color$/i.test(t)) return 'string';
    if (/^state$/i.test(t)) return 'state';
    if (/^bool$/i.test(t)) return 'bool';
    if (/^float$/i.test(t) || /^double$/i.test(t) || /^fixed$/i.test(t)) return 'float';
    if (/^int$/i.test(t)) return 'int';
    return 'int';
}

function normalizeDefault(def, type) {
    if (def == null) return undefined;
    let d = def.trim().replace(/\/\/.*$/, '').trim();
    if (type === 'string' || type === 'state') {
        if (/^AAPTR_/i.test(d) || /^[A-Z][A-Z0-9_]*$/.test(d)) return d;
        if ((d.startsWith('"') && d.endsWith('"')) || (d.startsWith("'") && d.endsWith("'"))) {
            return d.startsWith("'") ? `"${d.slice(1, -1)}"` : d;
        }
        return `"${d}"`;
    }
    if (type === 'bool') {
        if (/^true$/i.test(d)) return 'true';
        if (/^false$/i.test(d)) return 'false';
        return d;
    }
    return d;
}

function parseParams(argStr) {
    const params = [];
    if (!argStr || !argStr.trim()) return params;

    const parts = [];
    let cur = '';
    let depthAngle = 0;
    let depthParen = 0;
    for (const ch of argStr) {
        if (ch === '<') depthAngle++;
        else if (ch === '>') depthAngle--;
        else if (ch === '(') depthParen++;
        else if (ch === ')') depthParen--;
        if (ch === ',' && depthAngle === 0 && depthParen === 0) {
            parts.push(cur.trim());
            cur = '';
        } else {
            cur += ch;
        }
    }
    if (cur.trim()) parts.push(cur.trim());

    for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed === '...') {
            params.push({ name: '...', type: 'state', optional: true, variadic: true });
            continue;
        }
        const pm = /^(coerce\s+name|class<[^>]+>|[A-Za-z_][\w:]*)\s+(\w+)(?:\s*=\s*(.+))?$/i.exec(trimmed);
        if (!pm) {
            console.warn('Unparsed param:', trimmed);
            continue;
        }
        const type = mapType(pm[1]);
        const param = { name: pm[2], type, optional: pm[3] !== undefined };
        if (pm[3] !== undefined) {
            param.default = normalizeDefault(pm[3], type);
        }
        params.push(param);
    }
    return params;
}

function walkTxtFiles(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkTxtFiles(p, out);
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.txt')) out.push(p);
    }
    return out;
}

/**
 * Parse all actor files: class extends map + action natives with declaring class.
 */
function parseActorSources() {
    /** @type {Map<string, string|null>} class -> parent (null = no parent / native root) */
    const extendsMap = new Map();
    /** @type {Map<string, { name: string, params: any[], classes: Set<string> }>} */
    const natives = new Map();

    const actorHeaderRe = /^\s*actor\s+(\w+)(?:\s*:\s*(\w+))?/i;
    const actionRe = /action\s+native\s+(\w+)\s*\(([^;]*)\)\s*;/gi;

    for (const file of walkTxtFiles(ACTORS_DIR)) {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split(/\r?\n/);

        let currentClass = null;
        let braceDepth = 0;
        let inActor = false;

        for (const line of lines) {
            const header = actorHeaderRe.exec(line);
            if (header && braceDepth === 0) {
                currentClass = header[1];
                const parent = header[2] || null;
                if (!extendsMap.has(currentClass)) {
                    extendsMap.set(currentClass, parent);
                }
                inActor = true;
            }

            if (inActor && currentClass) {
                actionRe.lastIndex = 0;
                let m;
                while ((m = actionRe.exec(line)) !== null) {
                    const name = m[1];
                    const params = parseParams(m[2]);
                    if (!natives.has(name)) {
                        natives.set(name, { name, params, classes: new Set() });
                    }
                    const entry = natives.get(name);
                    entry.classes.add(currentClass);
                    // Prefer first non-empty param list if later decl is empty duplicate
                    if ((!entry.params || entry.params.length === 0) && params.length > 0) {
                        entry.params = params;
                    }
                }
            }

            for (const ch of line) {
                if (ch === '{') {
                    braceDepth++;
                } else if (ch === '}') {
                    braceDepth--;
                    if (braceDepth <= 0) {
                        braceDepth = 0;
                        inActor = false;
                        currentClass = null;
                    }
                }
            }
        }
    }

    return { extendsMap, natives };
}

function categoryFor(className, extendsMap) {
    let cur = className;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        if (cur === 'Inventory' || cur === 'Weapon' || cur === 'Ammo' || cur === 'Armor') {
            return 'Inventory';
        }
        if (cur === 'Powerup' || /^Power/.test(cur)) {
            return 'Powerup';
        }
        cur = extendsMap.get(cur) || null;
    }
    return 'Actor';
}

function collectAncestors(className, extendsMap) {
    const out = [];
    let cur = className;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
        seen.add(cur);
        out.push(cur);
        cur = extendsMap.get(cur) || null;
    }
    return out;
}

function forValue(classes) {
    const list = [...classes].filter((c) => c !== 'Actor').sort();
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return list;
}

function mergeFor(existing, next) {
    const a = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
    const b = next == null ? [] : Array.isArray(next) ? next : [next];
    const set = new Set([...a, ...b].filter(Boolean));
    // Actor-global: no for
    if (set.size === 0) return undefined;
    const arr = [...set].sort();
    return arr.length === 1 ? arr[0] : arr;
}

function buildParamFromSource(src, existing) {
    const p = {
        name: src.name,
        type: src.type,
        optional: !!src.optional,
    };
    if (src.variadic) p.variadic = true;
    if (src.optional && src.default !== undefined) p.default = src.default;
    if (existing) {
        if (existing.mode) p.mode = existing.mode;
        if (existing.enum) p.enum = existing.enum;
        if (existing.variadic) p.variadic = existing.variadic;
        if (src.type === 'state') p.type = 'state';
    }
    return p;
}

function forClassesEqual(a, b) {
    const norm = (v) => {
        if (v == null) return [];
        return (Array.isArray(v) ? v : [v]).slice().sort();
    };
    const aa = norm(a);
    const bb = norm(b);
    return aa.length === bb.length && aa.every((x, i) => x === bb[i]);
}

function expectedForFromClasses(classes) {
    return forValue(new Set([...classes].filter((c) => c !== 'Actor')));
}

function main() {
    const apply = process.argv.includes('--apply');
    const { extendsMap, natives } = parseActorSources();

    const actions = JSON.parse(fs.readFileSync(ACTIONS_PATH, 'utf8'));
    const inheritance = JSON.parse(fs.readFileSync(INHERITANCE_PATH, 'utf8'));

    let actorCount = 0;
    let scopedCount = 0;
    let added = 0;
    let updatedFor = 0;
    let inheritanceAdded = 0;

    // Classes that declare at least one non-Actor action (need inheritance coverage)
    const scopedDeclaring = new Set();

    for (const [, native] of natives) {
        const classes = [...native.classes];
        const onlyActor = classes.length === 1 && classes[0] === 'Actor';
        const hasActor = classes.includes('Actor');
        const scopedClasses = classes.filter((c) => c !== 'Actor');

        if (onlyActor || (hasActor && scopedClasses.length === 0)) {
            actorCount++;
            // Ensure Actor natives have no for
            if (actions[native.name] && actions[native.name].for !== undefined) {
                if (apply) {
                    delete actions[native.name].for;
                    updatedFor++;
                }
            }
            continue;
        }

        scopedCount++;
        for (const c of scopedClasses) scopedDeclaring.add(c);

        const forVal = forValue(new Set(scopedClasses));
        const existing = actions[native.name];

        if (!existing) {
            if (apply) {
                actions[native.name] = {
                    params: native.params,
                    for: forVal,
                    desc: `Action function: ${native.name}`,
                };
                added++;
            } else {
                added++;
            }
            continue;
        }

        // Update existing: set/merge for, preserve usage/enum, sync params from source when arity differs
        const nextFor = mergeFor(existing.for, forVal);
        const forChanged = JSON.stringify(existing.for ?? null) !== JSON.stringify(nextFor ?? null);
        const jsonParams = Array.isArray(existing.params) ? existing.params : [];
        const arityMismatch = jsonParams.length !== native.params.length;

        if (apply) {
            const newParams = native.params.map((sp, i) =>
                buildParamFromSource(
                    sp,
                    jsonParams.find((p) => typeof p === 'object' && p.name === sp.name) ||
                        (typeof jsonParams[i] === 'object' ? jsonParams[i] : undefined)
                )
            );
            const next = {
                params: newParams,
                desc: existing.desc || `Action function: ${native.name}`,
            };
            if (existing.usage) next.usage = existing.usage;
            if (nextFor !== undefined) next.for = nextFor;
            actions[native.name] = next;
            if (forChanged || arityMismatch) updatedFor++;
        } else if (forChanged || !existing.for || arityMismatch) {
            updatedFor++;
        }
    }

    // Merge inheritance for scoped declaring classes + full ancestor chains
    for (const className of scopedDeclaring) {
        for (const anc of collectAncestors(className, extendsMap)) {
            if (anc === 'Actor') continue;
            const parent = extendsMap.get(anc) || 'Actor';
            if (!inheritance[anc]) {
                inheritance[anc] = {
                    category: categoryFor(anc, extendsMap),
                    extends: parent === null ? 'Actor' : parent,
                };
                inheritanceAdded++;
            } else if (!inheritance[anc].extends && parent) {
                inheritance[anc].extends = parent;
            }
        }
    }

    // Ensure Inventory/Weapon chain roots exist
    if (!inheritance.Inventory) {
        inheritance.Inventory = { category: 'Inventory', extends: 'Actor' };
        inheritanceAdded++;
    }

    console.log('=== Class-scoped import ===');
    console.log('Natives total:', natives.size);
    console.log('Actor-only (no for):', actorCount);
    console.log('Class-scoped:', scopedCount);
    console.log('Would add / added:', added);
    console.log('For updates:', updatedFor);
    console.log('Inheritance entries added:', inheritanceAdded);
    console.log('Scoped declaring classes:', scopedDeclaring.size);

    if (apply) {
        // Stable-ish key order: keep existing keys first, append new sorted
        const ordered = {};
        for (const k of Object.keys(actions)) ordered[k] = actions[k];
        fs.writeFileSync(ACTIONS_PATH, JSON.stringify(ordered, null, 2) + '\n', 'utf8');

        const inhOrdered = {};
        for (const k of Object.keys(inheritance).sort((a, b) => a.localeCompare(b))) {
            inhOrdered[k] = inheritance[k];
        }
        fs.writeFileSync(INHERITANCE_PATH, JSON.stringify(inhOrdered, null, 2) + '\n', 'utf8');
        console.log('Wrote actions.json and inheritance.json');
    } else {
        console.log('Dry run. Pass --apply to write.');
    }

    // Sample checks
    for (const sample of ['A_CFlameRotate', 'A_WeaponReady', 'A_FireBullets', 'A_ZoomFactor', 'A_RandomPowerupFrame']) {
        const e = apply ? actions[sample] : (actions[sample] || (natives.has(sample) ? { for: forValue(natives.get(sample).classes) } : null));
        console.log(' ', sample, e ? JSON.stringify({ for: e.for, params: (e.params || []).length }) : 'MISSING');
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    parseActorSources,
    expectedForFromClasses,
    forClassesEqual,
    collectAncestors,
    ACTORS_DIR,
    ACTIONS_PATH,
    INHERITANCE_PATH,
};
