// Tokens and browser sessions. Only hashes are stored; plaintext tokens are shown once.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_MS = 30 * 24 * 3600_000;
export const USED_EVERY_MS = 60_000; // a token's last-used time is written at most this often
export const INVITE_MS = 7 * 24 * 3600_000;
const ROLES = ['human', 'agent'];
// What a person may do here: owner > steward > member > viewer (see PERSON_CAN in core.js).
export const PERSON_ROLES = ['owner', 'steward', 'member', 'viewer'];
// What an agent token may do; reading, asking, proposing and notes are always allowed (see core.js).
export const POWERS = ['shape', 'build', 'review'];
// The power to act as an operator (#609), given only by name: never part of a token's default powers.
export const OPERATE = 'operate';
// Whose agent tokens may act as an operator without it: a steward's or an owner's.
const OPERATOR_MINTERS = ['owner', 'steward'];
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const sha = (s) => createHash('sha256').update(String(s)).digest();
const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const scopeOf = (s) => (s ? s.split(',') : null); // null: every project
// Tokens start nwq_ (invites nwi_). Tokens made before the rename start trl_ and still work.
const TOKEN_PREFIXES = ['nwq_', 'trl_'];

export class Auth {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    // The people table itself is in src/db.js, so the hub can route attention without an Auth.
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        id           INTEGER PRIMARY KEY,
        name         TEXT UNIQUE NOT NULL,
        role         TEXT NOT NULL,            -- human | agent
        hash         BLOB NOT NULL,            -- sha256 of the token
        prefix       TEXT NOT NULL,            -- first 8 characters, for display and lookup
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER,
        projects     TEXT NOT NULL DEFAULT ''  -- agent tokens: comma-separated project slugs it may reach; '' = all
      );
      CREATE INDEX IF NOT EXISTS tokens_prefix ON tokens (prefix);
      CREATE TABLE IF NOT EXISTS sessions (
        hash       BLOB PRIMARY KEY,           -- sha256 of the session id
        token_id   INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );`);
    for (const sql of [
      "ALTER TABLE tokens ADD COLUMN projects TEXT NOT NULL DEFAULT ''", // agent tokens: the projects it may reach
      'ALTER TABLE tokens ADD COLUMN person_id INTEGER', // human tokens: the person they log in as
      'ALTER TABLE tokens ADD COLUMN minted_by INTEGER', // agent tokens: the person accountable for them
      'ALTER TABLE tokens ADD COLUMN runner TEXT', // or a named runner (CI, cloud agents) that outlives any one person
      'ALTER TABLE tokens ADD COLUMN powers TEXT', // JSON subset of shape/build/review; NULL means all
    ]) {
      try { db.exec(sql); } catch { /* already there */ }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS invites (
        id         INTEGER PRIMARY KEY,
        hash       BLOB UNIQUE NOT NULL,        -- sha256 of the invite token; the link is shown once
        role       TEXT NOT NULL,
        email      TEXT NOT NULL DEFAULT '',    -- shown on the invite; signing in with GitHub/Google as this email uses it
        created_by TEXT NOT NULL DEFAULT '',    -- "@handle" of the owner who invited
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at    INTEGER,
        used_by    TEXT,
        revoked_at INTEGER
      );`);
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

  // verified: they proved the email is theirs (signed in with it), or the host vouches for it. Otherwise the email
  // is only a hint for matching their first sign-in, never who they are (#470).
  addPerson(handle, role = 'member', { name = '', email = '', verified = false } = {}) {
    handle = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!HANDLE.test(handle)) throw new Error('handle: 1–40 lowercase letters, digits, ., _ or -, starting with a letter or digit');
    if (!PERSON_ROLES.includes(role)) throw new Error(`role must be one of ${PERSON_ROLES.join(', ')}`);
    if (this.person(handle)) throw new Error(`@${handle} already exists`);
    email = String(email).trim().toLowerCase();
    const t = this.now();
    const r = this.db.prepare('INSERT INTO people (handle, name, email, role, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(handle, String(name).trim(), email, role, t, verified && email ? t : null);
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

  // ── invites: single-use, expiring links that add a person with a role ──

  createInvite(role, { email = '', by = '', ttl = INVITE_MS } = {}) {
    if (!PERSON_ROLES.includes(role)) throw new Error(`role must be one of ${PERSON_ROLES.join(', ')}`);
    const token = 'nwi_' + randomBytes(24).toString('base64url');
    const t = this.now();
    const r = this.db.prepare('INSERT INTO invites (hash, role, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha(token), role, String(email).trim().toLowerCase(), String(by), t, t + ttl);
    return { id: Number(r.lastInsertRowid), token, role, expires_at: t + ttl };
  }

  listInvites() {
    const t = this.now();
    return this.db.prepare('SELECT id, role, email, created_by, created_at, expires_at, used_at, used_by, revoked_at FROM invites ORDER BY id').all()
      .map((i) => ({ ...i, state: i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at < t ? 'expired' : 'open' }));
  }

  revokeInvite(id) {
    const r = this.db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(this.now(), Number(id));
    if (!r.changes) throw new Error(`no open invite ${id}`);
  }

  // What an invite link offers, without using it (so the page can say "you're invited as steward").
  peekInvite(token) {
    const i = this.db.prepare('SELECT * FROM invites WHERE hash = ?').get(sha(String(token ?? '').trim()));
    if (!i) return { ok: false, error: 'this invite link is not valid' };
    if (i.used_at) return { ok: false, error: 'this invite was already used' };
    if (i.revoked_at) return { ok: false, error: 'this invite was revoked' };
    if (i.expires_at < this.now()) return { ok: false, error: 'this invite has expired' };
    return { ok: true, invite: i };
  }

  // Use an invite: the person is created with its role and signed in (a login token they never see, plus a session).
  acceptInvite(token, handle) {
    const peek = this.peekInvite(token);
    if (!peek.ok) throw new Error(peek.error);
    const inv = peek.invite;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const p = this.addPerson(handle, inv.role, { email: inv.email });
      this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(this.now(), p.handle, inv.id);
      const name = `${p.handle}-invite-${inv.id}`;
      this.createToken(name, 'human', { person: p.handle });
      const tokenId = this.db.prepare('SELECT id FROM tokens WHERE name = ?').get(name).id;
      const sid = this.createSession(tokenId);
      this.db.exec('COMMIT');
      return { person: p, sid, invitedBy: inv.created_by };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Sign in with a verified email from GitHub or Google: the person who signed in with it before, else the open
  // invite bound to it (it sets their role; a new person gets a handle from the email), else a person someone made
  // by typing the email, else null. A role typed for an email before its owner ever signed in doesn't take effect
  // on its own (#470): unless an invite they accepted gave it, they come in as a viewer, and held is the role an
  // owner may now confirm.
  signInByEmail(email, provider) {
    email = String(email ?? '').trim().toLowerCase();
    if (!email.includes('@')) return null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const t = this.now();
      let p = this.db.prepare('SELECT * FROM people WHERE email = ? AND verified_at IS NOT NULL ORDER BY id').get(email), invitedBy, held, joined = false;
      if (!p) {
        const typed = this.db.prepare('SELECT * FROM people WHERE email = ? AND verified_at IS NULL ORDER BY id').get(email);
        const inv = this.db.prepare('SELECT * FROM invites WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at >= ? ORDER BY id').get(email, t);
        if (!typed && !inv) { this.db.exec('ROLLBACK'); return null; }
        // A verified sign-in never vouches for a session it didn't create (#612): whoever opened an invite link to this
        // email was signed in as this row without proving it, so what they hold ends before the row becomes verified.
        if (typed) this.revokeUnproven(typed);
        if (inv) {
          if (typed) {
            this.db.prepare('UPDATE people SET role = ?, verified_at = ? WHERE id = ?').run(inv.role, t, typed.id);
            p = { ...typed, role: inv.role, verified_at: t };
          } else {
            const stem = Auth.handleOf(email.split('@')[0]).slice(0, 36);
            let handle = stem;
            for (let n = 2; this.person(handle); n++) handle = `${stem}-${n}`;
            p = this.addPerson(handle, inv.role, { email, verified: true });
          }
          this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(t, p.handle, inv.id);
          invitedBy = inv.created_by;
          joined = true;
        } else {
          // Made by accepting an invite link to this email: that invite gave the role, so it stands.
          const accepted = this.db.prepare('SELECT 1 FROM invites WHERE used_by = ? AND email = ? AND used_at >= ?').get(typed.handle, email, typed.created_at);
          const role = accepted ? typed.role : 'viewer';
          if (role !== typed.role) held = typed.role;
          joined = !accepted; // accepting the link already said they joined
          this.db.prepare('UPDATE people SET role = ?, verified_at = ? WHERE id = ?').run(role, t, typed.id);
          p = { ...typed, role, verified_at: t };
        }
      }
      // One login token per person and provider, never shown: sessions hang off it, and revoking it signs them out.
      const stem = `${p.handle}-${provider}`.slice(0, 50);
      let tok = this.db.prepare(`SELECT id FROM tokens WHERE (name = ? OR name LIKE ?) AND role = 'human' AND person_id = ? AND revoked_at IS NULL ORDER BY id DESC`)
        .get(stem, `${stem}-%`, p.id);
      if (!tok) {
        let name = stem;
        for (let n = 2; this.db.prepare('SELECT 1 FROM tokens WHERE name = ?').get(name); n++) name = `${stem}-${n}`;
        this.createToken(name, 'human', { person: p.handle });
        tok = this.db.prepare('SELECT id FROM tokens WHERE name = ?').get(name);
      }
      const sid = this.createSession(tok.id);
      this.db.exec('COMMIT');
      return { person: p, sid, invitedBy, joined, held };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── tokens ──

  // Human tokens belong to a person (by default one named like the token, created as an owner if new).
  // Agent tokens may name who minted them (a person) or the runner they belong to, and limit their powers.
  // projects: slugs an agent token is limited to; empty means every project.
  createToken(name, role = 'agent', { person, personRole = 'owner', mintedBy, runner, powers, projects = [] } = {}) {
    name = String(name ?? '').trim();
    if (!/^[\w.@-]{1,60}$/.test(name)) throw new Error('token name: 1–60 letters, digits, ., _, @ or -');
    if (!ROLES.includes(role)) throw new Error('role must be "human" or "agent"');
    if (projects.length && role !== 'agent') throw new Error('only agent tokens can be limited to projects (humans see every project)');
    if (this.db.prepare('SELECT 1 FROM tokens WHERE name = ?').get(name)) throw new Error(`a token named "${name}" already exists (revoke it first, or pick another name)`);
    let personId = null, minter = null, power = null;
    if (role === 'human') {
      const handle = person ? String(person).replace(/^@/, '').toLowerCase() : Auth.handleOf(name);
      personId = (this.person(handle) ?? this.addPerson(handle, personRole)).id;
    } else {
      if (mintedBy && runner) throw new Error('a token is minted by a person or belongs to a runner, not both');
      if (mintedBy) {
        minter = this.person(mintedBy)?.id;
        if (!minter) throw new Error(`no person @${String(mintedBy).replace(/^@/, '')}`);
      }
      if (powers != null) {
        const list = (Array.isArray(powers) ? powers : String(powers).split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        const bad = list.filter((x) => ![...POWERS, OPERATE].includes(x));
        if (bad.length || !list.length) throw new Error(`powers: one or more of ${[...POWERS, OPERATE].join(', ')}`);
        power = JSON.stringify([...new Set(list)]);
      }
    }
    const token = TOKEN_PREFIXES[0] + randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO tokens (name, role, hash, prefix, person_id, minted_by, runner, powers, created_at, projects) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, role, sha(token), token.slice(0, 8), personId, minter, runner ? String(runner) : null, power, this.now(), projects.join(','));
    return token;
  }

  listTokens() {
    return this.db.prepare(`SELECT t.id, t.name, t.role, t.prefix, t.created_at, t.last_used_at, t.revoked_at, t.projects, p.handle AS person,
        m.handle AS minted_by, t.runner, t.powers
      FROM tokens t LEFT JOIN people p ON p.id = t.person_id LEFT JOIN people m ON m.id = t.minted_by ORDER BY t.id`).all()
      .map((t) => ({ ...t, powers: t.role === 'agent' ? (t.powers ? JSON.parse(t.powers) : [...POWERS]) : null }));
  }

  // Removing a person revokes their logins and every agent token they minted. Runner tokens stay.
  // Every token (and so every session) an unverified person row holds or minted (#612), revoked before a verified
  // sign-in claims the row. Returns how many.
  revokeUnproven(p) {
    const ids = this.db.prepare('SELECT id FROM tokens WHERE (person_id = ? OR minted_by = ?) AND revoked_at IS NULL').all(p.id, p.id).map((r) => r.id);
    for (const id of ids) this.revoke(id);
    return ids.length;
  }

  removePerson(handle) {
    const p = this.person(handle);
    if (!p) throw new Error(`no person @${String(handle).replace(/^@/, '')}`);
    if (p.role === 'owner' && this.db.prepare(`SELECT COUNT(*) AS n FROM people WHERE role = 'owner'`).get().n === 1) {
      throw new Error(`@${p.handle} is the last owner; make someone else an owner first`);
    }
    const ids = this.db.prepare('SELECT id FROM tokens WHERE person_id = ? OR minted_by = ?').all(p.id, p.id).map((t) => t.id);
    for (const id of ids) this.revoke(id);
    this.db.prepare('DELETE FROM people WHERE id = ?').run(p.id);
    return { handle: p.handle, revoked: ids.length };
  }

  // Who a token or session acts as: agents by their token, humans as their person.
  identity(row) {
    if (!row) return null;
    const out = { id: row.id, name: row.name, role: row.role };
    if (row.role === 'agent') {
      const full = this.db.prepare('SELECT t.powers, t.projects, t.minted_by, m.role AS minter_role FROM tokens t LEFT JOIN people m ON m.id = t.minted_by WHERE t.id = ?').get(row.id);
      out.powers = full?.powers ? JSON.parse(full.powers) : [...POWERS];
      out.projects = scopeOf(full?.projects);
      // May it act as an operator (#609)? A steward's or owner's token, one made on the hub host (no person minted
      // it), or one given the operate power by name. A member's device login isn't, nor is a runner's token.
      out.operator = !row.runner && (out.powers.includes(OPERATE) || full?.minted_by == null || OPERATOR_MINTERS.includes(full?.minter_role));
      if (row.runner) out.runner = row.runner; // a runner's token: the runner it reports as (#171)
    }
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
    if (!TOKEN_PREFIXES.some((p) => token.startsWith(p)) || token.length < 20) return null;
    const h = sha(token);
    this._byPrefix ??= this.db.prepare('SELECT * FROM tokens WHERE prefix = ? AND revoked_at IS NULL');
    const match = this._byPrefix.all(token.slice(0, 8)).find((t) => same(Buffer.from(t.hash), h));
    if (!match) return null;
    // Last used to the minute (#516): every bearer request writing it held the write lock and waited on a sync.
    const t = this.now();
    if (match.last_used_at == null || t - match.last_used_at >= USED_EVERY_MS) {
      this._used ??= this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?');
      this._used.run(t, match.id);
    }
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
