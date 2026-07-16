/**
 * Audit / patch data/decorate/actions.json against Zandronum action native decls.
 *
 * Usage:
 *   node scripts/audit-decorate-actions.js           # report only
 *   node scripts/audit-decorate-actions.js --apply   # write fixes + additions
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REF = path.join(ROOT, 'ref', 'zandronum-stable-branch-default');
const ACTIONS_PATH = path.join(ROOT, 'data', 'decorate', 'actions.json');

const SOURCE_FILES = [
    path.join(REF, 'wadsrc', 'static', 'actors', 'actor.txt'),
    path.join(REF, 'wadsrc', 'static', 'actors', 'shared', 'inventory.txt'),
    path.join(REF, 'wadsrc', 'static', 'actors', 'Skulltag', 'skulltagartifacts.txt'),
];

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
    let d = def.trim();
    // Strip trailing comments
    d = d.replace(/\/\/.*$/, '').trim();
    if (type === 'string' || type === 'state') {
        if (/^AAPTR_/i.test(d) || /^[A-Z][A-Z0-9_]*$/.test(d)) {
            // Flag / pointer constant defaults stay as bare identifiers for int-ish enums,
            // but for string/state they often appear as AAPTR_DEFAULT on int params.
            return d;
        }
        if ((d.startsWith('"') && d.endsWith('"')) || (d.startsWith("'") && d.endsWith("'"))) {
            return d.startsWith("'") ? `"${d.slice(1, -1)}"` : d;
        }
        // Unquoted string defaults like * or none or BulletPuff → quote them
        return `"${d}"`;
    }
    if (type === 'bool') {
        if (/^true$/i.test(d)) return 'true';
        if (/^false$/i.test(d)) return 'false';
        return d;
    }
    return d;
}

function parseActionNatives(text) {
    const result = new Map();
    // Multi-line tolerant: action native Name ( ... );
    const re = /action\s+native\s+(\w+)\s*\(([^;]*)\)\s*;/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
        const name = m[1];
        const argStr = m[2].trim();
        const params = [];
        if (argStr.length > 0) {
            // Split on commas not inside <> or ()
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
                // Varargs: A_Jump(..., state label, ...)
                if (trimmed === '...') {
                    params.push({
                        name: '...',
                        type: 'state',
                        optional: true,
                        variadic: true,
                    });
                    continue;
                }
                // type name (= default)?
                const pm = /^(coerce\s+name|class<[^>]+>|[A-Za-z_][\w:]*)\s+(\w+)(?:\s*=\s*(.+))?$/i.exec(trimmed);
                if (!pm) {
                    console.warn('Unparsed param:', name, part);
                    continue;
                }
                const type = mapType(pm[1]);
                const pname = pm[2];
                const hasDefault = pm[3] !== undefined;
                const param = {
                    name: pname,
                    type,
                    optional: hasDefault,
                };
                if (hasDefault) {
                    param.default = normalizeDefault(pm[3], type);
                }
                params.push(param);
            }
        }
        result.set(name, { name, params, rawArgs: argStr });
    }
    return result;
}

function loadAllNatives() {
    const all = new Map();
    for (const file of SOURCE_FILES) {
        if (!fs.existsSync(file)) {
            console.warn('Missing source file:', file);
            continue;
        }
        const natives = parseActionNatives(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of natives) {
            if (!all.has(k)) all.set(k, { ...v, file: path.relative(REF, file) });
        }
    }
    return all;
}

function compareParam(src, json, index) {
    const issues = [];
    if (src.name !== json.name) {
        issues.push(`param[${index}] name: json=${json.name} source=${src.name}`);
    }
    if (src.type !== json.type) {
        // state in source often stored as string in JSON historically — flag but allow soft
        if (!(src.type === 'state' && json.type === 'string') &&
            !(src.type === 'string' && json.type === 'state')) {
            issues.push(`param[${index}] (${src.name}) type: json=${json.type} source=${src.type}`);
        }
    }
    if (Boolean(src.optional) !== Boolean(json.optional)) {
        issues.push(`param[${index}] (${src.name}) optional: json=${!!json.optional} source=${!!src.optional}`);
    }
    if (src.optional) {
        const jd = json.default != null ? String(json.default) : undefined;
        const sd = src.default != null ? String(src.default) : undefined;
        if (jd !== sd) {
            // Normalize quotes for comparison
            const norm = (x) => (x || '').replace(/^'|'$/g, '"');
            if (norm(jd) !== norm(sd)) {
                issues.push(`param[${index}] (${src.name}) default: json=${jd} source=${sd}`);
            }
        }
    }
    return issues;
}

function buildParamFromSource(src, existing) {
    const p = {
        name: src.name,
        type: src.type,
        optional: !!src.optional,
    };
    if (src.variadic) {
        p.variadic = true;
    }
    if (src.optional && src.default !== undefined) {
        p.default = src.default;
    }
    // Preserve bitmask/enum metadata when present and arity slot matches by name
    if (existing) {
        if (existing.mode) p.mode = existing.mode;
        if (existing.enum) p.enum = existing.enum;
        if (existing.variadic) p.variadic = existing.variadic;
        // Prefer existing type when it's state vs string soft mismatch but keep source truth for state
        if (src.type === 'state') p.type = 'state';
    }
    return p;
}

function fixDesc(name, desc) {
    if (!desc) return `Action function: ${name}`;
    const m = /^Action function:\s*(.+)$/.exec(desc.trim());
    if (m && m[1] !== name) {
        return `Action function: ${name}`;
    }
    return desc;
}

/** Line specials / duals that are both state actions and expression calls. */
const DUAL_USAGE = ['state', 'expression'];

/** ACS line specials usable as DECORATE state actions (DEFINE_SPECIAL min>=0). */
function acsSpecialEntries() {
    // Names from actionspecials.h; arg layouts follow ZDoom ACS_* special conventions.
    const usage = DUAL_USAGE;
    return {
        ACS_Execute: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: true, default: '0' },
                { name: 'arg1', type: 'int', optional: true, default: '0' },
                { name: 'arg2', type: 'int', optional: true, default: '0' },
                { name: 'arg3', type: 'int', optional: true, default: '0' },
            ],
            usage,
            desc: 'Action function: ACS_Execute',
        },
        ACS_ExecuteAlways: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: true, default: '0' },
                { name: 'arg1', type: 'int', optional: true, default: '0' },
                { name: 'arg2', type: 'int', optional: true, default: '0' },
                { name: 'arg3', type: 'int', optional: true, default: '0' },
            ],
            usage,
            desc: 'Action function: ACS_ExecuteAlways',
        },
        ACS_ExecuteWithResult: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'arg1', type: 'int', optional: true, default: '0' },
                { name: 'arg2', type: 'int', optional: true, default: '0' },
                { name: 'arg3', type: 'int', optional: true, default: '0' },
                { name: 'arg4', type: 'int', optional: true, default: '0' },
            ],
            usage,
            desc: 'Action function: ACS_ExecuteWithResult',
        },
        ACS_Suspend: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: false },
            ],
            usage,
            desc: 'Action function: ACS_Suspend',
        },
        ACS_Terminate: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: false },
            ],
            usage,
            desc: 'Action function: ACS_Terminate',
        },
        ACS_LockedExecute: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: false },
                { name: 'arg1', type: 'int', optional: false },
                { name: 'arg2', type: 'int', optional: false },
                { name: 'lock', type: 'int', optional: false },
            ],
            usage,
            desc: 'Action function: ACS_LockedExecute',
        },
        ACS_LockedExecuteDoor: {
            params: [
                { name: 'script', type: 'int', optional: false },
                { name: 'mapnum', type: 'int', optional: false },
                { name: 'arg1', type: 'int', optional: false },
                { name: 'arg2', type: 'int', optional: false },
                { name: 'lock', type: 'int', optional: false },
            ],
            usage,
            desc: 'Action function: ACS_LockedExecuteDoor',
        },
    };
}

/** Expression-only names that must NOT appear in actions.json. */
const EXPRESSION_ONLY = new Set([
    'CallACS',
    'CheckClass',
    'IsPointerEqual',
    'abs',
    'sin',
    'cos',
    'sqrt',
    'random',
    'random2',
    'frandom',
]);

/** Duals that must have usage: ["state","expression"] in actions.json. */
function dualActionNames() {
    return new Set([
        'ThrustThing',
        'ThrustThingZ',
        'ACS_NamedExecuteWithResult',
        ...Object.keys(acsSpecialEntries()),
    ]);
}

function usageIncludes(entry, mode) {
    const u = entry.usage && entry.usage.length ? entry.usage : ['state'];
    return u.includes(mode);
}

function sameUsage(a, expected) {
    const got = (a.usage && a.usage.length ? a.usage : ['state']).slice().sort().join(',');
    const exp = expected.slice().sort().join(',');
    return got === exp;
}

function main() {
    const apply = process.argv.includes('--apply');
    const natives = loadAllNatives();
    const actions = JSON.parse(fs.readFileSync(ACTIONS_PATH, 'utf8'));

    const EXPRESSIONS_PATH = path.join(ROOT, 'data', 'decorate', 'expressions.json');
    const expressions = fs.existsSync(EXPRESSIONS_PATH)
        ? JSON.parse(fs.readFileSync(EXPRESSIONS_PATH, 'utf8'))
        : {};

    const report = {
        missingInJson: [],
        extraInJson: [],
        paramIssues: [],
        descIssues: [],
        usageIssues: [],
        fixed: [],
        added: [],
    };

    // Actor + inventory + skulltag natives that should be in JSON when referenced
    // Plan: fix all JSON entries that have a matching native; add A_RandomPowerupFrame
    for (const [name, native] of natives) {
        if (!actions[name]) {
            // Only auto-add A_RandomPowerupFrame from skulltag; Actor set is already complete
            if (name === 'A_RandomPowerupFrame') {
                report.missingInJson.push(name);
            }
            continue;
        }
        const entry = actions[name];
        const jsonParams = entry.params || [];
        const issuesBefore = report.paramIssues.length;
        if (jsonParams.length !== native.params.length) {
            report.paramIssues.push({
                name,
                issue: `arity json=${jsonParams.length} source=${native.params.length}`,
            });
        }
        const n = Math.max(jsonParams.length, native.params.length);
        for (let i = 0; i < n; i++) {
            if (!native.params[i]) {
                report.paramIssues.push({ name, issue: `extra json param[${i}] ${jsonParams[i]?.name}` });
                continue;
            }
            if (!jsonParams[i]) {
                report.paramIssues.push({ name, issue: `missing json param[${i}] ${native.params[i].name}` });
                continue;
            }
            for (const iss of compareParam(native.params[i], jsonParams[i], i)) {
                report.paramIssues.push({ name, issue: iss });
            }
        }
        const fixedDesc = fixDesc(name, entry.desc);
        if (fixedDesc !== entry.desc) {
            report.descIssues.push({ name, from: entry.desc, to: fixedDesc });
        }

        const hadParamIssues = report.paramIssues.length > issuesBefore;
        const hadDescIssue = fixedDesc !== entry.desc;
        if (apply && (hadParamIssues || hadDescIssue)) {
            const newParams = native.params.map((sp, i) =>
                buildParamFromSource(sp, jsonParams.find(p => p.name === sp.name) || jsonParams[i])
            );
            const next = { params: newParams, desc: fixedDesc };
            // Preserve non-stub prose descriptions and usage
            if (entry.desc && !/^Action function:/.test(entry.desc.trim())) {
                next.desc = entry.desc;
            }
            if (entry.usage) {
                next.usage = entry.usage;
            }
            actions[name] = next;
            report.fixed.push(name);
        }
    }

    // Extras: JSON keys with no native — keep line specials ThrustThing* and ACS_* entry points
    // CallACS is expression-only and must NOT live in actions.json
    const intentionalExtras = dualActionNames();
    for (const name of Object.keys(actions)) {
        if (EXPRESSION_ONLY.has(name)) {
            report.usageIssues.push({
                name,
                issue: 'expression-only symbol must not be in actions.json',
            });
            if (apply) {
                delete actions[name];
                report.fixed.push(name + ' (removed from actions)');
            }
            continue;
        }
        if (!natives.has(name)) {
            if (!intentionalExtras.has(name)) {
                report.extraInJson.push(name);
            }
            const before = actions[name].desc;
            const fixedDesc = fixDesc(name, before);
            if (fixedDesc !== before) {
                report.descIssues.push({ name, from: before, to: fixedDesc });
                if (apply) {
                    actions[name].desc = fixedDesc;
                    report.fixed.push(name);
                }
            }
        }
    }

    // Usage classification: duals vs state-default vs expression-only file
    const duals = dualActionNames();
    for (const name of duals) {
        if (!actions[name]) {
            report.usageIssues.push({ name, issue: 'dual missing from actions.json' });
            continue;
        }
        if (!sameUsage(actions[name], DUAL_USAGE)) {
            report.usageIssues.push({
                name,
                issue: `usage expected [state,expression] got ${JSON.stringify(actions[name].usage || ['state'])}`,
            });
            if (apply) {
                actions[name].usage = DUAL_USAGE.slice();
                report.fixed.push(name + ' (usage)');
            }
        }
    }
    if (actions.ACS_NamedExecuteWithResult && !usageIncludes(actions.ACS_NamedExecuteWithResult, 'expression')) {
        report.usageIssues.push({
            name: 'ACS_NamedExecuteWithResult',
            issue: 'must allow expression usage',
        });
    }
    for (const name of EXPRESSION_ONLY) {
        if (name === 'CallACS' || name === 'CheckClass' || name === 'IsPointerEqual') {
            if (!expressions[name]) {
                report.usageIssues.push({
                    name,
                    issue: 'expression-only symbol missing from expressions.json',
                });
            } else {
                const kind = expressions[name].kind
                    || (Array.isArray(expressions[name].params) ? 'function' : 'variable');
                if (kind !== 'function') {
                    report.usageIssues.push({
                        name,
                        issue: `expressions.json kind should be function, got ${kind}`,
                    });
                }
            }
        }
    }

    if (apply) {
        // Add A_RandomPowerupFrame
        if (!actions.A_RandomPowerupFrame && natives.has('A_RandomPowerupFrame')) {
            actions.A_RandomPowerupFrame = {
                params: natives.get('A_RandomPowerupFrame').params,
                desc: 'Action function: A_RandomPowerupFrame',
            };
            report.added.push('A_RandomPowerupFrame');
        }

        // Add ACS specials (duals); never add CallACS to actions.json
        const acs = acsSpecialEntries();
        for (const [name, entry] of Object.entries(acs)) {
            if (!actions[name]) {
                actions[name] = entry;
                report.added.push(name);
            } else if (!sameUsage(actions[name], DUAL_USAGE)) {
                actions[name].usage = DUAL_USAGE.slice();
            }
        }
        if (actions.ACS_NamedExecuteWithResult) {
            actions.ACS_NamedExecuteWithResult.usage = DUAL_USAGE.slice();
        }
        for (const name of ['ThrustThing', 'ThrustThingZ']) {
            if (actions[name]) {
                actions[name].usage = DUAL_USAGE.slice();
            }
        }

        // Stable key order: existing order first, then new keys sorted
        const ordered = {};
        for (const k of Object.keys(actions)) {
            ordered[k] = actions[k];
        }
        fs.writeFileSync(ACTIONS_PATH, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
    }

    // Print summary
    console.log('=== Audit summary ===');
    console.log('Source natives:', natives.size);
    console.log('JSON actions:', Object.keys(actions).length);
    console.log('Param issues:', report.paramIssues.length);
    console.log('Desc issues:', report.descIssues.length);
    console.log('Usage issues:', report.usageIssues.length);
    console.log('Missing (tracked):', report.missingInJson);
    console.log('Extra in JSON:', report.extraInJson);
    if (report.usageIssues.length) {
        console.log('\n--- Usage issues ---');
        for (const x of report.usageIssues) {
            console.log(`${x.name}: ${x.issue}`);
        }
    }
    if (report.paramIssues.length) {
        console.log('\n--- Param issues (first 80) ---');
        for (const x of report.paramIssues.slice(0, 80)) {
            console.log(`${x.name}: ${x.issue}`);
        }
        if (report.paramIssues.length > 80) {
            console.log(`... +${report.paramIssues.length - 80} more`);
        }
    }
    if (report.descIssues.length) {
        console.log('\n--- Desc issues ---');
        for (const x of report.descIssues) {
            console.log(`${x.name}: "${x.from}" -> "${x.to}"`);
        }
    }
    if (apply) {
        console.log('\nApplied. Fixed:', report.fixed.length, 'Added:', report.added);
    } else {
        console.log('\nDry run. Pass --apply to write actions.json');
    }

    const reportPath = path.join(ROOT, 'scripts', 'audit-decorate-actions-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log('Wrote', reportPath);
}

main();
