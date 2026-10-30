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

const sha = (s) => createHash('sha256').update(String(s)).digest();
export const ORG_CAP = 5; // organizations one person may create, unless the host says otherwise
export const GRANT_MS = 14 * 24 * 60 * 60 * 1000; // how long an early-access grant is good for
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000; // a sign-in to the admin host lasts a working day

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
    return this.db.prepare('SELECT plan FROM plans WHERE workspace = ?').get(workspace)?.plan ?? null;
  }

  setPlan(workspace, plan, by = '') {
    this.db.prepare(`INSERT INTO plans (workspace, plan, set_by, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (workspace) DO UPDATE SET plan = excluded.plan, set_by = excluded.set_by, at = excluded.at`).run(workspace, plan, String(by), this.now());
  }

  // Whether any of these emails belongs to the organization (a membership the hub has seen).
  hasMember(workspace, emails) {
    if (!emails.length) return false;
    return !!this.db.prepare(`SELECT 1 FROM memberships m JOIN identities i ON i.id = m.identity_id
      WHERE m.workspace = ? AND i.email IN (${emails.map(() => '?').join(',')})`).get(workspace, ...emails);
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

  // Ask to come in. The same email again is the same request, brought up to date.
  request({ email, github = '', building = '', ip = '' }) {
    email = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('a valid email is required');
    const t = this.now();
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    this.db.prepare(`INSERT INTO access_requests (email, github, building, ip_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (email) DO UPDATE SET github = CASE WHEN excluded.github != '' THEN excluded.github ELSE github END,
        building = CASE WHEN excluded.building != '' THEN excluded.building ELSE building END, ip_hash = excluded.ip_hash, updated_at = excluded.updated_at`)
      .run(email, clip(github, 60).replace(/^@/, ''), clip(building, 2000), ip ? sha(ip).toString('hex') : '', t, t);
    return this.db.prepare('SELECT id, email, state, created_at, updated_at FROM access_requests WHERE email = ?').get(email);
  }

  requests({ state = '' } = {}) {
    return this.db.prepare(`SELECT id, email, github, building, state, created_at, updated_at, decided_by, decided_at FROM access_requests
      ${state ? 'WHERE state = ?' : ''} ORDER BY state = 'new' DESC, created_at DESC`).all(...(state ? [state] : []));
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
  useGrant(code, identity) {
    if (!code) return false;
    const t = this.now();
    return this.db.prepare('UPDATE org_grants SET used_by = ?, used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(identity.id, t, sha(code), t).changes === 1;
  }

  // Give a grant back when the organization it was used for couldn't be made after all.
  returnGrant(code) {
    this.db.prepare('UPDATE org_grants SET used_by = NULL, used_at = NULL WHERE hash = ?').run(sha(code));
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

  // Remember that this email belongs to a workspace (no-op for an email the hub has never seen sign in:
  // it is recorded when they first do, from the workspaces' people).
  join(email, workspace, { created = false } = {}) {
    const i = this.identity(email);
    if (!i) return;
    this.db.prepare(`INSERT INTO memberships (identity_id, workspace, created, at) VALUES (?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET created = MAX(created, excluded.created)`).run(i.id, workspace, created ? 1 : 0, this.now());
  }

  // An identity's organizations, checked against each workspace's people: { workspace, handle, role, created }.
  // spaces: the Workspaces registry. Memberships whose workspace or person is gone are forgotten.
  orgsOf(identity, spaces) {
    const out = [];
    for (const m of this.db.prepare('SELECT * FROM memberships WHERE identity_id = ? ORDER BY at').all(identity.id)) {
      const hub = spaces.get(m.workspace);
      const p = hub?.db.prepare('SELECT handle, role FROM people WHERE email = ? ORDER BY id').get(identity.email);
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
