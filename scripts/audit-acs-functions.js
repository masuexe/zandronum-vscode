/**
 * Audit / patch data/acs/functions.json against Zandronum-ACC + engine.
 *
 * Sources (under ref/):
 *   - acc-branch-zandronum/symbol.c          InternalFunctions[] (PCD builtins)
 *   - acc-branch-zandronum/zspecial.acs      CALLFUNC (negative) + line specials (positive)
 *   - zandronum-stable-branch-default/src/p_acs.cpp  EACSFunctions (warnings only)
 *
 * Usage:
 *   node scripts/audit-acs-functions.js           # report only
 *   node scripts/audit-acs-functions.js --apply   # write fixes + additions + removals
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ACC = path.join(ROOT, 'ref', 'acc-branch-zandronum');
const ENGINE = path.join(ROOT, 'ref', 'zandronum-stable-branch-default');
const FUNCTIONS_PATH = path.join(ROOT, 'data', 'acs', 'functions.json');

/** ACC language constructs (token.h) — not in InternalFunctions / zspecial tables. */
const LANGUAGE_ALLOWLIST = new Map([
    // Print-family: cast:expression list (not typed params). Keep max:0 so --apply does not invent fake args.
    ['print', { name: 'Print', min: 0, max: 0, kind: 'language' }],
    ['printbold', { name: 'PrintBold', min: 0, max: 0, kind: 'language' }],
    ['log', { name: 'Log', min: 0, max: 0, kind: 'language' }],
    ['strparam', { name: 'StrParam', min: 0, max: 0, kind: 'language' }],
    // HudMessage: cast list + ';' + fixed 6 + type-dependent opts (not ordinary typed params).
    ['hudmessage', { name: 'HudMessage', min: 0, max: 0, kind: 'language' }],
    ['hudmessagebold', { name: 'HudMessageBold', min: 0, max: 0, kind: 'language' }],
    ['beginprint', { name: 'BeginPrint', min: 0, max: 0, kind: 'language' }],
    ['endprint', { name: 'EndPrint', min: 0, max: 0, kind: 'language' }],
    ['morehudmessage', { name: 'MoreHudMessage', min: 0, max: 0, kind: 'language' }],
    ['opthudmessage', { name: 'OptHudMessage', min: 0, max: 0, kind: 'language' }],
]);

/** Atomic tokens for PascalCase (longest first). Underscores are split separately. */
const ACS_WORDS = [
    'inventory', 'activator', 'projectile', 'ceiling', 'texture', 'textures', 'blocking',
    'monster', 'special', 'network', 'invasion', 'marine', 'weapon', 'sprite', 'pointer',
    'gravity', 'trigger', 'control', 'sector', 'player', 'health', 'armor', 'points',
    'expert', 'frags', 'skull', 'yellow', 'blue', 'red', 'card', 'team', 'count', 'score',
    'floor', 'wait', 'poly', 'tag', 'line', 'side', 'clear', 'change', 'check', 'actor',
    'spawn', 'spot', 'facing', 'music', 'local', 'font', 'thing', 'sound', 'fixed',
    'angle', 'pitch', 'state', 'camera', 'ammo', 'capacity', 'level', 'info', 'sky',
    'cvar', 'result', 'value', 'hud', 'size', 'input', 'classify', 'number', 'game',
    'type', 'skill', 'timer', 'fade', 'range', 'style', 'mouse', 'grab', 'movie',
    'from', 'write', 'give', 'take', 'flag', 'sigil', 'pieces', 'screen', 'width',
    'height', 'light', 'damage', 'replace', 'unmorph', 'air', 'named',
    'script', 'name', 'get', 'set', 'use', 'is', 'one', 'mul', 'div', 'ini', 'tid',
    'bot', 'ctf', 'delay', 'random', 'cancel', 'single', 'console', 'command',
    'ambient', 'sequence', 'class', 'wave', 'row', 'offset', 'to', 'in', 'of',
    'str', 'len', 'mug', 'shot',
].sort((a, b) => b.length - a.length || a.localeCompare(b));

const SPECIAL_CASING = {
    tid: 'TID',
    cvar: 'CVar',
    ctf: 'CTF',
    hud: 'Hud',
    ini: 'INI',
};

/** Case/underscore-insensitive lookup key (music_change ≡ MusicChange). */
function normKey(name) {
    return String(name).replace(/_/g, '').toLowerCase();
}

function toAcsPascalCase(raw) {
    // Keep short trig names lowercase (sin/cos) — matches existing JSON.
    const compact = raw.replace(/_/g, '').toLowerCase();
    if (compact === 'sin' || compact === 'cos') return compact;

    // Split underscores first (e.g. music_change, thing_damage2).
    const segments = raw.toLowerCase().split('_').filter(Boolean);
    const parts = [];
    for (const seg of segments) {
        let rest = seg;
        while (rest.length > 0) {
            let matched = false;
            for (const w of ACS_WORDS) {
                if (rest.startsWith(w)) {
                    parts.push(w);
                    rest = rest.slice(w.length);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                // Trailing single x/y/z, or trailing digits (thing_damage2 → Damage + 2)
                if (/^[xyz]$/i.test(rest[0]) && (rest.length === 1 || /^\d/.test(rest.slice(1)))) {
                    parts.push(rest[0]);
                    rest = rest.slice(1);
                    continue;
                }
                const digits = /^\d+/.exec(rest);
                if (digits) {
                    parts.push(digits[0]);
                    rest = rest.slice(digits[0].length);
                    continue;
                }
                const m = /^[a-z]+/.exec(rest);
                if (!m) break;
                parts.push(m[0]);
                rest = rest.slice(m[0].length);
            }
        }
    }

    return parts
        .map((p) => {
            if (/^\d+$/.test(p)) return p;
            if (SPECIAL_CASING[p]) return SPECIAL_CASING[p];
            if (p.length === 1 && /[xyz]/i.test(p)) return p.toUpperCase();
            return p.charAt(0).toUpperCase() + p.slice(1);
        })
        .join('');
}

function readText(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing source file: ${filePath}\nEnsure ref/acc-branch-zandronum and ref/zandronum-stable-branch-default are present.`);
    }
    return fs.readFileSync(filePath, 'utf8');
}

function parseInternalFunctions(symbolC) {
    const m = /InternalFunctions\s*\[\s*\]\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(symbolC);
    if (!m) throw new Error('InternalFunctions[] not found in symbol.c');
    const map = new Map();
    const re = /\{\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*[A-Z0-9_]+\s*,\s*[A-Z0-9_]+\s*,\s*(\d+)/g;
    let entry;
    while ((entry = re.exec(m[1])) !== null) {
        const raw = entry[1];
        const args = Number(entry[2]);
        const key = normKey(raw);
        map.set(key, {
            key,
            name: toAcsPascalCase(raw),
            min: args,
            max: args,
            kind: 'internal',
            idx: null,
        });
    }
    return map;
}

function parseZSpecial(zspecial) {
    const callfuncs = new Map();
    const lineSpecials = new Map();
    for (const line of zspecial.split(/\r?\n/)) {
        const mm = /^\s*(-?\d+)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/.exec(line);
        if (!mm) continue;
        const idx = Number(mm[1]);
        const name = mm[2];
        if (name.startsWith('__')) continue;
        const argNums = mm[3]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => /^-?\d+$/.test(s))
            .map(Number);
        const min = argNums[0] ?? 0;
        const max = argNums.length > 1 ? argNums[1] : min;
        const key = normKey(name);
        const rec = { key, name, min, max, kind: idx < 0 ? 'callfunc' : 'linespecial', idx };
        if (idx < 0) {
            // Keep first spelling; aliases (strcasecmp) still get an entry if different key.
            if (!callfuncs.has(key)) callfuncs.set(key, rec);
        } else {
            if (!lineSpecials.has(key)) lineSpecials.set(key, rec);
        }
    }
    return { callfuncs, lineSpecials };
}

function parseEngineAcsf(pAcsCpp) {
    const m = /enum\s+EACSFunctions\s*\{([\s\S]*?)\};/.exec(pAcsCpp);
    if (!m) return new Set();
    const set = new Set();
    for (const name of m[1].matchAll(/\bACSF_([A-Za-z0-9_]+)\b/g)) {
        set.add(name[1].toLowerCase());
    }
    return set;
}

function buildCanonical(internal, callfuncs, lineSpecials) {
    /** @type {Map<string, {key:string,name:string,min:number,max:number,kind:string,idx:number|null}>} */
    const canonical = new Map();

    // Prefer zspecial spelling for shared names; internals fill gaps.
    for (const [key, rec] of lineSpecials) canonical.set(key, rec);
    for (const [key, rec] of callfuncs) canonical.set(key, rec);
    for (const [key, rec] of internal) {
        if (!canonical.has(key)) canonical.set(key, rec);
    }
    for (const [key, rec] of LANGUAGE_ALLOWLIST) {
        const nk = normKey(key);
        if (!canonical.has(nk)) canonical.set(nk, { ...rec, key: nk, idx: null });
    }
    return canonical;
}

function paramCount(entry) {
    const params = entry.params || [];
    let required = 0;
    let total = params.length;
    for (const p of params) {
        if (typeof p === 'string') {
            required++;
        } else if (!p.optional) {
            required++;
        }
    }
    return { required, total };
}

function makeParams(min, max, existing) {
    const prev = Array.isArray(existing) ? existing.slice() : [];
    const out = [];
    for (let i = 0; i < max; i++) {
        const optional = i >= min;
        const old = prev[i];
        if (old && typeof old === 'object') {
            const next = { ...old };
            if (optional) next.optional = true;
            else delete next.optional;
            if (!next.type) next.type = 'int';
            if (!next.name) next.name = `arg${i + 1}`;
            out.push(next);
        } else if (typeof old === 'string') {
            const next = { name: old, type: 'int' };
            if (optional) next.optional = true;
            out.push(next);
        } else {
            const next = { name: `arg${i + 1}`, type: 'int' };
            if (optional) next.optional = true;
            out.push(next);
        }
    }
    return out;
}

function defaultDesc(kind, name) {
    if (kind === 'language') return '';
    if (kind === 'linespecial') return `Line special / ACS callable: ${name}.`;
    if (kind === 'callfunc') return `ACS function: ${name}.`;
    return `ACS built-in: ${name}.`;
}

function sortKeys(obj) {
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const out = {};
    for (const k of keys) out[k] = obj[k];
    return out;
}

function main() {
    const apply = process.argv.includes('--apply');

    const symbolC = readText(path.join(ACC, 'symbol.c'));
    const zspecial = readText(path.join(ACC, 'zspecial.acs'));
    const pAcs = readText(path.join(ENGINE, 'src', 'p_acs.cpp'));

    const internal = parseInternalFunctions(symbolC);
    const { callfuncs, lineSpecials } = parseZSpecial(zspecial);
    const engineAcsf = parseEngineAcsf(pAcs);
    const canonical = buildCanonical(internal, callfuncs, lineSpecials);

    const current = JSON.parse(readText(FUNCTIONS_PATH));
    const currentByKey = new Map();
    for (const [name, entry] of Object.entries(current)) {
        currentByKey.set(normKey(name), { name, entry });
    }

    const missing = [];
    const arityMismatches = [];
    const extras = [];
    const engineMissing = [];

    for (const [key, rec] of canonical) {
        const cur = currentByKey.get(key);
        if (!cur) {
            missing.push(rec);
            continue;
        }
        const { required, total } = paramCount(cur.entry);
        if (required !== rec.min || total !== rec.max) {
            arityMismatches.push({
                name: cur.name,
                accMin: rec.min,
                accMax: rec.max,
                extReq: required,
                extTotal: total,
                kind: rec.kind,
            });
        }
        if (rec.kind === 'callfunc' && rec.name) {
            const engKey = rec.name.toLowerCase();
            // Engine enums omit some aliases; warn only when no close match.
            if (!engineAcsf.has(engKey) && !engineAcsf.has(engKey.replace(/_/g, ''))) {
                // Many ACSF names match without underscores issues; skip strcasecmp alias noise
                if (engKey !== 'strcasecmp') {
                    engineMissing.push(rec.name);
                }
            }
        }
    }

    for (const [key, { name }] of currentByKey) {
        if (!canonical.has(key)) extras.push(name);
    }

    console.log('=== ACS functions audit ===');
    console.log(`ACC internal:     ${internal.size}`);
    console.log(`ACC callfunc:     ${callfuncs.size}`);
    console.log(`ACC linespecial:  ${lineSpecials.size}`);
    console.log(`Language allow:   ${LANGUAGE_ALLOWLIST.size}`);
    console.log(`Canonical total:  ${canonical.size}`);
    console.log(`Extension total:  ${currentByKey.size}`);
    console.log(`Missing:          ${missing.length}`);
    console.log(`Arity mismatch:   ${arityMismatches.length}`);
    console.log(`Extra (remove):   ${extras.length}`);
    console.log(`Callfunc not in EACSFunctions (warn): ${engineMissing.length}`);

    if (missing.length) {
        console.log('\n--- Missing (sample / all) ---');
        for (const r of missing.sort((a, b) => a.name.localeCompare(b.name))) {
            console.log(`  [${r.kind}] ${r.name}  (${r.min}-${r.max})`);
        }
    }
    if (arityMismatches.length) {
        console.log('\n--- Arity mismatches ---');
        for (const m of arityMismatches.sort((a, b) => a.name.localeCompare(b.name))) {
            console.log(
                `  ${m.name}: ACC ${m.accMin}-${m.accMax}  EXT req=${m.extReq} total=${m.extTotal}  [${m.kind}]`
            );
        }
    }
    if (extras.length) {
        console.log('\n--- Extra (not in ACC / allowlist) ---');
        for (const n of extras.sort((a, b) => a.localeCompare(b))) {
            console.log(`  ${n}`);
        }
    }
    if (engineMissing.length) {
        console.log('\n--- CALLFUNC name not found as ACSF_* (informational) ---');
        for (const n of engineMissing.sort((a, b) => a.localeCompare(b)).slice(0, 40)) {
            console.log(`  ${n}`);
        }
        if (engineMissing.length > 40) console.log(`  ... +${engineMissing.length - 40} more`);
    }

    if (!apply) {
        console.log('\n(report only; pass --apply to write functions.json)');
        return;
    }

    /** @type {Record<string, {params: any[], desc: string, signature?: string}>} */
    const next = {};

    // Prefer existing display names when present.
    for (const [key, rec] of canonical) {
        const cur = currentByKey.get(key);
        const displayName = cur ? cur.name : rec.name;
        const prevEntry = cur ? cur.entry : null;
        const prevDesc = prevEntry && typeof prevEntry.desc === 'string' ? prevEntry.desc : '';
        const prevSig =
            prevEntry && typeof prevEntry.signature === 'string' && prevEntry.signature.length > 0
                ? prevEntry.signature
                : undefined;

        let params;
        let desc;
        if (rec.kind === 'language' && rec.max === 0) {
            // Print-family / PCD helpers: keep hand-authored signature/desc; never invent argN.
            params = [];
            desc = prevDesc || defaultDesc(rec.kind, displayName);
        } else {
            params = makeParams(rec.min, rec.max, prevEntry ? prevEntry.params : undefined);
            desc = prevDesc || defaultDesc(rec.kind, displayName);
        }

        const entry = { params, desc };
        if (prevSig) entry.signature = prevSig;
        next[displayName] = entry;
    }

    const sorted = sortKeys(next);
    fs.writeFileSync(FUNCTIONS_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

    const added = missing.length;
    const fixed = arityMismatches.length;
    const removed = extras.length;
    console.log(`\nWrote ${FUNCTIONS_PATH}`);
    console.log(`  entries: ${Object.keys(sorted).length}`);
    console.log(`  added: ${added}, arity-fixed: ${fixed}, removed: ${removed}`);
}

main();
