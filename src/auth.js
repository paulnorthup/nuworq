// Tokens and browser sessions. Only hashes are stored; plaintext tokens are shown once.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_MS = 30 * 24 * 3600_000;
const ROLES = ['human', 'agent'];
// What a person may do here: owner > steward > member > viewer (see PERSON_CAN in core.js).
export const PERSON_ROLES = ['owner', 'steward', 'member', 'viewer'];
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const sha = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export class Auth {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS people (
        id         INTEGER PRIMARY KEY,
        handle     TEXT UNIQUE NOT NULL,        -- acts as "@handle" on the record
        name       TEXT NOT NULL DEFAULT '',
        email      TEXT NOT NULL DEFAULT '',
        role       TEXT NOT NULL,               -- owner | steward | member | viewer
        created_at INTEGER NOT NULL
      );`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id           INTEGER PRIMARY KEY,
        name         TEXT UNIQUE NOT NULL,
        role         TEXT NOT NULL,            -- human | agent
        hash         BLOB NOT NULL,            -- sha256 of the token
        prefix       TEXT NOT NULL,            -- first 8 characters, for display and lookup
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS tokens_prefix ON tokens (prefix);
      CREATE TABLE IF NOT EXISTS sessions (
        hash       BLOB PRIMARY KEY,           -- sha256 of the session id
        token_id   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
    try { db.exec('ALTER TABLE tokens ADD COLUMN person_id INTEGER'); } catch { /* already there */ }
    // Human tokens from before people existed: each becomes an owner, so nobody loses access.
    for (const t of db.prepare(`SELECT id, name FROM tokens WHERE role = 'human' AND person_id IS NULL`).all()) {
      const handle = Auth.handleOf(t.name);
      const p = this.person(handle) ?? this.addPerson(handle, 'owner');
      db.prepare('UPDATE tokens SET person_id = ? WHERE id = ?').run(p.id, t.id);
    }
  }

  // A usable handle from any name: "Paul N." → "paul-n".
  static handleOf(name) {
    return String(name ?? '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '').slice(0, 40) || 'person';
  }

  // ── people ──

  person(handle) {
    return this.db.prepare('SELECT * FROM people WHERE handle = ?').get(String(handle ?? '').replace(/^@/, '').toLowerCase()) ?? null;
  }

  addPerson(handle, role = 'member', { name = '', email = '' } = {}) {
    handle = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!HANDLE.test(handle)) throw new Error('handle: 1–40 lowercase letters, digits, ., _ or -, starting with a letter or digit');
    if (!PERSON_ROLES.includes(role)) throw new Error(`role must be one of ${PERSON_ROLES.join(', ')}`);
    if (this.person(handle)) throw new Error(`@${handle} already exists`);
    const r = this.db.prepare('INSERT INTO people (handle, name, email, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(handle, String(name).trim(), String(email).trim().toLowerCase(), role, this.now());
    return this.db.prepare('SELECT * FROM people WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  listPeople() {
    return this.db.prepare('SELECT id, handle, name, email, role, created_at FROM people ORDER BY id').all();
  }

  setRole(handle, role) {
    if (!PERSON_ROLES.includes(role)) throw new Error(`role must be one of ${PERSON_ROLES.join(', ')}`);
    const p = this.person(handle);
    if (!p) throw new Error(`no person @${String(handle).replace(/^@/, '')}`);
    if (p.role === 'owner' && role !== 'owner' && this.db.prepare(`SELECT COUNT(*) AS n FROM people WHERE role = 'owner'`).get().n === 1) {
      throw new Error(`@${p.handle} is the last owner; make someone else an owner first`);
    }
    this.db.prepare('UPDATE people SET role = ? WHERE id = ?').run(role, p.id);
    return { ...p, role };
  }

  // ── tokens ──

  // Human tokens belong to a person (by default one named like the token, created as an owner if new).
  createToken(name, role = 'agent', { person, personRole = 'owner' } = {}) {
    name = String(name ?? '').trim();
    if (!/^[\w.@-]{1,60}$/.test(name)) throw new Error('token name: 1–60 letters, digits, ., _, @ or -');
    if (!ROLES.includes(role)) throw new Error('role must be "human" or "agent"');
    if (this.db.prepare('SELECT 1 FROM tokens WHERE name = ?').get(name)) throw new Error(`a token named "${name}" already exists (revoke it first, or pick another name)`);
    let personId = null;
    if (role === 'human') {
      const handle = person ? String(person).replace(/^@/, '').toLowerCase() : Auth.handleOf(name);
      personId = (this.person(handle) ?? this.addPerson(handle, personRole)).id;
    }
    const token = 'trl_' + randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO tokens (name, role, hash, prefix, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, role, sha(token), token.slice(0, 8), personId, this.now());
    return token;
  }

  listTokens() {
    return this.db.prepare(`SELECT t.id, t.name, t.role, t.prefix, t.created_at, t.last_used_at, t.revoked_at, p.handle AS person
      FROM tokens t LEFT JOIN people p ON p.id = t.person_id ORDER BY t.id`).all();
  }

  // Who a token or session acts as: agents by their token, humans as their person.
  identity(row) {
    if (!row) return null;
    const out = { id: row.id, name: row.name, role: row.role };
    if (row.role === 'human') {
      const p = row.person_id != null ? this.db.prepare('SELECT * FROM people WHERE id = ?').get(row.person_id) : null;
      if (!p) return null;
      out.person = { handle: p.handle, role: p.role };
    }
    return out;
  }

  revoke(nameOrId) {
    const t = this.db.prepare('SELECT * FROM tokens WHERE name = ? OR id = ?').get(String(nameOrId), Number(nameOrId) || -1);
    if (!t) return null;
    this.db.prepare('UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(this.now(), t.id);
    this.db.prepare('DELETE FROM sessions WHERE token_id = ?').run(t.id);
    return { id: t.id, name: t.name, role: t.role };
  }

  verifyToken(token) {
    token = String(token ?? '').trim();
    if (!token.startsWith('trl_') || token.length < 20) return null;
    const h = sha(token);
    const match = this.db.prepare('SELECT * FROM tokens WHERE prefix = ? AND revoked_at IS NULL').all(token.slice(0, 8))
      .find((t) => same(Buffer.from(t.hash), h));
    if (!match) return null;
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(this.now(), match.id);
    return this.identity(match);
  }

  createSession(tokenId) {
    const sid = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
    this.db.prepare('INSERT INTO sessions (hash, token_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(sid), tokenId, t, t + SESSION_MS);
    return sid;
  }

  verifySession(sid) {
    if (!sid || sid.length < 20) return null;
    const s = this.db.prepare(`SELECT t.id, t.name, t.role, t.person_id FROM sessions s JOIN tokens t ON t.id = s.token_id
      WHERE s.hash = ? AND s.expires_at > ? AND t.revoked_at IS NULL`).get(sha(sid), this.now());
    return this.identity(s);
  }

  deleteSession(sid) {
    if (sid) this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(sid));
  }

  hasHumanToken() {
    return !!this.db.prepare(`SELECT 1 FROM tokens WHERE role = 'human' AND revoked_at IS NULL`).get();
  }
}
