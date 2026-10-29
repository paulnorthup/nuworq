// The hub's state and every operation agents and humans can perform.
// HTTP, MCP and the CLI are thin transports over this file.
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { openDb } from './db.js';
import { gitFacts, gitWarning, isRepo, baseOf, branchExists, headOf, contains, itemBranch, mirror, fetchMirror, mirrorPath, originOf, refetch } from './git.js';
import { findSecret } from './secrets.js';
import { normUsage, split } from './usage.js';
import { measure } from './llmproxy.js';
import { normPrecondition, describe as describePrecondition, WAIT_DAYS } from './precondition.js';
import { issuesOf, markDuplicate, markStale, staleAnswered, reporterIssue } from './issues.js';
import { prMerged, prSeen } from './github.js';

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
const GITHUB = 'github'; // holds accepted work while the hub opens its pull request
const PR_LEASE = 2 * MIN;
const PR_PASS = MIN; // how often the hub looks at landing work's pull requests itself (mergeReady)
const MIRROR_RETRY = 5 * MIN; // after GitHub refuses the app a token for a mirror, ask again this often
// The hub's own entries on the record: SYSTEM, GitHub's (webhooks, the pull requests it opens), or
// "trellis" in events recorded before the rename. None of them is an agent.
export const isSystem = (actor) => actor === SYSTEM || actor === GITHUB || actor === 'trellis';
// People act on the record as "@handle"; without accounts (local mode) the one human is "you".
export const isHuman = (actor) => actor === HUMAN || String(actor ?? '').startsWith('@');
const You = (by) => (by === HUMAN ? 'You' : by);

// Which human actions each person role may take. Reading is open to every role.
const MEMBER_CAN = ['comment', 'create', 'dismiss', 'seen'];
const STEWARD_CAN = [...MEMBER_CAN, 'answer', 'unpark', 'confirm', 'steer', 'decide', 'accept', 'sendback', 'update', 'pick', 'retire', 'check'];
export const PERSON_CAN = { viewer: [], member: MEMBER_CAN, steward: STEWARD_CAN, owner: [...STEWARD_CAN, 'settings', 'stewards', 'remote', 'archive', 'restore', 'delete'] };

// The lifecycle. "court" is whose move it is while work sits in that stage.
export const STAGES = {
  proposed:  { label: 'Proposed',  court: 'shaping', blurb: 'An idea someone (human or agent) thinks is worth doing. Agents claim proposals to shape them: they read the code, write what done means, and split big ideas. Then the work becomes Ready (or comes to you for approval).' },
  ready:     { label: 'Ready',     court: 'queue',   blurb: 'Shaped, with acceptance criteria. Any agent can pick it up.' },
  outside:   { label: 'Outside',   court: 'external', blurb: 'Shaped, but waiting on a fact outside this hub (an API that answers, a page that says it shipped). The hub checks it, backing off, and makes the work Ready when it passes.' },
  active:    { label: 'Active',    court: 'agents',  blurb: 'An agent holds a 20-minute lease and is working. Progress renews the lease; if the agent goes quiet, the work returns to Ready for someone else.' },
  waiting:   { label: 'Waiting',   court: 'you',     blurb: 'An agent hit a question only you can answer and parked the work (it took other work meanwhile). Your answer returns it to Ready.' },
  verifying: { label: 'Verifying', court: 'review',  blurb: 'The agent says it is done and attached evidence. Someone other than the implementer checks it.' },
  landing:   { label: 'Landing',   court: 'agents',  blurb: 'Accepted, and an agent is putting it on main: rebase onto the latest main, run the checks, fast-forward main. It is done when git shows main contains it.' },
  done:      { label: 'Done',      court: null,      blurb: 'Accepted.' },
  dropped:   { label: 'Dropped',   court: null,      blurb: 'Decided not to do. Kept for the record.' },
};
export const OPEN_STAGES = ['proposed', 'ready', 'outside', 'active', 'waiting', 'verifying', 'landing'];
// Events that mean an agent took a job: building (or a race slot), shaping, reviewing, landing.
export const CLAIM_TYPES = ['claimed', 'shaping', 'review_started', 'landing'];
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

// What an item waits on outside the hub, for agents and the UI: the condition, in words, and the last check. undefined: nothing.
export function preconditionOut(item) {
  if (!item.precondition) return undefined;
  const pre = JSON.parse(item.precondition), last = json(item.last_check, null);
  return { ...pre, waits_for: describePrecondition(pre), met: !!last?.ok, last_check: last ? { ok: last.ok, detail: last.detail, at: last.at } : null };
}
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

// What to give git clone for a normalized remote: https for host/owner/repo, a path as it is.
export function cloneUrl(remote) {
  return remote.startsWith('/') ? remote : `https://${remote}.git`;
}

export function slugify(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export class Hub extends EventEmitter {
  // repos: where the hub keeps mirrors of repositories it has no checkout of (null: it keeps none,
  // so git can't say anything about those projects). keys: per-repository deploy keys for fetching
  // them, <keys>/<host>/<owner>/<repo> (null: the default key only; see sshCommandFor in git.js).
  // hosted: one organization on a shared hub (workspaces mode): it reaches only repositories it was
  // granted, never a path on the hub's disk or the hub's own SSH identity (see mirror in git.js).
  constructor({ file = ':memory:', clock = () => Date.now(), repos = null, keys = null, hosted = false } = {}) {
    super();
    this.setMaxListeners(200);
    this.db = openDb(file);
    this.now = clock;
    this.repos = repos;
    this.keys = keys;
    this.hosted = hosted;
    this._stmts = new Map();
    this._unreachable = new Set(); // repositories the hub has said it can't reach
    // The app's read tokens for the hub's own mirrors, per remote: { token, expires_at } once minted,
    // { pending } while minting, { error, hint, at } when GitHub said no. Memory only, never the database.
    this._mirrorTokens = new Map();
    // github: opens pull requests and turns on auto-merge, as the GitHub App ({ covers, openPr, autoMerge, merge,
    // pull }; see prClient in src/ghapp.js). Set by the server when it has an app; tests set a fake. publicUrl:
    // links in PR bodies.
    this.github = null;
    this.publicUrl = '';
    this._opening = new Map(); // item id → the pull request being opened for it
    this._prPass = { at: 0, running: null }; // the periodic look at landing PRs (mergeReady)
    this._mergeFailed = new Map(); // item id → why GitHub last wouldn't merge its ready PR (on the record once)
    // llmProxy: where measured usage comes from ({ requests }; see proxyClient in src/llmproxy.js). Set by
    // `nuworq serve` from NUWORQ_LLM_PROXY_URL; tests set a fake. null: reported usage only.
    this.llmProxy = null;
    this._measuring = new Map(); // item id → its measurement in flight
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

  // The projects in use; archived ones only when asked for (they keep their history and can be restored).
  projects({ archived = false } = {}) {
    return this.q(`SELECT * FROM projects WHERE ${archived ? 'archived_at > 0' : 'archived_at = 0'} ORDER BY name COLLATE NOCASE`).all();
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
  // archived: also find an archived project (its repository still belongs to it until it is deleted).
  projectByRemote(remote, scope = null, { archived = false } = {}) {
    const r = normRemote(remote);
    const p = r ? this.q(`SELECT p.* FROM projects p JOIN project_remotes r ON r.project_id = p.id WHERE r.remote = ?${archived ? '' : ' AND p.archived_at = 0'}`).get(r) ?? null : null;
    return p && scope && !scope.includes(p.slug) ? null : p;
  }

  remotesOf(p) {
    return this.q('SELECT remote FROM project_remotes WHERE project_id = ? ORDER BY at').all(p.id).map((r) => r.remote);
  }

  // The repository an item lands in: its own, else the project's first. '' when the project has none.
  repoOf(p, item = null) {
    return item?.repo || this.remotesOf(p)[0] || '';
  }

  // Whether the project's checkout on this machine is where an item's work lands: always for an item
  // that names no repository (as before projects had several); otherwise only when the checkout's
  // origin is that repository (or, with no origin, when it is the project's first).
  localFor(p, item = null) {
    if (!isRepo(p.path)) return false;
    if (!item?.repo) return true;
    const origin = originOf(p.path);
    return origin ? normRemote(origin) === item.repo : item.repo === this.remotesOf(p)[0];
  }

  // Whether work lands through the item's remote (GitHub) instead of a checkout on this machine:
  // the hub has no checkout of it here, but knows the repository.
  remoteMode(p, item = null) {
    return !this.localFor(p, item) && !!this.repoOf(p, item);
  }

  // Whether accepted work lands through a pull request the hub opens with auto-merge on (#63): the item's
  // repository is on GitHub, the hub has no checkout of it, and it has a GitHub App to open the PR as.
  // Not while the App is known not to reach the repository (not installed there): the PR would only fail,
  // so the work lands by hand. An item whose PR is already open keeps it.
  prMode(p, item) {
    if (!this.github || !this.remoteMode(p, item)) return false;
    const repo = this.repoOf(p, item);
    if (!this.github.covers(repo)) return false;
    return !this.appTrouble(p, item) || !!this.q(`SELECT 1 FROM prs WHERE item_id = ? AND state = 'open'`).get(item.id);
  }

  // Why the GitHub App can't reach the item's repository right now (see mirrorTrouble), or null.
  appTrouble(p, item) {
    return this.github ? this.mirrorTrouble(this.repoOf(p, item)) : null;
  }

  // Open the pull request for accepted work. The item is held as 'github' meanwhile, so nobody gets a land
  // job for it; if the hub stops before it finishes, the lease lapses and it becomes an ordinary land job.
  openPr(p, item) {
    if (this._opening.has(item.id)) return;
    this.patch(item, { holder: GITHUB, lease_until: this.now() + PR_LEASE, touching: '[]' });
    let done;
    this._opening.set(item.id, new Promise((r) => (done = r)));
    setImmediate(() => openPr.call(this, p, item.id)
      .catch((e) => console.error('opening a pull request failed', e))
      .finally(() => { this._opening.delete(item.id); done(); }));
  }

  // Resolves once every pull request being opened is open (or has failed). For tests and shutdown.
  async prsSettled() {
    while (this._opening.size) await Promise.all(this._opening.values());
  }

  // The hub's own look at landing work's open pull requests, at most once a minute (the server's sweep calls
  // it): no webhook may reach the hub, and GitHub won't turn auto-merge on for a PR with nothing to wait for.
  // A PR that is ready with no auto-merge gets merged; one GitHub merged lands its item; one closed, or in
  // conflict with main, becomes a land job (prSeen in src/github.js). Resolves to how many it landed.
  mergeReady() {
    const pass = this._prPass;
    if (pass.running) return pass.running;
    if (!this.github?.pull || this.now() - pass.at < PR_PASS) return Promise.resolve(0);
    pass.at = this.now();
    return (pass.running = mergeReady.call(this).finally(() => { pass.running = null; }));
  }

  // The item's open pull request that conflicts with main (GitHub said so), or null.
  conflictedPr(item) {
    return this.q(`SELECT * FROM prs WHERE item_id = ? AND state = 'open' AND blocked = 'conflict'`).get(item.id) ?? null;
  }

  // Ask llm-proxy what the item cost, after this transaction: on submit and on landing. One at a time
  // per item; a later ask waits for the one in flight, so the newest windows win.
  measureUsage(item) {
    if (!this.llmProxy) return;
    const id = item.id;
    const run = (this._measuring.get(id) ?? Promise.resolve())
      .then(() => new Promise((r) => setImmediate(r)))
      .then(() => measure(this, id))
      .catch((e) => console.error('measuring usage from llm-proxy failed', e))
      .finally(() => { if (this._measuring.get(id) === run) this._measuring.delete(id); });
    this._measuring.set(id, run);
  }

  // Resolves once every measurement asked for has finished. For tests and shutdown.
  async measured() {
    while (this._measuring.size) await Promise.all(this._measuring.values());
  }

  // The hub tried to open a pull request since the item was last accepted, and couldn't: it lands by hand.
  prFailed(item) {
    const e = this.q(`SELECT type FROM events WHERE item_id = ? AND type IN ('accepted', 'pr_failed') ORDER BY at DESC, id DESC LIMIT 1`).get(item.id);
    return e?.type === 'pr_failed';
  }

  // A repository for an item: one of the project's remotes, in its normalized form. '' for none.
  checkRepo(p, repo) {
    const r = normRemote(repo);
    if (!r) return '';
    const all = this.remotesOf(p);
    if (!all.includes(r)) {
      throw new UserError(`${r} isn't one of ${p.name}'s repositories`, {
        hint: all.length ? `Use one of: ${all.join(', ')}. Or leave repo out to use ${all[0]}.` : `${p.name} has no repositories linked yet; leave repo out, or link one first (it is learned from an agent's checkin in a clone).`,
      });
    }
    return r;
  }

  // Where the hub asks git about an item's work (or the project's, with no item): the project's checkout
  // on this machine (local), else its own mirror of the item's remote (remote), as it is: it never waits
  // on the network. A stale mirror is fetched in the background, and the project hears when that changed
  // something. Decisions that need the newest state are prefetched by the server first (prefetch).
  // fresh: a mirror of a repository on this machine is fetched now. null when git can't say: no
  // repository, the remote can't be reached or read, or its first clone is still under way.
  repoFor(p, item = null, { fresh = false } = {}) {
    if (this.localFor(p, item)) return { path: p.path, mode: 'local' };
    const remote = this.repoOf(p, item);
    if (!remote || !this.repos) return null;
    const m = mirror(this.repos, remote, { fresh, keys: this.keys, https: this.mirrorHttps(remote), hosted: this.hosted, onFetched: () => this.remoteChanged(remote) });
    if (!m.error) return { path: m.path, mode: 'remote' };
    if (!m.pending && !this._unreachable.has(remote)) {
      this._unreachable.add(remote);
      console.error(`nuworq: can't read ${remote} for ${p.name} (${m.error}). Until it can, accepted work there waits in landing: the hub can't confirm main has it. Check the network and the hub's access to the repository (the hub's GitHub App installed on it, or a read-only deploy key${this.keys && !remote.startsWith('/') ? `, as ${this.keys}/${remote}` : ''}).`);
    }
    return null;
  }

  // Fetch the mirror an op is about to decide on (accept, submit, review), so it reads the newest state.
  // The server awaits this before the op, outside any transaction; nothing else waits on the network.
  // Best effort: an unknown project or item, or a fetch that fails, leaves the op to say so as before.
  async prefetch(slug, args = {}, { remote = '', root = '', scope = null } = {}) {
    if (!this.repos) return;
    try {
      const p = slug ? this.project(slug) : this.projectByRemote(normRemote(remote), scope) ?? this.projectByPath(root, scope);
      const item = p && args.item ? this.item(p, args.item) : null;
      if (!p || this.localFor(p, item)) return;
      const repo = this.repoOf(p, item);
      if (!repo) return;
      // A read token being minted is worth the wait: without it the fetch goes over SSH.
      if (this.github?.readToken && this.github.covers(repo)) {
        this.mirrorHttps(repo);
        await this._mirrorTokens.get(repo)?.pending;
      }
      const r = await fetchMirror(this.repos, repo, { keys: this.keys, https: this.mirrorHttps(repo), hosted: this.hosted });
      if (r.changed) this.remoteChanged(repo);
    } catch { /* the op says what's wrong */ }
  }

  // The plan's limit on agents working at once (planLimit, set per organization by Workspaces; null or
  // unset: no limit). Enforced where work is claimed: the hub holds every lease, so an agent that would be
  // one too many is refused, and the ones already working carry on.
  checkPlan(agent) {
    const limit = this.planLimit?.();
    if (!limit) return;
    const working = new Set([
      ...this.q(`SELECT DISTINCT holder FROM items WHERE holder IS NOT NULL AND holder != ?`).all(GITHUB).map((r) => r.holder),
      ...this.q(`SELECT DISTINCT agent FROM attempts WHERE stage = 'active' AND closed = 0`).all().map((r) => r.agent),
    ]);
    if (working.has(agent) || working.size < limit) return;
    throw new UserError(`The Free plan runs ${limit} agent at a time, and ${[...working].join(', ')} is working now`, {
      status: 402,
      hint: `Your work waits until ${[...working][0]} finishes or hands off; then call next again. To run agents side by side, upgrade the organization to Pro.`,
    });
  }

  // How the hub reaches remote's mirror over HTTPS with the GitHub App: { url, token }, or null to use
  // SSH and deploy keys as before (no app, not a GitHub repository, GitHub said no, or no token yet).
  // repoFor is synchronous and minting isn't, so this uses a token already minted, reused until 5
  // minutes before it expires, and starts minting the next one; the fetch after it lands uses it.
  mirrorHttps(remote) {
    const gh = this.github;
    if (!gh?.readToken || !gh.covers(remote)) return null;
    const have = this._mirrorTokens.get(remote), t = Date.now();
    const good = have?.token && Date.parse(have.expires_at) - 5 * 60_000 > t;
    // After a refusal, ask again every few minutes: someone may have installed the app since.
    if (!good && !have?.pending && !(have?.error && t - have.at < MIRROR_RETRY)) this.mintMirrorToken(remote);
    return good ? { url: `${gh.web ?? 'https://github.com'}/${remote.split('/').slice(1).join('/')}.git`, token: have.token } : null;
  }

  mintMirrorToken(remote) {
    const was = this._mirrorTokens.get(remote);
    const pending = this.github.readToken(remote).then(
      ({ token, expires_at }) => {
        this._mirrorTokens.set(remote, { token, expires_at });
        // Fetch with it at the next ask, and say again if even that can't read the repository.
        refetch(this.repos, remote);
        this._unreachable.delete(remote);
        if (was?.error) this.remoteChanged(remote);
      },
      (e) => {
        const same = was?.error === e.message;
        this._mirrorTokens.set(remote, { error: e.message, hint: e.hint ?? '', at: Date.now(), since: same ? was.since : this.now() });
        if (!same) this.remoteChanged(remote);
      });
    this._mirrorTokens.set(remote, { ...(was ?? {}), pending });
    return pending;
  }

  // Mint ahead the mirror tokens that are due (or retry refusals), so fetches rarely wait a turn on SSH. On a timer.
  refreshMirrorTokens() {
    for (const remote of this._mirrorTokens.keys()) this.mirrorHttps(remote);
  }

  // Why the GitHub App can't read remote for the hub ({ error, hint, since }), or null.
  mirrorTrouble(remote) {
    const have = this._mirrorTokens.get(remote);
    return have?.error ? { error: have.error, hint: have.hint, since: have.since } : null;
  }

  remoteChanged(remote) {
    for (const p of this.projects()) if (this.remotesOf(p).includes(remote)) this.changed(p);
  }

  // The branch work lands on, as far as git can say: main, else master; main when it can't.
  baseFor(p, item = null) {
    const repo = this.repoFor(p, item);
    return (repo && baseOf(repo.path)) ?? 'main';
  }

  addRemote(p, remote, actor) {
    const r = normRemote(remote);
    if (!r) throw new UserError('a remote is required', { hint: 'e.g. github.com/acme/api, or any form git accepts (git@github.com:acme/api.git).' });
    if (this.hosted && r.startsWith('/')) {
      throw new UserError(`${r} is a path on the hub's machine; an organization on a shared hub links repositories by address`, { hint: 'Use the repository\'s address, e.g. github.com/acme/api.' });
    }
    const owner = this.projectByRemote(r, null, { archived: true });
    if (owner?.id === p.id) return r;
    if (owner) {
      throw new UserError(`${r} already belongs to ${owner.name}${owner.archived_at ? ' (archived)' : ''}`, {
        status: 409, hint: owner.archived_at ? `Restore ${owner.name}, or delete it for good, to use ${r} again.` : `Remove it from ${owner.name} first: one repository maps to one project.`,
      });
    }
    // On the Free plan, a repository belongs to one free organization (repoGuard, set by Workspaces).
    const other = this.repoGuard?.(r);
    if (other) {
      throw new UserError(`${r} is already in the free organization ${other}; a repository can be in one free organization`, {
        status: 402, hint: `Work on it in ${other}, or upgrade this organization to Pro to use it here too.`,
      });
    }
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
      project: o.p.slug, name: o.p.name, path: o.p.path || null, repo: this.repoOf(o.p, o.item) || null,
      mode: o.mode, item: `#${o.item.seq}`, title: o.item.title, priority: o.item.priority,
      waiting: dur(this.now() - o.item.stage_since), claimable: o.claimable,
      slots: this.racing(o.item) ? this.openSlots(o.item) : undefined, // a race with open slots can take that many workers
      // Who is on work here: holders, and racers (whose leases live in attempts).
      ...(runner ? { holders: this.q(`SELECT holder FROM items WHERE project_id = ? AND holder IS NOT NULL
          UNION SELECT a.agent FROM attempts a JOIN items i ON i.id = a.item_id WHERE i.project_id = ? AND a.stage = 'active' AND a.closed = 0`)
        .all(o.p.id, o.p.id).map((h) => h.holder) } : {}),
    }));
  }

  // How many jobs an agent took since a moment, across the projects a token may reach: tells
  // `nuworq run` whether a worker that exited quickly did anything, even between its polls.
  claimsSince(agent, since, { scope = null } = {}) {
    let n = 0;
    for (const p of this.projects()) {
      if (scope && !scope.includes(p.slug)) continue;
      n += this.q(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND actor = ? AND at >= ?
          AND type IN (${CLAIM_TYPES.map(() => '?').join(',')})`).get(p.id, agent, since, ...CLAIM_TYPES).n;
    }
    return n;
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
    // Work waiting on an outside fact the hub hasn't seen yet isn't ready, whichever way it got here. One
    // only a person can vouch for waits on them, as a question.
    const unmet = stage === 'ready' && this.unmetPrecondition(item);
    if (unmet) stage = unmet.kind === 'ask' ? 'waiting' : 'outside';
    const t = this.now();
    const fields = { ...patch, stage, stage_since: t, updated_at: t };
    if (stage !== 'waiting' && item.parked_by) fields.parked_by = ''; // out of waiting: no longer kept parked
    const keys = Object.keys(fields);
    this.q(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), item.id);
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    // Leaving the race (back to the queue, done, dropped) closes this round's attempts, whatever the race
    // count is now: it may have been changed while the item was verifying.
    if (!['active', 'verifying'].includes(stage)) this.q('UPDATE attempts SET closed = 1 WHERE item_id = ? AND closed = 0').run(item.id);    Object.assign(item, fields);
    if (['verifying', 'done'].includes(stage)) this.measureUsage(item);
    if (unmet?.kind === 'ask') this.askPrecondition(item, actor);
  }

  // The item's precondition (src/precondition.js), unless none or it has passed.
  unmetPrecondition(item) {
    return item.precondition && !json(item.last_check, {}).ok ? JSON.parse(item.precondition) : null;
  }

  // An 'ask' precondition becomes a blocking question to the human, once; its last check points at it, so
  // answering it is what passes the precondition.
  askPrecondition(item, actor) {
    const pre = this.unmetPrecondition(item);
    const asked = json(item.last_check, {}).question;
    if (pre?.kind !== 'ask' || (asked && this.q(`SELECT 1 FROM questions WHERE id = ? AND status = 'open'`).get(asked))) return;
    const p = this.q('SELECT * FROM projects WHERE id = ?').get(item.project_id);
    const t = this.now();
    const r = this.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, detail, options, blocking, assumption, at)
      VALUES (?, ?, ?, ?, ?, '', '[]', 1, '', ?)`).run(p.id, item.id, actor, pre.question, `#${item.seq} waits on this before any agent starts it. Answering makes it ready.`, t);
    const id = Number(r.lastInsertRowid);
    this.patch(item, { last_check: JSON.stringify({ at: t, ok: false, detail: 'asked you', question: id }) });
    this.event(p, { item, actor, type: 'question', headline: `#${item.seq} waits on you: ${pre.question}`, data: { question: id } });
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
  // Where llm-proxy measured an agent's traffic, that agent's reported rows are kept but superseded:
  // out of the totals, so nothing counts twice.
  usageOf(item) {
    const all = this.q(`SELECT agent, model, source, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cost_usd) AS cost_usd, COUNT(cost_usd) = COUNT(*) AS priced,
        SUM(duration_ms) AS duration_ms, SUM(requests) AS requests, SUM(failures) AS failures, SUM(cold_loads) AS cold_loads
      FROM usage WHERE item_id = ? GROUP BY agent, model, source ORDER BY MIN(at)`).all(item.id);
    if (!all.length) return null;
    const measured = new Set(all.filter((r) => r.source === 'llm-proxy').map((r) => r.agent));
    const rows = all.map(({ priced, duration_ms, requests, failures, cold_loads, ...r }) => ({
      ...r, cost_usd: priced ? r.cost_usd : null,
      ...(r.source === 'llm-proxy' ? { duration_ms, requests, failures, cold_loads } : measured.has(r.agent) ? { superseded: true } : {}),
    }));
    const counted = rows.filter((r) => !r.superseded);
    const sum = (k) => counted.reduce((a, r) => a + (r[k] ?? 0), 0);
    return {
      rows,
      total: {
        input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
        cost_usd: counted.some((r) => r.cost_usd != null) ? sum('cost_usd') : null,
        ...(measured.size ? { duration_ms: sum('duration_ms'), requests: sum('requests'), failures: sum('failures'), cold_loads: sum('cold_loads') } : {}),
      },
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
        missing: data.git?.missing?.length ? data.git.missing : undefined, git_warning: gitWarning(data.git) ?? undefined,
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
      const repo = landed.length ? this.repoFor(p, item) : null;
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
        AND type IN ('handoff','sent_back','lease_expired','answered','assumption_confirmed','submitted','shaped','picked','comment','steer','refined',
          'accepted','pr_failed','pr_blocked','rebased','issue_close_failed')
        ORDER BY at DESC LIMIT 8`).all(item.id).reverse();
    const questions = this.q('SELECT * FROM questions WHERE item_id = ? ORDER BY at').all(item.id);
    const steers = this.q(`SELECT n.* FROM notes n WHERE n.item_id = ? AND n.kind = 'steer' AND n.active = 1
        AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.note_id = n.id AND a.agent = ?) ORDER BY n.at`).all(item.id, agent ?? '');
    const handoff = json(item.handoff, null);
    const lease = this.leaseOf(item, agent);
    const touching = this.touchingOf(item, agent);
    const steerers = this.steerersOf(item);
    const racers = item.race > 1 ? this.attemptsOf(item) : [];
    // What git found at submit, for the reviewer (a race shows it per submission instead).
    const g = item.stage === 'verifying' && item.race <= 1 ? this.submittedGit(item) : null;
    return {
      item: `#${item.seq}`,
      title: item.title,
      stage: item.stage,
      priority: item.priority,
      needs: json(item.needs, []).length ? json(item.needs, []) : undefined,
      size: item.size || undefined,
      summary: item.summary || undefined,
      detail: item.detail || undefined,
      precondition: preconditionOut(item),
      done_means: item.acceptance || 'No acceptance criteria yet. Write them with refine before you submit, so a reviewer knows what to check.',
      issue: this.q('SELECT url FROM issues WHERE item_id = ?').get(item.id)?.url || undefined, // the GitHub issue it came from
      repo: this.repoOf(p, item) || undefined,
      branch: item.branch || undefined,
      git: g ? { branch: g.branch, base: g.base, commits: g.commits, missing: g.missing } : undefined,
      git_warning: gitWarning(g) ?? undefined,
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
      if (p.archived_at) throw new UserError(`${p.name} is archived`, { status: 410, hint: 'Nothing is worked on there until an owner restores it. Check in without a project to be sent to work that is waiting.' });
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
    // Learn where the project lives the first time an agent names it from a folder, but only a folder
    // that is a clone of the project's repository: a worker started in the wrong repo must not teach it.
    const knownRemotes = this.remotesOf(p);
    if (slug && here && !p.path && op === 'checkin' && (!knownRemotes.length || knownRemotes.includes(remote))) {
      this.q('UPDATE projects SET path = ? WHERE id = ?').run(here, p.id);
      p.path = here;
      this.event(p, { actor: SYSTEM, type: 'path', headline: `${p.name} lives in ${here}`, summary: `Learned from ${agent}'s checkin. Agents working in that folder now find this project on their own.` });
    }
    // Learn the repository the same way, unless it already belongs to another project.
    // (Not one another free organization has: the checkin goes on, the repository stays unlinked here.)
    if (slug && remote && op === 'checkin' && !(this.hosted && remote.startsWith('/')) && !this.projectByRemote(remote, null, { archived: true }) && !this.repoGuard?.(remote)) this.addRemote(p, remote, agent);
    // A clone of the project's repository is the right place to work, wherever it sits on disk.
    const ownClone = !!remote && this.projectByRemote(remote)?.id === p.id;
    const result = this.tx(() => {
      // The runner posts a worker's usage after it exited: that's bookkeeping, not the agent being here.
      const presence = op === 'usage' ? null : this.touchAgent(p, agent, op === 'checkin' ? args : { model: args.model, client: args.client });
      this.noteToken(p, agent, token?.name);
      if (token?.role === 'agent') this.q('UPDATE agents SET token_id = ? WHERE project_id = ? AND name = ?').run(token.id, p.id, agent);
      const need = powers && this.powerFor(p, op, args ?? {});
      if (need && !powers.includes(need)) {
        throw new UserError(`This agent's token can't ${need} (its powers: ${powers.join(', ')})`, {
          status: 403, hint: `Call next: it only offers work this token may do. A token with ${need} comes from: nuworq token create <name> --powers ${need}.`,
        });
      }
      if (op === 'claim' || (op === 'next' && args?.claim !== false)) this.checkPlan(agent);
      this.caller = { powers, remote };
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
      const repo = this.repoFor(p, this.itemById(check.about), { fresh: true });
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
  pick(p, agent, { powers = null, has, repo = '' } = {}) {
    return this.claimable(p, agent, { powers, has, repo })[0] ?? null;
  }

  // Items this agent handed off within the cooldown, by id.
  handedOff(p, agent) {
    if (!agent) return new Set();
    return new Set(this.q(`SELECT DISTINCT item_id FROM events WHERE project_id = ? AND actor = ? AND type = 'handoff' AND at > ?`)
      .all(p.id, agent, this.now() - HANDOFF_COOLDOWN).map((r) => r.item_id));
  }

  // Everything this agent could claim here, most useful first. Not what it just handed off, not a race
  // it already ran in, not work its token's powers don't cover, and not work needing what its machine lacks.
  // repo: the repository the agent is in (its clone's origin). When it is one of the project's, only work
  // in that repository: the rest is left for agents in clones of the others.
  claimable(p, agent, { powers = null, has, repo = '' } = {}) {
    const may = (power) => !powers || powers.includes(power);
    const fit = this.fit(p, agent, has);
    const inRepo = repo && this.remotesOf(p).includes(repo) ? (i) => this.repoOf(p, i) === repo : () => true;
    const ok = (i) => (!fit.has || json(i.needs, []).every((t) => fit.has.includes(t))) && inRepo(i);
    const gave = this.handedOff(p, agent);
    const fresh = (i) => !gave.has(i.id) && ok(i); // not just handed off, doable on this machine, in this clone
    const reviews = p.autonomy !== 'full' || !may('review') ? [] : this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'verifying' AND holder IS NULL
        AND COALESCE(implementer, '') != ?
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = items.id AND a.agent = ? AND a.stage = 'submitted' AND a.closed = 0)
      ORDER BY stage_since`).all(p.id, agent, agent).filter(fresh).map((item) => ({ mode: 'review', item }));
    // Accepted work waiting to land: its builder first, then anyone after LAND_GRACE. Landing even in a
    // parked project: it finishes work, it doesn't start any.
    // An open pull request lands it: GitHub's merge marks it done. Unless it conflicts with main: then an
    // agent rebases it, and the PR's auto-merge carries on.
    const lands = !may('build') ? [] : this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'landing' AND holder IS NULL
        AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.item_id = items.id AND prs.state = 'open' AND prs.blocked != 'conflict') ORDER BY stage_since`).all(p.id)
      .filter((i) => !gave.has(i.id) && inRepo(i) && (i.implementer === agent || this.now() - i.stage_since >= LAND_GRACE))
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
    if (item.stage === 'outside') {
      const last = json(item.last_check, null);
      throw new UserError(`#${item.seq} waits on something outside this hub: ${describePrecondition(JSON.parse(item.precondition))}${last ? ` (last check: ${last.detail})` : ' (not checked yet)'}`, { status: 409, hint: 'The hub checks it and makes the work ready when it passes. Pick other work with next.' });
    }
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
  toLand(p, item, branch, { fresh = false } = {}) {
    const repo = branch ? this.repoFor(p, item, { fresh }) : null;
    if (!repo || !branchExists(repo.path, branch)) return null;
    const base = baseOf(repo.path);
    if (!base) return null;
    return { base, pending: !contains(repo.path, base, branch), head: headOf(repo.path, base) };
  }

  // The land job's hint: the base as git says it, and a push first when the hub can't see the branch.
  landHint(p, item) {
    const remote = this.remoteMode(p, item);
    const repo = this.repoFor(p, item);
    const base = (repo && baseOf(repo.path)) ?? 'main';
    const unseen = remote && !!item.branch && !(repo && branchExists(repo.path, item.branch));
    const where = this.remotesOf(p).length > 1 ? `This is in ${this.repoOf(p, item)}. ` : '';
    if (this.prMode(p, item)) {
      const pr = this.conflictedPr(item);
      if (pr) return where + PR_REBASE_HINT(item, pr, base);
      if (unseen) return where + PR_LAND_HINT(item);
      if (this.prFailed(item)) return `${where}The hub couldn't open a pull request for it (see its history), so land it by hand. ${LAND_HINT(item, p, base, remote)}`;
      const open = this.q(`SELECT number FROM prs WHERE item_id = ? AND state = 'open'`).get(item.id);
      if (open) return `${where}PR #${open.number} is open with auto-merge on: GitHub merges it once its checks pass, and that marks #${item.seq} done. Nothing to push.`;
      // On origin with no pull request yet (the hub stopped while opening it): submit, and the hub opens it.
      return where + PR_OPEN_HINT(item);
    }
    const trouble = this.appTrouble(p, item);
    if (trouble) return `${where}It lands by hand: the hub can't open a pull request because ${trouble.error.replace(/^The /, 'the ')}. ${LAND_HINT(item, p, base, remote, unseen)}`;
    return where + LAND_HINT(item, p, base, remote, unseen);
  }

  // The work job's hint: where to cut the branch, in the item's repo and from its base.
  // An agent that isn't in a clone at all (no remote came with its call) is told to clone the item's first.
  workHint(p, item) {
    const remote = this.remoteMode(p, item);
    const repo = this.remotesOf(p).length > 1 ? this.repoOf(p, item) : '';
    const clone = remote && item.branch && this.caller && !this.caller.remote
      ? `You aren't in a clone of ${this.repoOf(p, item)}: clone it first (git clone ${cloneUrl(this.repoOf(p, item))}) and work in that clone. `
      : '';
    return clone + WORK_HINT(item, p, remote, this.baseFor(p, item), repo);
  }

  // The branch git found for the latest submission, when the item has none of its own (older work).
  submittedBranch(item) {
    return this.submittedGit(item)?.branch ?? '';
  }

  // What git found when the latest submission came in (#24), or null.
  submittedGit(item) {
    const e = this.q(`SELECT data FROM events WHERE item_id = ? AND type = 'submitted' ORDER BY at DESC LIMIT 1`).get(item.id);
    return json(e?.data, {}).git ?? null;
  }

  // A reviewer's hint, led by anything git found wrong with the submission.
  reviewHint(item, hint) {
    const warn = item.race > 1 ? null : gitWarning(this.submittedGit(item));
    return warn ? `${warn}: check it before you accept. ${hint}` : hint;
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
// repos: the project's repositories; with several, each item lands in one of them.
const SHAPE_HINT = (item, p, repos = []) => [
  `You're shaping #${item.seq}, not building it yet. You hold it for ${dur(LEASE_MS)}.`,
  'Read the relevant code, then refine it: a sharp title and summary, and acceptance criteria (checkable, so a reviewer knows what done means).',
  `If it's big, split it: propose sub-items with parent #${item.seq}, each with acceptance criteria. #${item.seq} then waits for them.`,
  repos.length > 1 ? `Each item lands in one repository (${repos.join(', ')}): set repo when you refine or propose. Work that spans repositories becomes one sub-item per repository, with depends_on giving the order (e.g. the API before the client that calls it).` : '',
  'If the intent is unclear, ask with an assumption.',
  `Finish with submit (headline: the shape you chose). ${p.autonomy === 'ask' ? 'The human then approves it.' : 'It becomes ready for any agent, including you.'}`,
].filter(Boolean).join(' ');

// Every claim says where to work: the item's own branch, in a worktree, never the main checkout.
// remote: the hub has no checkout here, so the branch is cut from origin and pushed there for review.
// base: the branch it lands on, in the item's repo. repo: named when the project has several.
const WORK_HINT = (item, p, remote = false, base = 'main', repo = '') => !item.branch ? ''
  : remote
    ? `${repo ? `This is in ${repo}: work in a clone of it. ` : ''}Work on branch ${item.branch}, cut from the latest ${base} on origin: git fetch origin, then git switch -c ${item.branch} origin/${base} (or git switch ${item.branch} if it exists). Work in a git worktree or a clone of your own, not a checkout another agent is using. Commit as you go. Before you submit, push the branch (git push origin ${item.branch}) so reviewers anywhere can see it.`
    : `${repo ? `This is in ${repo}. ` : ''}Work on branch ${item.branch}, cut from the latest ${base}: git switch -c ${item.branch} ${base} (or git switch ${item.branch} if it exists). Work in a git worktree, never in ${p.path || 'the main checkout'} itself: it stays on ${base} so work can land there. Commit as you go.`;
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

// Remote work that lands through a pull request: the lander only pushes; the hub opens the PR.
const PR_LAND_HINT = (item) => `Push it: git push origin ${item.branch} (the hub can't see it on origin yet). Then submit #${item.seq}: the hub opens a pull request with auto-merge on, and GitHub's merge marks it done.`;
const PR_OPEN_HINT = (item) => `${item.branch} is on origin but has no pull request yet. Submit #${item.seq}: the hub opens one with auto-merge on, and GitHub's merge marks it done. Don't push to main yourself.`;

// Its pull request conflicts with main: rebase the branch and push it again; the PR and its auto-merge stay.
const PR_REBASE_HINT = (item, pr, base = 'main') => [
  `PR #${pr.number} for #${item.seq} conflicts with ${base} (${pr.url}). Rebase it; the pull request and its auto-merge stay as they are.`,
  `1. git fetch origin, then git switch ${item.branch}, then git rebase origin/${base}. Resolve conflicts keeping both intents. If resolving changed what the reviewer approved, submit with conflicts (what you changed and why) instead, and it goes back for review.`,
  `2. Run the project's checks (e.g. npm test).`,
  `3. git push origin ${item.branch} --force-with-lease.`,
  `4. submit #${item.seq}. GitHub merges the PR once its checks pass, and the hub marks it done.`,
].join(' ');

// What a pull request the hub opens says: the item, who built and reviewed it, and the evidence.
function prBody(p, item) {
  const link = this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/#/p/${encodeURIComponent(p.slug)}/${item.seq}` : '';
  const last = (type) => this.q('SELECT * FROM events WHERE item_id = ? AND type = ? ORDER BY at DESC, id DESC LIMIT 1').get(item.id, type);
  const accepted = last('accepted'), submitted = last('submitted');
  const builder = item.implementer || submitted?.actor || '';
  const model = builder ? this.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, builder)?.model ?? '' : '';
  const evidence = json(submitted?.data, {}).evidence ?? [];
  // The issues it closes on merge: every open GitHub issue linked to it (its import, merged duplicates) in this repository.
  const fixes = this.q(`SELECT number FROM issues WHERE item_id = ? AND repo = ? AND state = 'open' ORDER BY number`).all(item.id, this.repoOf(p, item)).map((r) => r.number);
  return [
    `nuworq #${item.seq}: ${item.title}${link ? `\n${link}` : ''}`,
    [builder && `Built by ${builder}${model ? ` (${model})` : ''}`, accepted && `reviewed by ${accepted.actor}`].filter(Boolean).join(', ') + '.',
    item.summary,
    evidence.length ? `Evidence:\n${evidence.map((e) => `- ${e.label}${e.url ? ` (${e.url})` : ''}`).join('\n')}` : '',
    fixes.map((n) => `Fixes #${n}`).join('\n'),
  ].filter((s) => s && s !== '.').join('\n\n');
}

// Opens the pull request for accepted work, with auto-merge (squash) on, and links it to the item.
// A failure goes on the record and the item becomes an ordinary land job. A PR with nothing to wait for (no
// required checks, or they already passed) gets no auto-merge from GitHub: the hub squash-merges it at once,
// and that lands the item as GitHub's merged webhook would.
async function openPr(p, id) {
  let item = this.itemById(id);
  if (item.stage !== 'landing') return;
  const release = () => { const it = this.itemById(id); if (it.holder === GITHUB) this.patch(it, { holder: null, lease_until: null }); };
  const repo = this.repoOf(p, item), base = this.baseFor(p, item);
  if (this.q(`SELECT 1 FROM prs WHERE item_id = ? AND state = 'open'`).get(id)) return release(); // accepted again: it has one
  let pr, auto, noAuto = '', merged = null, noMerge = '';
  try {
    pr = await this.github.openPr({ repo, head: item.branch, base, title: item.title, body: prBody.call(this, p, item) });
  } catch (e) {
    this.tx(() => {
      release();
      this.event(p, {
        item, actor: SYSTEM, type: 'pr_failed', headline: `The hub couldn't open a pull request for #${item.seq}: ${clip(e.message)}`,
        summary: 'An agent lands it by hand: the next land job has the steps.', data: { repo, branch: item.branch },
      });
    });
    return this.changed(p);
  }
  try { auto = await this.github.autoMerge({ repo, number: pr.number, id: pr.node_id }); } catch (e) { noAuto = e.message; }
  if (auto?.ready) {
    try { merged = await this.github.merge({ repo, number: pr.number }); } catch (e) { noMerge = e.message; }
  }
  let row;
  this.tx(() => {
    item = this.itemById(id);
    this.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
        ON CONFLICT (project_id, repo, number) DO UPDATE SET item_id = excluded.item_id, url = excluded.url, state = 'open', updated_at = excluded.updated_at`)
      .run(p.id, repo, pr.number, id, pr.url ?? '', item.title, pr.head_ref ?? item.branch, pr.head_sha ?? '', this.now());
    row = this.q('SELECT * FROM prs WHERE project_id = ? AND repo = ? AND number = ?').get(p.id, repo, pr.number);
    release();
    this.event(p, {
      item, actor: SYSTEM, type: 'pr',
      headline: `Opened PR #${pr.number} for #${item.seq}${merged ? '; it had nothing to wait for, so the hub squash-merged it'
        : noAuto || noMerge ? '' : '; GitHub squash-merges it when its checks pass'}`,
      summary: noAuto ? `Auto-merge couldn't be turned on (${clip(noAuto)}): merge it on GitHub, and the hub marks #${item.seq} done.` : '',
      data: { url: pr.url, repo, number: pr.number, state: 'open', auto_merge: !noAuto && !auto?.ready },
    });
    if (merged) prMerged(this, p, row, { ...merged, base });
  });
  if (noMerge) mergeFailed.call(this, p, row, noMerge);
  this.changed(p);
}

// One pass of mergeReady: each landing item's open pull request, as GitHub has it now.
async function mergeReady() {
  const rows = this.q(`SELECT prs.* FROM prs JOIN items i ON i.id = prs.item_id WHERE prs.state = 'open' AND i.stage = 'landing' ORDER BY prs.updated_at`).all();
  let landed = 0;
  for (const row of rows.filter((r) => this.github.covers(r.repo))) {
    let pr;
    try { pr = await this.github.pull({ repo: row.repo, number: row.number }); } catch { continue; } // GitHub didn't answer: the next pass asks again
    const p = this.q('SELECT * FROM projects WHERE id = ?').get(row.project_id);
    if (!p) continue;
    // Ready with no auto-merge to wait for (opened before the hub merged those, or auto-merge is off).
    if (pr.state === 'open' && pr.mergeable_state === 'clean' && !pr.auto_merge) {
      try {
        pr = { ...pr, ...await this.github.merge({ repo: row.repo, number: row.number }), state: 'merged' };
        this._mergeFailed.delete(row.item_id);
      } catch (e) {
        mergeFailed.call(this, p, row, e.message);
        continue;
      }
    }
    if (!this.tx(() => prSeen(this, p, row, pr))) continue;
    if (this.itemById(row.item_id)?.stage === 'done') landed++;
    this.changed(p);
  }
  return landed;
}

// GitHub wouldn't merge a ready pull request: the reason goes on the record once (until it changes), and the
// next pass of mergeReady tries again. The item stays in landing.
function mergeFailed(p, row, why) {
  const item = this.itemById(row.item_id);
  if (!item || this._mergeFailed.get(row.item_id) === why) return;
  this._mergeFailed.set(row.item_id, why);
  this.tx(() => this.event(p, {
    item, actor: SYSTEM, type: 'pr_merge_failed', headline: `The hub couldn't merge PR #${row.number} for #${item.seq}, which is ready: ${clip(why)}`,
    summary: `It tries again within a minute; or merge it on GitHub, and the hub marks #${item.seq} done.`,
    data: { url: row.url, number: row.number, error: why },
  }));
  this.changed(p);
}

// Submit on a land job: done when git shows main has the branch; back to review when the rebase changed it.
function finishLanding(p, agent, item, { headline, summary, detail, conflicts }) {
  const reviewer = p.autonomy === 'full' ? 'Another agent reviews it again' : 'The human verifies it again';
  if (conflicts) {
    this.move(item, 'verifying', agent, { holder: null, lease_until: null, last_worker: agent });
    this.event(p, { item, actor: agent, type: 'rebased', headline: `${agent} rebased #${item.seq} and had to resolve conflicts; it needs another look`, summary: conflicts, detail });
    this.setStatus(p, agent, `Sent #${item.seq} back for review after a rebase`);
    return { ok: true, hint: `#${item.seq} is verifying again with your note on the conflicts. ${reviewer}, then it lands. Call next.` };
  }
  const land = this.toLand(p, item, item.branch, { fresh: true });
  const remote = this.remoteMode(p, item);
  if (!land) {
    throw new UserError(`The hub can't see ${item.branch || 'a branch for this item'} in ${remote ? this.repoOf(p, item) : p.path || 'a repository it can reach'}`, {
      status: 409,
      hint: remote
        ? `Push it (git push origin ${item.branch} --force-with-lease) and submit again. If you have, the hub may not reach the repository right now: try again in a minute. Keep the branch until the hub confirms the landing.`
        : 'Keep the branch until the hub confirms the landing. If the work is on another branch, say which in a comment and handoff.',
    });
  }
  // Rebased for a pull request that conflicted: the branch on origin must now contain main. The PR stays.
  const conflicted = land.pending && this.prMode(p, item) && this.conflictedPr(item);
  if (conflicted) {
    const repo = this.repoFor(p, item);
    if (!contains(repo.path, item.branch, land.base)) {
      throw new UserError(`${item.branch} on origin doesn't contain ${land.base} yet`, { status: 409, hint: PR_REBASE_HINT(item, conflicted, land.base) });
    }
    this.q(`UPDATE prs SET blocked = '' WHERE item_id = ? AND state = 'open'`).run(item.id);
    this.patch(item, { holder: null, lease_until: null });
    this.event(p, { item, actor: agent, type: 'rebased', headline: `${agent} rebased ${item.branch} onto ${land.base} for PR #${conflicted.number}; auto-merge carries on`, summary, detail });
    this.setStatus(p, agent, `Rebased #${item.seq} for its pull request`);
    return { ok: true, hint: `PR #${conflicted.number} has the rebased branch. GitHub merges it once its checks pass, and #${item.seq} is done. Call next.` };
  }
  // Pushed for a pull request: the hub opens it, and GitHub's merge marks the item done.
  if (land.pending && this.prMode(p, item) && !this.prFailed(item)) {
    this.event(p, { item, actor: agent, type: 'pushed', headline: `${agent} pushed ${item.branch} for #${item.seq}; the hub opens its pull request`, summary, detail });
    this.openPr(p, item);
    this.setStatus(p, agent, `Pushed #${item.seq} for its pull request`);
    return { ok: true, hint: `${item.branch} is on origin. The hub opens a pull request with auto-merge on; GitHub's merge marks #${item.seq} done. Call next.` };
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
    const repo = this.caller?.remote ?? '';
    const pick = this.pick(p, agent, { powers: this.caller?.powers, repo });
    if (!pick) {
      if (p.parked) return { mode: 'idle', hint: 'The human has parked this project: start nothing new. Signoff.' };
      // Nothing in the clone it is in, but work waits in the project's other repositories.
      const elsewhere = repo ? [...new Set(this.claimable(p, agent, { powers: this.caller?.powers }).map((o) => this.repoOf(p, o.item)))].filter((r) => r !== repo) : [];
      if (elsewhere.length) {
        return {
          mode: 'idle', repos_with_work: elsewhere,
          hint: `Nothing is ready for you in ${repo}, the repository you're in. Work waits in ${elsewhere.join(', ')}: work there from a clone of it (${elsewhere.map((r) => `git clone ${cloneUrl(r)}`).join('; ')}), check in from that folder, then call next. Or signoff.`,
        };
      }
      const { has } = this.fit(p, agent);
      const gave = [...this.handedOff(p, agent)].map((id) => this.itemById(id))
        .filter((i) => !i.holder && ['ready', 'proposed', 'verifying'].includes(i.stage));
      const open = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL`).all(p.id)
        .filter((i) => !gave.some((g) => g.id === i.id));
      const unfit = open.filter((i) => json(i.needs, []).some((t) => !has.includes(t)));
      // Waiting on dependencies counts only work this token could take once they're done.
      const canBuild = !this.caller?.powers || this.caller.powers.includes('build');
      const blocked = canBuild ? open.filter((i) => !unfit.includes(i) && this.unmetDeps(i).length).length : 0;
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
        ? this.reviewHint(pick.item, `Review #${pick.item.seq} against done_means and the evidence, then call review with accept or reject.${pick.item.race > 1 ? ' It was raced: compare race.submissions and accept with attempt set to the one to keep.' : ''}`)
        : pick.mode === 'land' && args.claim !== false
          ? this.landHint(p, this.itemById(pick.item.id))
        : pick.mode === 'shape' && args.claim !== false
          ? SHAPE_HINT(pick.item, p, this.remotesOf(p))
          : args.claim === false
          ? `Not claimed. Claim #${pick.item.seq} to start.`
          : `You hold #${pick.item.seq} for ${dur(LEASE_MS)}. ${this.workHint(p, this.itemById(pick.item.id))} ${TOUCHING_HINT} Then progress at milestones (it renews the lease). Submit with evidence when done_means is met.`.replace(/  +/g, ' '),
    };
  },

  claim(p, agent, args) {
    const item = this.item(p, args.item);
    this.claimItem(p, agent, item);
    if (item.stage === 'active') this.setTouching(item, args.touching, agent);
    return {
      ...this.context(p, item, agent),
      hint: item.stage === 'verifying'
        ? this.reviewHint(item, `Review #${item.seq} against done_means and the evidence, then call review.`)
        : item.stage === 'proposed'
          ? SHAPE_HINT(item, p, this.remotesOf(p))
          : item.stage === 'landing'
            ? this.landHint(p, this.itemById(item.id))
            : `You hold #${item.seq} for ${dur(LEASE_MS)}. ${this.workHint(p, this.itemById(item.id))} ${args.touching ? '' : `${TOUCHING_HINT} `}Progress renews the lease.`.replace(/  +/g, ' '),
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
    const to = str(args.to).toLowerCase();
    if (to && !['reporter', 'human'].includes(to)) throw new UserError(`to must be "reporter" or "human", not "${args.to}"`, { hint: 'Leave it out to ask the human.' });
    const item = args.item ? this.item(p, args.item) : null;
    // To the issue's reporter: posted on the issue as a comment (askReporters in src/issues.js, right after this
    // answer), and the item parks like any blocking question until their reply comes back through the webhook.
    const issue = to === 'reporter' ? item && reporterIssue(this, item) : null;
    if (to === 'reporter' && !issue) {
      throw new UserError(item ? `#${item.seq} didn't come from a GitHub issue with a known author, so there is no reporter to ask` : 'Asking the reporter needs the item whose issue to ask on', {
        hint: item ? 'Ask the human instead: leave out to.' : 'Pass item, or leave out to and ask the human.',
      });
    }
    if (issue && !this.github) throw new UserError("This hub has no GitHub App, so it can't post on the issue", { hint: 'Ask the human instead: leave out to.' });
    const blocking = !!issue || args.blocking === true || args.blocking === 'true' || (!assumption && args.blocking == null);
    const options = Array.isArray(args.options) ? args.options.map(str).filter(Boolean).slice(0, 6) : [];
    const r = this.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, detail, options, blocking, assumption, at, reporter, issue_repo, issue_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, agent, question.headline, question.summary, question.detail,
      JSON.stringify(options), blocking ? 1 : 0, assumption, this.now(), issue?.author ?? '', issue?.repo ?? '', issue?.number ?? 0);
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
      headline: issue ? `${agent} asks @${issue.author} on GitHub: ${question.headline}` : blocking ? `${agent} asks: ${question.headline}` : `${agent} assumed "${assumption}"`,
      summary: blocking ? question.summary : `Question: ${question.headline}${question.summary ? `\n\n${question.summary}` : ''}`,
      detail: question.detail, data: { question: id, ...(issue ? { reporter: issue.author, url: issue.url } : {}) },
    });
    return {
      ok: true, question: id, blocking,
      ...(issue ? { reporter: `@${issue.author}`, issue: issue.url } : {}),
      hint: issue
        ? `Posted for @${issue.author} on ${issue.url || 'the issue'}; #${item.seq} is parked until they reply (or, after ${p.reporter_wait}h without a reply, the human answers). Call next and take other work.`
        : blocking
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
        [GIT_CHECK]: { event: id, about: item.id, claim: { headline, summary, evidence } }, // the race review shows each attempt's branch
      };
    }
    this.move(item, 'verifying', agent, { holder: null, lease_until: null, last_worker: agent, implementer: agent, touching: '[]' });
    const event = this.event(p, { item, actor: agent, type: 'submitted', headline, summary, detail, data: { evidence } });
    this.setStatus(p, agent, `Submitted #${item.seq}`);
    return {
      ok: true,
      hint: `#${item.seq} is verifying. ${reviewer} ${nudge}Call next for more work.`,
      [GIT_CHECK]: { event, item: item.id, about: item.id, branch: item.branch, claim: { headline, summary, evidence } }, // asked of git once the transaction is done
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
    const repo = this.checkRepo(p, args.repo);
    const human = isHuman(actor);
    const pre = normPrecondition(args.precondition);
    let stage = human ? (args.stage === 'proposed' ? 'proposed' : 'ready')
      : p.autonomy !== 'ask' && acceptance ? 'ready' : 'proposed';
    if (stage === 'ready' && pre) stage = pre.kind === 'ask' ? 'waiting' : 'outside';
    const t = this.now();
    const seq = this.q('SELECT next_seq FROM projects WHERE id = ?').get(p.id).next_seq;
    this.q('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?').run(p.id);
    const needs = JSON.stringify(normTags(args.needs));
    const size = SIZES.includes(args.size) ? args.size : '';
    const r = this.q(`INSERT INTO items (project_id, seq, title, summary, detail, acceptance, stage, priority, parent_id, created_by, needs, size, repo, precondition, next_check, stage_since, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, seq, title, summary, detail, acceptance, stage, priority, parent?.id ?? null, actor, needs, size, repo, pre ? JSON.stringify(pre) : '', t, t, t, t);
    const item = this.itemById(Number(r.lastInsertRowid));
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    this.setDeps(p, item, args.depends_on);
    this.event(p, {
      item, actor, type: 'created',
      headline: human ? `${You(actor)} added #${seq}: ${title}` : `${actor} proposed #${seq}: ${title}`,
      summary, data: { stage },
    });
    if (stage === 'waiting') this.askPrecondition(item, actor);
    return item;
  },

  refineItem(p, actor, item, args) {
    // Shaping an imported backlog: a duplicate of another item, or a stale issue for the human to close.
    const dup = str(args.duplicate_of), stale = str(args.stale);
    if (dup || stale) {
      if (!issuesOf(this, item).length) {
        throw new UserError(`#${item.seq} didn't come from a GitHub issue`, { hint: 'duplicate_of and stale are for proposals imported from issues. For other work, drop it in the UI or ask the human.' });
      }
      if (dup) {
        const target = this.item(p, dup);
        if (target.id === item.id) throw new UserError(`#${item.seq} can't duplicate itself`);
        if (target.stage === 'dropped') throw new UserError(`#${target.seq} is dropped`, { hint: 'Point duplicate_of at the item that carries on.' });
        markDuplicate(this, p, item, target, actor);
        return [`duplicate of #${target.seq}`];
      }
      markStale(this, p, item, stale, actor);
      return ['flagged stale'];
    }
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
    if (args.repo != null) {
      const repo = this.checkRepo(p, args.repo);
      if (repo !== item.repo) {
        if (['landing', 'done'].includes(item.stage)) throw new UserError(`#${item.seq} is ${item.stage}; its repository can't change now`, { status: 409, hint: 'Propose a new item for the other repository.' });
        set.repo = repo;
        changed.push(`repo → ${repo || this.remotesOf(p)[0] || 'unset'}`);
      }
    }
    // A new precondition starts unchecked (checked at the next sweep); none at all releases waiting work.
    let gate = null;
    if (args.precondition !== undefined) {
      const pre = normPrecondition(args.precondition);
      const val = pre ? JSON.stringify(pre) : '';
      if (val !== item.precondition) {
        if (['active', 'verifying', 'landing', 'done', 'dropped'].includes(item.stage)) throw new UserError(`#${item.seq} is ${item.stage}; a precondition only holds work that hasn't started`, { status: 409 });
        // The question an earlier 'ask' precondition put to the human no longer stands.
        const asked = json(item.last_check, {}).question;
        if (asked) this.q(`UPDATE questions SET status = 'withdrawn' WHERE id = ? AND status = 'open'`).run(asked);
        Object.assign(set, { precondition: val, last_check: '', check_fails: 0, next_check: this.now() });
        changed.push(pre ? `waits on: ${describePrecondition(pre)}` : 'no longer waits on anything outside');
        gate = !pre ? 'ready' : pre.kind === 'ask' ? 'waiting' : 'outside';
      }
    }
    if (Object.keys(set).length) this.patch(item, set);
    // To outside, to the human, or out of either; work parked on other questions stays parked.
    if (gate && (['ready', 'outside'].includes(item.stage) || (item.stage === 'waiting' && !this.openQuestions(item, { blocking: true }).length))) {
      if (gate !== item.stage) this.move(item, 'ready', actor);
      else if (gate === 'waiting') this.askPrecondition(item, actor);
    }
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
      const land = this.toLand(p, item, branch, { fresh: true });
      // Done means on main. Remote mode: work with a branch the hub can't see in its mirror (never pushed,
      // or the remote can't be read right now) still lands. The lander pushes it; finishLanding checks.
      const unseen = !land && !!branch && !!this.repos && this.remoteMode(p, item);
      const landing = !!land?.pending || unseen;
      this.move(item, landing ? 'landing' : 'done', actor, {
        holder: null, lease_until: null, ...(kept ? { implementer: kept.agent } : {}), ...(branch ? { branch } : {}),
      });
      const viaPr = landing && this.prMode(p, item);
      this.event(p, {
        item, actor, type: 'accepted',
        headline: `${who} accepted #${item.seq}${kept ? ` (${kept.agent}'s attempt)` : ''}${headline ? `: ${headline}` : ''}`,
        summary: [
          land?.pending && viaPr ? `${branch} lands through a pull request: the hub opens it with auto-merge on, and GitHub's merge marks #${item.seq} done.` : '',
          unseen && viaPr ? `${branch} lands through a pull request: the hub can't see it on origin yet, so an agent pushes it, then the hub opens the PR.` : '',
          land?.pending && !viaPr ? `${branch} lands on ${land.base} next: an agent rebases it, runs the checks and fast-forwards ${land.base}.` : '',
          unseen && !viaPr ? `${branch} lands next: the hub can't see it on origin yet, so the lander pushes it first, then rebases it, runs the checks and pushes it to main.` : '',
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
      if (viaPr && land) this.openPr(p, item);
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

// An answer from outside the UI (an issue's reporter on GitHub, src/issues.js), inside the caller's transaction.
export const answerQuestion = (hub, p, args, by) => HUMAN_OPS.answer.call(hub, p, args, by);

const HUMAN_OPS = {
  // keep_parked: answered, but not yet: the work stays waiting (parked by whoever answered) until unpark.
  answer(p, { question, answer, decide, keep_parked }, by) {
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
    // The question an 'ask' precondition put: answering it is what passes the precondition.
    if (item && json(item.last_check, {}).question === q.id) {
      this.patch(item, { last_check: JSON.stringify({ at: this.now(), ok: true, detail: `you answered: ${clip(text, 100)}`, question: q.id }) });
    }
    if (item && item.stage === 'waiting' && keep_parked) {
      this.patch(item, { parked_by: by });
      this.event(p, { item, actor: by, type: 'kept_parked', headline: `${You(by)} kept #${item.seq} parked: agents don't get it until it's unparked` });
    } else if (item && item.stage === 'waiting' && !this.openQuestions(item, { blocking: true }).length) {
      this.move(item, 'ready', by);
    }
    if (decide) this.addNote(p, 'decision', `${q.question} → ${text}`, null, null, by);
    return staleAnswered(this, p, q, text, by) ?? undefined;
  },

  // Let work kept parked (answer with keep_parked) go back to agents.
  unpark(p, { item }, by) {
    const it = this.item(p, item);
    if (it.stage !== 'waiting' || !it.parked_by) throw new UserError(`#${it.seq} isn't parked by anyone`, { status: 409, hint: 'Only work kept parked after an answer can be unparked.' });
    const open = this.openQuestions(it, { blocking: true }).length;
    this.patch(it, { parked_by: '' });
    if (!open) this.move(it, 'ready', by);
    this.event(p, { item: it, actor: by, type: 'unparked', headline: `${You(by)} unparked #${it.seq}${open ? '; it still waits on an open question' : ': agents can pick it up'}` });
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

  // "Check now": forget the backoff, so the next sweep checks it.
  check(p, { item }, by) {
    const it = this.item(p, item);
    if (it.stage !== 'outside' || !this.unmetPrecondition(it)) throw new UserError(`#${it.seq} isn't waiting on anything outside`, { status: 409 });
    this.patch(it, { check_fails: 0, next_check: this.now() });
    this.event(p, { item: it, actor: by, type: 'check_now', headline: `${You(by)} asked the hub to check #${it.seq}'s precondition now` });
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

  // Archive: out of the project list and routing, with everything kept; restore brings it back as it was.
  archive(p, args, by) {
    if (p.archived_at) return { archived: p.slug };
    this.q('UPDATE projects SET archived_at = ? WHERE id = ?').run(this.now(), p.id);
    this.event(p, { actor: by, type: 'project', headline: `${You(by)} archived ${p.name}`, summary: 'Its items and history are kept. Agents are no longer sent here; restore it to work on it again.' });
    return { archived: p.slug };
  },

  restore(p, args, by) {
    if (!p.archived_at) return { restored: p.slug };
    this.q('UPDATE projects SET archived_at = 0 WHERE id = ?').run(p.id);
    this.event(p, { actor: by, type: 'project', headline: `${You(by)} restored ${p.name}` });
    return { restored: p.slug };
  },

  // Delete for good: every row of the project, its mirrors, and its place in tokens limited to it. Only
  // after typing its name. The repository on GitHub is never touched.
  delete(p, { confirm }, by) {
    if (str(confirm) !== p.name && str(confirm) !== p.slug) {
      throw new UserError(`Type the project's name (${p.name}) to delete it`, { hint: 'Deleting removes its items, history, notes and mirror for good. Archive it instead to keep them.' });
    }
    const remotes = this.remotesOf(p);
    const items = `SELECT id FROM items WHERE project_id = ${Number(p.id)}`;
    this.q(`DELETE FROM acks WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)`).run(p.id);
    for (const t of ['attempts', 'transitions']) this.q(`DELETE FROM ${t} WHERE item_id IN (${items})`).run();
    this.q(`DELETE FROM deps WHERE item_id IN (${items}) OR depends_on IN (${items})`).run();
    for (const t of ['agents', 'events', 'questions', 'notes', 'project_stewards', 'dismissals', 'project_remotes', 'notified', 'prs', 'issues', 'checks', 'usage', 'items']) {
      this.q(`DELETE FROM ${t} WHERE project_id = ?`).run(p.id);
    }
    this.q('DELETE FROM projects WHERE id = ?').run(p.id);
    // Tokens limited to projects lose this one; a token left with none is revoked, not widened to all.
    let revoked = 0;
    if (this.q("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tokens'").get()) {
      for (const t of this.q("SELECT id, projects FROM tokens WHERE projects != '' AND revoked_at IS NULL").all()) {
        const scope = t.projects.split(',');
        if (!scope.includes(p.slug)) continue;
        const left = scope.filter((s) => s !== p.slug);
        if (left.length) this.q('UPDATE tokens SET projects = ? WHERE id = ?').run(left.join(','), t.id);
        else { this.q('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(this.now(), t.id); revoked++; }
      }
    }
    if (this.repos) for (const r of remotes) rmSync(mirrorPath(this.repos, r), { recursive: true, force: true });
    return { deleted: p.slug, by, revoked_tokens: revoked };
  },

  settings(p, { name, mission, autonomy, parked, path, runner, github_secret, issue_label, reporter_wait, wait_days }, by) {
    const changes = [];
    if (reporter_wait != null && Number(reporter_wait) !== p.reporter_wait) {
      const hours = Number(reporter_wait);
      if (!Number.isInteger(hours) || hours < 1) throw new UserError('reporter_wait is a whole number of hours, at least 1');
      this.q('UPDATE projects SET reporter_wait = ? WHERE id = ?').run(hours, p.id);
      this.event(p, { actor: by, type: 'github', headline: `${You(by)} gave issue reporters ${hours}h to answer a question before it comes to you` });
    }
    if (wait_days != null && wait_days !== '') {
      const n = Number(wait_days);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new UserError('wait_days must be a whole number of days from 1 to 365', { hint: `How long work may wait outside before you hear about it; the default is ${WAIT_DAYS}.` });
      if (n !== (p.wait_days || WAIT_DAYS)) {
        this.q('UPDATE projects SET wait_days = ? WHERE id = ?').run(n, p.id);
        this.event(p, { actor: by, type: 'settings', headline: `${You(by)} set work waiting outside to show up after ${n} day${n === 1 ? '' : 's'}` });
      }
    }
    if (issue_label != null && str(issue_label) !== p.issue_label) {
      this.q('UPDATE projects SET issue_label = ? WHERE id = ?').run(str(issue_label), p.id);
      this.event(p, { actor: by, type: 'github', headline: str(issue_label) ? `${You(by)} set GitHub issues to come in only with the label "${str(issue_label)}"` : `${You(by)} let every open GitHub issue come in` });
    }
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
