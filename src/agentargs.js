// The agent commands, generated from the protocol (#521): each operation in OPS is a CLI command, its parameters
// --kebab-case flags, and a small table says which come first as positional arguments. Nothing else is mapped by
// hand, so a parameter added to OPS is reachable from the CLI at once. An unknown flag is refused with the nearest
// valid one, and the hub refuses an unknown field the same way (unknownField).
import { OPS } from './protocol.js';

// The positional arguments of each operation, in order. "name?": taken only when it looks like an item ("12" or
// "#12") and something follows it; "name...": the rest of the words (joined, or a list for an array parameter).
export const POSITIONAL = {
  checkin: [], next: [], claim: ['item'], progress: ['item', 'headline...'],
  ask: ['item?', 'question...'], answer: ['question', 'answer...'], withdraw: ['question', 'reason...'],
  submit: ['item', 'headline...'], handoff: ['item', 'headline...'], propose: ['title...'], refine: ['item'],
  review: ['item', 'verdict', 'headline...'], comment: ['item?', 'headline...'], ack: ['steer', 'response...'],
  learn: ['note...'], retire: ['notes...'], distill: [], feedback: ['text...'], look: ['item'], signoff: ['headline...'],
};

// The flags every agent command takes besides its parameters: who you are and which hub and project.
export const COMMON = { as: 'string', url: 'string', project: 'string', token: 'string', help: 'boolean', h: 'boolean' };
// Older spellings still accepted: --assume, --option (repeatable, one answer each) and next's --peek.
const ALIASES = { ask: { assume: 'assumption', option: 'options' } };
// String lists whose entries are free text, so a value is one entry, never split on commas.
const WHOLE = new Set(['ask.options']);

const flagOf = (param) => param.replace(/_/g, '-');
const paramOf = (flag) => flag.replace(/-/g, '_');
const opOf = (name) => OPS.find((o) => o.name === name) ?? null;
const isRef = (s) => typeof s === 'string' && /^#?\d+$/.test(s);
const spec = (s) => ({ name: s.replace(/[?.]+$/, ''), optional: s.endsWith('?'), rest: s.endsWith('...') });

for (const op of OPS) {
  if (!POSITIONAL[op.name]) throw new Error(`agentargs: no POSITIONAL entry for "${op.name}"`);
  for (const s of POSITIONAL[op.name]) if (!op.params?.[spec(s).name]) throw new Error(`agentargs: ${op.name} has no param "${spec(s).name}"`);
}

// Levenshtein distance, for "did you mean".
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
// The nearest of words to word, within max edits (or one containing the other); null when none is close.
export function nearestOf(word, words, max = 3) {
  const w = String(word).toLowerCase();
  let best = null;
  for (const c of words) {
    const n = c.includes(w) || w.includes(c) ? Math.min(distance(w, c), 2) : distance(w, c);
    if (n <= max && (!best || n < best.n)) best = { c, n };
  }
  return best?.c ?? null;
}

// How a positional argument is named in usage: <item>, <question-id>, <note-id>...
const label = (op, name) => {
  const p = op.params[name];
  const id = p.type === 'integer' || p.items?.type === 'integer';
  return id ? `${name.replace(/s$/, '')}-id` : name;
};

// The usage line of an agent command, e.g. "submit <item> <headline> [flags]".
export function usage(name) {
  const op = opOf(name);
  const required = new Set(op.required ?? []);
  const args = POSITIONAL[name].map((s) => {
    const { name: n, optional, rest } = spec(s);
    const shown = `<${label(op, n)}>${rest && op.params[n].type === 'array' ? '...' : ''}`;
    return optional || !required.has(n) ? `[${shown}]` : shown;
  });
  const flags = Object.keys(op.params).length > POSITIONAL[name].length ? ['[flags]'] : [];
  return [name, ...args, ...flags].join(' ');
}

// Every flag of an agent command: [flag, param, its schema]. Positional parameters have a flag too.
export function flags(name) {
  const op = opOf(name);
  return Object.entries(op.params ?? {}).map(([param, schema]) => {
    const value = schema.type === 'boolean' ? '' : schema.type === 'array' ? (schema.items?.type === 'object' ? ` <${Object.keys(schema.items.properties).join('|')}>` : WHOLE.has(`${name}.${param}`) ? ' <x>' : ' <a,b>') : schema.type === 'object' ? ' <json>' : schema.enum ? ` <${schema.enum.join('|')}>` : ` <${schema.type === 'integer' ? 'n' : param.split('_').pop()}>`;
    return [`--${flagOf(param)}${value}`, param, schema];
  });
}

const fail = (message, hint) => Object.assign(new Error(message), { hint, usage: true });

// One flag value as its parameter's type. read: what "-" means (stdin).
function convert(op, param, schema, values, read) {
  const flag = `--${flagOf(param)}`;
  const one = (v) => {
    if (v === true && schema.type !== 'boolean') throw fail(`${flag} needs a value`, `See: nuworq help ${op.name}`);
    return v === '-' ? read() : v;
  };
  const json = (v, what) => {
    try { return JSON.parse(v); } catch { throw fail(`${flag} takes ${what} as JSON`, `e.g. ${flag} '${schema.type === 'array' ? '[...]' : '{...}'}'`); }
  };
  const num = (v) => {
    const n = Number(String(v).replace(/^#/, ''));
    return String(v).trim() !== '' && Number.isFinite(n) ? n : v; // anything else: the hub says what's wrong
  };
  const last = values[values.length - 1];
  if (schema.type === 'boolean') {
    if (last === true || last === 'true') return true;
    if (last === 'false') return false;
    throw fail(`${flag} is true or false, not "${last}"`);
  }
  if (schema.type === 'integer' || schema.type === 'number') return num(one(last));
  if (schema.type === 'object') return json(one(last), 'an object');
  if (schema.type === 'array') {
    const items = schema.items ?? {};
    return values.flatMap((raw) => {
      const v = one(raw);
      if (typeof v !== 'string') return [v];
      if (/^\s*\[/.test(v)) return json(v, 'a list');
      if (items.type === 'object') {
        if (/^\s*\{/.test(v)) return [json(v, 'an object')];
        // "label|url", "do|where|check": the parts in the order the schema lists them.
        const keys = Object.keys(items.properties ?? {});
        const parts = v.split('|');
        const tail = parts.splice(keys.length - 1).join('|');
        return [Object.fromEntries([...parts, tail].map((x, i) => [keys[i], x.trim()]).filter(([, x]) => x !== ''))];
      }
      const list = WHOLE.has(`${op.name}.${param}`) ? [v] : v.split(/[\s,]+/).filter(Boolean);
      return items.type === 'integer' ? list.map(num) : list;
    });
  }
  return one(last);
}

// argv (after the command) → { body, common }. body: the operation's fields; common: --as, --url, --project, --token.
// read: what "-" as a value reads (stdin). Throws, with a hint, on an unknown flag or a missing required argument.
export function agentArgs(name, argv, { read = () => '' } = {}) {
  const op = opOf(name);
  if (!op) throw fail(`unknown operation "${name}"`);
  const params = op.params ?? {};
  const aliases = ALIASES[name] ?? {};
  const known = [...Object.keys(params).map(flagOf), ...Object.keys(COMMON), ...Object.keys(aliases), ...(name === 'next' ? ['peek'] : [])];
  const typeOf = (key) => COMMON[key] ?? (key === 'peek' ? 'boolean' : params[paramOf(aliases[key] ?? key)]?.type);
  const pos = [];
  const given = {}; // flag key → every value given
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-' || /^-\d/.test(a)) { pos.push(a); continue; }
    let key = a.replace(/^--?/, '');
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
    if (!known.includes(key)) {
      const near = nearestOf(key, known);
      throw fail(`${name} has no flag --${key}${near ? `: did you mean --${near}?` : ''}`, `See: nuworq help ${name}`);
    }
    if (val === undefined) {
      if (typeOf(key) === 'boolean') val = /^(true|false)$/.test(argv[i + 1] ?? '') ? argv[++i] : true;
      else if (i + 1 < argv.length) val = argv[++i];
      else val = true;
    }
    (given[key] ??= []).push(val);
  }
  const common = {};
  for (const k of Object.keys(COMMON)) if (given[k]) common[k] = given[k].at(-1);
  const body = {};
  // checkin's project is its parameter as well as which project the call goes to.
  for (const [key, values] of Object.entries(given)) {
    if (COMMON[key] && !(key === 'project' && params.project)) continue;
    if (key === 'peek') { body.claim = false; continue; }
    const param = paramOf(aliases[key] ?? key);
    const value = convert(op, param, params[param], values, read);
    body[param] = Array.isArray(value) && Array.isArray(body[param]) ? [...body[param], ...value] : value;
  }
  // Positional arguments, after the flags: a flag can give any of them instead.
  const specs = POSITIONAL[name].map(spec);
  let at = 0;
  for (const s of specs) {
    if (at >= pos.length) break;
    if (s.optional && !(isRef(pos[at]) && pos.length - at > 1)) continue;
    const schema = params[s.name];
    let value;
    if (s.rest) {
      const words = pos.slice(at);
      at = pos.length;
      value = schema.type === 'array' ? convert(op, s.name, schema, words, read) : words.join(' ').trim();
      if (value === '-') value = read();
    } else {
      value = convert(op, s.name, schema, [pos[at++]], read);
    }
    if (value !== '' && body[s.name] === undefined) body[s.name] = value;
  }
  if (at < pos.length) throw fail(`${name} takes ${usage(name)}: "${pos.slice(at).join(' ')}" is left over`, `See: nuworq help ${name}`);
  for (const r of op.required ?? []) {
    if (body[r] === undefined || body[r] === '') {
      const p = specs.find((s) => s.name === r);
      throw fail(`missing ${p ? `<${label(op, r)}>` : `--${flagOf(r)}`}`, `Usage: nuworq ${usage(name)}. See: nuworq help ${name}`);
    }
  }
  return { body, common };
}

// What the hub takes besides the protocol's parameters: fields its own clients send. The MCP process sends a
// worker's role and runner with checkin; the runner posts usage, an operation of its own; retire's note is the
// older spelling of notes.
const EXTRA = { checkin: ['role', 'runner'], retire: ['note'], usage: ['usage'] };

// The first field args has that op doesn't take, with the nearest one it does: { field, near } or null.
export function unknownField(name, args) {
  const op = opOf(name);
  if (!op && !EXTRA[name]) return null;
  const valid = [...Object.keys(op?.params ?? {}), ...(EXTRA[name] ?? [])];
  for (const field of Object.keys(args ?? {})) {
    if (!valid.includes(field)) return { field, near: nearestOf(field, valid) };
  }
  return null;
}
