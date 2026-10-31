// Many workspaces on one hub process: each is one company, in its own SQLite file, so nothing
// can leak between them and export or delete is one file. A workspace is just a Hub (and the
// server's Auth on the same db), opened on first use.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub, UserError } from './core.js';
import { Directory } from './directory.js';
import { paid, billingLine } from './billing.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED = new Set(['www', 'api', 'app', 'admin', 'w', 'static', 'login', 'auth', 'hub']);
export const PLANS = ['free', 'unlimited'];
export const FREE_AGENTS = 1; // agents working at once on the Free plan

export class Workspaces {
  // repos: where hubs keep mirrors of repositories they have no checkout of; each workspace gets
  // its own folder there, like its own database. keys: per-repository deploy keys, likewise one
  // folder per workspace, so one workspace's key never fetches for another.
  // plans: whether plan limits apply (off by default: early access changes nothing). owners: the hub
  // owner's emails; an organization they belong to is never limited.
  constructor({ dir, clock, repos = null, keys = null, plans = false, owners = [] } = {}) {
    if (!dir) throw new Error('Workspaces needs a directory');
    this.dir = dir;
    this.clock = clock;
    this.repos = repos;
    this.keys = keys;
    this.plans = !!plans;
    this.owners = owners.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
    this.open = new Map(); // slug → Hub
    mkdirSync(dir, { recursive: true });
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

  // The workspace's hub, or null if there is no such workspace. Never creates one.
  get(slug) {
    let s;
    try { s = Workspaces.check(slug); } catch { return null; }
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
    }
    return hub ?? null;
  }

  create(slug) {
    const s = Workspaces.check(slug);
    if (existsSync(this.file(s))) throw new UserError(`Workspace "${s}" already exists`, { status: 409 });
    new Hub({ file: this.file(s) }).db.close();
    return s;
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
    const stamp = new Date(this.clock?.() ?? Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const backup = `${source}.before-workspaces-${stamp}`;
    const src = new DatabaseSync(source);
    try {
      src.prepare('VACUUM INTO ?').run(backup);
      src.prepare('VACUUM INTO ?').run(this.file(s));
    } finally { src.close(); }
    const hub = this.get(s); // brings the copy's schema up to date
    for (const { email } of hub.db.prepare("SELECT email FROM people WHERE email IS NOT NULL AND email != ''").all()) {
      this.directory.identify(email, 'github');
      this.directory.join(email, s);
    }
    if (!this.directory.rootWorkspace()) this.directory.setRootWorkspace(s);
    return { workspace: s, file: this.file(s), backup };
  }

  // ── plans (#113): Free runs one agent at a time; Pro and Team are unlimited ──

  static checkPlan(plan) {
    if (!PLANS.includes(plan)) throw new UserError(`"${plan}" is not a plan`, { hint: `One of: ${PLANS.join(', ')}.` });
    return plan;
  }

  // free or unlimited. With plans off, every organization is unlimited; one the hub owner belongs to always
  // is. Otherwise the plan the hub owner set; with none, free if someone signed up for it, and unlimited if
  // the host made it (nuworq workspace create).
  planOf(slug) {
    return this.plans ? this.planInfo(slug).plan : 'unlimited';
  }

  // The plan the organization is on while plans are on, and why: source 'owners' (a hub owner belongs to it),
  // 'set' (the hub owner set it: set_by, set_at), 'billing' (a Stripe subscription pays for it, #227) or 'default'
  // (free if someone signed up for it, else unlimited). billing: its Stripe state, whatever the source, or null.
  planInfo(slug) {
    const b = this.directory.billingOf(slug);
    const billing = b ? { status: b.status, period_end: b.period_end, cancel_at_period_end: b.cancel_at_period_end, plan: b.plan, line: billingLine(b, this.directory.now()) } : null;
    if (this.directory.hasMember(slug, this.owners)) return { plan: 'unlimited', source: 'owners', set_by: null, set_at: null, billing };
    const set = this.directory.planSet(slug);
    if (set) return { plan: set.plan, source: 'set', set_by: set.set_by || null, set_at: set.at, billing };
    if (paid(b, this.directory.now())) return { plan: 'unlimited', source: 'billing', set_by: null, set_at: null, billing };
    return { plan: this.directory.madeBySomeone(slug) ? 'free' : 'unlimited', source: 'default', set_by: null, set_at: null, billing };
  }

  // One row per workspace for the hub owners' dashboard (#169), most recently active first: its plan, who
  // made it, how many people and projects, the agents holding work now, and when anything last happened.
  overview() {
    const rows = this.list().map((name) => {
      const hub = this.get(name);
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
      && this.get(other)?.projects().some((p) => this.get(other).remotesOf(p).includes(remote))) ?? null;
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
