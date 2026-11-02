// Many workspaces on one hub process: each is one company, in its own SQLite file, so nothing
// can leak between them and export or delete is one file. A workspace is just a Hub (and the
// server's Auth on the same db), opened on first use.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub, UserError } from './core.js';
import { Directory } from './directory.js';
import { paid, billingLine } from './billing.js';
import { forgetWorkspace } from './follow.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED = new Set(['www', 'api', 'app', 'admin', 'w', 'static', 'login', 'auth', 'hub']);
export const PLANS = ['free', 'unlimited'];
export const FREE_AGENTS = 1; // agents working at once on the Free plan
// How long a workspace nobody uses stays open, and how often a closed one is opened for its sweep (#525).
export const IDLE_MS = 10 * 60_000, WAKE_MS = 5 * 60_000;

// Whether an agent holds a lease there: its lapse must be seen on time, so the workspace stays open.
const inMotion = (hub) => !!hub.db.prepare(`SELECT 1 FROM items WHERE lease_until > ?
  UNION ALL SELECT 1 FROM attempts WHERE closed = 0 AND lease_until > ? LIMIT 1`).get(hub.now(), hub.now());

export class Workspaces {
  // repos: where hubs keep mirrors of repositories they have no checkout of; each workspace gets
  // its own folder there, like its own database. keys: per-repository deploy keys, likewise one
  // folder per workspace, so one workspace's key never fetches for another.
  // backups: where serve --follow keeps its copies of every workspace (src/follow.js); removing one deletes its copies.
  // plans: whether plan limits apply (off by default: early access changes nothing). owners: the hub
  // owner's emails; an organization they belong to is never limited.
  constructor({ dir, clock, repos = null, keys = null, backups = null, plans = false, owners = [] } = {}) {
    if (!dir) throw new Error('Workspaces needs a directory');
    this.dir = dir;
    this.clock = clock;
    this.repos = repos;
    this.keys = keys;
    this.backups = backups;
    this.plans = !!plans;
    this.owners = owners.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    this.open = new Map(); // slug → Hub
    // Each open workspace costs memory and timers, so one nobody uses closes again (#525): when it was last used
    // (a request), last woken for its sweep, who wants to hear it open, and what may hold it open.
    this.used = new Map();
    this.woken = new Map();
    this.openers = [];
    this.holds = [(hub) => inMotion(hub)];
    mkdirSync(dir, { recursive: true });
  }

  now() {
    return this.clock?.() ?? Date.now();
  }

  file(slug) {
    return join(this.dir, `${slug}.db`);
  }

  // Who is signed in to the hub itself, and their organizations (src/directory.js). Not a .db, so
  // it is never mistaken for a workspace.
  get directory() {
    return (this._directory ??= new Directory(join(this.dir, 'directory.sqlite'), this.clock ? { now: this.clock } : {}));
  }

  static check(slug) {
    const s = String(slug ?? '').trim().toLowerCase();
    // People see these as they name a workspace (#155, #159).
    if (!SLUG.test(s) || s.length < 2) throw new UserError(`"${slug}" can't be a workspace's address`, { hint: '2–40 characters: lowercase letters, digits and dashes, e.g. "acme".' });
    if (RESERVED.has(s)) throw new UserError(`"${s}" is reserved; pick another address for your workspace`, { hint: `Reserved for the hub itself: ${[...RESERVED].join(', ')}.` });
    return s;
  }

  has(slug) {
    try { return existsSync(this.file(Workspaces.check(slug))); } catch { return false; }
  }

  list() {
    return readdirSync(this.dir).filter((f) => f.endsWith('.db')).map((f) => f.slice(0, -3)).sort();
  }

  // The workspace's hub, or null if there is no such workspace. Never creates one. touch: false for the hub's own
  // bookkeeping (dashboards, sweeps), which doesn't count as use and so doesn't keep it open.
  get(slug, { touch = true } = {}) {
    let s;
    try { s = Workspaces.check(slug); } catch { return null; }
    if (touch) this.used.set(s, this.now());
    let hub = this.open.get(s);
    // Removed from the host (nuworq workspace remove) while we had it open: let it go.
    if (hub && !existsSync(this.file(s))) {
      this.evict(s);
      return null;
    }
    if (!hub && existsSync(this.file(s))) {
      hub = new Hub({ file: this.file(s), repos: this.repos && join(this.repos, s), keys: this.keys && join(this.keys, s), hosted: true, ...(this.clock ? { clock: this.clock } : {}) });
      hub.workspace = s;
      // Asked at each claim and each repository linked, so a plan change applies at once.
      hub.planLimit = () => (this.planOf(s) === 'free' ? FREE_AGENTS : null);
      hub.repoGuard = (remote) => this.repoTaken(s, remote);
      this.open.set(s, hub);
      for (const fn of this.openers) {
        try { fn(s, hub); } catch (e) { console.error('opening a workspace failed', e); }
      }
    }
    return hub ?? null;
  }

  // Call fn(name, hub) each time a workspace opens.
  onOpen(fn) {
    this.openers.push(fn);
  }

  // Keep a workspace open while hold(hub) says so, e.g. a browser streaming it or a push about to go out.
  holdOpen(hold) {
    this.holds.push(hold);
  }

  // Close each open workspace nobody has used for idleMs and nothing holds open. Returns the names closed.
  closeIdle(idleMs) {
    const t = this.now(), closed = [];
    for (const [s, hub] of this.open) {
      if (t - (this.used.get(s) ?? 0) < idleMs || this.holds.some((hold) => hold(hub))) continue;
      this.evict(s);
      closed.push(s);
    }
    return closed;
  }

  // Open the closed workspace that has gone longest without a sweep, if that's over everyMs: its leases lapse,
  // preconditions get checked and pushes go out while nobody uses it. It closes again with closeIdle. Returns its
  // hub, or null. One whose file won't open (corrupt, say) is logged and skipped until its turn comes again (#740).
  wake(everyMs) {
    const t = this.now();
    const since = (s) => Math.max(this.used.get(s) ?? 0, this.woken.get(s) ?? 0);
    const due = this.list().filter((s) => !this.open.has(s) && t - since(s) >= everyMs).sort((a, b) => since(a) - since(b));
    for (const s of due) {
      this.woken.set(s, t);
      try { return this.get(s, { touch: false }); } catch (e) { console.error(`waking workspace "${s}" failed; skipped`, e); }
    }
    return null;
  }

  // claim(name): what must hold before it's made (an early-access grant, say), run once the name starts clean: it may
  // bind the name in the directory, and throws to refuse.
  create(slug, { claim } = {}) {
    const s = Workspaces.check(slug);
    if (existsSync(this.file(s))) throw new UserError(`Workspace "${s}" already exists`, { status: 409 });
    this.forgetName(s);
    claim?.(s);
    new Hub({ file: this.file(s) }).db.close();
    return s;
  }

  // A name with no workspace hands nothing on (#749): rows a workspace of that name left in the directory, removed
  // before remove forgot them (#728), go before the name is used again. Opens no directory that isn't there yet.
  forgetName(s) {
    if (this._directory || existsSync(join(this.dir, 'directory.sqlite'))) this.directory.forget(s);
  }

  // Each name the directory holds rows for with no workspace of that name: forgotten, and returned (names only).
  forgetGone() {
    if (!this._directory && !existsSync(join(this.dir, 'directory.sqlite'))) return [];
    const gone = this.directory.named().filter((s) => !existsSync(this.file(s)));
    for (const s of gone) this.directory.forget(s);
    return gone;
  }

  // A single hub's database becomes a workspace (#204): copied whole (projects, items, history, decisions,
  // field notes, people, tokens) with VACUUM INTO, so a running hub's WAL is included; the original stays where
  // it is, with a dated copy beside it. Its people with an email become members, so the hub owner finds it on
  // signing in, and it becomes the root workspace: tokens saved with the hub's root address keep working.
  // Refuses a taken or reserved name. Returns { workspace, file, backup }.
  adopt(slug, source) {
    const s = Workspaces.check(slug);
    if (existsSync(this.file(s))) throw new UserError(`Workspace "${s}" already exists`, { status: 409, hint: 'Pick another name, or remove that workspace first.' });
    if (!source || !existsSync(source)) throw new UserError(`No hub database at ${source}`, { status: 404, hint: 'Point --db at the single hub\'s database (default ~/.nuworq/nuworq.db).' });
    this.forgetName(s);
    const stamp = new Date(this.clock?.() ?? Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const backup = `${source}.before-workspaces-${stamp}`;
    const src = new DatabaseSync(source);
    try {
      src.prepare('VACUUM INTO ?').run(backup);
      src.prepare('VACUUM INTO ?').run(this.file(s));
    } finally { src.close(); }
    const hub = this.get(s); // brings the copy's schema up to date
    // The host adopting its own hub vouches for its people's emails (#470).
    hub.db.prepare("UPDATE people SET verified_at = COALESCE(verified_at, created_at) WHERE email != ''").run();
    for (const { email } of hub.db.prepare("SELECT email FROM people WHERE email IS NOT NULL AND email != ''").all()) {
      this.directory.identify(email, 'github');
      this.directory.join(email, s);
    }
    if (!this.directory.rootWorkspace()) this.directory.setRootWorkspace(s);
    this.directory.setting(`adopted:${s}`, backup); // removing the workspace removes this copy too
    return { workspace: s, file: this.file(s), backup };
  }

  // Bind GitHub App installations to a workspace (#226), so the app's deliveries for them reach it: a single
  // hub's installations once it is adopted, or one by hand. One already bound elsewhere stays there.
  // Returns { bound: [id], elsewhere: [{ id, workspace }] }.
  bindInstallations(slug, ids) {
    const s = Workspaces.check(slug);
    if (!existsSync(this.file(s))) throw new UserError(`No workspace "${s}"`, { status: 404, hint: 'See them with: nuworq workspace list' });
    const out = { bound: [], elsewhere: [] };
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isSafeInteger(id) || id <= 0) throw new UserError(`"${raw}" is not an installation id`, { hint: "It's the number at the end of the installation's settings URL, e.g. https://github.com/settings/installations/12345678." });
      if (this.directory.bindInstallation(id, s)) out.bound.push(id);
      else out.elsewhere.push({ id, workspace: this.directory.installation(id) });
    }
    return out;
  }

  // ── plans (#113): Free runs one agent at a time; Pro and Team are unlimited ──

  static checkPlan(plan) {
    if (!PLANS.includes(plan)) throw new UserError(`"${plan}" is not a plan`, { hint: `One of: ${PLANS.join(', ')}.` });
    return plan;
  }

  // free or unlimited. With plans off, every organization is unlimited; one the hub owner belongs to always
  // is. Otherwise the plan the hub owner set; with none, unlimited if Stripe pays for it or an early-access
  // grant made it, else free if someone signed up for it, and unlimited if the host made it (nuworq workspace create).
  planOf(slug) {
    return this.plans ? this.planInfo(slug).plan : 'unlimited';
  }

  // The plan the organization is on while plans are on, and why: source 'owners' (a hub owner belongs to it),
  // 'set' (the hub owner set it: set_by, set_at), 'billing' (a Stripe subscription pays for it, #227),
  // 'early_access' (an approved early-access grant made it, #355: never charged) or 'default' (free if someone
  // signed up for it, else unlimited). billing: its Stripe state, whatever the source, or null.
  planInfo(slug) {
    const b = this.directory.billingOf(slug);
    const billing = b ? { status: b.status, period_end: b.period_end, cancel_at_period_end: b.cancel_at_period_end, plan: b.plan, line: billingLine(b, this.directory.now()) } : null;
    if (this.directory.hasMember(slug, this.owners, this)) return { plan: 'unlimited', source: 'owners', set_by: null, set_at: null, billing };
    const set = this.directory.planSet(slug);
    if (set) return { plan: set.plan, source: 'set', set_by: set.set_by || null, set_at: set.at, billing };
    if (paid(b, this.directory.now())) return { plan: 'unlimited', source: 'billing', set_by: null, set_at: null, billing };
    if (this.directory.madeByGrant(slug)) return { plan: 'unlimited', source: 'early_access', set_by: null, set_at: null, billing };
    return { plan: this.directory.madeBySomeone(slug) ? 'free' : 'unlimited', source: 'default', set_by: null, set_at: null, billing };
  }

  // One row per workspace for the hub owners' dashboard (#169), most recently active first: its plan, who
  // made it, how many people and projects, the agents holding work now, and when anything last happened.
  overview() {
    const rows = this.list().map((name) => {
      const hub = this.get(name, { touch: false });
      const n = (sql) => hub.db.prepare(sql).get().n ?? null;
      const last = Math.max(n('SELECT MAX(at) AS n FROM events') ?? 0, n('SELECT MAX(last_seen) AS n FROM agents') ?? 0);
      return {
        name, ...this.planInfo(name),
        creator: this.directory.creator(name),
        people: n('SELECT COUNT(*) AS n FROM people'),
        projects: hub.projects().length,
        working: [...hub.working()].sort(),
        last_active: last || null,
      };
    });
    return rows.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0) || a.name.localeCompare(b.name));
  }

  // How far each early-access source got (#356), for the owners' dashboard: per source (most requests first, ''
  // for none), the requests made in the last `days` and all time, and of those: let in, with a workspace where an
  // agent has connected, and with one where an item has landed.
  sources({ days = 14 } = {}) {
    const since = this.directory.now() - days * 24 * 60 * 60 * 1000;
    const seen = new Map(); // workspace → { connected, landed }
    const reached = (ws) => {
      if (!seen.has(ws)) {
        const hub = this.get(ws, { touch: false });
        const n = (sql) => (hub ? hub.db.prepare(sql).get().n : 0);
        seen.set(ws, { connected: n('SELECT COUNT(*) AS n FROM agents') > 0, landed: n("SELECT COUNT(*) AS n FROM items WHERE stage = 'done'") > 0 });
      }
      return seen.get(ws);
    };
    const zero = () => ({ requests: 0, let_in: 0, connected: 0, landed: 0 });
    const by = new Map();
    for (const r of this.directory.requestFunnel()) {
      if (!by.has(r.source)) by.set(r.source, { source: r.source, recent: zero(), all: zero() });
      const ws = r.workspaces.map(reached);
      const add = (c) => {
        c.requests++;
        if (r.let_in) c.let_in++;
        if (ws.some((w) => w.connected)) c.connected++;
        if (ws.some((w) => w.landed)) c.landed++;
      };
      add(by.get(r.source).all);
      if (r.created_at >= since) add(by.get(r.source).recent);
    }
    return { days, sources: [...by.values()].sort((a, b) => b.all.requests - a.all.requests || (a.source === '') - (b.source === '') || a.source.localeCompare(b.source)) };
  }

  setPlan(slug, plan, by = '') {
    const s = Workspaces.check(slug);
    if (!this.has(s)) throw new UserError(`No workspace "${s}"`, { status: 404 });
    this.directory.setPlan(s, Workspaces.checkPlan(plan), by);
  }

  // The free organization other than slug that already has remote, or null. A repository belongs to one
  // free organization; paid ones may share it.
  repoTaken(slug, remote) {
    if (this.planOf(slug) !== 'free') return null;
    return this.list().find((other) => other !== slug && this.planOf(other) === 'free'
      && this.get(other, { touch: false })?.projects().some((p) => this.get(other, { touch: false }).remotesOf(p).includes(remote))) ?? null;
  }

  // A signed-in person's free organizations that still exist: one is the most they may create.
  freeCreatedBy(identity) {
    return this.directory.created(identity).filter((w) => this.has(w) && this.planOf(w) === 'free');
  }

  remove(slug) {
    const s = Workspaces.check(slug);
    if (!existsSync(this.file(s))) throw new UserError(`No workspace "${s}"`, { status: 404 });
    this.evict(s);
    for (const f of [this.file(s), `${this.file(s)}-wal`, `${this.file(s)}-shm`]) rmSync(f, { force: true });
    // And every copy of it: follow's, and the dated copy of the single hub it was adopted from (#479).
    forgetWorkspace(this.backups, s);
    if (!this._directory && !existsSync(join(this.dir, 'directory.sqlite'))) return;
    const adopted = this.directory.setting(`adopted:${s}`);
    if (adopted) rmSync(adopted, { force: true });
    this.directory.forget(s); // and its name starts clean (#728)
  }

  evict(slug) {
    const hub = this.open.get(slug);
    if (!hub) return;
    this.open.delete(slug);
    hub.emit('closed');
    try { hub.db.close(); } catch { /* already closed */ }
  }

  hubs() {
    return [...this.open.values()];
  }

  close() {
    for (const hub of this.open.values()) hub.db.close();
    this.open.clear();
    this._directory?.close();
    this._directory = null;
  }
}
