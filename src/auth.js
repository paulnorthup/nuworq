// Tokens and browser sessions. Only hashes are stored; plaintext tokens are shown once.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_MS = 30 * 24 * 3600_000;
const ROLES = ['human', 'agent'];
const sha = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export class Auth {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
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
  }

  createToken(name, role = 'agent') {
    name = String(name ?? '').trim();
    if (!/^[\w.@-]{1,60}$/.test(name)) throw new Error('token name: 1–60 letters, digits, ., _, @ or -');
    if (!ROLES.includes(role)) throw new Error('role must be "human" or "agent"');
    if (this.db.prepare('SELECT 1 FROM tokens WHERE name = ?').get(name)) throw new Error(`a token named "${name}" already exists (revoke it first, or pick another name)`);
    const token = 'trl_' + randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO tokens (name, role, hash, prefix, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, role, sha(token), token.slice(0, 8), this.now());
    return token;
  }

  listTokens() {
    return this.db.prepare('SELECT id, name, role, prefix, created_at, last_used_at, revoked_at FROM tokens ORDER BY id').all();
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
    return { id: match.id, name: match.name, role: match.role };
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
    const s = this.db.prepare(`SELECT t.id, t.name, t.role FROM sessions s JOIN tokens t ON t.id = s.token_id
      WHERE s.hash = ? AND s.expires_at > ? AND t.revoked_at IS NULL`).get(sha(sid), this.now());
    return s ? { id: s.id, name: s.name, role: s.role } : null;
  }

  deleteSession(sid) {
    if (sid) this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha(sid));
  }

  hasHumanToken() {
    return !!this.db.prepare(`SELECT 1 FROM tokens WHERE role = 'human' AND revoked_at IS NULL`).get();
  }
}
