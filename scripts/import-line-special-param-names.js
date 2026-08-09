/**
 * Import semantic parameter names for Zandronum line specials.
 *
 * Primary source: engine src/p_lnspec.cpp FUNC(LS_*) blocks, whose
 *   // Thing_Move (tid, mapspot, nofog)
 * comments name each special's args in engine order.
 * Fallback: SLADE config/languages/acs.txt (names only; SLADE arity is
 * GZDoom-era and must NOT override Zandronum actionspecials.h min/max).
 *
 * Updates data/acs/functions.json param names to engine names, then rebuilds
 * ALL line-special entries in data/decorate/actions.json (including the former
 * hand-authored ACS_* / ThrustThing* duals) with ENGINE arity
 * (actionspecials.h min/max -- ACC arity can differ and is not valid for DECORATE).
 *
 * Usage:
 *   node scripts/import-line-special-param-names.js   # report only
 *   node scripts/import-line-special-param-names.js --apply
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'ref', 'zandronum-stable-branch-default');
const SLADE = path.join(ROOT, 'ref', 'SLADE');
const FUNCTIONS_PATH = path.join(ROOT, 'data', 'acs', 'functions.json');
const ACTIONS_PATH = path.join(ROOT, 'data', 'decorate', 'actions.json');

/** Manual names for specials whose engine comment is missing/typo'd. */
const OVERRIDES = {
    changeskill: ['level'],
    setglobalfogparameter: ['type', 'value'],
    fs_execute: ['script', 'frontonly', 'lock', 'lockedmessage'],
    sector_setwind: ['tag', 'amount', 'angle', 'useline'],
    sector_setcurrent: ['tag', 'amount', 'angle', 'useline'],
};

/** Omitted args default to 0; zero defaults are never stored in metadata. */
function isZeroDefault(value) {
    if (value == null) return false;
    const s = String(value).trim().toLowerCase();
    if (s === 'false' || s === 'aaptr_default') return true;
    if (/^[-+]?0(\.0*)?$/.test(s)) return true;
    if (/^0x0+$/i.test(s)) return true;
    return false;
}

function callableSpecials() {
    const h = fs.readFileSync(path.join(ENGINE, 'src', 'actionspecials.h'), 'utf8');
    const out = new Map();
    const re = /DEFINE_SPECIAL\(\s*([A-Za-z0-9_]+)\s*,\s*\d+\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*\d+\s*\)/g;
    let m;
    while ((m = re.exec(h)) !== null) {
        if (Number(m[2]) >= 0) out.set(m[1].toLowerCase(), { name: m[1], min: +m[2], max: +m[3] });
    }
    return out;
}

function engineCommentArgs() {
    const cpp = fs.readFileSync(path.join(ENGINE, 'src', 'p_lnspec.cpp'), 'utf8');
    const lines = cpp.split(/\r?\n/);
    const funcRe = /^FUNC\(\s*LS_([A-Za-z0-9_]+)\s*\)/;
    const commentRe = /^\/\/\s*([A-Za-z0-9_]+)\s*\((.*)\)\s*;?\s*$/;
    const map = new Map();
    for (let i = 0; i < lines.length; i++) {
        const fm = funcRe.exec(lines[i]);
        if (!fm) continue;
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        const cm = j < lines.length ? commentRe.exec(lines[j]) : null;
        if (cm) {
            const args = cm[2].split(',').map((s) => s.trim()).filter(Boolean);
            map.set(fm[1].toLowerCase(), args);
        }
    }
    return map;
}

function sladeNames() {
    const txt = fs.readFileSync(path.join(SLADE, 'dist', 'res', 'config', 'languages', 'acs.txt'), 'utf8');
    const map = new Map();
    const re = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*;/;
    for (const line of txt.split(/\r?\n/)) {
        const m = re.exec(line);
        if (!m) continue;
        const args = m[2].split(',').map((s) => s.trim()).filter(Boolean)
            .map((a) => a.replace(/^\[|\]$/g, '').trim().split(/\s+/).pop());
        map.set(m[1].toLowerCase(), args);
    }
    return map;
}

function resolveNames(name, special, engineArgs, sladeArgs) {
    const key = name.toLowerCase();
    if (OVERRIDES[key]) return OVERRIDES[key].slice();
    const base = (engineArgs && engineArgs.length ? engineArgs : (sladeArgs || [])).slice(0, special.max);
    // Pad with SLADE names when the engine comment is shorter than max arity.
    if (sladeArgs && base.length < special.max) {
        for (const n of sladeArgs) {
            if (base.length >= special.max) break;
            if (!base.includes(n)) base.push(n);
        }
    }
    return base;
}

const ENGINE_ARGS = engineCommentArgs();
const SLADE_ARGS = sladeNames();

/** Engine-arity params + semantic names for one line special. */
function buildLineSpecialEntry(name, special, src) {
    const srcParams = Array.isArray(src.params) ? src.params : [];
    const names = resolveNames(name, special, ENGINE_ARGS.get(name.toLowerCase()), SLADE_ARGS.get(name.toLowerCase()));
    const params = [];
    for (let i = 0; i < special.max; i++) {
        const prev = srcParams[i];
        const p = {
            name: names[i] || `arg${i + 1}`,
            type: (prev && prev.type) || 'int',
            optional: i >= special.min,
        };
        if (prev && prev.default !== undefined && !isZeroDefault(prev.default)) p.default = prev.default;
        if (prev && prev.desc) p.desc = prev.desc;
        params.push(p);
    }
    return { params, desc: src.desc || `Line special / ACS callable: ${name}.` };
}

function main() {
    const apply = process.argv.includes('--apply');
    const specials = callableSpecials();

    const functions = JSON.parse(fs.readFileSync(FUNCTIONS_PATH, 'utf8'));
    const actions = JSON.parse(fs.readFileSync(ACTIONS_PATH, 'utf8'));
    const changed = [];

    for (const [key, special] of specials) {
        const src = functions[special.name];
        if (!src || !Array.isArray(src.params)) continue;
        const names = resolveNames(special.name, special, ENGINE_ARGS.get(key), SLADE_ARGS.get(key));
        src.params.forEach((p, i) => {
            if (p && typeof p === 'object' && names[i] && p.name !== names[i]) {
                changed.push(`${special.name} ${p.name} -> ${names[i]}`);
                if (apply) p.name = names[i];
            }
        });
    }

    // Rebuild DECORATE line-special entries with engine arity + semantic names.
    const synced = [];
    for (const [, special] of specials) {
        const entry = actions[special.name];
        const src = functions[special.name];
        if (!entry || !src) continue;
        const rebuilt = buildLineSpecialEntry(special.name, special, src);
        if (apply) {
            actions[special.name] = { ...rebuilt, usage: ['state', 'expression'] };
        }
        synced.push(special.name);
    }

    if (apply) {
        fs.writeFileSync(FUNCTIONS_PATH, JSON.stringify(functions, null, 2) + '\n', 'utf8');
        fs.writeFileSync(ACTIONS_PATH, JSON.stringify(actions, null, 2) + '\n', 'utf8');
    }

    console.log(`Line specials: ${specials.size}`);
    console.log(`Engine comments: ${ENGINE_ARGS.size}`);
    console.log(`Param names changed: ${changed.length}`);
    console.log(`actions.json entries re-synced: ${synced.length}`);
    const missing = [...specials.keys()].filter((k) => !ENGINE_ARGS.has(k) && !OVERRIDES[k]);
    console.log(`Specials without engine comment or override: ${missing.join(', ') || 'none'}`);
    if (!apply) console.log('\nDry run. Pass --apply to write files.');
}

if (require.main === module) {
    main();
}

module.exports = { callableSpecials, buildLineSpecialEntry };
