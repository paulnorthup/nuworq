// Push: when something new needs the human, send one batched message over plain HTTP
// (ntfy, a Slack incoming webhook, or any JSON webhook). Healthy work sends nothing.
import { view } from './insight.js';
import { outcomes } from './outcomes.js';
import { MIN, HOUR, DAY, SYSTEM, UserError } from './core.js';

const WEEK = 7 * DAY;

export const KINDS = {
  ntfy: 'ntfy topic URL (phone push), e.g. https://ntfy.sh/my-secret-topic',
  slack: 'Slack incoming webhook URL, e.g. https://hooks.slack.com/services/…',
  webhook: 'any URL that accepts a JSON POST: { text, title, url, entries }',
};
const LABEL = { question: 'question', review: 'verify', proposal: 'approve', struggling: 'struggling', direction: 'pick what matters', 'no-agents': 'no agent working', 'group-stalled': 'stalled on a capability' };
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

// person: "@handle" (or "handle") for a personal channel: it gets only what that person owns. '' or
// absent: a hub-wide channel, which gets every "needs you".
export function addChannel(db, kind, url, now = Date.now(), { person = '' } = {}) {
  const who = normPerson(person);
  if (who && !personExists(db, who)) throw new UserError(`no person ${who} here`, { status: 404, hint: 'See: nuworq person list' });
  kind = String(kind ?? '').toLowerCase();
  if (!KINDS[kind]) throw new UserError(`unknown channel "${kind}"`, { hint: `Use one of: ${Object.keys(KINDS).join(', ')}.` });
  let raw = String(url ?? '').trim();
  // Forgiving: a bare ntfy topic means the public ntfy.sh server.
  if (kind === 'ntfy' && raw && !/^[a-z]+:\/\//i.test(raw)) raw = `https://ntfy.sh/${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new UserError('a channel needs a URL', { hint: KINDS[kind] }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('channel URLs must be http or https', { hint: KINDS[kind] });
  if (db.prepare('SELECT 1 FROM channels WHERE url = ?').get(u.href)) throw new UserError('that channel is already set up', { hint: 'See: nuworq notify list' });
  const r = db.prepare('INSERT INTO channels (kind, url, created_at, person) VALUES (?, ?, ?, ?)').run(kind, u.href, now, who);
  return { id: Number(r.lastInsertRowid), kind, url: mask(u.href), person: who || null };
}

export const normPerson = (p) => { const h = String(p ?? '').trim().replace(/^@/, '').toLowerCase(); return h ? `@${h}` : ''; };
const personExists = (db, who) => {
  try { return !!db.prepare('SELECT 1 FROM people WHERE handle = ?').get(who.slice(1)); } catch { return false; }
};

// person: only that person's channels (what a non-owner sees and manages); null: all of them.
export function listChannels(db, { person = null } = {}) {
  return db.prepare('SELECT * FROM channels ORDER BY id').all().filter((c) => person == null || c.person === person).map((c) => ({
    id: c.id, kind: c.kind, url: mask(c.url), person: c.person || null, failing: !!c.failing_since, last_error: c.last_error || null,
    weekly: !!c.weekly,
  }));
}

// The weekly line (#178), on or off for one channel.
export function setWeekly(db, id, on) {
  const r = db.prepare('UPDATE channels SET weekly = ? WHERE id = ?').run(on ? 1 : 0, Number(id));
  if (!r.changes) throw new UserError(`no channel ${id}`, { status: 404, hint: 'See: nuworq notify list' });
}

export const channelOwner = (db, id) => db.prepare('SELECT person FROM channels WHERE id = ?').get(Number(id))?.person ?? null;

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

// What the week got you (#178), one line per unparked project where anything happened in (from, to]: items
// landed, your actions, recorded cost and escapes, the same numbers as the outcomes API for that window, with a
// link to the project. null when nothing happened anywhere: a quiet week sends nothing.
export function composeWeekly(hub, baseUrl, from, to) {
  const link = (slug) => (baseUrl ? `${baseUrl}/#/p/${encodeURIComponent(slug)}` : '');
  const money = (usd) => `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;
  const lines = [], links = [];
  for (const p of hub.projects()) {
    if (p.parked) continue;
    if (!hub.q('SELECT 1 FROM events WHERE project_id = ? AND at > ? AND at <= ? AND actor != ? LIMIT 1').get(p.id, from, to, SYSTEM)) continue;
    const o = outcomes(hub, p.slug, { since: from, until: to });
    const landed = o.items.filter((i) => i.outcome === 'landed').length;
    const costs = o.by_model.map((m) => m.cost_usd).filter((c) => c != null);
    const cost = costs.length ? money(costs.reduce((a, c) => a + c, 0)) : 'no cost recorded';
    lines.push(`${p.name}: ${landed} landed, ${o.human_actions.total} of your actions, ${cost}, ${plural(o.items.filter((i) => i.escaped).length, 'escape')}${link(p.slug) ? ` → ${link(p.slug)}` : ''}`);
    links.push(link(p.slug));
  }
  if (!lines.length) return null;
  const title = 'nuworq: this week';
  return { title, url: (links.length === 1 ? links[0] : baseUrl ? `${baseUrl}/#/` : '') || undefined, text: [title, ...lines].join('\n'), entries: [] };
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

  // Once a week per channel that has it on (#178): the week since it last went (or since the channel was
  // added) as one line per project. Due either way, so a quiet week starts the next one; it just sends nothing.
  async weekly() {
    const db = this.hub.db, t = this.hub.now();
    const due = db.prepare('SELECT * FROM channels WHERE weekly = 1 ORDER BY id').all().filter((c) => t - (c.weekly_at || c.created_at) >= WEEK);
    const sends = [];
    for (const c of due) {
      const msg = composeWeekly(this.hub, this.baseUrl, c.weekly_at || c.created_at, t);
      db.prepare('UPDATE channels SET weekly_at = ? WHERE id = ?').run(t, c.id);
      if (msg) sends.push(deliver(db, c, msg, this.sendOpts));
    }
    return Promise.all(sends);
  }

  scan() {
    try {
      if (!this.channels().length) { this.pending.clear(); return; }
      this.weekly().catch((e) => console.error('weekly push failed', e));
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
    // A personal channel gets only the entries its person owns; a hub-wide one gets them all.
    const sends = channels.map((c) => [c, c.person ? entries.filter((e) => (e.entry.owners ?? []).includes(c.person)) : entries]).filter(([, es]) => es.length);
    const before = new Set(channels.filter((c) => c.failing_since).map((c) => c.id));
    const results = await Promise.all(sends.map(([c, es]) => deliver(db, c, compose(es, this.baseUrl), this.sendOpts)));
    // A channel started or stopped failing: the UI shows that as something worth knowing.
    if (results.some((r) => r.ok === before.has(r.id))) this.hub.emit('change', { project: null, at: this.hub.now() });
    return results;
  }
}

// Many workspaces in one process: each has its own channels, so each gets its own notifier, linking to
// its own address (baseUrlFor(name)). Workspaces created while serving are picked up within `every` ms.
// A workspace whose hub closes (evicted, or removed, even from another process) loses its notifier;
// re-created, it gets a fresh one. Returns { notifiers (name → Notifier), sweep(), stop() }.
export function notifyWorkspaces(spaces, baseUrlFor, { every = 30_000, ...opts } = {}) {
  const notifiers = new Map();
  const sweep = () => {
    const names = spaces.list();
    for (const [name, n] of notifiers) {
      if (names.includes(name)) continue;
      spaces.get(name); // removed from the host: lets its hub go
      n.stop();
      notifiers.delete(name);
    }
    for (const name of names) {
      if (notifiers.has(name)) continue;
      const hub = spaces.get(name);
      if (!hub) continue;
      const n = new Notifier(hub, { baseUrl: baseUrlFor(name), ...opts }).start();
      hub.once('closed', () => { n.stop(); if (notifiers.get(name) === n) notifiers.delete(name); });
      notifiers.set(name, n);
    }
  };
  sweep();
  const timer = setInterval(sweep, every);
  timer.unref?.();
  return { notifiers, sweep, stop: () => { clearInterval(timer); for (const n of notifiers.values()) n.stop(); } };
}

// ── the hub's owners (workspaces mode) ──

// A new early-access request, as its push: who asked and the link that opens it, nothing else (#167).
export function composeRequest({ email, github = '', building = '' }, url = '') {
  const title = 'nuworq: early-access request';
  const note = clip(building, 140);
  const who = `${email}${github ? ` (@${github})` : ''}`;
  return { title, url, text: [title, `${who} asked to come in${note ? `: ${note}` : ''}`, url && `→ ${url}`].filter(Boolean).join('\n'), entries: [] };
}

// The owners' own channels: in each workspace where a person has an owner's verified email, that person's
// personal channels. A workspace's hub-wide channels only where the owner is its only person (#251):
// otherwise others there read them. Each URL once.
export function ownerChannels(spaces, owners) {
  const dir = spaces.directory, out = new Map();
  for (const email of owners) {
    const id = dir.identity(email);
    for (const m of id ? dir.orgsOf(id, spaces) : []) {
      const db = spaces.get(m.workspace)?.db;
      for (const c of db ? requestChannels(db, m.handle) : []) if (!out.has(c.url)) out.set(c.url, { db, c });
    }
  }
  return [...out.values()];
}

// In one workspace, the channels that hear an owner's request pushes: their personal ones, and the hub-wide
// ones too when they are its only person, since nobody else reads them.
export function requestChannels(db, handle) {
  const alone = db.prepare('SELECT COUNT(*) AS n FROM people').get().n === 1;
  return db.prepare(`SELECT * FROM channels WHERE person = ?${alone ? " OR person = ''" : ''} ORDER BY id`).all(`@${handle}`);
}

// Push one new request to the owners. Never throws: a channel that fails is recorded on it, as for any push.
export async function notifyOwners(spaces, owners, request, url, opts = {}) {
  const msg = composeRequest(request, url);
  return Promise.all(ownerChannels(spaces, owners).map(({ db, c }) => deliver(db, c, msg, opts)));
}

// New feedback about nuworq (#295), batched into one push: who sent each piece from which workspace, the start of
// it, and the link to the admin dashboard's Feedback section.
export function composeFeedback(list, url = '') {
  const title = list.length === 1 ? 'nuworq: feedback' : `nuworq: ${list.length} pieces of feedback`;
  const lines = list.slice(0, 5).map(({ sender, workspace, text }) => `${sender} (${workspace}): ${clip(text, 140)}`);
  if (list.length > 5) lines.push(`and ${list.length - 5} more`);
  return { title, url, text: [title, ...lines, url && `→ ${url}`].filter(Boolean).join('\n'), entries: [] };
}

export async function notifyFeedback(spaces, owners, list, url, opts = {}) {
  const msg = composeFeedback(list, url);
  return Promise.all(ownerChannels(spaces, owners).map(({ db, c }) => deliver(db, c, msg, opts)));
}

// A workspace's address, for links in pushes: its subdomain of baseDomain, else /w/<name>/ under the hub.
export function workspaceUrl(name, { baseDomain = '', publicUrl = '', url = '' } = {}) {
  const base = (publicUrl || url).replace(/\/+$/, '');
  if (baseDomain) return `${base.startsWith('http://') ? 'http' : 'https'}://${name}.${baseDomain}`;
  return `${base}/w/${encodeURIComponent(name)}`;
}
