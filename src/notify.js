// Push: when something new needs the human, send one batched message over plain HTTP
// (ntfy, a Slack incoming webhook, or any JSON webhook). Healthy work sends nothing.
import { view } from './insight.js';
import { MIN, HOUR, UserError } from './core.js';

export const KINDS = {
  ntfy: 'ntfy topic URL (phone push), e.g. https://ntfy.sh/my-secret-topic',
  slack: 'Slack incoming webhook URL, e.g. https://hooks.slack.com/services/…',
  webhook: 'any URL that accepts a JSON POST: { text, title, url, entries }',
};
const LABEL = { question: 'question', review: 'verify', proposal: 'approve', struggling: 'struggling', direction: 'pick what matters', 'no-agents': 'no agent working' };
const FORGET = HOUR; // an entry gone this long may be pushed again if it comes back (e.g. "What matters most?")

const clip = (s, n = 100) => { const line = String(s ?? '').split('\n')[0]; return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line; };
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Secrets live in the URL (the ntfy topic, the Slack webhook path), so only ever show its host and last few characters.
export function mask(url) {
  try {
    const u = new URL(url);
    const rest = (u.pathname + u.search).replace(/^\//, '');
    return `${u.origin}/${rest.length > 8 ? '…' + rest.slice(-4) : rest ? '…' : ''}`;
  } catch { return '…'; }
}

// ── channels (hub-wide, stored in the database) ──

export function addChannel(db, kind, url, now = Date.now()) {
  kind = String(kind ?? '').toLowerCase();
  if (!KINDS[kind]) throw new UserError(`unknown channel "${kind}"`, { hint: `Use one of: ${Object.keys(KINDS).join(', ')}.` });
  let raw = String(url ?? '').trim();
  // Forgiving: a bare ntfy topic means the public ntfy.sh server.
  if (kind === 'ntfy' && raw && !/^[a-z]+:\/\//i.test(raw)) raw = `https://ntfy.sh/${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new UserError('a channel needs a URL', { hint: KINDS[kind] }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('channel URLs must be http or https', { hint: KINDS[kind] });
  if (db.prepare('SELECT 1 FROM channels WHERE url = ?').get(u.href)) throw new UserError('that channel is already set up', { hint: 'See: nuworq notify list' });
  const r = db.prepare('INSERT INTO channels (kind, url, created_at) VALUES (?, ?, ?)').run(kind, u.href, now);
  return { id: Number(r.lastInsertRowid), kind, url: mask(u.href) };
}

export function listChannels(db) {
  return db.prepare('SELECT * FROM channels ORDER BY id').all().map((c) => ({
    id: c.id, kind: c.kind, url: mask(c.url), failing: !!c.failing_since, last_error: c.last_error || null,
  }));
}

export function removeChannel(db, id) {
  const r = db.prepare('DELETE FROM channels WHERE id = ?').run(Number(id));
  if (!r.changes) throw new UserError(`no channel ${id}`, { status: 404, hint: 'See: nuworq notify list' });
}

// ── sending ──

async function send(c, msg, { fetch, timeout }) {
  const signal = AbortSignal.timeout(timeout);
  const res = c.kind === 'ntfy'
    ? await fetch(c.url, { method: 'POST', body: msg.text, signal, headers: { Title: msg.title, Tags: 'seedling', ...(msg.url ? { Click: msg.url } : {}) } })
    : await fetch(c.url, {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c.kind === 'slack' ? { text: msg.text } : msg),
    });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// Send to one channel, retrying once. Records the outcome on the channel so the UI can say it's failing.
export async function deliver(db, c, msg, { fetch = globalThis.fetch, timeout = 5000, retryDelay = 2000, now = Date.now } = {}) {
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelay));
    try {
      await send(c, msg, { fetch, timeout });
      db.prepare(`UPDATE channels SET failing_since = NULL, last_error = '' WHERE id = ?`).run(c.id);
      return { id: c.id, kind: c.kind, ok: true };
    } catch (e) {
      error = e?.name === 'TimeoutError' ? `no answer in ${timeout / 1000}s` : String(e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.cause?.message ?? e?.message ?? e);
    }
  }
  db.prepare('UPDATE channels SET failing_since = COALESCE(failing_since, ?), last_error = ? WHERE id = ?').run(now(), error, c.id);
  return { id: c.id, kind: c.kind, ok: false, error };
}

export async function testChannels(db, { baseUrl = '', ...opts } = {}) {
  const channels = db.prepare('SELECT * FROM channels ORDER BY id').all();
  const msg = { title: 'nuworq', text: `nuworq: test message. When something needs you, it arrives here.${baseUrl ? `\n→ ${baseUrl}` : ''}`, url: baseUrl || undefined, entries: [] };
  return Promise.all(channels.map((c) => deliver(db, c, msg, opts)));
}

export function compose(entries, baseUrl = '') {
  const slugs = [...new Set(entries.map((e) => e.project))];
  const link = (slug) => (baseUrl ? `${baseUrl}/#/p/${encodeURIComponent(slug)}` : '');
  const url = baseUrl ? (slugs.length === 1 ? link(slugs[0]) : `${baseUrl}/#/`) : '';
  const title = `nuworq: ${plural(entries.length, 'thing')} ${entries.length === 1 ? 'needs' : 'need'} you`;
  const lines = entries.map((e) => `• ${slugs.length > 1 ? `${e.name} ` : ''}${e.entry.item ? `${e.entry.item} ` : ''}${LABEL[e.entry.kind] ?? e.entry.kind}: ${clip(e.entry.headline)}`);
  return {
    title, url,
    text: [title, ...lines, url && `→ ${url}`].filter(Boolean).join('\n'),
    entries: entries.map((e) => ({ project: e.project, key: e.entry.key, kind: e.entry.kind, item: e.entry.item, headline: e.entry.headline, url: link(e.project) })),
  };
}

// Watches every unparked project for new act-level attention entries and pushes each one once,
// batched: the first new entry opens a window, and everything new within it goes out as one message.
export class Notifier {
  constructor(hub, { baseUrl = '', windowMs = 2 * MIN, interval = 30_000, debounce = 500, ...sendOpts } = {}) {
    Object.assign(this, { hub, baseUrl: baseUrl.replace(/\/+$/, ''), windowMs, interval, debounce });
    this.sendOpts = { now: () => hub.now(), ...sendOpts };
    this.pending = new Set(); // `${project_id}\t${key}` waiting for the batch window to close
    this.onChange = () => this.soon();
  }

  start() {
    this.hub.on('change', this.onChange);
    this.timer = setInterval(() => this.scan(), this.interval);
    this.timer.unref?.();
    this.scan();
    return this;
  }

  stop() {
    this.hub.off('change', this.onChange);
    for (const t of [this.timer, this.scanTimer, this.batch]) clearTimeout(t);
    this.batch = this.scanTimer = null;
  }

  soon() {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scan(); }, this.debounce);
  }

  // What needs the human right now, everywhere it's allowed to ask.
  current() {
    const entries = new Map(), looked = [];
    for (const p of this.hub.projects()) {
      if (p.parked) continue;
      looked.push(p.id);
      for (const entry of view(this.hub, p.slug, { light: true }).attention) {
        if (entry.level === 'act') entries.set(`${p.id}\t${entry.key}`, { project_id: p.id, project: p.slug, name: p.name, entry });
      }
    }
    return { entries, looked };
  }

  channels() {
    return this.hub.db.prepare('SELECT * FROM channels ORDER BY id').all();
  }

  scan() {
    try {
      if (!this.channels().length) { this.pending.clear(); return; }
      const db = this.hub.db, t = this.hub.now();
      const { entries, looked } = this.current();
      const seen = db.prepare('UPDATE notified SET seen_at = ? WHERE project_id = ? AND key = ?');
      for (const [k, e] of entries) {
        if (!seen.run(t, e.project_id, e.entry.key).changes) this.pending.add(k); // never pushed before
      }
      // Forget entries long gone from projects we looked at, so a situation that recurs is news again.
      const forget = db.prepare('DELETE FROM notified WHERE project_id = ? AND seen_at < ?');
      for (const id of looked) forget.run(id, t - FORGET);
      if (this.pending.size && !this.batch) this.batch = setTimeout(() => this.flush(), this.windowMs);
    } catch (e) {
      console.error('notify scan failed', e);
    }
  }

  // Close the window: whatever is still new and still needs you goes out as one message per channel.
  async flush() {
    clearTimeout(this.batch);
    this.batch = null;
    const now = this.current().entries;
    // Resolved, dismissed or parked in the meantime: drop it. Headlines are read fresh.
    const entries = [...this.pending].map((k) => now.get(k)).filter(Boolean);
    this.pending.clear();
    const channels = this.channels();
    if (!entries.length || !channels.length) return [];
    const db = this.hub.db, t = this.hub.now();
    const mark = db.prepare('INSERT OR REPLACE INTO notified (project_id, key, at, seen_at) VALUES (?, ?, ?, ?)');
    for (const e of entries) mark.run(e.project_id, e.entry.key, t, t);
    const msg = compose(entries, this.baseUrl);
    const before = new Set(channels.filter((c) => c.failing_since).map((c) => c.id));
    const results = await Promise.all(channels.map((c) => deliver(db, c, msg, this.sendOpts)));
    // A channel started or stopped failing: the UI shows that as something worth knowing.
    if (results.some((r) => r.ok === before.has(r.id))) this.hub.emit('change', { project: null, at: this.hub.now() });
    return results;
  }
}

// Many workspaces in one process: each has its own channels, so each gets its own notifier, linking to
// its own address (baseUrlFor(name)). Workspaces created while serving are picked up within `every` ms.
// Returns { notifiers (name → Notifier), stop() }.
export function notifyWorkspaces(spaces, baseUrlFor, { every = 30_000, ...opts } = {}) {
  const notifiers = new Map();
  const sweep = () => {
    for (const name of spaces.list()) {
      if (notifiers.has(name)) continue;
      const hub = spaces.get(name);
      if (hub) notifiers.set(name, new Notifier(hub, { baseUrl: baseUrlFor(name), ...opts }).start());
    }
  };
  sweep();
  const timer = setInterval(sweep, every);
  timer.unref?.();
  return { notifiers, sweep, stop: () => { clearInterval(timer); for (const n of notifiers.values()) n.stop(); } };
}

// A workspace's address, for links in pushes: its subdomain of baseDomain, else /w/<name>/ under the hub.
export function workspaceUrl(name, { baseDomain = '', publicUrl = '', url = '' } = {}) {
  const base = (publicUrl || url).replace(/\/+$/, '');
  if (baseDomain) return `${base.startsWith('http://') ? 'http' : 'https'}://${name}.${baseDomain}`;
  return `${base}/w/${encodeURIComponent(name)}`;
}
