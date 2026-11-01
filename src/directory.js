// The host's directory: who is signed in to the hub itself (not to one workspace), and which
// organizations (workspaces) each of them belongs to. One small SQLite file next to the workspace files.
//
// An identity is a verified email from GitHub or Google sign-in (src/oauth.js): that is what a
// workspace's people are matched by, so it is what links a person across workspaces. A membership
// is a hint the hub keeps (written when someone creates, joins or signs in to an organization); the
// workspace's own people table stays the truth, and every read checks it, so a role change or a
// removal shows at once, however it was made.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { SESSION_MS } from './auth.js';
import { paid } from './billing.js';

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const ORG_CAP = 5; // organizations one person may create, unless the host says otherwise
export const GRANT_MS = 14 * 24 * 60 * 60 * 1000; // how long an early-access grant is good for
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // a sign-in to the admin host lasts a working day
export const FEEDBACK_MAX = 4000, FEEDBACK_PER_DAY = 10; // characters a piece of feedback; pieces per sender a day
const DAY_MS = 24 * 60 * 60 * 1000;

// An early-access request's source (#356), e.g. "hn" or "news.ycombinator.com": lowercased, at most 64 characters
// of a-z 0-9 . - _. Anything else is dropped (''), never refused: the request still counts.
export function sourceOf(s) {
  const v = String(s ?? '').trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(v) ? v : '';
}

// Cloudflare Turnstile, checked on the hub (the secret never reaches a browser): resolves true when the
// token a request form got from the widget is good. The only call early access makes to anyone else.
export function turnstile(secret, { fetch: get = fetch } = {}) {
  return async (token, ip) => {
    if (!secret || !token) return false;
    try {
      const r = await get('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: String(token), ...(ip ? { remoteip: ip } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
      return (await r.json())?.success === true;
    } catch { return false; }
  };
}

export class Directory {
  constructor(file, { now = () => Date.now() } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS identities (
        id         INTEGER PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,          -- verified by the provider, lowercase
        provider   TEXT NOT NULL,                 -- the last one they signed in with: github | google
        created_at INTEGER NOT NULL,
        seen_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hub_sessions (
        hash        BLOB PRIMARY KEY,             -- sha256 of the session id
        identity_id INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        identity_id INTEGER NOT NULL,
        workspace   TEXT NOT NULL,
        created     INTEGER NOT NULL DEFAULT 0,   -- 1: this identity created the organization
        at          INTEGER NOT NULL,
        PRIMARY KEY (identity_id, workspace)
      );
      CREATE TABLE IF NOT EXISTS installations (
        id        INTEGER PRIMARY KEY,            -- the GitHub App installation id
        workspace TEXT NOT NULL,                  -- the organization it was installed for
        at        INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plans (
        workspace TEXT PRIMARY KEY,
        plan      TEXT NOT NULL,                  -- free | unlimited (no row: free, while plans are on)
        set_by    TEXT NOT NULL DEFAULT '',
        at        INTEGER NOT NULL
      );
      -- Early access: who asked to come in, and what the hub's owners decided.
      CREATE TABLE IF NOT EXISTS access_requests (
        id         INTEGER PRIMARY KEY,
        email      TEXT UNIQUE NOT NULL,          -- lowercase; asking again updates the same request
        github     TEXT NOT NULL DEFAULT '',
        building   TEXT NOT NULL DEFAULT '',      -- what they would build, in their words
        state      TEXT NOT NULL DEFAULT 'new',   -- new | approved | declined
        ip_hash    TEXT NOT NULL DEFAULT '',      -- sha256 of the address it came from, never the address
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL DEFAULT '',
        decided_at INTEGER
      );
      -- An approved request's grant: one organization, created once, before it expires.
      CREATE TABLE IF NOT EXISTS org_grants (
        hash       BLOB PRIMARY KEY,              -- sha256 of the code in the link
        request_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_by    INTEGER,                       -- the identity that created its organization
        used_at    INTEGER
      );`);
    // A session's kind: 'hub' (the app's own address) or 'admin' (the admin host). Neither opens the other.
    try { this.db.exec("ALTER TABLE hub_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'hub'"); } catch { /* already there */ }
    // Hub-wide settings, e.g. root_workspace: the workspace a single hub became (#204).
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    // Billing (#227): what Stripe's signed webhook said about each subscription, and which events it already sent.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing (
        subscription TEXT PRIMARY KEY,            -- Stripe's sub_…
        workspace    TEXT,                        -- null until its checkout names one
        customer     TEXT,                        -- cus_…
        status       TEXT,                        -- Stripe's: active, trialing, past_due, canceled, …
        period_end   INTEGER,                     -- ms
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        plan         TEXT,                        -- the name NUWORQ_STRIPE_PRICES gives its price
        event_at     INTEGER NOT NULL DEFAULT 0,  -- the newest event applied (ms): an older one changes nothing
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
    // Payments (#231): the failed renewal not yet paid (failed_at, and pay_by: Stripe's next retry), and the last paid one.
    for (const col of ['failed_at INTEGER', 'pay_by INTEGER', 'paid_at INTEGER']) {
      try { this.db.exec(`ALTER TABLE billing ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    // Feedback about nuworq itself (#295), from people and agents in any workspace, for the hub's owners.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id         INTEGER PRIMARY KEY,
        kind       TEXT NOT NULL,                 -- person | agent
        sender     TEXT NOT NULL,                 -- "@handle", or the agent's name
        email      TEXT NOT NULL DEFAULT '',      -- a person's, for the owners only: never in the proposal
        workspace  TEXT NOT NULL,
        text       TEXT NOT NULL,                 -- their words, untrusted
        item       TEXT NOT NULL DEFAULT '',      -- the item an agent named, e.g. "api#12"
        context    TEXT NOT NULL DEFAULT '{}',    -- JSON: page, version, browser; or client, model, version
        state      TEXT NOT NULL DEFAULT 'new',   -- new | approved | declined
        note       TEXT NOT NULL DEFAULT '',      -- a decline's note to the sender
        proposal   TEXT NOT NULL DEFAULT '',      -- what Approve made: "<workspace>/<project>#<seq>"
        created_at INTEGER NOT NULL,
        decided_by TEXT NOT NULL DEFAULT '',
        decided_at INTEGER
      );`);
    // When its sender was told it's fixed (#297): once, never again.
    try { this.db.exec('ALTER TABLE feedback ADD COLUMN told_at INTEGER'); } catch { /* already there */ }
    // The level that proposed a piece at once, without an owner's decision (#296): balanced | full; '' when decided.
    try { this.db.exec("ALTER TABLE feedback ADD COLUMN auto TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
    // The workspace a used grant made (#355): it starts on Unlimited.
    try { this.db.exec('ALTER TABLE org_grants ADD COLUMN workspace TEXT'); } catch { /* already there */ }
    // Where an early-access request came from (#356): a ?ref= tag or the referring host, '' when unknown.
    try { this.db.exec("ALTER TABLE access_requests ADD COLUMN source TEXT NOT NULL DEFAULT ''"); } catch { /* already there */ }
  }

  // ── billing (#227) ──

  eventSeen(id) {
    return !!this.db.prepare('SELECT 1 FROM stripe_events WHERE id = ?').get(String(id));
  }

  markEvent(id) {
    this.db.prepare('INSERT OR IGNORE INTO stripe_events (id, at) VALUES (?, ?)').run(String(id), this.now());
  }

  // Record what an event says about a subscription. ids: the workspace and customer it names (null: keep what is
  // known; a customer seen with a workspace before brings it along). state applies only when its event (at) is
  // no older than the last one applied; fill: only when no state is known yet (a checkout, ahead of its events).
  setBilling(subscription, { workspace = null, customer = null } = {}, { at = this.now(), status = null, period_end = null, cancel_at_period_end = false, plan = null, fill = false } = {}) {
    if (!subscription) return null;
    const row = this.db.prepare('SELECT * FROM billing WHERE subscription = ?').get(subscription);
    const ws = workspace ?? row?.workspace ?? (customer
      ? this.db.prepare('SELECT workspace FROM billing WHERE customer = ? AND workspace IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(customer)?.workspace ?? null : null);
    const t = this.now();
    if (!row) {
      this.db.prepare(`INSERT INTO billing (subscription, workspace, customer, status, period_end, cancel_at_period_end, plan, event_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(subscription, ws, customer, status, period_end, cancel_at_period_end ? 1 : 0, plan, fill ? 0 : at, t);
    } else {
      this.db.prepare('UPDATE billing SET workspace = ?, customer = COALESCE(?, customer), updated_at = ? WHERE subscription = ?').run(ws, customer, t, subscription);
      if (fill ? !row.status && status : at >= row.event_at) {
        this.db.prepare(fill ? 'UPDATE billing SET status = ? WHERE subscription = ?'
          : 'UPDATE billing SET status = ?, period_end = ?, cancel_at_period_end = ?, plan = ?, event_at = ? WHERE subscription = ?')
          .run(...(fill ? [status, subscription] : [status, period_end, cancel_at_period_end ? 1 : 0, plan, at, subscription]));
      }
    }
    return this.billingRow(subscription);
  }

  // An invoice for a subscription the hub keeps (#231): failed (pay_by: Stripe's next retry) or paid, which clears
  // the failure. A retry that fails again keeps the first failed_at (one failure, until it's paid). An invoice
  // older than the last one applied changes nothing. null: no such subscription.
  setPayment(subscription, { at = this.now(), failed = false, pay_by = null } = {}) {
    const row = this.billingRow(subscription);
    if (!row) return null;
    if (failed && at >= (row.paid_at ?? 0)) this.db.prepare('UPDATE billing SET failed_at = COALESCE(failed_at, ?), pay_by = ?, updated_at = ? WHERE subscription = ?').run(at, pay_by, this.now(), subscription);
    if (!failed && at >= (row.failed_at ?? 0)) this.db.prepare('UPDATE billing SET failed_at = NULL, pay_by = NULL, paid_at = ?, updated_at = ? WHERE subscription = ?').run(at, this.now(), subscription);
    return this.billingRow(subscription);
  }

  billingRow(subscription) {
    const r = this.db.prepare('SELECT * FROM billing WHERE subscription = ?').get(subscription);
    return r ? { ...r, cancel_at_period_end: !!r.cancel_at_period_end } : null;
  }

  // A workspace's billing: the subscription that makes it paid now, else its latest one; null with none.
  billingOf(workspace, now = this.now()) {
    const rows = this.db.prepare('SELECT subscription FROM billing WHERE workspace = ? ORDER BY updated_at DESC').all(workspace).map((r) => this.billingRow(r.subscription));
    return rows.find((b) => paid(b, now)) ?? rows[0] ?? null;
  }

  // The workspace a single hub was adopted into (#204), or null: tokens saved with the hub's root address
  // reach it there, and old links find their project in it.
  rootWorkspace() {
    return this.db.prepare("SELECT value FROM settings WHERE key = 'root_workspace'").get()?.value ?? null;
  }

  setRootWorkspace(slug) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('root_workspace', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(slug);
  }

  // Which organization a GitHub App installation belongs to, or null.
  installation(id) {
    return this.db.prepare('SELECT workspace FROM installations WHERE id = ?').get(Number(id))?.workspace ?? null;
  }

  // Bind an installation to an organization. The first binding stands: an installation already bound to
  // another organization stays there (returns false).
  bindInstallation(id, workspace) {
    const was = this.installation(id);
    if (was && was !== workspace) return false;
    if (!was) this.db.prepare('INSERT INTO installations (id, workspace, at) VALUES (?, ?, ?)').run(Number(id), workspace, this.now());
    return true;
  }

  // An organization's plan as set by the hub owner, or null when nobody set one.
  plan(workspace) {
    return this.planSet(workspace)?.plan ?? null;
  }

  // The same, with who set it and when: { plan, set_by, at }, or null.
  planSet(workspace) {
    return this.db.prepare('SELECT plan, set_by, at FROM plans WHERE workspace = ?').get(workspace) ?? null;
  }

  // Who created the organization, when a signed-in person did: { email, github }, or null (the host made it).
  // github: the handle their early-access request gave, if any.
  creator(workspace) {
    const c = this.db.prepare(`SELECT i.email, r.github FROM memberships m JOIN identities i ON i.id = m.identity_id
      LEFT JOIN access_requests r ON r.email = i.email WHERE m.workspace = ? AND m.created = 1 ORDER BY m.at LIMIT 1`).get(workspace);
    return c ? { email: c.email, github: c.github || null } : null;
  }

  setPlan(workspace, plan, by = '') {
    this.db.prepare(`INSERT INTO plans (workspace, plan, set_by, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace) DO UPDATE SET plan = excluded.plan, set_by = excluded.set_by, at = excluded.at`).run(workspace, plan, String(by), this.now());
  }

  // Whether any of these emails belongs to the organization: a membership the hub has seen, whose person is still
  // there with that email as their own (they signed in with it, #470). spaces: the Workspaces registry.
  hasMember(workspace, emails, spaces) {
    if (!emails.length) return false;
    const db = spaces.get(workspace)?.db;
    return !!db && this.db.prepare(`SELECT i.email FROM memberships m JOIN identities i ON i.id = m.identity_id
      WHERE m.workspace = ? AND i.email IN (${emails.map(() => '?').join(',')})`).all(workspace, ...emails)
      .some(({ email }) => db.prepare('SELECT 1 FROM people WHERE email = ? AND verified_at IS NOT NULL').get(email));
  }

  // Whether a signed-in person created the organization (else the host did, on the command line).
  madeBySomeone(workspace) {
    return !!this.db.prepare('SELECT 1 FROM memberships WHERE workspace = ? AND created = 1').get(workspace);
  }

  // The organizations this identity created (whether they still exist is the caller's question).
  created(identity) {
    return this.db.prepare('SELECT workspace FROM memberships WHERE identity_id = ? AND created = 1').all(identity.id).map((m) => m.workspace);
  }

  // ── early access ──

  // Ask to come in. The same email again is the same request, brought up to date; it keeps the first source it had.
  request({ email, github = '', building = '', source = '', ip = '' }) {
    email = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');
    const t = this.now();
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    this.db.prepare(`INSERT INTO access_requests (email, github, building, source, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (email) DO UPDATE SET github = CASE WHEN excluded.github != '' THEN excluded.github ELSE github END,
        building = CASE WHEN excluded.building != '' THEN excluded.building ELSE building END,
        source = CASE WHEN source = '' THEN excluded.source ELSE source END, ip_hash = excluded.ip_hash, updated_at = excluded.updated_at`)
      .run(email, clip(github, 60).replace(/^@/, ''), clip(building, 2000), sourceOf(source), ip ? sha(ip).toString('hex') : '', t, t);
    return this.db.prepare('SELECT id, email, source, state, created_at, updated_at FROM access_requests WHERE email = ?').get(email);
  }

  requests({ state = '' } = {}) {
    return this.db.prepare(`SELECT id, email, github, building, source, state, created_at, updated_at, decided_by, decided_at FROM access_requests
      ${state ? 'WHERE state = ?' : ''} ORDER BY state = 'new' DESC, created_at DESC`).all(...(state ? [state] : []));
  }

  // Each request's source, when it was made, whether it was let in, and the workspaces its person created (#356).
  requestFunnel() {
    const rows = this.db.prepare(`SELECT r.id, r.source, r.state, r.created_at, m.workspace FROM access_requests r
      LEFT JOIN identities i ON i.email = r.email LEFT JOIN memberships m ON m.identity_id = i.id AND m.created = 1 ORDER BY r.id`).all();
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, { source: r.source, created_at: r.created_at, let_in: r.state === 'approved', workspaces: [] });
      if (r.workspace) out.get(r.id).workspaces.push(r.workspace);
    }
    return [...out.values()];
  }

  // Approve (returns { code }: the grant, shown once, for the link) or decline (mints nothing). Only a new
  // request is decided: { already } says how an earlier decision went, and nothing changes.
  decide(id, approve, by) {
    const r = this.db.prepare('SELECT * FROM access_requests WHERE id = ?').get(Number(id));
    if (!r) return null;
    if (r.state !== 'new') return { already: r.state };
    const t = this.now();
    this.db.prepare('UPDATE access_requests SET state = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'declined', String(by), t, r.id);
    if (!approve) return { state: 'declined' };
    const code = randomBytes(24).toString('base64url');
    this.db.prepare('INSERT INTO org_grants (hash, request_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(code), r.id, t, t + GRANT_MS);
    return { state: 'approved', code };
  }

  // Use a grant to create one organization: true once, for an unused grant before it expires.
  useGrant(code, identity, workspace = null) {
    if (!code) return false;
    const t = this.now();
    return this.db.prepare('UPDATE org_grants SET used_by = ?, used_at = ?, workspace = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(identity.id, t, workspace, sha(code), t).changes === 1;
  }

  // Give a grant back when the organization it was used for couldn't be made after all.
  returnGrant(code) {
    this.db.prepare('UPDATE org_grants SET used_by = NULL, used_at = NULL, workspace = NULL WHERE hash = ?').run(sha(code));
  }

  // Whether an early-access grant made this workspace (#355).
  madeByGrant(workspace) {
    return !!this.db.prepare('SELECT 1 FROM org_grants WHERE workspace = ? AND used_at IS NOT NULL').get(workspace);
  }

  // ── feedback (#295) ──

  // Store a piece of feedback. Refused (an Error with status and hint) when it's empty or too long, or when its
  // sender sent FEEDBACK_PER_DAY in the last day.
  giveFeedback({ kind, sender, email = '', workspace, text, item = '', context = {} }) {
    text = String(text ?? '').trim();
    const no = (status, message, hint) => Object.assign(new Error(message), { status, hint });
    if (!text) throw no(400, 'what happened?', 'Say what got in your way, or what didn\'t make sense, in a sentence or two.');
    if (text.length > FEEDBACK_MAX) throw no(400, `feedback is at most ${FEEDBACK_MAX} characters (this is ${text.length})`, 'Say the one thing that got in your way; leave logs out.');
    const t = this.now();
    const sent = this.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE kind = ? AND sender = ? AND workspace = ? AND created_at > ?').get(kind, sender, workspace, t - DAY_MS).n;
    if (sent >= FEEDBACK_PER_DAY) throw no(429, `${sender} sent ${FEEDBACK_PER_DAY} pieces of feedback today, the most a day allows`, 'Try again tomorrow, or add to one you sent.');
    const r = this.db.prepare(`INSERT INTO feedback (kind, sender, email, workspace, text, item, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, sender, String(email).toLowerCase(), workspace, text, String(item ?? '').slice(0, 80), JSON.stringify(context), t);
    return this.feedbackById(Number(r.lastInsertRowid));
  }

  feedbackById(id) {
    const f = this.db.prepare('SELECT * FROM feedback WHERE id = ?').get(Number(id));
    return f ? { ...f, context: JSON.parse(f.context) } : null;
  }

  // Newest first; state: new | approved | declined, or '' for all.
  feedbackList({ state = '' } = {}) {
    return this.db.prepare(`SELECT id FROM feedback ${state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC, id DESC`).all(...(state ? [state] : []))
      .map((r) => this.feedbackById(r.id));
  }

  // What one sender sent from one workspace (#297), newest first.
  feedbackFrom({ kind, sender, workspace }, limit = 50) {
    return this.db.prepare('SELECT id FROM feedback WHERE kind = ? AND sender = ? AND workspace = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(kind, sender, workspace, limit).map((r) => this.feedbackById(r.id));
  }

  // Proposed feedback whose sender hasn't been told it's fixed yet (#297).
  feedbackUntold() {
    return this.db.prepare("SELECT id FROM feedback WHERE proposal != '' AND told_at IS NULL ORDER BY id").all().map((r) => this.feedbackById(r.id));
  }

  // Mark it told; false when it already was, so each sender hears once.
  toldFeedback(id) {
    return this.db.prepare('UPDATE feedback SET told_at = ? WHERE id = ? AND told_at IS NULL').run(this.now(), Number(id)).changes === 1;
  }

  // Record an owner's decision on new feedback: approved (with the proposal it made) or declined (with an optional
  // note to the sender). Returns false when it was already decided.
  // auto: the feedback autonomy that proposed it at once, with no owner deciding (by is then '').
  decideFeedback(id, { approve, by, note = '', proposal = '', auto = '' }) {
    return this.db.prepare(`UPDATE feedback SET state = ?, note = ?, proposal = ?, decided_by = ?, decided_at = ?, auto = ? WHERE id = ? AND state = 'new'`)
      .run(approve ? 'approved' : 'declined', String(note ?? '').trim().slice(0, 1000), proposal, String(by), this.now(), auto, Number(id)).changes === 1;
  }

  // How far feedback goes on its own (#296), as a project's autonomy: ask (each piece waits for Approve or
  // Decline, the default), balanced (proposed at once; shaped items wait for an owner's OK) or full.
  feedbackAutonomy() {
    return this.db.prepare("SELECT value FROM settings WHERE key = 'feedback_autonomy'").get()?.value ?? 'ask';
  }

  setFeedbackAutonomy(level) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('feedback_autonomy', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(level);
  }

  // The identity for a verified email, made on first sign-in.
  identify(email, provider) {
    email = String(email ?? '').trim().toLowerCase();
    if (!email.includes('@')) throw new Error('a verified email is required');
    const t = this.now();
    this.db.prepare(`INSERT INTO identities (email, provider, created_at, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (email) DO UPDATE SET provider = excluded.provider, seen_at = excluded.seen_at`).run(email, String(provider), t, t);
    return this.identity(email);
  }

  identity(email) {
    return this.db.prepare('SELECT * FROM identities WHERE email = ?').get(String(email ?? '').trim().toLowerCase()) ?? null;
  }

  // kind: 'hub', or 'admin' for the admin host (shorter-lived: ADMIN_SESSION_MS).
  createSession(identityId, kind = 'hub') {
    const sid = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.prepare('DELETE FROM hub_sessions WHERE expires_at < ?').run(t);
    this.db.prepare('INSERT INTO hub_sessions (hash, identity_id, created_at, expires_at, kind) VALUES (?, ?, ?, ?, ?)')
      .run(sha(sid), identityId, t, t + (kind === 'admin' ? ADMIN_SESSION_MS : SESSION_MS), kind);
    return sid;
  }

  // A session of this kind only: an app session never opens the admin host, nor an admin session the app.
  verifySession(sid, kind = 'hub') {
    if (!sid || sid.length < 20) return null;
    return this.db.prepare(`SELECT i.* FROM hub_sessions s JOIN identities i ON i.id = s.identity_id
      WHERE s.hash = ? AND s.expires_at > ? AND s.kind = ?`).get(sha(sid), this.now(), kind) ?? null;
  }

  deleteSession(sid) {
    if (sid) this.db.prepare('DELETE FROM hub_sessions WHERE hash = ?').run(sha(sid));
  }

  // Remember that this email belongs to a workspace (no-op for an email the hub has never seen sign in).
  // Only for an email its owner just proved there: their sign-in, or the workspace they made (#470).
  join(email, workspace, { created = false } = {}) {
    const i = this.identity(email);
    if (!i) return;
    this.db.prepare(`INSERT INTO memberships (identity_id, workspace, created, at) VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET created = MAX(created, excluded.created)`).run(i.id, workspace, created ? 1 : 0, this.now());
  }

  // An identity's organizations, checked against each workspace's people: { workspace, handle, role, created }.
  // spaces: the Workspaces registry. Memberships whose workspace or person is gone are forgotten; a person only
  // counts with the email as their own (they signed in with it), never one an owner typed for them (#470).
  orgsOf(identity, spaces) {
    const out = [];
    for (const m of this.db.prepare('SELECT * FROM memberships WHERE identity_id = ? ORDER BY at').all(identity.id)) {
      const hub = spaces.get(m.workspace);
      const p = hub?.db.prepare('SELECT handle, role FROM people WHERE email = ? AND verified_at IS NOT NULL ORDER BY id').get(identity.email);
      if (!p) {
        this.db.prepare('DELETE FROM memberships WHERE identity_id = ? AND workspace = ?').run(identity.id, m.workspace);
        continue;
      }
      out.push({ workspace: m.workspace, handle: p.handle, role: p.role, created: !!m.created });
    }
    return out;
  }

  // Organizations this identity created that still exist.
  createdBy(identity, spaces) {
    return this.db.prepare('SELECT workspace FROM memberships WHERE identity_id = ? AND created = 1').all(identity.id)
      .filter((m) => spaces.has(m.workspace)).length;
  }

  close() {
    this.db.close();
  }
}
