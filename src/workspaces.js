// Many workspaces on one hub process: each is one company, in its own SQLite file, so nothing
// can leak between them and export or delete is one file. A workspace is just a Hub (and the
// server's Auth on the same db), opened on first use.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hub, UserError } from './core.js';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const RESERVED = new Set(['www', 'api', 'app', 'admin', 'w', 'static', 'login']);

export class Workspaces {
  constructor({ dir, clock } = {}) {
    if (!dir) throw new Error('Workspaces needs a directory');
    this.dir = dir;
    this.clock = clock;
    this.open = new Map(); // slug → Hub
    mkdirSync(dir, { recursive: true });
  }

  file(slug) {
    return join(this.dir, `${slug}.db`);
  }

  static check(slug) {
    const s = String(slug ?? '').trim().toLowerCase();
    if (!SLUG.test(s) || s.length < 2) throw new UserError(`"${slug}" is not a workspace name`, { hint: '2–40 characters: lowercase letters, digits and dashes, e.g. "acme".' });
    if (RESERVED.has(s)) throw new UserError(`"${s}" is reserved; pick another workspace name`);
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
      hub = new Hub({ file: this.file(s), ...(this.clock ? { clock: this.clock } : {}) });
      hub.workspace = s;
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
  }
}
