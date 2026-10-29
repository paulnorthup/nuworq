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
      );`);
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

  createSession(identityId) {
    const sid = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.prepare('DELETE FROM hub_sessions WHERE expires_at < ?').run(t);
    this.db.prepare('INSERT INTO hub_sessions (hash, identity_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(sid), identityId, t, t + SESSION_MS);
    return sid;
  }

  verifySession(sid) {
    if (!sid || sid.length < 20) return null;
    return this.db.prepare(`SELECT i.* FROM hub_sessions s JOIN identities i ON i.id = s.identity_id
      WHERE s.hash = ? AND s.expires_at > ?`).get(sha(sid), this.now()) ?? null;
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
