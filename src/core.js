// The hub's state and every operation agents and humans can perform.
// HTTP, MCP and the CLI are thin transports over this file.
import { EventEmitter } from 'node:events';
import { openDb } from './db.js';
import { gitFacts, gitWarning, isRepo, baseOf, branchExists, headOf, contains, itemBranch, mirror } from './git.js';
import { findSecret } from './secrets.js';
import { normUsage, split } from './usage.js';

const GIT_CHECK = Symbol('git check');
const USAGE_OPS = ['progress', 'submit', 'handoff']; // the agent ops that take an optional usage

export class UserError extends Error {
  constructor(message, { status = 400, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const LEASE_MS = 20 * MIN;
export const HANDOFF_COOLDOWN = 30 * MIN; // work you just handed off isn't offered straight back to you
const HEADLINE_MAX = 140;
const STEER_TTL = 3 * DAY;
export const HUMAN = 'you';
export const SYSTEM = 'nuworq';
// The hub's own entries on the record: SYSTEM, or "trellis" in events recorded before the rename.
export const isSystem = (actor) => actor === SYSTEM || actor === 'trellis';
// People act on the record as "@handle"; without accounts (local mode) the one human is "you".
export const isHuman = (actor) => actor === HUMAN || String(actor ?? '').startsWith('@');
const You = (by) => (by === HUMAN ? 'You' : by);

// Which human actions each person role may take. Reading is open to every role.
const MEMBER_CAN = ['comment', 'create', 'dismiss', 'seen'];
const STEWARD_CAN = [...MEMBER_CAN, 'answer', 'confirm', 'steer', 'decide', 'accept', 'sendback', 'update', 'pick', 'retire'];
export const PERSON_CAN = { viewer: [], member: MEMBER_CAN, steward: STEWARD_CAN, owner: [...STEWARD_CAN, 'settings', 'stewards', 'remote'] };

// The lifecycle. "court" is whose move it is while work sits in that stage.
export const STAGES = {
  proposed:  { label: 'Proposed',  court: 'shaping', blurb: 'An idea someone (human or agent) thinks is worth doing. Agents claim proposals to shape them: they read the code, write what done means, and split big ideas. Then the work becomes Ready (or comes to you for approval).' },
  ready:     { label: 'Ready',     court: 'queue',   blurb: 'Shaped, with acceptance criteria. Any agent can pick it up.' },
  active:    { label: 'Active',    court: 'agents',  blurb: 'An agent holds a 20-minute lease and is working. Progress renews the lease; if the agent goes quiet, the work returns to Ready for someone else.' },
  waiting:   { label: 'Waiting',   court: 'you',     blurb: 'An agent hit a question only you can answer and parked the work (it took other work meanwhile). Your answer returns it to Ready.' },
  verifying: { label: 'Verifying', court: 'review',  blurb: 'The agent says it is done and attached evidence. Someone other than the implementer checks it.' },
  landing:   { label: 'Landing',   court: 'agents',  blurb: 'Accepted, and an agent is putting it on main: rebase onto the latest main, run the checks, fast-forward main. It is done when git shows main contains it.' },
  done:      { label: 'Done',      court: null,      blurb: 'Accepted.' },
  dropped:   { label: 'Dropped',   court: null,      blurb: 'Decided not to do. Kept for the record.' },
};
export const OPEN_STAGES = ['proposed', 'ready', 'active', 'waiting', 'verifying', 'landing'];
// Accepted work goes to its builder to land first; after this, any agent may land it.
export const LAND_GRACE = 3 * MIN;

export const AUTONOMY = {
  ask: {
    label: 'Check with me',
    human: 'Agent proposals wait for your OK. You verify all finished work.',
    agent: 'Work you propose waits for the human to approve it. The human verifies finished work.',
  },
  balanced: {
    label: 'Keep moving',
    human: 'Agents shape and start their own proposals. You verify finished work.',
    agent: 'You may shape proposals into ready work (give them acceptance criteria) and start them. The human verifies finished work.',
  },
  full: {
    label: 'Run with it',
    human: 'Agents also peer-review each other (never their own work). You get the digest and step in when you choose.',
    agent: "You may shape and start work, and peer-review other agents' submissions (never your own). Finish before starting: reviews come before new work.",
  },
};

const PRIORITY_RANK = { now: 0, soon: 1, later: 2 };
export const MAX_RACE = 4;

// whose court a stage is in, given the project's autonomy
export function courtOf(stage, autonomy) {
  const c = STAGES[stage]?.court;
  // Proposals are backlog, not anyone's bottleneck, unless the human has asked to approve them.
  if (c === 'shaping') return autonomy === 'ask' ? 'you' : null;
  if (c === 'review') return autonomy === 'full' ? 'agents' : 'you';
  return c;
}

export function dur(ms) {
  ms = Math.max(0, ms);
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${+(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)}h`;
  return `${+(ms / DAY).toFixed(1)}d`;
}

export function providerOf(model = '') {
  const m = model.toLowerCase();
  if (!m) return '';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Anthropic';
  if (/gpt|openai|codex|^o\d/.test(m)) return 'OpenAI';
  if (/gemini/.test(m)) return 'Google';
  return 'Open-weight';
}

// Everything written into nuworq has up to three layers. Be forgiving: an over-long
// headline is trimmed and the overflow moved into the summary rather than rejected.
export function layered(headline, summary = '', detail = '', what = 'headline') {
  headline = String(headline ?? '').trim();
  summary = String(summary ?? '').trim();
  detail = String(detail ?? '').trim();
  if (!headline) throw new UserError(`${what} is required`, { hint: 'One line a busy person can read in three seconds, outcome first.' });
  if (headline.includes('\n')) {
    const [first, ...rest] = headline.split('\n');
    headline = first.trim();
    summary = [rest.join('\n').trim(), summary].filter(Boolean).join('\n\n');
  }
  if (headline.length > HEADLINE_MAX) {
    const space = headline.lastIndexOf(' ', HEADLINE_MAX - 1);
    const at = space > 60 ? space : HEADLINE_MAX - 1;
    summary = ['…' + headline.slice(at).trim(), summary].filter(Boolean).join('\n\n');
    headline = headline.slice(0, at).trim() + '…';
  }
  return { headline, summary, detail };
}

const str = (v) => (v == null ? '' : String(v).trim());
const clip = (v, n = 120) => { const line = str(v).split('\n')[0]; return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line; };
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const fmtOther = (o) => `${o.agent} → ${o.item} ${o.title}${o.touching ? ` (changing ${o.touching.join(', ')})` : ''}`;

// Paths an agent says it is changing. Normalised so "src/db/**", "./src/db/" and "src/db" all compare equal.
export function normPaths(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return [...new Set(list.map((x) => str(x).replace(/^\.\//, '').replace(/(\/\*\*|\/\*|\*|\/)+$/, '')).filter(Boolean))].slice(0, 30);
}
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

// Fit tags: what an item needs, and what an agent's machine has. "Docker, linux-vm" → ["docker", "linux-vm"].
export function normTags(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return [...new Set(list.map((x) => slugify(x)).filter(Boolean))].slice(0, 20);
}
export const SIZES = ['small', 'large'];

// A model whose name says it has ≤8B parameters (qwen3:8b, Llama-3.1-8B-Instruct, gemma3n:e2b).
export function smallModel(model = '') {
  const m = String(model ?? '').toLowerCase().match(/(?:^|[^\d.])(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  return !!m && Number(m[1]) <= 8;
}
const normDir = (d) => str(d).replace(/\/+$/, '');

// Refuse a write that carries a secret, before anything is stored. The error names the field, never the value.
function refuseSecrets(args) {
  const hit = findSecret(args);
  if (hit) {
    throw new UserError(`${hit.path} looks like ${hit.kind}; nothing was saved`, {
      status: 422,
      hint: `Remove or redact it (e.g. "sk-…abcd") and send again. Secrets don't belong in nuworq: everything written here is stored and shown to others.`,
    });
  }
}

// A git remote in the one form every clone shares: host/owner/repo. ssh, scp-style and https forms
// of the same repository compare equal (git@github.com:Acme/api.git → github.com/acme/api). A path
// (a repository on this machine) keeps its case: unlike GitHub, a filesystem may care.
export function normRemote(url) {
  let s = str(url);
  if (!s) return '';
  const scp = !/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && s.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d*(?=\/|$)/, '$1');
  s = s.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return s.startsWith('/') ? s : s.toLowerCase();
}

export function slugify(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export class Hub extends EventEmitter {
  // repos: where the hub keeps mirrors of repositories it has no checkout of (null: it keeps none,
  // so git can't say anything about those projects).
  constructor({ file = ':memory:', clock = () => Date.now(), repos = null } = {}) {
    super();
    this.setMaxListeners(200);
    this.db = openDb(file);
    this.now = clock;
    this.repos = repos;
    this._stmts = new Map();
    this._unreachable = new Set(); // projects whose repository the hub has said it can't reach
  }

  q(sql) {
    let s = this._stmts.get(sql);
    if (!s) this._stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  tx(fn) {
    if (this._inTx) return fn();
    this._inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this._inTx = false;
    }
  }

  changed(p) {
    this.emit('change', { project: p.slug, at: this.now() });
  }

  // ── projects ────────────────────────────────────────────────────────────

  projects() {
    return this.q('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
  }

  project(slug, { create = false, name } = {}) {
    const s = slugify(slug);
    if (!s) throw new UserError('project is required', { hint: 'Pass a project slug, e.g. "my-app".' });
    // An agent told "work on the Acme API project" names it the way a person would: match the name
    // too, so it reaches the project instead of creating an empty one beside it.
    let p = this.q('SELECT * FROM projects WHERE slug = ?').get(s)
      ?? this.q('SELECT * FROM projects WHERE lower(name) = lower(?) ORDER BY id LIMIT 1').get(String(slug).trim());
    if (!p && create) {
      this.q('INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)').run(s, str(name) || s, this.now());
      p = this.q('SELECT * FROM projects WHERE slug = ?').get(s);
      this.event(p, { actor: SYSTEM, type: 'project', headline: `Project ${p.name} created` });
    }
    if (!p) throw new UserError(`No project "${s}"`, { status: 404, hint: 'An agent checkin creates a project automatically, or create one in the UI.' });
    return p;
  }

  // The project whose code lives in (or above) this folder. Longest match wins. scope: slugs to consider (null: all).
  projectByPath(root, scope = null) {
    const r = normDir(root);
    if (!r) return null;
    let best = null;
    for (const p of this.projects()) {
      if (scope && !scope.includes(p.slug)) continue;
      const pp = normDir(p.path);
      if (pp && (r === pp || r.startsWith(pp + '/')) && (!best || pp.length > normDir(best.path).length)) best = p;
    }
    return best;
  }

  // The project a repository belongs to, by its normalized remote: the same answer on every machine.
  // scope: slugs to consider (null: all).
  projectByRemote(remote, scope = null) {
    const r = normRemote(remote);
    const p = r ? this.q('SELECT p.* FROM projects p JOIN project_remotes r ON r.project_id = p.id WHERE r.remote = ?').get(r) ?? null : null;
    return p && scope && !scope.includes(p.slug) ? null : p;
  }

  remotesOf(p) {
    return this.q('SELECT remote FROM project_remotes WHERE project_id = ? ORDER BY at').all(p.id).map((r) => r.remote);
  }

  // Whether work lands through the project's remote (GitHub) instead of a checkout on this machine:
  // the hub has no checkout of the project here, but knows its repository.
  remoteMode(p) {
    return !isRepo(p.path) && this.remotesOf(p).length > 0;
  }

  // Where the hub asks git about a project: its checkout on this machine (local), else its own
  // mirror of the project's remote, fetched first (remote). fresh: fetch now, not just every ~10s.
  // null when git can't say: no repository, or the remote can't be reached or read.
  repoFor(p, { fresh = false } = {}) {
    if (isRepo(p.path)) return { path: p.path, mode: 'local' };
    const remote = this.remotesOf(p)[0];
    if (!remote || !this.repos) return null;
    const m = mirror(this.repos, remote, { fresh });
    if (!m.error) return { path: m.path, mode: 'remote' };
    if (!this._unreachable.has(p.id)) {
      this._unreachable.add(p.id);
      console.error(`nuworq: can't read ${remote} for ${p.name} (${m.error}). Until it can, accepted work there waits in landing: the hub can't confirm main has it. Check the network and the hub's access to the repository (a read-only deploy key is enough).`);
    }
    return null;
  }

  // The branch work lands on, as far as git can say: main, else master; main when it can't.
  baseFor(p) {
    const repo = this.repoFor(p);
    return (repo && baseOf(repo.path)) ?? 'main';
  }

  addRemote(p, remote, actor) {
    const r = normRemote(remote);
    if (!r) throw new UserError('a remote is required', { hint: 'e.g. github.com/acme/api, or any form git accepts (git@github.com:acme/api.git).' });
    const owner = this.projectByRemote(r);
    if (owner?.id === p.id) return r;
    if (owner) throw new UserError(`${r} already belongs to ${owner.name}`, { status: 409, hint: `Remove it from ${owner.name} first: one repository maps to one project.` });
    this.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(p.id, r, this.now());
    this.event(p, {
      actor, type: 'remote',
      headline: isHuman(actor) ? `${You(actor)} linked ${r} to ${p.name}` : `${p.name} is the repository ${r}`,
      summary: isHuman(actor) ? '' : `Learned from ${actor}'s checkin. Agents in any clone of it, on any machine, now find this project on their own.`,
    });
    return r;
  }

  // Where the most valuable claimable work is, across every project that isn't parked:
  // your picks and "now" work first, then building before shaping, then whatever has waited longest.
  // With runner, only projects the human lets `nuworq run` staff. scope: the slugs a token may reach;
  // powers: what it may do (null: everything); has: the agent's tags when it is declaring them right
  // now (else what it declared last).
  route(agent = '', { runner = false, scope = null, powers = null, has } = {}) {
    this.sweep();
    const options = [];
    for (const p of this.projects()) {
      if (p.parked || (runner && !p.runner) || (scope && !scope.includes(p.slug))) continue;
      const all = this.claimable(p, agent, { powers, has });
      // A race with open slots can take that many workers at once.
      if (all.length) options.push({ p, ...all[0], claimable: all.reduce((n, o) => n + (this.racing(o.item) ? this.openSlots(o.item) : 1), 0) });
    }
    options.sort((a, b) =>
      PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] ||
      (a.mode === 'shape') - (b.mode === 'shape') ||
      a.item.stage_since - b.item.stage_since);
    return options.map((o) => ({
      project: o.p.slug, name: o.p.name, path: o.p.path || null,
      mode: o.mode, item: `#${o.item.seq}`, title: o.item.title, priority: o.item.priority,
      waiting: dur(this.now() - o.item.stage_since), claimable: o.claimable,
      slots: this.racing(o.item) ? this.openSlots(o.item) : undefined, // a race with open slots can take that many workers
      // Who is on work here: holders, and racers (whose leases live in attempts).
      ...(runner ? { holders: this.q(`SELECT holder FROM items WHERE project_id = ? AND holder IS NOT NULL
          UNION SELECT a.agent FROM attempts a JOIN items i ON i.id = a.item_id WHERE i.project_id = ? AND a.stage = 'active' AND a.closed = 0`)
        .all(o.p.id, o.p.id).map((h) => h.holder) } : {}),
    }));
  }

  // ── small helpers ───────────────────────────────────────────────────────

  item(p, ref) {
    const n = Number(String(ref ?? '').trim().replace(/^#/, '').replace(/^[a-z]+-?/i, ''));
    if (!Number.isInteger(n) || n < 1) throw new UserError(`Not an item reference: "${ref}"`, { hint: 'Use "#12" or "12".' });
    const it = this.q('SELECT * FROM items WHERE project_id = ? AND seq = ?').get(p.id, n);
    if (!it) throw new UserError(`No item #${n} in ${p.slug}`, { status: 404 });
    return it;
  }

  itemById(id) {
    return id == null ? null : this.q('SELECT * FROM items WHERE id = ?').get(id);
  }

  event(p, { item = null, actor, type, headline, summary = '', detail = '', data = {} }) {
    const r = this.q(`INSERT INTO events (project_id, item_id, actor, type, headline, summary, detail, data, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, actor, type, headline, summary, detail, JSON.stringify(data), this.now());
    return Number(r.lastInsertRowid);
  }

  move(item, stage, actor, patch = {}) {
    const t = this.now();
    const fields = { ...patch, stage, stage_since: t, updated_at: t };
    const keys = Object.keys(fields);
    this.q(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), item.id);
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    // Leaving the race (back to the queue, done, dropped) closes this round's attempts, whatever the race
    // count is now: it may have been changed while the item was verifying.
    if (!['active', 'verifying'].includes(stage)) this.q('UPDATE attempts SET closed = 1 WHERE item_id = ? AND closed = 0').run(item.id);
    Object.assign(item, fields);
  }

  patch(item, fields) {
    fields = { ...fields, updated_at: this.now() };
    const keys = Object.keys(fields);
    this.q(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), item.id);
    Object.assign(item, fields);
  }

  requireAgent(name) {
    const n = str(name);
    if (!n) throw new UserError('agent name is required', { hint: 'Identify yourself: a short unique name such as "claude-1" or "codex-api".' });
    if (n.length > 60) throw new UserError('agent name is too long (max 60 characters)');
    if (n.toLowerCase() === HUMAN || isSystem(n.toLowerCase())) throw new UserError(`"${n}" is reserved; pick another agent name`);
    if (n.startsWith('@')) throw new UserError(`Agent names can't start with "@": that is how people appear on the record`, { hint: 'Pick a name such as "claude-1".' });
    return n;
  }

  touchAgent(p, name, { model, client, status } = {}) {
    const t = this.now();
    const a = this.q('SELECT * FROM agents WHERE project_id = ? AND name = ?').get(p.id, name);
    if (!a) {
      this.q(`INSERT INTO agents (project_id, name, model, client, status, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, name, str(model), str(client), str(status), t, t);
      return { fresh: true, gap: Infinity };
    }
    this.q(`UPDATE agents SET last_seen = ?, signed_off = 0,
        model = CASE WHEN ? != '' THEN ? ELSE model END,
        client = CASE WHEN ? != '' THEN ? ELSE client END,
        status = CASE WHEN ? != '' THEN ? ELSE status END
      WHERE project_id = ? AND name = ?`)
      .run(t, str(model), str(model), str(client), str(client), str(status), str(status), p.id, name);
    return { fresh: false, gap: t - a.last_seen, wasSignedOff: !!a.signed_off };
  }

  // usage: normalized (src/usage.js). The model falls back to the one the agent checked in with.
  recordUsage(p, item, agent, u, source) {
    const model = u.model || this.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model || '';
    this.q(`INSERT INTO usage (project_id, item_id, agent, model, input_tokens, output_tokens, cost_usd, source, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, agent, model, u.input_tokens, u.output_tokens, u.cost_usd, source, this.now());
  }

  // One item's usage, per agent and model, with totals. Cost stays null while any part of it is unknown.
  usageOf(item) {
    const rows = this.q(`SELECT agent, model, source, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cost_usd) AS cost_usd, COUNT(cost_usd) = COUNT(*) AS priced
      FROM usage WHERE item_id = ? GROUP BY agent, model, source ORDER BY MIN(at)`).all(item.id)
      .map(({ priced, ...r }) => ({ ...r, cost_usd: priced ? r.cost_usd : null }));
    if (!rows.length) return null;
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    return {
      rows,
      total: { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cost_usd: rows.some((r) => r.cost_usd != null) ? rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0) : null },
    };
  }

  // Which tokens have spoken as this agent name: more than one is worth the human's eye.
  noteToken(p, name, token) {
    if (!token) return;
    const a = this.q('SELECT tokens FROM agents WHERE project_id = ? AND name = ?').get(p.id, name);
    const seen = a?.tokens ? a.tokens.split(',') : [];
    if (a && !seen.includes(token)) this.q('UPDATE agents SET tokens = ? WHERE project_id = ? AND name = ?').run([...seen, token].join(','), p.id, name);
  }

  // A token limited to some projects: refuse the rest, saying which it may use.
  inScope(scope, slug) {
    if (!scope || scope.includes(slugify(slug))) return;
    throw new UserError(`This token can't reach project "${slugify(slug)}"`, { status: 403, hint: `It is limited to: ${scope.join(', ')}. Ask the human for a token that covers it.` });
  }

  setStatus(p, agent, status) {
    this.q('UPDATE agents SET status = ? WHERE project_id = ? AND name = ?').run(str(status).slice(0, 200), p.id, agent);
  }

  deps(item) {
    return this.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.depends_on WHERE d.item_id = ? ORDER BY i.seq`).all(item.id);
  }

  // What must finish first: explicit dependencies, and an umbrella item's own children.
  unmetDeps(item) {
    const deps = this.deps(item).filter((d) => !['done', 'dropped'].includes(d.stage));
    const kids = this.q(`SELECT * FROM items WHERE parent_id = ? AND stage NOT IN ('done', 'dropped') ORDER BY seq`).all(item.id);
    return [...deps, ...kids.filter((k) => !deps.some((d) => d.id === k.id))];
  }

  // Proposals an agent could claim to shape right now.
  shapeable(p) {
    return this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'proposed' AND holder IS NULL ORDER BY seq`).all(p.id)
      .filter((i) => !this.openQuestions(i, { blocking: true }).length)
      .filter((i) => !(p.autonomy === 'ask' && i.acceptance)); // shaped, waiting for the human's approval
  }

  setDeps(p, item, refs) {
    if (!Array.isArray(refs)) return;
    this.q('DELETE FROM deps WHERE item_id = ?').run(item.id);
    for (const r of refs) {
      const d = this.item(p, r);
      if (d.id === item.id) continue;
      this.q('INSERT OR IGNORE INTO deps (item_id, depends_on) VALUES (?, ?)').run(item.id, d.id);
    }
  }

  openQuestions(item, { blocking } = {}) {
    const rows = this.q(`SELECT * FROM questions WHERE item_id = ? AND status = 'open' ORDER BY at`).all(item.id);
    return blocking == null ? rows : rows.filter((q) => !!q.blocking === blocking);
  }

  heldBy(p, agent) {
    return this.q(`SELECT * FROM items WHERE project_id = ? AND (holder = ?
        OR id IN (SELECT item_id FROM attempts WHERE agent = ? AND stage = 'active' AND closed = 0)) ORDER BY seq`).all(p.id, agent, agent);
  }

  // ── races: an item with race > 1 is attempted by several agents at once, each with its own lease ──
  // Race items never use items.holder while ready or active; their leases live in attempts.

  racing(item) {
    return item.race > 1 && ['ready', 'active'].includes(item.stage);
  }

  attemptsOf(item) {
    return this.q('SELECT * FROM attempts WHERE item_id = ? AND closed = 0 ORDER BY id').all(item.id);
  }

  attemptOf(item, agent) {
    return this.q(`SELECT * FROM attempts WHERE item_id = ? AND agent = ? AND stage = 'active' AND closed = 0`).get(item.id, agent);
  }

  openSlots(item) {
    return item.race - this.attemptsOf(item).filter((a) => a.stage !== 'abandoned').length;
  }

  holds(item, agent) {
    return item.holder === agent || (this.racing(item) && !!this.attemptOf(item, agent));
  }

  // Racers can't review the race they ran.
  implementedBy(item, agent) {
    return item.implementer === agent ||
      !!this.q(`SELECT 1 FROM attempts WHERE item_id = ? AND agent = ? AND stage = 'submitted' AND closed = 0`).get(item.id, agent);
  }

  leaseOf(item, agent) {
    return this.racing(item) ? this.attemptOf(item, agent)?.lease_until ?? null : item.lease_until;
  }

  renew(item, agent) {
    const until = this.now() + LEASE_MS;
    if (this.racing(item)) this.q('UPDATE attempts SET lease_until = ? WHERE id = ?').run(until, this.attemptOf(item, agent).id);
    else this.patch(item, { lease_until: until });
  }

  endAttempt(item, agent, stage, submission = null) {
    this.q(`UPDATE attempts SET stage = ?, lease_until = NULL, touching = '[]', submission = ? WHERE id = ?`)
      .run(stage, submission, this.attemptOf(item, agent).id);
  }

  // A race's submissions, numbered for the reviewer (1-based, in the order the attempts started).
  submissions(item) {
    if (item.race <= 1) return [];
    return this.attemptsOf(item).filter((a) => ['submitted', 'chosen', 'not_chosen'].includes(a.stage)).map((a, k) => {
      const e = this.q('SELECT * FROM events WHERE id = ?').get(a.submission) ?? {};
      const data = json(e.data, {});
      return {
        n: k + 1, agent: a.agent, model: a.model, stage: a.stage,
        headline: e.headline ?? '', summary: e.summary || undefined, evidence: data.evidence ?? [],
        branch: data.git?.branch ?? null, commits: data.git?.commits ?? undefined,
        took: e.at ? dur(e.at - a.at) : undefined,
      };
    });
  }

  // Which attempt a reviewer keeps: by number or agent name. With one submission, that one.
  keptAttempt(item, choice, actor) {
    const subs = this.submissions(item).filter((s) => s.stage === 'submitted');
    if (!subs.length) return null;
    const which = `Pass attempt: ${subs.map((s) => `${s.n} (${s.agent})`).join(', ')}.`;
    if (choice == null || str(choice) === '') {
      if (subs.length === 1) return subs[0];
      throw new UserError(`#${item.seq} was raced: ${subs.length} attempts were submitted, so say which one to keep`, { hint: which });
    }
    const k = subs.find((s) => String(s.n) === str(choice).replace(/^#/, '') || s.agent === str(choice));
    if (!k) throw new UserError(`No submitted attempt "${choice}" on #${item.seq}`, { status: 404, hint: which });
    if (k.agent === actor) throw new UserError("You can't pick your own attempt", { status: 403 });
    return k;
  }

  // When no attempt is still running, the race is over: to review if anyone submitted, else back to the queue.
  settleRace(p, item, actor) {
    if (item.race <= 1 || item.stage !== 'active') return;
    const all = this.attemptsOf(item);
    if (all.some((a) => a.stage === 'active')) return;
    const subs = all.filter((a) => a.stage === 'submitted');
    if (subs.length) {
      this.move(item, 'verifying', actor, { holder: null, lease_until: null, implementer: subs.at(-1).agent, touching: '[]' });
      this.event(p, {
        item, actor: SYSTEM, type: 'race_finished',
        headline: `The race on #${item.seq} is over: ${subs.length === 1 ? '1 submission' : `${subs.length} submissions`} to review (${subs.map((a) => a.agent).join(', ')})`,
      });
    } else {
      this.move(item, 'ready', actor, { holder: null, lease_until: null, touching: '[]' });
      this.event(p, { item, actor: SYSTEM, type: 'race_finished', headline: `Every attempt on #${item.seq} was abandoned; it's back in the queue` });
    }
  }

  // Steering an agent has not acknowledged: recent project-wide steers, plus steers on items it holds.
  pendingSteers(p, agent) {
    return this.q(`SELECT n.*, i.seq AS item_seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'steer' AND n.active = 1
        AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.note_id = n.id AND a.agent = ?)
        AND ((n.item_id IS NULL AND n.target IS NULL AND n.at > ?) OR i.holder = ? OR n.target = ?
          OR EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = n.item_id AND a.agent = ? AND a.stage = 'active' AND a.closed = 0))
      ORDER BY n.at`).all(p.id, agent, this.now() - STEER_TTL, agent, agent, agent)
      .map((n) => ({ steer: n.id, about: n.item_seq ? `#${n.item_seq}` : 'whole project', from: n.author, body: n.body, ago: dur(this.now() - n.at) }));
  }

  // What every other agent is doing right now, and where in the code.
  others(p, agent) {
    const held = this.q(`SELECT seq, title, holder AS agent, touching FROM items WHERE project_id = ? AND stage = 'active' AND holder IS NOT NULL AND holder != ?`).all(p.id, agent ?? '');
    const racers = this.q(`SELECT i.seq, i.title, a.agent, a.touching FROM attempts a JOIN items i ON i.id = a.item_id
      WHERE i.project_id = ? AND i.stage = 'active' AND a.stage = 'active' AND a.closed = 0 AND a.agent != ?`).all(p.id, agent ?? '');
    return [...held, ...racers].sort((a, b) => a.seq - b.seq)
      .map((i) => {
        const t = json(i.touching, []);
        return { agent: i.agent, item: `#${i.seq}`, title: i.title, touching: t.length ? t : undefined };
      });
  }

  // What this agent says it is changing on the item: its own attempt's paths, on a race.
  touchingOf(item, agent) {
    return json(this.racing(item) ? this.attemptOf(item, agent)?.touching : item.touching, []);
  }

  headsUp(p, agent, item) {
    const notes = [];
    const mine = this.touchingOf(item, agent);
    const clashes = [];
    for (const o of mine.length ? this.others(p, agent) : []) {
      const hit = (o.touching ?? []).filter((x) => mine.some((m) => overlap(m, x)));
      if (hit.length) clashes.push(`${o.agent} is also changing ${hit.join(', ')} (for ${o.item})`);
    }
    if (clashes.length) notes.push(`${clashes.join('; ')}. Keep your changes there small and coordinate with a comment on their item.`);
    // Work that landed since this agent started, unless its branch already has it: rebase while conflicts are small.
    if (item.stage === 'active' && item.branch) {
      const landed = this.q(`SELECT DISTINCT i.seq FROM events e JOIN items i ON i.id = e.item_id
        WHERE e.project_id = ? AND e.type = 'landed' AND e.at > ? AND i.id != ? ORDER BY i.seq`).all(p.id, item.stage_since, item.id);
      const repo = landed.length ? this.repoFor(p) : null;
      const base = repo ? baseOf(repo.path) : null;
      if (base && branchExists(repo.path, item.branch) && !contains(repo.path, item.branch, base)) {
        const how = repo.mode === 'remote'
          ? `git fetch origin, then git rebase origin/${base}, then git push origin ${item.branch} --force-with-lease`
          : `git rebase ${base}`;
        notes.push(`${base} moved since you started: ${landed.map((x) => `#${x.seq}`).join(', ')} landed. Rebase now (${how}), while any conflicts are small.`);
      }
    }
    return notes.length ? notes.join(' ') : undefined;
  }

  setTouching(item, v, agent) {
    if (v == null) return;
    if (this.racing(item)) this.q('UPDATE attempts SET touching = ? WHERE id = ?').run(JSON.stringify(normPaths(v)), this.attemptOf(item, agent).id);
    else this.patch(item, { touching: JSON.stringify(normPaths(v)) });
  }

  fieldNotes(p) {
    return this.q(`SELECT n.id, n.body, n.author, i.seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at DESC LIMIT 40`).all(p.id)
      .map((n) => ({ id: n.id, note: n.body, by: n.author, about: n.seq ? `#${n.seq}` : undefined }));
  }

  // ── who a "needs you" belongs to, when there are people ──

  hasPeople() {
    return !!this.q('SELECT 1 FROM people LIMIT 1').get();
  }

  // The project's stewards; with none named, the workspace's owners and stewards.
  stewardsOf(p) {
    const named = this.q('SELECT handle FROM project_stewards WHERE project_id = ? ORDER BY handle').all(p.id).map((r) => `@${r.handle}`);
    if (named.length) return named;
    return this.q(`SELECT handle FROM people WHERE role IN ('owner', 'steward') ORDER BY id`).all().map((r) => `@${r.handle}`);
  }

  // People who have steered this item (active steers): they own what comes up on it.
  steerersOf(item) {
    return this.q(`SELECT author FROM notes WHERE item_id = ? AND kind = 'steer' AND active = 1 AND author LIKE '@%'
      GROUP BY author ORDER BY MIN(at), MIN(id)`).all(item.id).map((r) => r.author);
  }

  ownersOf(p, item) {
    const steerers = item ? this.steerersOf(item) : [];
    return steerers.length ? steerers : this.stewardsOf(p);
  }

  decisions(p) {
    return this.q(`SELECT id, body, at FROM notes WHERE project_id = ? AND kind = 'decision' AND active = 1 ORDER BY at`).all(p.id);
  }

  // Everything an agent needs to work an item, and nothing it doesn't.
  context(p, item, agent) {
    const parent = this.itemById(item.parent_id);
    const children = this.q('SELECT seq, title, stage FROM items WHERE parent_id = ? ORDER BY seq').all(item.id);
    const history = this.q(`SELECT * FROM events WHERE item_id = ?
        AND type IN ('handoff','sent_back','lease_expired','answered','assumption_confirmed','submitted','shaped','picked','comment','steer','refined')
        ORDER BY at DESC LIMIT 8`).all(item.id).reverse();
    const questions = this.q('SELECT * FROM questions WHERE item_id = ? ORDER BY at').all(item.id);
    const steers = this.q(`SELECT n.* FROM notes n WHERE n.item_id = ? AND n.kind = 'steer' AND n.active = 1
        AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.note_id = n.id AND a.agent = ?) ORDER BY n.at`).all(item.id, agent ?? '');
    const handoff = json(item.handoff, null);
    const lease = this.leaseOf(item, agent);
    const touching = this.touchingOf(item, agent);
    const steerers = this.steerersOf(item);
    const racers = item.race > 1 ? this.attemptsOf(item) : [];
    return {
      item: `#${item.seq}`,
      title: item.title,
      stage: item.stage,
      priority: item.priority,
      needs: json(item.needs, []).length ? json(item.needs, []) : undefined,
      size: item.size || undefined,
      summary: item.summary || undefined,
      detail: item.detail || undefined,
      done_means: item.acceptance || 'No acceptance criteria yet. Write them with refine before you submit, so a reviewer knows what to check.',
      repo: this.remotesOf(p)[0] || undefined,
      branch: item.branch || undefined,
      lease: item.holder ? { holder: item.holder, expires_in: dur(item.lease_until - this.now()) }
        : this.racing(item) && lease ? { holder: agent, expires_in: dur(lease - this.now()) } : undefined,
      race: item.race > 1 ? (item.stage === 'verifying' ? {
        slots: item.race,
        submissions: this.submissions(item),
        note: 'Compare the attempts side by side against done_means. Accept with attempt: <n or agent> to keep one; the others are recorded as not chosen. Reject sends them all back.',
      } : {
        slots: item.race,
        attempts: racers.length ? racers.map((a) => `${a.agent}${a.model ? ` (${a.model})` : ''}: ${a.stage}`) : undefined,
        note: 'Several agents attempt this item at once, each on its own. Work independently; the reviewer compares the submissions.',
      }) : undefined,
      touching: touching.length ? touching : undefined,
      attempt: item.attempts || undefined,
      last_handoff: handoff ? { by: handoff.by, kind: handoff.kind, headline: handoff.headline, summary: handoff.summary || undefined, ago: dur(this.now() - handoff.at) } : undefined,
      parent: parent ? `#${parent.seq} ${parent.title}` : undefined,
      children: children.length ? children.map((c) => `#${c.seq} [${c.stage}] ${c.title}`) : undefined,
      depends_on: (() => { const d = this.deps(item); return d.length ? d.map((x) => `#${x.seq} [${x.stage}] ${x.title}`) : undefined; })(),
      questions: questions.length ? questions.map((q) => ({
        question: q.question, status: q.status, blocking: !!q.blocking,
        assumption: q.assumption || undefined, answer: q.answer || undefined,
      })) : undefined,
      steers: steers.length ? steers.map((n) => ({ steer: n.id, from: n.author, body: n.body, ago: dur(this.now() - n.at) })) : undefined,
      // The hub can't tell whether two people's steers conflict; the agent can, and its question reaches both.
      steered_by: steerers.length > 1
        ? `Steers from ${steerers.slice(0, -1).join(', ')} and ${steerers.at(-1)}. If they disagree, ask: the question goes to all of them.`
        : undefined,
      history: history.length ? history.map((e) => ({ ago: dur(this.now() - e.at), by: e.actor, type: e.type, headline: e.headline, summary: e.summary || undefined })) : undefined,
      others_working: (() => { const o = this.others(p, agent); return o.length ? o.map(fmtOther) : undefined; })(),
      heads_up: agent ? this.headsUp(p, agent, item) : undefined,
    };
  }

  // Expired leases go back to the queue. Run before every operation and on a timer.
  sweep() {
    const t = this.now();
    const expired = this.q(`SELECT i.*, p.slug FROM items i JOIN projects p ON p.id = i.project_id
      WHERE i.holder IS NOT NULL AND i.lease_until < ?`).all(t);
    const lapsed = this.q(`SELECT * FROM attempts WHERE stage = 'active' AND closed = 0 AND lease_until < ?`).all(t);
    if (!expired.length && !lapsed.length) return 0;
    const touched = new Map();
    this.tx(() => {
      // A lapsed race attempt frees its slot; the other racers carry on.
      for (const a of lapsed) {
        const it = this.itemById(a.item_id);
        const p = this.q('SELECT * FROM projects WHERE id = ?').get(it.project_id);
        touched.set(p.id, p);
        const last = this.q(`SELECT headline FROM events WHERE item_id = ? AND actor = ? ORDER BY at DESC LIMIT 1`).get(it.id, a.agent);
        this.q(`UPDATE attempts SET stage = 'abandoned', lease_until = NULL, touching = '[]' WHERE id = ?`).run(a.id);
        this.patch(it, { last_worker: a.agent, stalls: it.stalls + 1 });
        this.event(p, {
          item: it, actor: SYSTEM, type: 'lease_expired',
          headline: `${a.agent} went quiet on #${it.seq}; their race slot is open again`,
          summary: last ? `Their last update: "${last.headline}"` : 'They left no updates.',
          data: { agent: a.agent },
        });
        this.settleRace(p, it, SYSTEM);
      }
      for (const it of expired) {
        const p = this.q('SELECT * FROM projects WHERE id = ?').get(it.project_id);
        touched.set(p.id, p);
        const last = this.q(`SELECT headline FROM events WHERE item_id = ? AND actor = ? ORDER BY at DESC LIMIT 1`).get(it.id, it.holder);
        if (it.stage === 'proposed') {
          this.patch(it, { holder: null, lease_until: null, last_worker: it.holder, stalls: it.stalls + 1 });
          this.event(p, {
            item: it, actor: SYSTEM, type: 'lease_expired',
            headline: `${it.last_worker} went quiet while shaping #${it.seq}; it's open for shaping again`,
            summary: last ? `Their last update: "${last.headline}"` : '', data: { agent: it.last_worker },
          });
        } else if (it.stage === 'active') {
          this.move(it, 'ready', SYSTEM, { holder: null, lease_until: null, last_worker: it.holder, stalls: it.stalls + 1, touching: '[]' });
          this.event(p, {
            item: it, actor: SYSTEM, type: 'lease_expired',
            headline: `${it.last_worker} went quiet on #${it.seq}; it's back in the queue`,
            summary: last ? `Their last update: "${last.headline}"` : 'They left no updates.',
            data: { agent: it.last_worker },
          });
        } else {
          this.patch(it, { holder: null, lease_until: null });
          this.event(p, it.stage === 'landing'
            ? { item: it, actor: SYSTEM, type: 'lease_expired', headline: `${it.holder} went quiet while landing #${it.seq}; another agent can land it`, data: { agent: it.holder } }
            : { item: it, actor: SYSTEM, type: 'lease_expired', headline: `Review lease on #${it.seq} expired; it's open for review again` });
        }
      }
    });
    for (const p of touched.values()) this.changed(p);
    return expired.length + lapsed.length;
  }

  // ── agent operations ────────────────────────────────────────────────────

  // slug may be empty: then the agent's folder (root) picks the project, or the hub routes it to work.
  // scope: the project slugs the caller's token may reach (null: all).
  // token: the calling token's identity (required mode): its name is recorded on the agent; an agent
  // token also brings its powers (none means every power) and provenance.
  // remote: the agent's repository (normalized origin remote), which finds the project on any machine.
  agentOp(slug, op, name, args = {}, { root = '', remote = '', scope = null, token = null } = {}) {
    const fn = AGENT_OPS[op];
    if (!fn) throw new UserError(`Unknown operation "${op}"`, { status: 404, hint: `Operations: ${Object.keys(AGENT_OPS).join(', ')}` });
    refuseSecrets(args);
    this.sweep();
    const agent = this.requireAgent(name);
    const powers = token?.powers ?? null;
    remote = normRemote(remote);
    let p;
    let routed = null;
    if (slug) {
      this.inScope(scope, slug);
      p = this.project(slug, { create: op === 'checkin' });
    } else {
      // The repository is the same on every machine; the folder only on this one.
      p = this.projectByRemote(remote, scope) ?? this.projectByPath(root, scope);
      if (!p) {
        if (!['checkin', 'next'].includes(op)) {
          throw new UserError('Which project?', { hint: 'Call checkin first: the hub sends you to the work that matters most, and remembers it for this session.' });
        }
        routed = this.route(agent, { scope, powers, has: op === 'checkin' && args.has != null ? normTags(args.has) : undefined })[0];
        if (!routed) {
          return {
            ok: true, project: null,
            next: 'No work is waiting in any project: everything is parked, idle, or waiting on the human. Signoff, or check in to a specific project to propose work.',
            projects: this.projects().map((x) => x.slug).filter((s) => !scope || scope.includes(s)),
          };
        }
        p = this.project(routed.project);
      }
    }
    const here = normDir(root);
    if (slug && here && !p.path && op === 'checkin') {
      // Learn where the project lives the first time an agent names it from a folder.
      this.q('UPDATE projects SET path = ? WHERE id = ?').run(here, p.id);
      p.path = here;
      this.event(p, { actor: SYSTEM, type: 'path', headline: `${p.name} lives in ${here}`, summary: `Learned from ${agent}'s checkin. Agents working in that folder now find this project on their own.` });
    }
    // Learn the repository the same way, unless it already belongs to another project.
    if (slug && remote && op === 'checkin' && !this.projectByRemote(remote)) this.addRemote(p, remote, agent);
    // A clone of the project's repository is the right place to work, wherever it sits on disk.
    const ownClone = !!remote && this.projectByRemote(remote)?.id === p.id;
    const result = this.tx(() => {
      const presence = this.touchAgent(p, agent, op === 'checkin' ? args : { model: args.model, client: args.client });
      this.noteToken(p, agent, token?.name);
      if (token?.role === 'agent') this.q('UPDATE agents SET token_id = ? WHERE project_id = ? AND name = ?').run(token.id, p.id, agent);
      const need = powers && this.powerFor(p, op, args ?? {});
      if (need && !powers.includes(need)) {
        throw new UserError(`This agent's token can't ${need} (its powers: ${powers.join(', ')})`, {
          status: 403, hint: `Call next: it only offers work this token may do. A token with ${need} comes from: nuworq token create <name> --powers ${need}.`,
        });
      }
      this.caller = { powers };
      // Checked before the op runs, so a malformed usage changes nothing.
      const usage = USAGE_OPS.includes(op) ? normUsage(args?.usage) : null;
      let r;
      try { r = fn.call(this, p, agent, args ?? {}, presence); } finally { this.caller = null; }
      if (usage) this.recordUsage(p, this.item(p, args.item), agent, usage, 'agent');
      // Steering rides along on every response, so it lands on the agent's very next call.
      if (op !== 'checkin') {
        const steers = this.pendingSteers(p, agent);
        if (steers.length) {
          r.steers = steers;
          r.hint = `The human has steered you; read it, adjust, then ack. ${r.hint ?? ''}`.trim();
        }
      }
      if (!slug) r.project ??= p.slug; // so clients can stay with the project they were sent to
      if (['checkin', 'next'].includes(op)) {
        const where = normDir(p.path);
        if (routed) r.routed = `The hub sent you to ${p.name}: ${routed.item} ${routed.title} is the most valuable waiting work (${routed.priority}, waiting ${routed.waiting}).`;
        if (ownClone && here) {
          r.workspace = here;
        } else if (where && here && here !== where && !here.startsWith(where + '/')) {
          r.workspace = `This project's code lives in ${where}, but you are in ${here}. Do the work there: start a session in that folder, or ask the human.`;
        } else if (where) {
          r.workspace = where;
        }
      }
      return r;
    });
    const check = result[GIT_CHECK];
    if (check) {
      delete result[GIT_CHECK];
      // Fetched now: the agent has likely just pushed, and a stale mirror would say it hadn't.
      const repo = this.repoFor(p, { fresh: true });
      const g = repo ? gitFacts(repo.path, agent, check.claim, check.branch) : null;
      if (g && repo.mode === 'remote' && !g.branch && check.branch) g.unpushed = check.branch;
      if (g) {
        if (check.item && g.branch && g.branch !== check.branch) this.q('UPDATE items SET branch = ? WHERE id = ?').run(g.branch, check.item);
        const e = this.q('SELECT data FROM events WHERE id = ?').get(check.event);
        this.q('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify({ ...json(e.data, {}), git: g }), check.event);
        const warn = gitWarning(g);
        if (warn) result.hint = `${warn}: the reviewer will see this. ${result.hint}`;
      }
    }
    this.changed(p);
    return result;
  }

  briefing(p, agent, since = 0) {
    const feedback = this.q(`SELECT e.*, i.seq FROM events e JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? AND e.type IN ('accepted', 'sent_back') AND i.implementer = ? AND e.actor != ? AND e.at > ?
      ORDER BY e.at DESC LIMIT 5`).all(p.id, agent, agent, since);
    const answers = this.q(`SELECT q.*, i.seq AS item_seq FROM questions q LEFT JOIN items i ON i.id = q.item_id
      WHERE q.project_id = ? AND q.asked_by = ? AND q.status IN ('answered', 'confirmed') AND q.seen_by_asker = 0 ORDER BY q.answered_at`).all(p.id, agent);
    if (answers.length) this.q(`UPDATE questions SET seen_by_asker = 1 WHERE id IN (${answers.map(() => '?').join(',')})`).run(...answers.map((a) => a.id));
    const holding = this.heldBy(p, agent);
    const steers = this.pendingSteers(p, agent);
    const count = (stage) => this.q('SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND stage = ?').get(p.id, stage).n;
    const board = { ready: count('ready'), active: count('active'), waiting_on_human: count('waiting'), verifying: count('verifying'), proposed: count('proposed') };
    const reopened = answers.filter((a) => a.item_seq && a.blocking && this.itemById(a.item_id)?.stage === 'ready');

    let next;
    if (steers.length) next = 'Read the steering below, adjust, and ack each one (ack with its steer id).';
    else if (holding.length) next = `You hold ${holding.map((i) => `#${i.seq}`).join(', ')}. Continue (progress renews your lease), submit, or handoff.`;
    else if (p.parked) next = 'The human has parked this project: start nothing new. Signoff.';
    else if (reopened.length) next = `Your question on #${reopened[0].item_seq} was answered and it's ready again. Claim it to continue.`;
    else if (p.autonomy === 'full' && board.verifying) next = 'Call next: there is work waiting for peer review.';
    else if (board.ready) next = 'Call next to pick up the most useful ready work.';
    else if (this.shapeable(p).length) next = 'Nothing is ready to build, but there are proposals to shape. Call next.';
    else next = "Nothing is ready. Propose work you think matters (with acceptance criteria), or signoff.";

    return {
      project: p.slug,
      name: p.name,
      parked: p.parked ? true : undefined,
      mission: p.mission || 'No mission written yet. Infer intent from the work and ask if it really matters.',
      autonomy: { level: p.autonomy, means: AUTONOMY[p.autonomy].agent },
      you: agent,
      decisions: this.decisions(p).map((d) => d.body),
      steers: steers.length ? steers : undefined,
      answers: answers.length ? answers.map((a) => ({
        about: a.item_seq ? `#${a.item_seq}` : 'project',
        question: a.question,
        answer: a.status === 'confirmed' ? `Your assumption stands: ${a.assumption}` : a.answer,
      })) : undefined,
      feedback: feedback.length ? feedback.map((e) => ({
        item: `#${e.seq}`,
        verdict: e.type === 'accepted' ? 'accepted' : 'sent back',
        by: e.actor,
        note: (e.type === 'sent_back' ? json(this.itemById(e.item_id).handoff, {})?.headline : '') || undefined,
      })) : undefined,
      field_notes: (() => { const n = this.fieldNotes(p); return n.length ? n : undefined; })(),
      holding: holding.length ? holding.map((i) => ({ item: `#${i.seq}`, title: i.title, stage: i.stage, lease_expires_in: dur(this.leaseOf(i, agent) - this.now()) })) : undefined,
      others_working: (() => { const o = this.others(p, agent); return o.length ? o.map(fmtOther) : undefined; })(),
      board,
      next,
    };
  }

  // The power an agent op needs: shaping proposals, building work, or reviewing it. Others need none.
  powerFor(p, op, args) {
    if (op === 'review') return 'review';
    if (op === 'refine') return 'shape';
    if (!['claim', 'progress', 'submit', 'handoff'].includes(op)) return null;
    let item;
    try { item = this.item(p, args.item); } catch { return null; } // a bad reference is reported by the op itself
    return item.stage === 'proposed' ? 'shape' : item.stage === 'verifying' ? 'review' : 'build';
  }

  // Pick the most useful thing for this agent. Finish before starting: reviews first, then by priority;
  // at equal priority, build ready work before shaping proposals, and prefer work you touched before.
  // powers: what the caller's token may do (null: everything); work it can't do is never offered.
  // Never offers work whose needs the agent's machine lacks; large work waits while a weak fit has other work.
  pick(p, agent, { powers = null, has } = {}) {
    return this.claimable(p, agent, { powers, has })[0] ?? null;
  }

  // Items this agent handed off within the cooldown, by id.
  handedOff(p, agent) {
    if (!agent) return new Set();
    return new Set(this.q(`SELECT DISTINCT item_id FROM events WHERE project_id = ? AND actor = ? AND type = 'handoff' AND at > ?`)
      .all(p.id, agent, this.now() - HANDOFF_COOLDOWN).map((r) => r.item_id));
  }

  // Everything this agent could claim here, most useful first. Not what it just handed off, not a race
  // it already ran in, not work its token's powers don't cover, and not work needing what its machine lacks.
  claimable(p, agent, { powers = null, has } = {}) {
    const may = (power) => !powers || powers.includes(power);
    const fit = this.fit(p, agent, has);
    const ok = (i) => !fit.has || json(i.needs, []).every((t) => fit.has.includes(t));
    const gave = this.handedOff(p, agent);
    const fresh = (i) => !gave.has(i.id) && ok(i); // not just handed off, and doable on this machine
    const reviews = p.autonomy !== 'full' || !may('review') ? [] : this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'verifying' AND holder IS NULL
        AND COALESCE(implementer, '') != ?
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = items.id AND a.agent = ? AND a.stage = 'submitted' AND a.closed = 0)
      ORDER BY stage_since`).all(p.id, agent, agent).filter(fresh).map((item) => ({ mode: 'review', item }));
    // Accepted work waiting to land: its builder first, then anyone after LAND_GRACE. Landing even in a
    // parked project: it finishes work, it doesn't start any.
    const lands = !may('build') ? [] : this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'landing' AND holder IS NULL ORDER BY stage_since`).all(p.id)
      .filter((i) => !gave.has(i.id) && (i.implementer === agent || this.now() - i.stage_since >= LAND_GRACE))
      .map((item) => ({ mode: 'land', item }));
    if (p.parked) return [...lands, ...reviews];
    const ready = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL`).all(p.id)
      .filter((i) => fresh(i) && !this.unmetDeps(i).length)
      .map((item) => ({ mode: 'work', item }));
    // Races with an open slot this agent hasn't taken a turn in. A slot goes to a different model first:
    // an agent on a model already in the race sees it after other work of the same priority.
    const model = agent ? this.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model ?? '' : '';
    const racing = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'active' AND race > 1`).all(p.id)
      .filter(fresh)
      .map((item) => ({ item, runs: this.attemptsOf(item) }))
      .filter(({ item, runs }) => this.openSlots(item) > 0 && !runs.some((a) => a.agent === agent))
      .map(({ item, runs }) => ({ mode: 'work', item, sameModel: !!model && runs.some((a) => a.stage !== 'abandoned' && a.model === model) }));
    const shape = this.shapeable(p).filter(fresh).map((item) => ({ mode: 'shape', item }));
    const large = (x) => (fit.weak && x.item.size === 'large' ? 1 : 0);
    const all = [...(may('build') ? [...ready, ...racing] : []), ...(may('shape') ? shape : [])].sort((a, b) =>
      large(a) - large(b) ||
      PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] ||
      !!a.sameModel - !!b.sameModel ||
      (a.mode === 'shape') - (b.mode === 'shape') ||
      (b.item.last_worker === agent) - (a.item.last_worker === agent) ||
      a.item.seq - b.item.seq);
    return [...lands, ...reviews, ...all];
  }

  // What fits this agent: the tags its machine has (declared at checkin, here or in its latest project),
  // and whether it is a weak fit for large work: a model recognised as ≤8B, or ≥2 stalls or send-backs
  // on large items here with none landed. has: null when nobody in particular is asking (any work fits).
  fit(p, agent, has) {
    if (!agent && has == null) return { has: null, weak: false };
    if (has) has = normTags(has);
    const a = this.q('SELECT has, model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent ?? '')
      ?? this.q('SELECT has, model FROM agents WHERE name = ? ORDER BY last_seen DESC LIMIT 1').get(agent ?? '');
    const landed = this.q(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND implementer = ? AND size = 'large' AND stage = 'done'`).get(p.id, agent ?? '').n;
    const missed = this.q(`SELECT COUNT(*) AS n FROM events e JOIN items i ON i.id = e.item_id WHERE e.project_id = ? AND i.size = 'large'
        AND ((e.type = 'sent_back' AND i.implementer = ?) OR (e.type = 'lease_expired' AND json_extract(e.data, '$.agent') = ?))`).get(p.id, agent ?? '', agent ?? '').n;
    return { has: has ?? json(a?.has, []), weak: smallModel(a?.model) || (missed >= 2 && !landed) };
  }

  claimItem(p, agent, item) {
    const t = this.now();
    if (item.stage === 'verifying') {
      if (p.autonomy !== 'full') throw new UserError(`#${item.seq} is waiting for the human to verify it`, { hint: 'Pick other work with next.' });
      if (this.implementedBy(item, agent)) throw new UserError(`You can't review your own work (#${item.seq})`, { hint: 'Another agent or the human will review it. Pick other work with next.' });
      if (item.holder && item.holder !== agent) throw new UserError(`${item.holder} is already reviewing #${item.seq}`, { hint: 'Pick other work with next.' });
      this.patch(item, { holder: agent, lease_until: t + LEASE_MS });
      this.event(p, { item, actor: agent, type: 'review_started', headline: `${agent} started reviewing #${item.seq}` });
      this.setStatus(p, agent, `Reviewing #${item.seq}: ${item.title}`);
      return;
    }
    if (item.holder === agent && ['active', 'proposed', 'landing'].includes(item.stage)) {
      this.patch(item, { lease_until: t + LEASE_MS });
      return;
    }
    if (item.stage === 'landing') {
      if (item.holder) throw new UserError(`${item.holder} is landing #${item.seq}`, { status: 409, hint: 'Pick other work with next.' });
      this.patch(item, { holder: agent, lease_until: t + LEASE_MS });
      this.event(p, { item, actor: agent, type: 'landing', headline: `${agent} is landing #${item.seq}` });
      this.setStatus(p, agent, `Landing #${item.seq}: ${item.title}`);
      return;
    }
    if (p.parked && ['ready', 'proposed'].includes(item.stage)) {
      throw new UserError(`${p.name} is parked: the human has paused new work`, { status: 409, hint: 'Finish or hand off what you hold, then signoff.' });
    }
    if (item.stage === 'proposed') {
      if (item.holder) throw new UserError(`${item.holder} is shaping #${item.seq}`, { status: 409, hint: 'Pick other work with next.' });
      if (this.openQuestions(item, { blocking: true }).length) throw new UserError(`#${item.seq} is waiting for the human to answer a question`, { status: 409, hint: 'Pick other work with next.' });
      if (p.autonomy === 'ask' && item.acceptance) throw new UserError(`#${item.seq} is shaped and waiting for the human to approve it`, { status: 409, hint: 'Pick other work with next.' });
      this.patch(item, { holder: agent, lease_until: t + LEASE_MS, last_worker: agent });
      this.event(p, { item, actor: agent, type: 'shaping', headline: `${agent} is shaping #${item.seq}` });
      this.setStatus(p, agent, `Shaping #${item.seq}: ${item.title}`);
      return;
    }
    if (this.racing(item)) return this.joinRace(p, agent, item);
    if (item.stage === 'active') throw new UserError(`#${item.seq} is held by ${item.holder} (lease ends in ${dur(item.lease_until - t)})`, { status: 409, hint: 'Pick other work with next. If they go quiet, it returns to the queue automatically.' });
    if (item.stage === 'waiting') throw new UserError(`#${item.seq} is parked waiting for the human to answer a question`, { status: 409, hint: 'Pick other work with next.' });
    if (item.stage !== 'ready') throw new UserError(`#${item.seq} is ${item.stage}`, { status: 409 });
    const unmet = this.unmetDeps(item);
    if (unmet.length) throw new UserError(`#${item.seq} depends on unfinished work: ${unmet.map((d) => `#${d.seq}`).join(', ')}`, { status: 409, hint: 'Work on a dependency, or pick other work with next.' });
    this.move(item, 'active', agent, { holder: agent, lease_until: t + LEASE_MS, last_worker: agent, attempts: item.attempts + 1, branch: item.branch || itemBranch(item) });
    this.event(p, {
      item, actor: agent, type: 'claimed',
      headline: `${agent} picked up #${item.seq}${item.attempts > 1 ? ` (attempt ${item.attempts})` : ''}`,
    });
    this.setStatus(p, agent, `Working on #${item.seq}: ${item.title}`);
  }

  // Take a slot in a race: an attempt with its own lease. The first one moves the item to active.
  joinRace(p, agent, item) {
    const t = this.now();
    if (this.attemptOf(item, agent)) {
      this.renew(item, agent);
      return;
    }
    if (p.parked) throw new UserError(`${p.name} is parked: the human has paused new work`, { status: 409, hint: 'Finish or hand off what you hold, then signoff.' });
    const unmet = item.stage === 'ready' ? this.unmetDeps(item) : [];
    if (unmet.length) throw new UserError(`#${item.seq} depends on unfinished work: ${unmet.map((d) => `#${d.seq}`).join(', ')}`, { status: 409, hint: 'Work on a dependency, or pick other work with next.' });
    if (this.openSlots(item) < 1) {
      throw new UserError(`All ${item.race} race slots on #${item.seq} are taken (${this.attemptsOf(item).filter((a) => a.stage !== 'abandoned').map((a) => a.agent).join(', ')})`, {
        status: 409, hint: 'Pick other work with next. If a racer goes quiet, its slot opens again.',
      });
    }
    const model = this.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model ?? '';
    this.q('INSERT INTO attempts (item_id, agent, model, lease_until, at) VALUES (?, ?, ?, ?, ?)').run(item.id, agent, model, t + LEASE_MS, t);
    const fields = { last_worker: agent, attempts: item.attempts + 1 };
    if (item.stage === 'ready') this.move(item, 'active', agent, fields);
    else this.patch(item, fields);
    const slot = item.race - this.openSlots(item);
    this.event(p, { item, actor: agent, type: 'claimed', headline: `${agent} joined the race on #${item.seq} (slot ${slot} of ${item.race})`, data: { model } });
    this.setStatus(p, agent, `Racing on #${item.seq}: ${item.title}`);
  }

  // Find an item this agent is allowed to write to; be helpful when it isn't.
  // Where accepted work lands: null when git can't say (no repo it can read, or no branch to land);
  // otherwise the base branch, and whether the branch still has commits main lacks.
  // fresh: deciding a landing, so a mirror is fetched first.
  toLand(p, branch, { fresh = false } = {}) {
    const repo = branch ? this.repoFor(p, { fresh }) : null;
    if (!repo || !branchExists(repo.path, branch)) return null;
    const base = baseOf(repo.path);
    if (!base) return null;
    return { base, pending: !contains(repo.path, base, branch), head: headOf(repo.path, base) };
  }

  // The land job's hint: the base as git says it, and a push first when the hub can't see the branch.
  landHint(p, item) {
    const remote = this.remoteMode(p);
    const repo = this.repoFor(p);
    const base = (repo && baseOf(repo.path)) ?? 'main';
    const unseen = remote && !!item.branch && !(repo && branchExists(repo.path, item.branch));
    return LAND_HINT(item, p, base, remote, unseen);
  }

  // The branch git found for the latest submission, when the item has none of its own (older work).
  submittedBranch(item) {
    const e = this.q(`SELECT data FROM events WHERE item_id = ? AND type = 'submitted' ORDER BY at DESC LIMIT 1`).get(item.id);
    return json(e?.data, {}).git?.branch ?? '';
  }

  heldItem(p, agent, ref, verb) {
    const item = this.item(p, ref);
    if (this.holds(item, agent)) return item;
    const why = item.holder ? `${item.holder} holds it now`
      : this.racing(item) ? `you have no running attempt in the race on it`
      : `it is ${item.stage} and nobody holds it`;
    throw new UserError(`You don't hold #${item.seq} (${why}), so you can't ${verb} it`, {
      status: 409,
      hint: item.stage === 'ready' ? `Claim it first: claim #${item.seq}.` : 'Your lease may have expired. Call next for other work, or comment to add your notes to the record.',
    });
  }
}

// Open-weight models (and others) skipped progress entirely until told when the first one is due.
const TOUCHING_HINT = 'As soon as you know which files you will change, post progress with a headline and touching, so other agents steer clear.';
const SHAPE_HINT = (item, p) => [
  `You're shaping #${item.seq}, not building it yet. You hold it for ${dur(LEASE_MS)}.`,
  'Read the relevant code, then refine it: a sharp title and summary, and acceptance criteria (checkable, so a reviewer knows what done means).',
  `If it's big, split it: propose sub-items with parent #${item.seq}, each with acceptance criteria. #${item.seq} then waits for them.`,
  'If the intent is unclear, ask with an assumption.',
  `Finish with submit (headline: the shape you chose). ${p.autonomy === 'ask' ? 'The human then approves it.' : 'It becomes ready for any agent, including you.'}`,
].join(' ');

// Every claim says where to work: the item's own branch, in a worktree, never the main checkout.
// remote: the hub has no checkout here, so the branch is cut from origin and pushed there for review.
const WORK_HINT = (item, p, remote = false) => !item.branch ? ''
  : remote
    ? `Work on branch ${item.branch}, cut from the latest main on origin: git fetch origin, then git switch -c ${item.branch} origin/main (or git switch ${item.branch} if it exists). Work in a git worktree or a clone of your own, not a checkout another agent is using. Commit as you go. Before you submit, push the branch (git push origin ${item.branch}) so reviewers anywhere can see it.`
    : `Work on branch ${item.branch}, cut from the latest main: git switch -c ${item.branch} main (or git switch ${item.branch} if it exists). Work in a git worktree, never in ${p.path || 'the main checkout'} itself: it stays on main so work can land there. Commit as you go.`;
// remote: main is the one on origin (GitHub). Pushing to it succeeds only as a fast-forward, so a
// rejected push means main moved; the branch is pushed again too, so the hub can see main contains it.
// unseen: the hub can't see the branch on origin, so it is pushed first. One git command at a time, and
// pushes as plain "git push origin …": headless workers may run only that prefix.
const LAND_HINT = (item, p, base = 'main', remote = false, unseen = false) => remote ? [
  unseen ? `Push it first: git push origin ${item.branch} (the hub can't see ${item.branch} on origin yet).` : '',
  `${unseen ? 'Then land' : 'Land'} #${item.seq}: put ${item.branch} on ${base} on origin.`,
  `1. In your worktree or clone: git fetch origin, then git switch ${item.branch}, then git rebase origin/${base} (commit or stash anything uncommitted first). Conflicts: resolve them keeping both intents. If resolving changed what the reviewer approved, don't land: submit with conflicts (what you changed and why), and it goes back for review.`,
  `2. Run the project's checks (e.g. npm test) and fix anything the rebase broke.`,
  `3. git push origin ${item.branch}:${base}. If it is rejected as non-fast-forward, ${base} moved: go back to step 1.`,
  `4. git push origin ${item.branch} --force-with-lease (the rebase rewrote the branch; this updates it on origin).`,
  `5. submit #${item.seq}. The hub fetches, checks that ${base} contains the branch, and marks it done.`,
].filter(Boolean).join(' ') : [
  `Land #${item.seq}: put ${item.branch} on ${base}.`,
  `1. In your worktree: git switch ${item.branch} (commit or stash anything uncommitted first).`,
  `2. git rebase ${base}. Conflicts: resolve them keeping both intents. If resolving changed what the reviewer approved, don't land: submit with conflicts (what you changed and why), and it goes back for review.`,
  `3. Run the project's checks (e.g. npm test) and fix anything the rebase broke.`,
  `4. git -C ${p.path} merge --ff-only ${item.branch}. If it can't fast-forward, ${base} moved: go back to step 2.`,
  `5. submit #${item.seq}. The hub checks that ${base} contains the branch and marks it done.`,
].join(' ');

// Submit on a land job: done when git shows main has the branch; back to review when the rebase changed it.
function finishLanding(p, agent, item, { headline, summary, detail, conflicts }) {
  const reviewer = p.autonomy === 'full' ? 'Another agent reviews it again' : 'The human verifies it again';
  if (conflicts) {
    this.move(item, 'verifying', agent, { holder: null, lease_until: null, last_worker: agent });
    this.event(p, { item, actor: agent, type: 'rebased', headline: `${agent} rebased #${item.seq} and had to resolve conflicts; it needs another look`, summary: conflicts, detail });
    this.setStatus(p, agent, `Sent #${item.seq} back for review after a rebase`);
    return { ok: true, hint: `#${item.seq} is verifying again with your note on the conflicts. ${reviewer}, then it lands. Call next.` };
  }
  const land = this.toLand(p, item.branch, { fresh: true });
  const remote = this.remoteMode(p);
  if (!land) {
    throw new UserError(`The hub can't see ${item.branch || 'a branch for this item'} in ${remote ? this.remotesOf(p)[0] : p.path || 'a repository it can reach'}`, {
      status: 409,
      hint: remote
        ? `Push it (git push origin ${item.branch} --force-with-lease) and submit again. If you have, the hub may not reach the repository right now: try again in a minute. Keep the branch until the hub confirms the landing.`
        : 'Keep the branch until the hub confirms the landing. If the work is on another branch, say which in a comment and handoff.',
    });
  }
  if (land.pending) {
    throw new UserError(`${land.base} doesn't contain ${item.branch} yet`, { status: 409, hint: LAND_HINT(item, p, land.base, remote) });
  }
  this.move(item, 'done', agent, { holder: null, lease_until: null, touching: '[]' });
  this.event(p, {
    item, actor: agent, type: 'landed',
    headline: `${agent} landed #${item.seq} on ${land.base}${headline && !/^land/i.test(headline) ? `: ${headline}` : ''}`,
    summary, detail, data: { branch: item.branch, base: land.base, head: land.head },
  });
  this.setStatus(p, agent, `Landed #${item.seq}`);
  return { ok: true, hint: `#${item.seq} is on ${land.base} and done. You can delete the branch: git branch -d ${item.branch}. Call next.` };
}

function finishShaping(p, agent, item, { headline, summary, detail, acceptance }) {
  if (str(acceptance)) this.patch(item, { acceptance: str(acceptance) });
  const kids = this.q(`SELECT COUNT(*) AS n FROM items WHERE parent_id = ?`).get(item.id).n;
  if (!item.acceptance && !kids) {
    throw new UserError(`#${item.seq} has no acceptance criteria yet`, { status: 409, hint: `Say what done means (refine #${item.seq} with acceptance, or pass acceptance to submit), or split it into sub-items.` });
  }
  if (!item.acceptance) this.patch(item, { acceptance: 'All sub-items are done and work together.' });
  const toReady = p.autonomy !== 'ask';
  if (toReady) this.move(item, 'ready', agent, { holder: null, lease_until: null, last_worker: agent });
  else this.patch(item, { holder: null, lease_until: null, last_worker: agent });
  this.event(p, { item, actor: agent, type: 'shaped', headline: `${agent} shaped #${item.seq}: ${headline}`, summary, detail });
  this.setStatus(p, agent, `Shaped #${item.seq}`);
  return {
    ok: true, stage: item.stage,
    hint: toReady
      ? `#${item.seq} is ready${kids ? ` (it waits for its ${kids} sub-item(s))` : ''}. Call next: you may well get to build it.`
      : `#${item.seq} is shaped and waiting for the human to approve it. Call next for other work.`,
  };
}

const AGENT_OPS = {
  checkin(p, agent, args, presence) {
    if (presence.fresh || presence.gap > 30 * MIN || presence.wasSignedOff) {
      const what = [args.model, args.client].filter(Boolean).join(' via ');
      this.event(p, { actor: agent, type: 'checkin', headline: `${agent} checked in${what ? ` (${what})` : ''}` });
    }
    const last = this.q('SELECT last_checkin FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.last_checkin ?? 0;
    this.q('UPDATE agents SET last_checkin = ? WHERE project_id = ? AND name = ?').run(this.now(), p.id, agent);
    if (args.has != null) this.q('UPDATE agents SET has = ? WHERE project_id = ? AND name = ?').run(JSON.stringify(normTags(args.has)), p.id, agent);
    return this.briefing(p, agent, last);
  },

  next(p, agent, args) {
    const holding = this.heldBy(p, agent).filter((i) => ['active', 'proposed', 'landing'].includes(i.stage));
    if (holding.length && args.claim !== false) {
      return {
        mode: 'holding',
        holding: holding.map((i) => `#${i.seq} ${i.title}`),
        hint: `Finish what you hold first: submit, or handoff if you can't. To work in parallel anyway, claim a specific item.`,
      };
    }
    const pick = this.pick(p, agent, { powers: this.caller?.powers });
    if (!pick) {
      if (p.parked) return { mode: 'idle', hint: 'The human has parked this project: start nothing new. Signoff.' };
      const { has } = this.fit(p, agent);
      const gave = [...this.handedOff(p, agent)].map((id) => this.itemById(id))
        .filter((i) => !i.holder && ['ready', 'proposed', 'verifying'].includes(i.stage));
      const open = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL`).all(p.id)
        .filter((i) => !gave.some((g) => g.id === i.id));
      const unfit = open.filter((i) => json(i.needs, []).some((t) => !has.includes(t)));
      const blocked = open.length - unfit.length;
      return {
        mode: 'idle',
        hint: [
          `Nothing is ready${unfit.length ? ' for you' : ''} or waiting to be shaped right now.`,
          gave.length ? `You handed off ${gave.map((i) => `#${i.seq}`).join(', ')}, so it's left for other agents for now (claim it if you really can do it now).` : '',
          unfit.length ? `${unfit.map((i) => `#${i.seq} needs ${json(i.needs, []).filter((t) => !has.includes(t)).join(', ')}`).join('; ')}, which you didn't declare at checkin (has). If your machine has it, check in again with has.` : '',
          blocked ? `${blocked} ready item(s) are waiting on dependencies or their own sub-items.` : '',
          'Propose work you think matters (with acceptance criteria), or signoff.',
        ].filter(Boolean).join(' '),
      };
    }
    if (args.claim !== false) this.claimItem(p, agent, pick.item);
    return {
      mode: pick.mode,
      ...this.context(p, pick.item, agent),
      hint: pick.mode === 'review'
        ? `Review #${pick.item.seq} against done_means and the evidence, then call review with accept or reject.${pick.item.race > 1 ? ' It was raced: compare race.submissions and accept with attempt set to the one to keep.' : ''}`
        : pick.mode === 'land' && args.claim !== false
          ? this.landHint(p, this.itemById(pick.item.id))
        : pick.mode === 'shape' && args.claim !== false
          ? SHAPE_HINT(pick.item, p)
          : args.claim === false
          ? `Not claimed. Claim #${pick.item.seq} to start.`
          : `You hold #${pick.item.seq} for ${dur(LEASE_MS)}. ${WORK_HINT(this.itemById(pick.item.id), p, this.remoteMode(p))} ${TOUCHING_HINT} Then progress at milestones (it renews the lease). Submit with evidence when done_means is met.`.replace(/  +/g, ' '),
    };
  },

  claim(p, agent, args) {
    const item = this.item(p, args.item);
    this.claimItem(p, agent, item);
    if (item.stage === 'active') this.setTouching(item, args.touching, agent);
    return {
      ...this.context(p, item, agent),
      hint: item.stage === 'verifying'
        ? `Review #${item.seq} against done_means and the evidence, then call review.`
        : item.stage === 'proposed'
          ? SHAPE_HINT(item, p)
          : item.stage === 'landing'
            ? this.landHint(p, this.itemById(item.id))
            : `You hold #${item.seq} for ${dur(LEASE_MS)}. ${WORK_HINT(this.itemById(item.id), p, this.remoteMode(p))} ${args.touching ? '' : `${TOUCHING_HINT} `}Progress renews the lease.`.replace(/  +/g, ' '),
    };
  },

  progress(p, agent, args) {
    const item = this.item(p, args.item);
    if (!str(args.headline) && this.holds(item, agent)) {
      // A silent heartbeat: renews the lease, adds nothing to the record.
      this.renew(item, agent);
      this.setTouching(item, args.touching, agent);
      return { ok: true, lease_expires_in: dur(LEASE_MS), heads_up: this.headsUp(p, agent, item) };
    }
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    if (!this.holds(item, agent)) {
      // Don't lose the work: keep the note on the record, then explain.
      this.event(p, { item, actor: agent, type: 'comment', headline, summary, detail });
      throw new UserError(`You no longer hold #${item.seq}${item.holder ? ` (${item.holder} does)` : ''}. Your update was saved as a comment.`, {
        status: 409, hint: 'Your lease probably expired. Call next to continue with whatever is most useful.',
      });
    }
    this.renew(item, agent);
    this.setTouching(item, args.touching, agent);
    this.event(p, { item, actor: agent, type: 'progress', headline, summary, detail });
    this.setStatus(p, agent, `#${item.seq}: ${headline}`);
    return { ok: true, lease_expires_in: dur(LEASE_MS), heads_up: this.headsUp(p, agent, item) };
  },

  ask(p, agent, args) {
    const question = layered(args.question, args.context, args.detail, 'question');
    const assumption = str(args.assumption);
    const blocking = args.blocking === true || args.blocking === 'true' || (!assumption && args.blocking == null);
    const item = args.item ? this.item(p, args.item) : null;
    const options = Array.isArray(args.options) ? args.options.map(str).filter(Boolean).slice(0, 6) : [];
    const r = this.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, detail, options, blocking, assumption, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, agent, question.headline, question.summary, question.detail,
      JSON.stringify(options), blocking ? 1 : 0, assumption, this.now());
    const id = Number(r.lastInsertRowid);
    let parked = false;
    if (blocking && item && ['active', 'ready'].includes(item.stage) && !this.racing(item)) {
      // A race doesn't park for one racer's question: the others keep going.
      this.move(item, 'waiting', agent, { holder: null, lease_until: null, last_worker: item.holder || item.last_worker });
      parked = true;
    } else if (blocking && item?.stage === 'proposed' && item.holder === agent) {
      this.patch(item, { holder: null, lease_until: null }); // shaping pauses until the answer comes
      parked = true;
    }
    this.event(p, {
      item, actor: agent, type: blocking ? 'question' : 'assumption',
      headline: blocking ? `${agent} asks: ${question.headline}` : `${agent} assumed "${assumption}"`,
      summary: blocking ? question.summary : `Question: ${question.headline}${question.summary ? `\n\n${question.summary}` : ''}`,
      detail: question.detail, data: { question: id },
    });
    return {
      ok: true, question: id, blocking,
      hint: blocking
        ? parked
          ? `#${item.seq} is parked until the human answers. Don't wait: call next and take other work. The answer will be in your next checkin.`
          : "Asked. Keep working on anything that doesn't depend on the answer; it will appear in your next checkin."
        : 'Assumption recorded; keep going. If the human overrides it, it will arrive as steering.',
    };
  },

  submit(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = this.heldItem(p, agent, args.item, 'submit');
    if (item.stage === 'proposed') return finishShaping.call(this, p, agent, item, { headline, summary, detail, acceptance: args.acceptance });
    if (item.stage === 'landing') return finishLanding.call(this, p, agent, item, { headline, summary, detail, conflicts: str(args.conflicts) });
    if (item.stage !== 'active') throw new UserError(`#${item.seq} is ${item.stage}; only active work can be submitted`, { status: 409 });
    const evidence = (Array.isArray(args.evidence) ? args.evidence : args.evidence ? [args.evidence] : [])
      .map((e) => (typeof e === 'string' ? { label: e } : { label: str(e.label || e.url), url: str(e.url) || undefined }))
      // Agents sometimes put the result where the link goes ("unit tests|2 passed"): keep it as text, not a broken link.
      .map((e) => (e.url && !/^https?:\/\//i.test(e.url) ? { label: e.label === e.url ? e.label : `${e.label}: ${e.url}` } : e))
      .filter((e) => e.label);
    const reviewer = p.autonomy === 'full' ? 'Another agent will peer-review it.' : 'The human will verify it.';
    const nudge = evidence.length ? '' : 'Next time attach evidence (tests run, commands, commit or PR links); it makes verification fast. ';
    if (this.racing(item)) {
      const id = this.event(p, { item, actor: agent, type: 'submitted', headline, summary, detail, data: { evidence, race: true } });
      this.endAttempt(item, agent, 'submitted', id);
      this.patch(item, { last_worker: agent });
      this.setStatus(p, agent, `Submitted an attempt on #${item.seq}`);
      this.settleRace(p, item, agent);
      return {
        ok: true,
        hint: `${item.stage === 'verifying' ? `The race is over and #${item.seq} is verifying. ${reviewer}` : `Your attempt is in; #${item.seq} goes to review when the other racers finish.`} ${nudge}Call next for more work.`,
        [GIT_CHECK]: { event: id, claim: { headline, summary, evidence } }, // the race review shows each attempt's branch
      };
    }
    this.move(item, 'verifying', agent, { holder: null, lease_until: null, last_worker: agent, implementer: agent, touching: '[]' });
    const event = this.event(p, { item, actor: agent, type: 'submitted', headline, summary, detail, data: { evidence } });
    this.setStatus(p, agent, `Submitted #${item.seq}`);
    return {
      ok: true,
      hint: `#${item.seq} is verifying. ${reviewer} ${nudge}Call next for more work.`,
      [GIT_CHECK]: { event, item: item.id, branch: item.branch, claim: { headline, summary, evidence } }, // asked of git once the transaction is done
    };
  },

  handoff(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = this.heldItem(p, agent, args.item, 'hand off');
    const racing = this.racing(item);
    if (racing) {
      // Giving up a race slot: it opens for someone else, and the note stays for whoever takes it.
      this.endAttempt(item, agent, 'abandoned');
      this.patch(item, { last_worker: agent, handoff: JSON.stringify({ kind: 'handoff', by: agent, headline, summary, at: this.now() }) });
    } else if (item.stage === 'verifying') {
      this.patch(item, { holder: null, lease_until: null });
    } else if (item.stage === 'proposed') {
      this.patch(item, { holder: null, lease_until: null, last_worker: agent, handoff: JSON.stringify({ kind: 'handoff', by: agent, headline, summary, at: this.now() }) });
    } else {
      this.move(item, 'ready', agent, {
        holder: null, lease_until: null, last_worker: agent, touching: '[]',
        handoff: JSON.stringify({ kind: 'handoff', by: agent, headline, summary, at: this.now() }),
      });
    }
    this.event(p, { item, actor: agent, type: 'handoff', headline: `${agent} handed off #${item.seq}: ${headline}`, summary, detail });
    if (racing) this.settleRace(p, item, agent);
    this.setStatus(p, agent, `Handed off #${item.seq}`);
    return { ok: true, hint: 'Handed off; the next agent will see your note. Call next or signoff.' };
  },

  propose(p, agent, args) {
    const item = this.createItem(p, agent, args);
    return {
      ok: true, item: `#${item.seq}`, stage: item.stage,
      hint: item.stage === 'ready'
        ? 'Ready for any agent (including you).'
        : p.autonomy === 'ask'
          ? 'Waiting for the human to approve it.'
          : `Add acceptance criteria (refine #${item.seq}) to make it ready.`,
    };
  },

  refine(p, agent, args) {
    const item = this.item(p, args.item);
    const changed = this.refineItem(p, agent, item, args);
    return { ok: true, item: `#${item.seq}`, stage: item.stage, changed };
  },

  review(p, agent, args) {
    const item = this.item(p, args.item);
    if (p.autonomy !== 'full') throw new UserError('In this project the human verifies finished work', { status: 403, hint: 'Leave a comment with what you noticed instead.' });
    if (item.stage !== 'verifying') throw new UserError(`#${item.seq} is ${item.stage}, not verifying`, { status: 409 });
    if (this.implementedBy(item, agent)) throw new UserError("You can't review your own work", { status: 403 });
    if (item.holder && item.holder !== agent) throw new UserError(`${item.holder} is reviewing #${item.seq}`, { status: 409 });
    const verdict = str(args.verdict).toLowerCase();
    if (!['accept', 'reject'].includes(verdict)) throw new UserError('verdict must be "accept" or "reject"');
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const r = this.verdict(p, agent, item, verdict, { headline, summary, detail, attempt: args.attempt });
    this.setStatus(p, agent, `Reviewed #${item.seq}`);
    return { ok: true, stage: item.stage, ...r, hint: 'Thanks. Call next.' };
  },

  comment(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = args.item ? this.item(p, args.item) : null;
    this.event(p, { item, actor: agent, type: 'comment', headline, summary, detail });
    return { ok: true };
  },

  ack(p, agent, args) {
    const id = Number(String(args.steer ?? '').replace(/^#/, ''));
    const note = this.q(`SELECT * FROM notes WHERE id = ? AND project_id = ? AND kind = 'steer'`).get(id, p.id);
    if (!note) throw new UserError(`No steer ${args.steer}`, { status: 404, hint: 'Use the steer id from checkin or a response.' });
    const response = str(args.response).slice(0, 300);
    this.q('INSERT OR REPLACE INTO acks (note_id, agent, response, at) VALUES (?, ?, ?, ?)').run(id, agent, response, this.now());
    const item = this.itemById(note.item_id);
    this.event(p, {
      item, actor: agent, type: 'ack',
      headline: response ? `${agent}: ${response}` : `${agent} acknowledged your steer`,
      summary: `Steer: "${note.body}"`, data: { steer: id },
    });
    return { ok: true };
  },

  look(p, agent, args) {
    if (args.item) return this.context(p, this.item(p, args.item), agent);
    const stages = args.stage ? [str(args.stage)] : OPEN_STAGES;
    const out = {};
    for (const s of stages) {
      const rows = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = ? ORDER BY seq`).all(p.id, s);
      if (rows.length) out[s] = rows.map((i) => `#${i.seq} [${i.priority}] ${i.title}${i.holder ? ` (${i.holder})` : ''}`);
    }
    const recent = this.q(`SELECT seq, title FROM items WHERE project_id = ? AND stage = 'done' AND stage_since > ? ORDER BY stage_since DESC LIMIT 10`)
      .all(p.id, this.now() - 3 * DAY);
    if (!args.stage && recent.length) out.recently_done = recent.map((i) => `#${i.seq} ${i.title}`);
    const notes = this.fieldNotes(p);
    return { board: out, decisions: this.decisions(p).map((d) => d.body), field_notes: notes.length ? notes : undefined, others_working: this.others(p, agent).map(fmtOther) };
  },

  learn(p, agent, args) {
    const text = str(args.note);
    if (!text) throw new UserError('note is required', { hint: 'One or two lines the next agent would want to know: a command that works, a trap, a convention.' });
    if (text.length > 600) throw new UserError('Keep field notes short (under 600 characters)', { hint: 'Put long explanations in docs in the repo and note where they are.' });
    const item = args.item ? this.item(p, args.item) : null;
    let replaced = null;
    if (args.replaces) {
      replaced = this.q(`SELECT * FROM notes WHERE id = ? AND project_id = ? AND kind = 'learning'`).get(Number(args.replaces), p.id);
      if (replaced) this.q('UPDATE notes SET active = 0 WHERE id = ?').run(replaced.id);
    }
    const r = this.q(`INSERT INTO notes (project_id, item_id, kind, author, body, at) VALUES (?, ?, 'learning', ?, ?, ?)`)
      .run(p.id, item?.id ?? null, agent, text, this.now());
    this.event(p, {
      item, actor: agent, type: 'learned',
      headline: `${agent} noted: ${clip(text)}`,
      summary: replaced ? `Replaces: "${replaced.body}"` : '', data: { note: Number(r.lastInsertRowid) },
    });
    return { ok: true, note: Number(r.lastInsertRowid), hint: 'Every agent will see this at checkin.' };
  },

  signoff(p, agent, args) {
    const held = this.heldBy(p, agent);
    const note = str(args.headline) || 'Signed off';
    for (const item of held) {
      AGENT_OPS.handoff.call(this, p, agent, { item: item.seq, headline: note, summary: args.summary });
    }
    this.q('UPDATE agents SET signed_off = 1, status = ? WHERE project_id = ? AND name = ?').run(note, p.id, agent);
    this.event(p, { actor: agent, type: 'signoff', headline: `${agent} signed off: ${note}`, summary: str(args.summary) });
    return { ok: true, handed_off: held.map((i) => `#${i.seq}`) };
  },

  // Not in the protocol: the runner posts what a worker's CLI said the run cost, once the agent exits.
  // Worker names are unique per run, so everything on the record under the name is that run. It is
  // split across the items the worker acted on, by how long it worked on each (first to last event).
  usage(p, agent, args) {
    const u = normUsage(args.usage);
    if (!u) return { ok: true, recorded: [] };
    const spans = this.q(`SELECT item_id, MIN(at) AS a, MAX(at) AS b FROM events
      WHERE project_id = ? AND actor = ? AND item_id IS NOT NULL GROUP BY item_id ORDER BY MIN(at)`).all(p.id, agent);
    if (!spans.length) {
      this.recordUsage(p, null, agent, u, 'runner');
      return { ok: true, recorded: [] };
    }
    const parts = split(u, spans.map((s) => Math.max(s.b - s.a, MIN)));
    spans.forEach((s, k) => this.recordUsage(p, this.itemById(s.item_id), agent, parts[k], 'runner'));
    return { ok: true, recorded: spans.map((s) => `#${this.itemById(s.item_id).seq}`) };
  },
};

// ── shared by agents and the human ─────────────────────────────────────────

Object.assign(Hub.prototype, {
  createItem(p, actor, args) {
    const { headline: title, summary, detail } = layered(args.title ?? args.headline, args.summary, args.detail, 'title');
    const acceptance = str(args.acceptance);
    const priority = PRIORITY_RANK[args.priority] != null ? args.priority : 'soon';
    const parent = args.parent ? this.item(p, args.parent) : null;
    const human = isHuman(actor);
    const stage = human ? (args.stage === 'proposed' ? 'proposed' : 'ready')
      : p.autonomy !== 'ask' && acceptance ? 'ready' : 'proposed';
    const t = this.now();
    const seq = this.q('SELECT next_seq FROM projects WHERE id = ?').get(p.id).next_seq;
    this.q('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?').run(p.id);
    const needs = JSON.stringify(normTags(args.needs));
    const size = SIZES.includes(args.size) ? args.size : '';
    const r = this.q(`INSERT INTO items (project_id, seq, title, summary, detail, acceptance, stage, priority, parent_id, created_by, needs, size, stage_since, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, seq, title, summary, detail, acceptance, stage, priority, parent?.id ?? null, actor, needs, size, t, t, t);
    const item = this.itemById(Number(r.lastInsertRowid));
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    this.setDeps(p, item, args.depends_on);
    this.event(p, {
      item, actor, type: 'created',
      headline: human ? `${You(actor)} added #${seq}: ${title}` : `${actor} proposed #${seq}: ${title}`,
      summary, data: { stage },
    });
    return item;
  },

  refineItem(p, actor, item, args) {
    const changed = [];
    const set = {};
    if (args.title != null && str(args.title) && str(args.title) !== item.title) { set.title = layered(args.title).headline; changed.push('title'); }
    for (const k of ['summary', 'detail', 'acceptance']) {
      if (args[k] != null && str(args[k]) !== item[k]) { set[k] = str(args[k]); changed.push(k); }
    }
    if (args.priority && PRIORITY_RANK[args.priority] != null && args.priority !== item.priority) { set.priority = args.priority; changed.push(`priority → ${args.priority}`); }
    if (args.race != null && args.race !== '') {
      const n = Number(args.race);
      if (!Number.isInteger(n) || n < 1 || n > MAX_RACE) throw new UserError(`race must be a whole number from 1 to ${MAX_RACE}`, { hint: '1 means one agent at a time (the usual); 2 or more lets that many agents attempt it at once.' });
      if (n !== item.race) {
        if (item.stage === 'active') throw new UserError(`#${item.seq} is being worked on; change its race count while it is ready`, { status: 409 });
        set.race = n;
        changed.push(n > 1 ? `race → ${n} agents` : 'no longer a race');
      }
    }
    if (args.needs != null && JSON.stringify(normTags(args.needs)) !== item.needs) {
      set.needs = JSON.stringify(normTags(args.needs));
      changed.push(`needs → ${normTags(args.needs).join(', ') || 'nothing'}`);
    }
    if (args.size != null && (SIZES.includes(args.size) || args.size === '') && args.size !== item.size) { set.size = args.size; changed.push(`size → ${args.size || 'unset'}`); }
    if (Object.keys(set).length) this.patch(item, set);
    if (Array.isArray(args.depends_on)) { this.setDeps(p, item, args.depends_on); changed.push('dependencies'); }
    const human = isHuman(actor);
    const promote = item.stage === 'proposed' && !item.holder && item.acceptance && (human || p.autonomy !== 'ask') && args.ready !== false;
    if (promote) { this.move(item, 'ready', actor); changed.push('now ready'); }
    if (changed.length) {
      this.event(p, {
        item, actor, type: 'refined',
        headline: `${You(actor)} refined #${item.seq}: ${changed.join(', ')}`,
        summary: set.acceptance ? `Done means: ${set.acceptance}` : '',
      });
    }
    return changed;
  },

  verdict(p, actor, item, verdict, { headline, summary = '', detail = '', attempt }) {
    const who = You(actor);
    if (verdict === 'accept') {
      // A race: keep one attempt, and record the others as not chosen.
      const kept = this.keptAttempt(item, attempt, actor);
      const merge = kept && (kept.branch ?? `nuworq/${kept.agent}`);
      if (kept) {
        for (const a of this.attemptsOf(item).filter((x) => x.stage === 'submitted')) {
          const chosen = a.agent === kept.agent;
          this.q('UPDATE attempts SET stage = ? WHERE id = ?').run(chosen ? 'chosen' : 'not_chosen', a.id);
          if (!chosen) this.event(p, { item, actor, type: 'not_chosen', headline: `${a.agent}'s attempt on #${item.seq} was not chosen`, data: { agent: a.agent } });
        }
      }
      const branch = kept ? merge : item.branch || this.submittedBranch(item);
      const land = this.toLand(p, branch, { fresh: true });
      // Done means on main. Remote mode: work with a branch the hub can't see in its mirror (never pushed,
      // or the remote can't be read right now) still lands. The lander pushes it; finishLanding checks.
      const unseen = !land && !!branch && !!this.repos && this.remoteMode(p);
      const landing = !!land?.pending || unseen;
      this.move(item, landing ? 'landing' : 'done', actor, {
        holder: null, lease_until: null, ...(kept ? { implementer: kept.agent } : {}), ...(branch ? { branch } : {}),
      });
      this.event(p, {
        item, actor, type: 'accepted',
        headline: `${who} accepted #${item.seq}${kept ? ` (${kept.agent}'s attempt)` : ''}${headline ? `: ${headline}` : ''}`,
        summary: [
          land?.pending ? `${branch} lands on ${land.base} next: an agent rebases it, runs the checks and fast-forwards ${land.base}.` : '',
          unseen ? `${branch} lands next: the hub can't see it on origin yet, so the lander pushes it first, then rebases it, runs the checks and pushes it to main.` : '',
          kept && !land && !unseen ? `Merge ${merge}${kept.branch ? '' : ' (the worker branch convention; check the evidence)'}.` : '',
          summary,
        ].filter(Boolean).join('\n\n'),
        detail, data: {
          ...(kept ? { kept: kept.agent, merge } : {}),
          ...(land ? { branch, base: land.base, landing: land.pending } : unseen ? { branch, landing: true, unseen: true } : {}),
        },
      });
      if (land && !land.pending) {
        this.event(p, { item, actor: SYSTEM, type: 'landed', headline: `#${item.seq} is already on ${land.base}`, data: { branch, base: land.base, head: land.head } });
      }
      return { ...(kept ? { kept: kept.agent, merge } : {}), ...(landing ? { landing: branch } : {}) };
    } else {
      this.move(item, 'ready', actor, {
        holder: null, lease_until: null, rejections: item.rejections + 1,
        handoff: JSON.stringify({ kind: 'sent_back', by: actor, headline, summary, at: this.now() }),
      });
      this.event(p, { item, actor, type: 'sent_back', headline: `${who} sent back #${item.seq}: ${headline}`, summary, detail });
    }
  },
});

// ── human operations ───────────────────────────────────────────────────────

const HUMAN_OPS = {
  answer(p, { question, answer, decide }, by) {
    const q = this.q('SELECT * FROM questions WHERE id = ? AND project_id = ?').get(Number(question), p.id);
    if (!q) throw new UserError(`No question ${question}`, { status: 404 });
    const text = str(answer);
    if (!text) throw new UserError('answer is required');
    const item = this.itemById(q.item_id);
    if (!q.blocking && text.toLowerCase() === q.assumption.trim().toLowerCase()) {
      return HUMAN_OPS.confirm.call(this, p, { question }, by);
    }
    this.q(`UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, seen_by_asker = 0 WHERE id = ?`)
      .run(text, by, this.now(), q.id);
    this.event(p, {
      item, actor: by, type: 'answered',
      headline: `${You(by)} answered${item ? ` on #${item.seq}` : ''}: ${clip(text)}`,
      summary: `${q.asked_by} asked: ${q.question}`, data: { question: q.id },
    });
    if (!q.blocking && q.status === 'open') {
      // Overriding an assumption the agent already acted on: tell whoever is on it now.
      this.addNote(p, 'steer', `Change of course${item ? ` on #${item.seq}` : ''}: you assumed "${q.assumption}". Instead: ${text}`, item, null, by);
    }
    if (item && item.stage === 'waiting' && !this.openQuestions(item, { blocking: true }).length) {
      this.move(item, 'ready', by);
    }
    if (decide) this.addNote(p, 'decision', `${q.question} → ${text}`, null, null, by);
  },

  confirm(p, { question }, by) {
    const q = this.q('SELECT * FROM questions WHERE id = ? AND project_id = ?').get(Number(question), p.id);
    if (!q) throw new UserError(`No question ${question}`, { status: 404 });
    this.q(`UPDATE questions SET status = 'confirmed', answered_by = ?, answered_at = ?, seen_by_asker = 0 WHERE id = ?`).run(by, this.now(), q.id);
    this.event(p, { item: this.itemById(q.item_id), actor: by, type: 'assumption_confirmed', headline: `${You(by)} confirmed ${q.asked_by}'s assumption: ${q.assumption}` });
  },

  accept(p, { item, note, attempt }, by) {
    const it = this.item(p, item);
    if (it.stage !== 'verifying') throw new UserError(`#${it.seq} is ${it.stage}, not verifying`, { status: 409 });
    return this.verdict(p, by, it, 'accept', { headline: str(note), attempt });
  },

  sendback(p, { item, note }, by) {
    const it = this.item(p, item);
    const { headline, summary } = layered(note, '', '', 'A reason for sending it back');
    if (!['verifying', 'landing', 'done'].includes(it.stage)) throw new UserError(`#${it.seq} is ${it.stage}`, { status: 409 });
    this.verdict(p, by, it, 'reject', { headline, summary });
  },

  steer(p, { item, body }, by) {
    this.addNote(p, 'steer', body, item ? this.item(p, item) : null, null, by);
  },

  decide(p, { body }, by) {
    this.addNote(p, 'decision', body, null, null, by);
  },

  retire(p, { note }, by) {
    const n = this.q('SELECT * FROM notes WHERE id = ? AND project_id = ?').get(Number(note), p.id);
    if (!n) throw new UserError(`No note ${note}`, { status: 404 });
    this.q('UPDATE notes SET active = 0 WHERE id = ?').run(n.id);
    this.event(p, { item: this.itemById(n.item_id), actor: by, type: 'retired', headline: `${You(by)} retired a ${n.kind === 'learning' ? 'field note' : n.kind}: ${clip(n.body, 100)}` });
  },

  comment(p, { item, body }, by) {
    const { headline, summary } = layered(body, '', '', 'comment');
    this.event(p, { item: item ? this.item(p, item) : null, actor: by, type: 'comment', headline, summary });
  },

  create(p, args, by) {
    return { item: `#${this.createItem(p, by, args).seq}` };
  },

  update(p, args, by) {
    const it = this.item(p, args.item);
    this.refineItem(p, by, it, args);
    if (args.stage && args.stage !== it.stage) {
      if (!['proposed', 'ready', 'dropped', 'done'].includes(args.stage)) throw new UserError(`You can move work to proposed, ready, done or dropped (not ${args.stage})`);
      const holders = [it.holder, ...(this.racing(it) ? this.attemptsOf(it).filter((a) => a.stage === 'active').map((a) => a.agent) : [])].filter(Boolean);
      this.move(it, args.stage, by, { holder: null, lease_until: null });
      const verb = { ready: 'moved', proposed: 'moved', done: 'marked', dropped: 'dropped' }[args.stage];
      this.event(p, { item: it, actor: by, type: 'staged', headline: `${You(by)} ${verb} #${it.seq}${args.stage !== 'dropped' ? ` to ${args.stage}` : ''}`, summary: str(args.note) });
      for (const holder of holders) this.addNote(p, 'steer', `#${it.seq} was ${args.stage === 'dropped' ? 'dropped' : `moved to ${args.stage}`} by the human; stop working on it.${args.note ? ` ${args.note}` : ''}`, null, holder, by);
    }
  },

  pick(p, { item }, by) {
    const it = this.item(p, item);
    if (!['proposed', 'ready'].includes(it.stage)) throw new UserError(`#${it.seq} is ${it.stage}`, { status: 409 });
    this.patch(it, { priority: 'now' });
    this.event(p, {
      item: it, actor: by, type: 'picked',
      headline: `${You(by)} picked #${it.seq} as what matters most: ${it.title}`,
      summary: it.stage === 'proposed' ? 'The next agent to check in will shape it first, then it gets built.' : 'It goes to the front of the queue.',
    });
  },

  // Who looks after this project: its "needs you" go to them. An empty list falls back to owners and stewards.
  stewards(p, { set }, by) {
    if (!Array.isArray(set)) throw new UserError('set is required: a list of people, e.g. ["@sam"]');
    const handles = [...new Set(set.map((h) => str(h).replace(/^@/, '').toLowerCase()).filter(Boolean))];
    for (const h of handles) {
      if (!this.q('SELECT 1 FROM people WHERE handle = ?').get(h)) throw new UserError(`No person @${h}`, { status: 404, hint: 'Add them first: nuworq person add <handle>.' });
    }
    this.q('DELETE FROM project_stewards WHERE project_id = ?').run(p.id);
    for (const h of handles) this.q('INSERT INTO project_stewards (project_id, handle) VALUES (?, ?)').run(p.id, h);
    this.event(p, {
      actor: by, type: 'stewards',
      headline: handles.length ? `${You(by)} made ${handles.map((h) => `@${h}`).join(', ')} steward${handles.length > 1 ? 's' : ''} of ${p.name}` : `${You(by)} cleared ${p.name}'s stewards`,
    });
  },

  remote(p, { add, remove }, by) {
    if (add) this.addRemote(p, add, by);
    if (remove) {
      const r = normRemote(remove);
      if (!this.q('DELETE FROM project_remotes WHERE project_id = ? AND remote = ?').run(p.id, r).changes) throw new UserError(`${p.name} has no remote ${r}`, { status: 404 });
      this.event(p, { actor: by, type: 'remote', headline: `${You(by)} unlinked ${r} from ${p.name}` });
    }
  },

  dismiss(p, { key }) {
    this.q('INSERT OR REPLACE INTO dismissals (project_id, key, at) VALUES (?, ?, ?)').run(p.id, str(key), this.now());
  },

  seen(p) {
    this.q('UPDATE projects SET seen_at = ? WHERE id = ?').run(this.now(), p.id);
  },

  settings(p, { name, mission, autonomy, parked, path, runner, github_secret }, by) {
    const changes = [];
    if (runner != null && !!runner !== !!p.runner) {
      this.q('UPDATE projects SET runner = ? WHERE id = ?').run(runner ? 1 : 0, p.id);
      this.event(p, { actor: by, type: 'runner', headline: runner ? `${You(by)} let \`nuworq run\` start workers here` : `${You(by)} stopped \`nuworq run\` starting workers here` });
    }
    if (github_secret != null && str(github_secret) !== p.github_secret) {
      this.q('UPDATE projects SET github_secret = ? WHERE id = ?').run(str(github_secret), p.id);
      this.event(p, { actor: by, type: 'github', headline: str(github_secret) ? `${You(by)} connected GitHub webhooks` : `${You(by)} disconnected GitHub webhooks` });
    }
    if (path != null && normDir(path) !== p.path) {
      this.q('UPDATE projects SET path = ? WHERE id = ?').run(normDir(path), p.id);
      this.event(p, { actor: by, type: 'path', headline: normDir(path) ? `${You(by)} set where ${p.name} lives: ${normDir(path)}` : `${You(by)} cleared where ${p.name} lives` });
    }
    if (parked != null && !!parked !== !!p.parked) {
      this.q('UPDATE projects SET parked = ? WHERE id = ?').run(parked ? 1 : 0, p.id);
      this.event(p, { actor: by, type: 'parked', headline: parked ? `${You(by)} parked the project` : `${You(by)} unparked the project` });
      if (parked) this.addNote(p, 'steer', 'The project is parked. Finish or hand off what you hold; start nothing new.', null, null, by);
    }
    if (name != null && str(name) && str(name) !== p.name) { this.q('UPDATE projects SET name = ? WHERE id = ?').run(str(name), p.id); changes.push('name'); }
    if (mission != null && str(mission) !== p.mission) { this.q('UPDATE projects SET mission = ? WHERE id = ?').run(str(mission), p.id); changes.push('mission'); }
    if (autonomy && autonomy !== p.autonomy) {
      if (!AUTONOMY[autonomy]) throw new UserError('autonomy must be ask, balanced or full');
      this.q('UPDATE projects SET autonomy = ? WHERE id = ?').run(autonomy, p.id);
      changes.push('autonomy');
      this.addNote(p, 'steer', `Autonomy is now "${AUTONOMY[autonomy].label}": ${AUTONOMY[autonomy].agent}`, null, null, by);
    }
    if (changes.includes('mission')) this.event(p, { actor: by, type: 'mission', headline: `${You(by)} updated the mission`, summary: str(mission) });
  },
};

Object.assign(Hub.prototype, {
  addNote(p, kind, body, item = null, target = null, author = HUMAN) {
    const text = str(body);
    if (!text) throw new UserError(`${kind} text is required`);
    const r = this.q('INSERT INTO notes (project_id, item_id, kind, target, author, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, item?.id ?? null, kind, target, author, text, this.now());
    this.event(p, {
      item, actor: author, type: kind,
      headline: kind === 'decision' ? `Decision: ${clip(text)}` : `${You(author)} steered${item ? ` #${item.seq}` : ''}: ${clip(text)}`,
      summary: text.includes('\n') || text.length > 120 ? text : '',
      data: { note: Number(r.lastInsertRowid) },
    });
    return Number(r.lastInsertRowid);
  },

  // by: who is acting. "you" without accounts; "@handle" for a person.
  humanOp(slug, action, args = {}, by = HUMAN) {
    const fn = HUMAN_OPS[action];
    if (!fn) throw new UserError(`Unknown action "${action}"`, { status: 404 });
    refuseSecrets(args);
    this.sweep();
    const p = this.project(slug, { create: action === 'create' && args.createProject });
    const result = this.tx(() => fn.call(this, p, args ?? {}, by)) ?? {};
    this.changed(p);
    return { ok: true, ...result };
  },
});

export const AGENT_OP_NAMES = Object.keys(AGENT_OPS);
export const HUMAN_OP_NAMES = Object.keys(HUMAN_OPS);
