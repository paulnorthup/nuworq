// Device login: a CLI shows a short code, a signed-in person approves it in the browser, and the CLI's
// next poll gets an agent token minted by that person. The shape of OAuth's device flow (RFC 8628).
// Only hashes of the codes are stored, and the token is minted when it is collected, so it is never stored.
import { createHash, randomBytes, randomInt } from 'node:crypto';

export const DEVICE_MS = 10 * 60_000;
export const DEVICE_INTERVAL = 5; // seconds between polls
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so a code never spells a word
const sha = (s) => createHash('sha256').update(String(s)).digest();
// "wdjb mjht", "WDJB-MJHT" and "wdjbmjht" are the same code.
const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const machineOf = (m) => String(m ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 30) || 'machine';
// Who may connect their own machines: everyone but viewers.
const CAN_APPROVE = ['owner', 'steward', 'member'];

export class Devices {
  constructor(auth) {
    this.auth = auth;
    this.db = auth.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_requests (
        id           INTEGER PRIMARY KEY,
        device_hash  BLOB UNIQUE NOT NULL,     -- sha256 of the device code the CLI polls with
        user_hash    BLOB UNIQUE NOT NULL,     -- sha256 of the code the person types or follows
        machine      TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_poll_at INTEGER,
        approved_by  INTEGER,                  -- the person who approved; the token is minted by them
        decided_at   INTEGER,
        denied       INTEGER NOT NULL DEFAULT 0,
        token_name   TEXT                      -- set once the CLI has collected its token
      );`);
    // A staffing request (#490): a connected machine asks to staff a project; approving it mints no token.
    try { this.db.exec('ALTER TABLE device_requests ADD COLUMN staff TEXT'); } catch { /* already there */ }
  }

  // staff: { project, budget, token }, for a machine asking to staff a project rather than for a token.
  start(machine, staff = null) {
    const t = this.auth.now();
    this.db.prepare('DELETE FROM device_requests WHERE expires_at < ?').run(t - DEVICE_MS);
    const device = 'nwd_' + randomBytes(32).toString('base64url');
    const code = Array.from({ length: 8 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
    this.db.prepare('INSERT INTO device_requests (device_hash, user_hash, machine, created_at, expires_at, staff) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha(device), sha(code), machineOf(machine), t, t + DEVICE_MS, staff ? JSON.stringify(staff) : null);
    return { device_code: device, user_code: `${code.slice(0, 4)}-${code.slice(4)}`, interval: DEVICE_INTERVAL, expires_in: DEVICE_MS / 1000 };
  }

  // The open request a person is about to approve, or why there is none.
  peek(userCode) {
    const r = this.db.prepare('SELECT * FROM device_requests WHERE user_hash = ?').get(sha(normCode(userCode)));
    if (!r) return { ok: false, error: 'no request has that code' };
    if (r.decided_at) return { ok: false, error: r.denied ? 'this request was denied' : 'this request was already approved' };
    if (r.expires_at < this.auth.now()) return { ok: false, error: 'this code has expired' };
    return { ok: true, request: { ...r, staff: r.staff ? JSON.parse(r.staff) : null } };
  }

  decide(userCode, handle, approve) {
    const peek = this.peek(userCode);
    if (!peek.ok) throw new Error(peek.error);
    const p = this.auth.person(handle);
    if (!p) throw new Error('only a person can approve a device');
    // Staffing changes a project's settings, which only an owner may (PERSON_CAN in src/core.js).
    if (approve && peek.request.staff && p.role !== 'owner') throw new Error(`a ${p.role} can't staff projects`);
    if (approve && !CAN_APPROVE.includes(p.role)) throw new Error(`a ${p.role} can't connect machines`);
    this.db.prepare('UPDATE device_requests SET approved_by = ?, decided_at = ?, denied = ? WHERE id = ?')
      .run(approve ? p.id : null, this.auth.now(), approve ? 0 : 1, peek.request.id);
    return { machine: peek.request.machine, staff: peek.request.staff, name: approve && !peek.request.staff ? `${p.handle}@${peek.request.machine}` : null };
  }

  // The CLI's poll: pending, slow_down, or (once) the token. Throws when the request is over.
  poll(deviceCode) {
    const r = this.db.prepare('SELECT * FROM device_requests WHERE device_hash = ?').get(sha(String(deviceCode ?? '').trim()));
    if (!r) throw Object.assign(new Error('unknown device code'), { code: 'invalid' });
    const t = this.auth.now();
    if (r.token_name) throw Object.assign(new Error('this request already gave out its token'), { code: 'used' });
    if (r.denied) throw Object.assign(new Error('the request was denied'), { code: 'denied' });
    if (!r.decided_at) {
      if (r.expires_at < t) throw Object.assign(new Error('the code expired before anyone approved it'), { code: 'expired' });
      const early = r.last_poll_at != null && t - r.last_poll_at < DEVICE_INTERVAL * 1000;
      this.db.prepare('UPDATE device_requests SET last_poll_at = ? WHERE id = ?').run(t, r.id);
      return { status: early ? 'slow_down' : 'pending', interval: DEVICE_INTERVAL };
    }
    const p = this.db.prepare('SELECT * FROM people WHERE id = ?').get(r.approved_by);
    if (!p) throw Object.assign(new Error('the person who approved it is no longer here'), { code: 'denied' });
    if (r.staff) return { status: 'approved', person: `@${p.handle}` }; // applied when approved; no token
    // Named <person>@<machine>; a second connect of the same machine gets -2, -3, …
    const root = `${p.handle}@${r.machine}`.slice(0, 56);
    let name = root;
    for (let n = 2; this.db.prepare('SELECT 1 FROM tokens WHERE name = ?').get(name); n++) name = `${root}-${n}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const token = this.auth.createToken(name, 'agent', { mintedBy: p.handle });
      this.db.prepare('UPDATE device_requests SET token_name = ? WHERE id = ?').run(name, r.id);
      this.db.exec('COMMIT');
      return { status: 'approved', token, name, person: `@${p.handle}` };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
