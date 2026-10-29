// The hub's state and every operation agents and humans can perform.
// HTTP, MCP and the CLI are thin transports over this file.
import { EventEmitter } from 'node:events';
import { openDb } from './db.js';

export class UserError extends Error {
  constructor(message, { status = 400, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const LEASE_MS = 20 * MIN;
const HEADLINE_MAX = 140;
const STEER_TTL = 3 * DAY;
export const HUMAN = 'you';
export const SYSTEM = 'trellis';

// The lifecycle. "court" is whose move it is while work sits in that stage.
export const STAGES = {
  proposed:  { label: 'Proposed',  court: 'shaping', blurb: 'An idea someone (human or agent) thinks is worth doing. Agents claim proposals to shape them: they read the code, write what done means, and split big ideas. Then the work becomes Ready (or comes to you for approval).' },
  ready:     { label: 'Ready',     court: 'queue',   blurb: 'Shaped, with acceptance criteria. Any agent can pick it up.' },
  active:    { label: 'Active',    court: 'agents',  blurb: 'An agent holds a 20-minute lease and is working. Progress renews the lease; if the agent goes quiet, the work returns to Ready for someone else.' },
  waiting:   { label: 'Waiting',   court: 'you',     blurb: 'An agent hit a question only you can answer and parked the work (it took other work meanwhile). Your answer returns it to Ready.' },
  verifying: { label: 'Verifying', court: 'review',  blurb: 'The agent says it is done and attached evidence. Someone other than the implementer checks it.' },
  done:      { label: 'Done',      court: null,      blurb: 'Accepted.' },
  dropped:   { label: 'Dropped',   court: null,      blurb: 'Decided not to do. Kept for the record.' },
};
export const OPEN_STAGES = ['proposed', 'ready', 'active', 'waiting', 'verifying'];

export const AUTONOMY = {
  ask: {
    label: 'Check with me',
    human: 'Agent proposals wait for your OK. You verify all finished work.',
    agent: 'Work you propose waits for the human to approve it. The human verifies finished work.',
  },
  balanced: {
    label: 'Keep moving',
    human: 'Agents shape and start their own proposals. You verify finished work.',
    agent: 'You may shape proposals into ready work (give them acceptance criteria) and start them. The human verifies finished work.',
  },
  full: {
    label: 'Run with it',
    human: 'Agents also peer-review each other (never their own work). You get the digest and step in when you choose.',
    agent: "You may shape and start work, and peer-review other agents' submissions (never your own). Finish before starting: reviews come before new work.",
  },
};

const PRIORITY_RANK = { now: 0, soon: 1, later: 2 };

// whose court a stage is in, given the project's autonomy
export function courtOf(stage, autonomy) {
  const c = STAGES[stage]?.court;
  // Proposals are backlog, not anyone's bottleneck, unless the human has asked to approve them.
  if (c === 'shaping') return autonomy === 'ask' ? 'you' : null;
  if (c === 'review') return autonomy === 'full' ? 'agents' : 'you';
  return c;
}

export function dur(ms) {
  ms = Math.max(0, ms);
  if (ms < MIN) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${+(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)}h`;
  return `${+(ms / DAY).toFixed(1)}d`;
}

export function providerOf(model = '') {
  const m = model.toLowerCase();
  if (!m) return '';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Anthropic';
  if (/gpt|openai|codex|^o\d/.test(m)) return 'OpenAI';
  if (/gemini/.test(m)) return 'Google';
  return 'Open-weight';
}

// Everything written into Trellis has up to three layers. Be forgiving: an over-long
// headline is trimmed and the overflow moved into the summary rather than rejected.
export function layered(headline, summary = '', detail = '', what = 'headline') {
  headline = String(headline ?? '').trim();
  summary = String(summary ?? '').trim();
  detail = String(detail ?? '').trim();
  if (!headline) throw new UserError(`${what} is required`, { hint: 'One line a busy person can read in three seconds, outcome first.' });
  if (headline.includes('\n')) {
    const [first, ...rest] = headline.split('\n');
    headline = first.trim();
    summary = [rest.join('\n').trim(), summary].filter(Boolean).join('\n\n');
  }
  if (headline.length > HEADLINE_MAX) {
    const space = headline.lastIndexOf(' ', HEADLINE_MAX - 1);
    const at = space > 60 ? space : HEADLINE_MAX - 1;
    summary = ['…' + headline.slice(at).trim(), summary].filter(Boolean).join('\n\n');
    headline = headline.slice(0, at).trim() + '…';
  }
  return { headline, summary, detail };
}

const str = (v) => (v == null ? '' : String(v).trim());
const clip = (v, n = 120) => { const line = str(v).split('\n')[0]; return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line; };
const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const fmtOther = (o) => `${o.agent} → ${o.item} ${o.title}${o.touching ? ` (changing ${o.touching.join(', ')})` : ''}`;

// Paths an agent says it is changing. Normalised so "src/db/**", "./src/db/" and "src/db" all compare equal.
export function normPaths(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return [...new Set(list.map((x) => str(x).replace(/^\.\//, '').replace(/(\/\*\*|\/\*|\*|\/)+$/, '')).filter(Boolean))].slice(0, 30);
}
const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

export function slugify(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export class Hub extends EventEmitter {
  constructor({ file = ':memory:', clock = () => Date.now() } = {}) {
    super();
    this.setMaxListeners(200);
    this.db = openDb(file);
    this.now = clock;
    this._stmts = new Map();
  }

  q(sql) {
    let s = this._stmts.get(sql);
    if (!s) this._stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  tx(fn) {
    if (this._inTx) return fn();
    this._inTx = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this._inTx = false;
    }
  }

  changed(p) {
    this.emit('change', { project: p.slug, at: this.now() });
  }

  // ── projects ────────────────────────────────────────────────────────────

  projects() {
    return this.q('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
  }

  project(slug, { create = false, name } = {}) {
    const s = slugify(slug);
    if (!s) throw new UserError('project is required', { hint: 'Pass a project slug, e.g. "my-app".' });
    let p = this.q('SELECT * FROM projects WHERE slug = ?').get(s);
    if (!p && create) {
      this.q('INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)').run(s, str(name) || s, this.now());
      p = this.q('SELECT * FROM projects WHERE slug = ?').get(s);
      this.event(p, { actor: SYSTEM, type: 'project', headline: `Project ${p.name} created` });
    }
    if (!p) throw new UserError(`No project "${s}"`, { status: 404, hint: 'An agent checkin creates a project automatically, or create one in the UI.' });
    return p;
  }

  // ── small helpers ───────────────────────────────────────────────────────

  item(p, ref) {
    const n = Number(String(ref ?? '').trim().replace(/^#/, '').replace(/^[a-z]+-?/i, ''));
    if (!Number.isInteger(n) || n < 1) throw new UserError(`Not an item reference: "${ref}"`, { hint: 'Use "#12" or "12".' });
    const it = this.q('SELECT * FROM items WHERE project_id = ? AND seq = ?').get(p.id, n);
    if (!it) throw new UserError(`No item #${n} in ${p.slug}`, { status: 404 });
    return it;
  }

  itemById(id) {
    return id == null ? null : this.q('SELECT * FROM items WHERE id = ?').get(id);
  }

  event(p, { item = null, actor, type, headline, summary = '', detail = '', data = {} }) {
    const r = this.q(`INSERT INTO events (project_id, item_id, actor, type, headline, summary, detail, data, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, actor, type, headline, summary, detail, JSON.stringify(data), this.now());
    return Number(r.lastInsertRowid);
  }

  move(item, stage, actor, patch = {}) {
    const t = this.now();
    const fields = { ...patch, stage, stage_since: t, updated_at: t };
    const keys = Object.keys(fields);
    this.q(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), item.id);
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    Object.assign(item, fields);
  }

  patch(item, fields) {
    fields = { ...fields, updated_at: this.now() };
    const keys = Object.keys(fields);
    this.q(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k] ?? null), item.id);
    Object.assign(item, fields);
  }

  requireAgent(name) {
    const n = str(name);
    if (!n) throw new UserError('agent name is required', { hint: 'Identify yourself: a short unique name such as "claude-1" or "codex-api".' });
    if (n.length > 60) throw new UserError('agent name is too long (max 60 characters)');
    if ([HUMAN, SYSTEM].includes(n.toLowerCase())) throw new UserError(`"${n}" is reserved; pick another agent name`);
    return n;
  }

  touchAgent(p, name, { model, client, status } = {}) {
    const t = this.now();
    const a = this.q('SELECT * FROM agents WHERE project_id = ? AND name = ?').get(p.id, name);
    if (!a) {
      this.q(`INSERT INTO agents (project_id, name, model, client, status, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(p.id, name, str(model), str(client), str(status), t, t);
      return { fresh: true, gap: Infinity };
    }
    this.q(`UPDATE agents SET last_seen = ?, signed_off = 0,
        model = CASE WHEN ? != '' THEN ? ELSE model END,
        client = CASE WHEN ? != '' THEN ? ELSE client END,
        status = CASE WHEN ? != '' THEN ? ELSE status END
      WHERE project_id = ? AND name = ?`)
      .run(t, str(model), str(model), str(client), str(client), str(status), str(status), p.id, name);
    return { fresh: false, gap: t - a.last_seen, wasSignedOff: !!a.signed_off };
  }

  setStatus(p, agent, status) {
    this.q('UPDATE agents SET status = ? WHERE project_id = ? AND name = ?').run(str(status).slice(0, 200), p.id, agent);
  }

  deps(item) {
    return this.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.depends_on WHERE d.item_id = ? ORDER BY i.seq`).all(item.id);
  }

  // What must finish first: explicit dependencies, and an umbrella item's own children.
  unmetDeps(item) {
    const deps = this.deps(item).filter((d) => !['done', 'dropped'].includes(d.stage));
    const kids = this.q(`SELECT * FROM items WHERE parent_id = ? AND stage NOT IN ('done', 'dropped') ORDER BY seq`).all(item.id);
    return [...deps, ...kids.filter((k) => !deps.some((d) => d.id === k.id))];
  }

  // Proposals an agent could claim to shape right now.
  shapeable(p) {
    return this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'proposed' AND holder IS NULL ORDER BY seq`).all(p.id)
      .filter((i) => !this.openQuestions(i, { blocking: true }).length)
      .filter((i) => !(p.autonomy === 'ask' && i.acceptance)); // shaped, waiting for the human's approval
  }

  setDeps(p, item, refs) {
    if (!Array.isArray(refs)) return;
    this.q('DELETE FROM deps WHERE item_id = ?').run(item.id);
    for (const r of refs) {
      const d = this.item(p, r);
      if (d.id === item.id) continue;
      this.q('INSERT OR IGNORE INTO deps (item_id, depends_on) VALUES (?, ?)').run(item.id, d.id);
    }
  }

  openQuestions(item, { blocking } = {}) {
    const rows = this.q(`SELECT * FROM questions WHERE item_id = ? AND status = 'open' ORDER BY at`).all(item.id);
    return blocking == null ? rows : rows.filter((q) => !!q.blocking === blocking);
  }

  heldBy(p, agent) {
    return this.q(`SELECT * FROM items WHERE project_id = ? AND holder = ? ORDER BY seq`).all(p.id, agent);
  }

  // Steering an agent has not acknowledged: recent project-wide steers, plus steers on items it holds.
  pendingSteers(p, agent) {
    return this.q(`SELECT n.*, i.seq AS item_seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'steer' AND n.active = 1
        AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.note_id = n.id AND a.agent = ?)
        AND ((n.item_id IS NULL AND n.target IS NULL AND n.at > ?) OR i.holder = ? OR n.target = ?)
      ORDER BY n.at`).all(p.id, agent, this.now() - STEER_TTL, agent, agent)
      .map((n) => ({ steer: n.id, about: n.item_seq ? `#${n.item_seq}` : 'whole project', from: n.author, body: n.body, ago: dur(this.now() - n.at) }));
  }

  // What every other agent is doing right now, and where in the code.
  others(p, agent) {
    return this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'active' AND holder IS NOT NULL AND holder != ? ORDER BY seq`).all(p.id, agent ?? '')
      .map((i) => {
        const t = json(i.touching, []);
        return { agent: i.holder, item: `#${i.seq}`, title: i.title, touching: t.length ? t : undefined };
      });
  }

  headsUp(p, agent, item) {
    const mine = json(item.touching, []);
    if (!mine.length) return undefined;
    const clashes = [];
    for (const o of this.others(p, agent)) {
      const hit = (o.touching ?? []).filter((x) => mine.some((m) => overlap(m, x)));
      if (hit.length) clashes.push(`${o.agent} is also changing ${hit.join(', ')} (for ${o.item})`);
    }
    return clashes.length ? `${clashes.join('; ')}. Keep your changes there small and coordinate with a comment on their item.` : undefined;
  }

  setTouching(item, v) {
    if (v == null) return;
    this.patch(item, { touching: JSON.stringify(normPaths(v)) });
  }

  fieldNotes(p) {
    return this.q(`SELECT n.id, n.body, n.author, i.seq FROM notes n LEFT JOIN items i ON i.id = n.item_id
      WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at DESC LIMIT 40`).all(p.id)
      .map((n) => ({ id: n.id, note: n.body, by: n.author, about: n.seq ? `#${n.seq}` : undefined }));
  }

  decisions(p) {
    return this.q(`SELECT id, body, at FROM notes WHERE project_id = ? AND kind = 'decision' AND active = 1 ORDER BY at`).all(p.id);
  }

  // Everything an agent needs to work an item, and nothing it doesn't.
  context(p, item, agent) {
    const parent = this.itemById(item.parent_id);
    const children = this.q('SELECT seq, title, stage FROM items WHERE parent_id = ? ORDER BY seq').all(item.id);
    const history = this.q(`SELECT * FROM events WHERE item_id = ?
        AND type IN ('handoff','sent_back','lease_expired','answered','assumption_confirmed','submitted','shaped','picked','comment','steer','refined')
        ORDER BY at DESC LIMIT 8`).all(item.id).reverse();
    const questions = this.q('SELECT * FROM questions WHERE item_id = ? ORDER BY at').all(item.id);
    const steers = this.q(`SELECT n.* FROM notes n WHERE n.item_id = ? AND n.kind = 'steer' AND n.active = 1
        AND NOT EXISTS (SELECT 1 FROM acks a WHERE a.note_id = n.id AND a.agent = ?) ORDER BY n.at`).all(item.id, agent ?? '');
    const handoff = json(item.handoff, null);
    return {
      item: `#${item.seq}`,
      title: item.title,
      stage: item.stage,
      priority: item.priority,
      summary: item.summary || undefined,
      detail: item.detail || undefined,
      done_means: item.acceptance || 'No acceptance criteria yet. Write them with refine before you submit, so a reviewer knows what to check.',
      lease: item.holder ? { holder: item.holder, expires_in: dur(item.lease_until - this.now()) } : undefined,
      touching: json(item.touching, []).length ? json(item.touching, []) : undefined,
      attempt: item.attempts || undefined,
      last_handoff: handoff ? { by: handoff.by, kind: handoff.kind, headline: handoff.headline, summary: handoff.summary || undefined, ago: dur(this.now() - handoff.at) } : undefined,
      parent: parent ? `#${parent.seq} ${parent.title}` : undefined,
      children: children.length ? children.map((c) => `#${c.seq} [${c.stage}] ${c.title}`) : undefined,
      depends_on: (() => { const d = this.deps(item); return d.length ? d.map((x) => `#${x.seq} [${x.stage}] ${x.title}`) : undefined; })(),
      questions: questions.length ? questions.map((q) => ({
        question: q.question, status: q.status, blocking: !!q.blocking,
        assumption: q.assumption || undefined, answer: q.answer || undefined,
      })) : undefined,
      steers: steers.length ? steers.map((n) => ({ steer: n.id, from: n.author, body: n.body, ago: dur(this.now() - n.at) })) : undefined,
      history: history.length ? history.map((e) => ({ ago: dur(this.now() - e.at), by: e.actor, type: e.type, headline: e.headline, summary: e.summary || undefined })) : undefined,
      others_working: (() => { const o = this.others(p, agent); return o.length ? o.map(fmtOther) : undefined; })(),
      heads_up: agent ? this.headsUp(p, agent, item) : undefined,
    };
  }

  // Expired leases go back to the queue. Run before every operation and on a timer.
  sweep() {
    const t = this.now();
    const expired = this.q(`SELECT i.*, p.slug FROM items i JOIN projects p ON p.id = i.project_id
      WHERE i.holder IS NOT NULL AND i.lease_until < ?`).all(t);
    if (!expired.length) return 0;
    const touched = new Map();
    this.tx(() => {
      for (const it of expired) {
        const p = this.q('SELECT * FROM projects WHERE id = ?').get(it.project_id);
        touched.set(p.id, p);
        const last = this.q(`SELECT headline FROM events WHERE item_id = ? AND actor = ? ORDER BY at DESC LIMIT 1`).get(it.id, it.holder);
        if (it.stage === 'proposed') {
          this.patch(it, { holder: null, lease_until: null, last_worker: it.holder, stalls: it.stalls + 1 });
          this.event(p, {
            item: it, actor: SYSTEM, type: 'lease_expired',
            headline: `${it.last_worker} went quiet while shaping #${it.seq}; it's open for shaping again`,
            summary: last ? `Their last update: "${last.headline}"` : '', data: { agent: it.last_worker },
          });
        } else if (it.stage === 'active') {
          this.move(it, 'ready', SYSTEM, { holder: null, lease_until: null, last_worker: it.holder, stalls: it.stalls + 1, touching: '[]' });
          this.event(p, {
            item: it, actor: SYSTEM, type: 'lease_expired',
            headline: `${it.last_worker} went quiet on #${it.seq}; it's back in the queue`,
            summary: last ? `Their last update: "${last.headline}"` : 'They left no updates.',
            data: { agent: it.last_worker },
          });
        } else {
          this.patch(it, { holder: null, lease_until: null });
          this.event(p, { item: it, actor: SYSTEM, type: 'lease_expired', headline: `Review lease on #${it.seq} expired; it's open for review again` });
        }
      }
    });
    for (const p of touched.values()) this.changed(p);
    return expired.length;
  }

  // ── agent operations ────────────────────────────────────────────────────

  agentOp(slug, op, name, args = {}) {
    const fn = AGENT_OPS[op];
    if (!fn) throw new UserError(`Unknown operation "${op}"`, { status: 404, hint: `Operations: ${Object.keys(AGENT_OPS).join(', ')}` });
    this.sweep();
    const agent = this.requireAgent(name);
    const p = this.project(slug, { create: op === 'checkin' });
    const result = this.tx(() => {
      const presence = this.touchAgent(p, agent, op === 'checkin' ? args : { model: args.model, client: args.client });
      const r = fn.call(this, p, agent, args ?? {}, presence);
      // Steering rides along on every response, so it lands on the agent's very next call.
      if (op !== 'checkin') {
        const steers = this.pendingSteers(p, agent);
        if (steers.length) {
          r.steers = steers;
          r.hint = `The human has steered you; read it, adjust, then ack. ${r.hint ?? ''}`.trim();
        }
      }
      return r;
    });
    this.changed(p);
    return result;
  }

  briefing(p, agent, since = 0) {
    const feedback = this.q(`SELECT e.*, i.seq FROM events e JOIN items i ON i.id = e.item_id
      WHERE e.project_id = ? AND e.type IN ('accepted', 'sent_back') AND i.implementer = ? AND e.actor != ? AND e.at > ?
      ORDER BY e.at DESC LIMIT 5`).all(p.id, agent, agent, since);
    const answers = this.q(`SELECT q.*, i.seq AS item_seq FROM questions q LEFT JOIN items i ON i.id = q.item_id
      WHERE q.project_id = ? AND q.asked_by = ? AND q.status IN ('answered', 'confirmed') AND q.seen_by_asker = 0 ORDER BY q.answered_at`).all(p.id, agent);
    if (answers.length) this.q(`UPDATE questions SET seen_by_asker = 1 WHERE id IN (${answers.map(() => '?').join(',')})`).run(...answers.map((a) => a.id));
    const holding = this.heldBy(p, agent);
    const steers = this.pendingSteers(p, agent);
    const count = (stage) => this.q('SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND stage = ?').get(p.id, stage).n;
    const board = { ready: count('ready'), active: count('active'), waiting_on_human: count('waiting'), verifying: count('verifying'), proposed: count('proposed') };
    const reopened = answers.filter((a) => a.item_seq && a.blocking && this.itemById(a.item_id)?.stage === 'ready');

    let next;
    if (steers.length) next = 'Read the steering below, adjust, and ack each one (ack with its steer id).';
    else if (holding.length) next = `You hold ${holding.map((i) => `#${i.seq}`).join(', ')}. Continue (progress renews your lease), submit, or handoff.`;
    else if (p.parked) next = 'The human has parked this project: start nothing new. Signoff.';
    else if (reopened.length) next = `Your question on #${reopened[0].item_seq} was answered and it's ready again. Claim it to continue.`;
    else if (p.autonomy === 'full' && board.verifying) next = 'Call next: there is work waiting for peer review.';
    else if (board.ready) next = 'Call next to pick up the most useful ready work.';
    else if (this.shapeable(p).length) next = 'Nothing is ready to build, but there are proposals to shape. Call next.';
    else next = "Nothing is ready. Propose work you think matters (with acceptance criteria), or signoff.";

    return {
      project: p.slug,
      name: p.name,
      parked: p.parked ? true : undefined,
      mission: p.mission || 'No mission written yet. Infer intent from the work and ask if it really matters.',
      autonomy: { level: p.autonomy, means: AUTONOMY[p.autonomy].agent },
      you: agent,
      decisions: this.decisions(p).map((d) => d.body),
      steers: steers.length ? steers : undefined,
      answers: answers.length ? answers.map((a) => ({
        about: a.item_seq ? `#${a.item_seq}` : 'project',
        question: a.question,
        answer: a.status === 'confirmed' ? `Your assumption stands: ${a.assumption}` : a.answer,
      })) : undefined,
      feedback: feedback.length ? feedback.map((e) => ({
        item: `#${e.seq}`,
        verdict: e.type === 'accepted' ? 'accepted' : 'sent back',
        by: e.actor,
        note: (e.type === 'sent_back' ? json(this.itemById(e.item_id).handoff, {})?.headline : '') || undefined,
      })) : undefined,
      field_notes: (() => { const n = this.fieldNotes(p); return n.length ? n : undefined; })(),
      holding: holding.length ? holding.map((i) => ({ item: `#${i.seq}`, title: i.title, stage: i.stage, lease_expires_in: dur(i.lease_until - this.now()) })) : undefined,
      others_working: (() => { const o = this.others(p, agent); return o.length ? o.map(fmtOther) : undefined; })(),
      board,
      next,
    };
  }

  // Pick the most useful thing for this agent. Finish before starting: reviews first, then by priority;
  // at equal priority, build ready work before shaping proposals, and prefer work you touched before.
  pick(p, agent) {
    if (p.autonomy === 'full') {
      const review = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'verifying' AND holder IS NULL
          AND COALESCE(implementer, '') != ? ORDER BY stage_since`).get(p.id, agent);
      if (review) return { mode: 'review', item: review };
    }
    if (p.parked) return null;
    const ready = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL`).all(p.id)
      .filter((i) => !this.unmetDeps(i).length)
      .map((item) => ({ mode: 'work', item }));
    const shape = this.shapeable(p).map((item) => ({ mode: 'shape', item }));
    const all = [...ready, ...shape].sort((a, b) =>
      PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority] ||
      (a.mode === 'shape') - (b.mode === 'shape') ||
      (b.item.last_worker === agent) - (a.item.last_worker === agent) ||
      a.item.seq - b.item.seq);
    return all[0] ?? null;
  }

  claimItem(p, agent, item) {
    const t = this.now();
    if (item.stage === 'verifying') {
      if (p.autonomy !== 'full') throw new UserError(`#${item.seq} is waiting for the human to verify it`, { hint: 'Pick other work with next.' });
      if (item.implementer === agent) throw new UserError(`You can't review your own work (#${item.seq})`, { hint: 'Another agent or the human will review it. Pick other work with next.' });
      if (item.holder && item.holder !== agent) throw new UserError(`${item.holder} is already reviewing #${item.seq}`, { hint: 'Pick other work with next.' });
      this.patch(item, { holder: agent, lease_until: t + LEASE_MS });
      this.event(p, { item, actor: agent, type: 'review_started', headline: `${agent} started reviewing #${item.seq}` });
      this.setStatus(p, agent, `Reviewing #${item.seq}: ${item.title}`);
      return;
    }
    if (item.holder === agent && ['active', 'proposed'].includes(item.stage)) {
      this.patch(item, { lease_until: t + LEASE_MS });
      return;
    }
    if (p.parked && ['ready', 'proposed'].includes(item.stage)) {
      throw new UserError(`${p.name} is parked: the human has paused new work`, { status: 409, hint: 'Finish or hand off what you hold, then signoff.' });
    }
    if (item.stage === 'proposed') {
      if (item.holder) throw new UserError(`${item.holder} is shaping #${item.seq}`, { status: 409, hint: 'Pick other work with next.' });
      if (this.openQuestions(item, { blocking: true }).length) throw new UserError(`#${item.seq} is waiting for the human to answer a question`, { status: 409, hint: 'Pick other work with next.' });
      if (p.autonomy === 'ask' && item.acceptance) throw new UserError(`#${item.seq} is shaped and waiting for the human to approve it`, { status: 409, hint: 'Pick other work with next.' });
      this.patch(item, { holder: agent, lease_until: t + LEASE_MS, last_worker: agent });
      this.event(p, { item, actor: agent, type: 'shaping', headline: `${agent} is shaping #${item.seq}` });
      this.setStatus(p, agent, `Shaping #${item.seq}: ${item.title}`);
      return;
    }
    if (item.stage === 'active') throw new UserError(`#${item.seq} is held by ${item.holder} (lease ends in ${dur(item.lease_until - t)})`, { status: 409, hint: 'Pick other work with next. If they go quiet, it returns to the queue automatically.' });
    if (item.stage === 'waiting') throw new UserError(`#${item.seq} is parked waiting for the human to answer a question`, { status: 409, hint: 'Pick other work with next.' });
    if (item.stage !== 'ready') throw new UserError(`#${item.seq} is ${item.stage}`, { status: 409 });
    const unmet = this.unmetDeps(item);
    if (unmet.length) throw new UserError(`#${item.seq} depends on unfinished work: ${unmet.map((d) => `#${d.seq}`).join(', ')}`, { status: 409, hint: 'Work on a dependency, or pick other work with next.' });
    this.move(item, 'active', agent, { holder: agent, lease_until: t + LEASE_MS, last_worker: agent, attempts: item.attempts + 1 });
    this.event(p, {
      item, actor: agent, type: 'claimed',
      headline: `${agent} picked up #${item.seq}${item.attempts > 1 ? ` (attempt ${item.attempts})` : ''}`,
    });
    this.setStatus(p, agent, `Working on #${item.seq}: ${item.title}`);
  }

  // Find an item this agent is allowed to write to; be helpful when it isn't.
  heldItem(p, agent, ref, verb) {
    const item = this.item(p, ref);
    if (item.holder === agent) return item;
    const why = item.holder ? `${item.holder} holds it now` : `it is ${item.stage} and nobody holds it`;
    throw new UserError(`You don't hold #${item.seq} (${why}), so you can't ${verb} it`, {
      status: 409,
      hint: item.stage === 'ready' ? `Claim it first: claim #${item.seq}.` : 'Your lease may have expired. Call next for other work, or comment to add your notes to the record.',
    });
  }
}

const SHAPE_HINT = (item, p) => [
  `You're shaping #${item.seq}, not building it yet. You hold it for ${dur(LEASE_MS)}.`,
  'Read the relevant code, then refine it: a sharp title and summary, and acceptance criteria (checkable, so a reviewer knows what done means).',
  `If it's big, split it: propose sub-items with parent #${item.seq}, each with acceptance criteria. #${item.seq} then waits for them.`,
  'If the intent is unclear, ask with an assumption.',
  `Finish with submit (headline: the shape you chose). ${p.autonomy === 'ask' ? 'The human then approves it.' : 'It becomes ready for any agent, including you.'}`,
].join(' ');

function finishShaping(p, agent, item, { headline, summary, detail, acceptance }) {
  if (str(acceptance)) this.patch(item, { acceptance: str(acceptance) });
  const kids = this.q(`SELECT COUNT(*) AS n FROM items WHERE parent_id = ?`).get(item.id).n;
  if (!item.acceptance && !kids) {
    throw new UserError(`#${item.seq} has no acceptance criteria yet`, { status: 409, hint: `Say what done means (refine #${item.seq} with acceptance, or pass acceptance to submit), or split it into sub-items.` });
  }
  if (!item.acceptance) this.patch(item, { acceptance: 'All sub-items are done and work together.' });
  const toReady = p.autonomy !== 'ask';
  if (toReady) this.move(item, 'ready', agent, { holder: null, lease_until: null, last_worker: agent });
  else this.patch(item, { holder: null, lease_until: null, last_worker: agent });
  this.event(p, { item, actor: agent, type: 'shaped', headline: `${agent} shaped #${item.seq}: ${headline}`, summary, detail });
  this.setStatus(p, agent, `Shaped #${item.seq}`);
  return {
    ok: true, stage: item.stage,
    hint: toReady
      ? `#${item.seq} is ready${kids ? ` (it waits for its ${kids} sub-item(s))` : ''}. Call next: you may well get to build it.`
      : `#${item.seq} is shaped and waiting for the human to approve it. Call next for other work.`,
  };
}

const AGENT_OPS = {
  checkin(p, agent, args, presence) {
    if (presence.fresh || presence.gap > 30 * MIN || presence.wasSignedOff) {
      const what = [args.model, args.client].filter(Boolean).join(' via ');
      this.event(p, { actor: agent, type: 'checkin', headline: `${agent} checked in${what ? ` (${what})` : ''}` });
    }
    const last = this.q('SELECT last_checkin FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.last_checkin ?? 0;
    this.q('UPDATE agents SET last_checkin = ? WHERE project_id = ? AND name = ?').run(this.now(), p.id, agent);
    return this.briefing(p, agent, last);
  },

  next(p, agent, args) {
    const holding = this.heldBy(p, agent).filter((i) => ['active', 'proposed'].includes(i.stage));
    if (holding.length && args.claim !== false) {
      return {
        mode: 'holding',
        holding: holding.map((i) => `#${i.seq} ${i.title}`),
        hint: `Finish what you hold first: submit, or handoff if you can't. To work in parallel anyway, claim a specific item.`,
      };
    }
    const pick = this.pick(p, agent);
    if (!pick) {
      if (p.parked) return { mode: 'idle', hint: 'The human has parked this project: start nothing new. Signoff.' };
      const blocked = this.q(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL`).get(p.id).n;
      return {
        mode: 'idle',
        hint: [
          'Nothing is ready or waiting to be shaped right now.',
          blocked ? `${blocked} ready item(s) are waiting on dependencies or their own sub-items.` : '',
          'Propose work you think matters (with acceptance criteria), or signoff.',
        ].filter(Boolean).join(' '),
      };
    }
    if (args.claim !== false) this.claimItem(p, agent, pick.item);
    return {
      mode: pick.mode,
      ...this.context(p, pick.item, agent),
      hint: pick.mode === 'review'
        ? `Review #${pick.item.seq} against done_means and the evidence, then call review with accept or reject.`
        : pick.mode === 'shape' && args.claim !== false
          ? SHAPE_HINT(pick.item, p)
          : args.claim === false
          ? `Not claimed. Claim #${pick.item.seq} to start.`
          : `You hold #${pick.item.seq} for ${dur(LEASE_MS)}. Post progress at milestones (it renews the lease). Submit with evidence when done_means is met.`,
    };
  },

  claim(p, agent, args) {
    const item = this.item(p, args.item);
    this.claimItem(p, agent, item);
    if (item.stage === 'active') this.setTouching(item, args.touching);
    return {
      ...this.context(p, item, agent),
      hint: item.stage === 'verifying'
        ? `Review #${item.seq} against done_means and the evidence, then call review.`
        : item.stage === 'proposed'
          ? SHAPE_HINT(item, p)
          : `You hold #${item.seq} for ${dur(LEASE_MS)}. Progress renews the lease.`,
    };
  },

  progress(p, agent, args) {
    const item = this.item(p, args.item);
    if (!str(args.headline) && item.holder === agent) {
      // A silent heartbeat: renews the lease, adds nothing to the record.
      this.patch(item, { lease_until: this.now() + LEASE_MS });
      this.setTouching(item, args.touching);
      return { ok: true, lease_expires_in: dur(LEASE_MS), heads_up: this.headsUp(p, agent, item) };
    }
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    if (item.holder !== agent) {
      // Don't lose the work: keep the note on the record, then explain.
      this.event(p, { item, actor: agent, type: 'comment', headline, summary, detail });
      throw new UserError(`You no longer hold #${item.seq}${item.holder ? ` (${item.holder} does)` : ''}. Your update was saved as a comment.`, {
        status: 409, hint: 'Your lease probably expired. Call next to continue with whatever is most useful.',
      });
    }
    this.patch(item, { lease_until: this.now() + LEASE_MS });
    this.setTouching(item, args.touching);
    this.event(p, { item, actor: agent, type: 'progress', headline, summary, detail });
    this.setStatus(p, agent, `#${item.seq}: ${headline}`);
    return { ok: true, lease_expires_in: dur(LEASE_MS), heads_up: this.headsUp(p, agent, item) };
  },

  ask(p, agent, args) {
    const question = layered(args.question, args.context, args.detail, 'question');
    const assumption = str(args.assumption);
    const blocking = args.blocking === true || args.blocking === 'true' || (!assumption && args.blocking == null);
    const item = args.item ? this.item(p, args.item) : null;
    const options = Array.isArray(args.options) ? args.options.map(str).filter(Boolean).slice(0, 6) : [];
    const r = this.q(`INSERT INTO questions (project_id, item_id, asked_by, question, context, detail, options, blocking, assumption, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, item?.id ?? null, agent, question.headline, question.summary, question.detail,
      JSON.stringify(options), blocking ? 1 : 0, assumption, this.now());
    const id = Number(r.lastInsertRowid);
    let parked = false;
    if (blocking && item && ['active', 'ready'].includes(item.stage)) {
      this.move(item, 'waiting', agent, { holder: null, lease_until: null, last_worker: item.holder || item.last_worker });
      parked = true;
    } else if (blocking && item?.stage === 'proposed' && item.holder === agent) {
      this.patch(item, { holder: null, lease_until: null }); // shaping pauses until the answer comes
      parked = true;
    }
    this.event(p, {
      item, actor: agent, type: blocking ? 'question' : 'assumption',
      headline: blocking ? `${agent} asks: ${question.headline}` : `${agent} assumed "${assumption}"`,
      summary: blocking ? question.summary : `Question: ${question.headline}${question.summary ? `\n\n${question.summary}` : ''}`,
      detail: question.detail, data: { question: id },
    });
    return {
      ok: true, question: id, blocking,
      hint: blocking
        ? parked
          ? `#${item.seq} is parked until the human answers. Don't wait: call next and take other work. The answer will be in your next checkin.`
          : "Asked. Keep working on anything that doesn't depend on the answer; it will appear in your next checkin."
        : 'Assumption recorded; keep going. If the human overrides it, it will arrive as steering.',
    };
  },

  submit(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = this.heldItem(p, agent, args.item, 'submit');
    if (item.stage === 'proposed') return finishShaping.call(this, p, agent, item, { headline, summary, detail, acceptance: args.acceptance });
    if (item.stage !== 'active') throw new UserError(`#${item.seq} is ${item.stage}; only active work can be submitted`, { status: 409 });
    const evidence = (Array.isArray(args.evidence) ? args.evidence : args.evidence ? [args.evidence] : [])
      .map((e) => (typeof e === 'string' ? { label: e } : { label: str(e.label || e.url), url: str(e.url) || undefined }))
      // Agents sometimes put the result where the link goes ("unit tests|2 passed"): keep it as text, not a broken link.
      .map((e) => (e.url && !/^https?:\/\//i.test(e.url) ? { label: e.label === e.url ? e.label : `${e.label}: ${e.url}` } : e))
      .filter((e) => e.label);
    this.move(item, 'verifying', agent, { holder: null, lease_until: null, last_worker: agent, implementer: agent, touching: '[]' });
    this.event(p, { item, actor: agent, type: 'submitted', headline, summary, detail, data: { evidence } });
    this.setStatus(p, agent, `Submitted #${item.seq}`);
    const reviewer = p.autonomy === 'full' ? 'Another agent will peer-review it.' : 'The human will verify it.';
    return {
      ok: true,
      hint: `#${item.seq} is verifying. ${reviewer} ${evidence.length ? '' : 'Next time attach evidence (tests run, commands, commit or PR links); it makes verification fast. '}Call next for more work.`,
    };
  },

  handoff(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = this.heldItem(p, agent, args.item, 'hand off');
    if (item.stage === 'verifying') {
      this.patch(item, { holder: null, lease_until: null });
    } else if (item.stage === 'proposed') {
      this.patch(item, { holder: null, lease_until: null, last_worker: agent, handoff: JSON.stringify({ kind: 'handoff', by: agent, headline, summary, at: this.now() }) });
    } else {
      this.move(item, 'ready', agent, {
        holder: null, lease_until: null, last_worker: agent, touching: '[]',
        handoff: JSON.stringify({ kind: 'handoff', by: agent, headline, summary, at: this.now() }),
      });
    }
    this.event(p, { item, actor: agent, type: 'handoff', headline: `${agent} handed off #${item.seq}: ${headline}`, summary, detail });
    this.setStatus(p, agent, `Handed off #${item.seq}`);
    return { ok: true, hint: 'Handed off; the next agent will see your note. Call next or signoff.' };
  },

  propose(p, agent, args) {
    const item = this.createItem(p, agent, args);
    return {
      ok: true, item: `#${item.seq}`, stage: item.stage,
      hint: item.stage === 'ready'
        ? 'Ready for any agent (including you).'
        : p.autonomy === 'ask'
          ? 'Waiting for the human to approve it.'
          : `Add acceptance criteria (refine #${item.seq}) to make it ready.`,
    };
  },

  refine(p, agent, args) {
    const item = this.item(p, args.item);
    const changed = this.refineItem(p, agent, item, args);
    return { ok: true, item: `#${item.seq}`, stage: item.stage, changed };
  },

  review(p, agent, args) {
    const item = this.item(p, args.item);
    if (p.autonomy !== 'full') throw new UserError('In this project the human verifies finished work', { status: 403, hint: 'Leave a comment with what you noticed instead.' });
    if (item.stage !== 'verifying') throw new UserError(`#${item.seq} is ${item.stage}, not verifying`, { status: 409 });
    if (item.implementer === agent) throw new UserError("You can't review your own work", { status: 403 });
    if (item.holder && item.holder !== agent) throw new UserError(`${item.holder} is reviewing #${item.seq}`, { status: 409 });
    const verdict = str(args.verdict).toLowerCase();
    if (!['accept', 'reject'].includes(verdict)) throw new UserError('verdict must be "accept" or "reject"');
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    this.verdict(p, agent, item, verdict, { headline, summary, detail });
    this.setStatus(p, agent, `Reviewed #${item.seq}`);
    return { ok: true, stage: item.stage, hint: 'Thanks. Call next.' };
  },

  comment(p, agent, args) {
    const { headline, summary, detail } = layered(args.headline, args.summary, args.detail);
    const item = args.item ? this.item(p, args.item) : null;
    this.event(p, { item, actor: agent, type: 'comment', headline, summary, detail });
    return { ok: true };
  },

  ack(p, agent, args) {
    const id = Number(String(args.steer ?? '').replace(/^#/, ''));
    const note = this.q(`SELECT * FROM notes WHERE id = ? AND project_id = ? AND kind = 'steer'`).get(id, p.id);
    if (!note) throw new UserError(`No steer ${args.steer}`, { status: 404, hint: 'Use the steer id from checkin or a response.' });
    const response = str(args.response).slice(0, 300);
    this.q('INSERT OR REPLACE INTO acks (note_id, agent, response, at) VALUES (?, ?, ?, ?)').run(id, agent, response, this.now());
    const item = this.itemById(note.item_id);
    this.event(p, {
      item, actor: agent, type: 'ack',
      headline: response ? `${agent}: ${response}` : `${agent} acknowledged your steer`,
      summary: `Steer: "${note.body}"`, data: { steer: id },
    });
    return { ok: true };
  },

  look(p, agent, args) {
    if (args.item) return this.context(p, this.item(p, args.item), agent);
    const stages = args.stage ? [str(args.stage)] : OPEN_STAGES;
    const out = {};
    for (const s of stages) {
      const rows = this.q(`SELECT * FROM items WHERE project_id = ? AND stage = ? ORDER BY seq`).all(p.id, s);
      if (rows.length) out[s] = rows.map((i) => `#${i.seq} [${i.priority}] ${i.title}${i.holder ? ` (${i.holder})` : ''}`);
    }
    const recent = this.q(`SELECT seq, title FROM items WHERE project_id = ? AND stage = 'done' AND stage_since > ? ORDER BY stage_since DESC LIMIT 10`)
      .all(p.id, this.now() - 3 * DAY);
    if (!args.stage && recent.length) out.recently_done = recent.map((i) => `#${i.seq} ${i.title}`);
    const notes = this.fieldNotes(p);
    return { board: out, decisions: this.decisions(p).map((d) => d.body), field_notes: notes.length ? notes : undefined, others_working: this.others(p, agent).map(fmtOther) };
  },

  learn(p, agent, args) {
    const text = str(args.note);
    if (!text) throw new UserError('note is required', { hint: 'One or two lines the next agent would want to know: a command that works, a trap, a convention.' });
    if (text.length > 600) throw new UserError('Keep field notes short (under 600 characters)', { hint: 'Put long explanations in docs in the repo and note where they are.' });
    const item = args.item ? this.item(p, args.item) : null;
    let replaced = null;
    if (args.replaces) {
      replaced = this.q(`SELECT * FROM notes WHERE id = ? AND project_id = ? AND kind = 'learning'`).get(Number(args.replaces), p.id);
      if (replaced) this.q('UPDATE notes SET active = 0 WHERE id = ?').run(replaced.id);
    }
    const r = this.q(`INSERT INTO notes (project_id, item_id, kind, author, body, at) VALUES (?, ?, 'learning', ?, ?, ?)`)
      .run(p.id, item?.id ?? null, agent, text, this.now());
    this.event(p, {
      item, actor: agent, type: 'learned',
      headline: `${agent} noted: ${clip(text)}`,
      summary: replaced ? `Replaces: "${replaced.body}"` : '', data: { note: Number(r.lastInsertRowid) },
    });
    return { ok: true, note: Number(r.lastInsertRowid), hint: 'Every agent will see this at checkin.' };
  },

  signoff(p, agent, args) {
    const held = this.heldBy(p, agent);
    const note = str(args.headline) || 'Signed off';
    for (const item of held) {
      AGENT_OPS.handoff.call(this, p, agent, { item: item.seq, headline: note, summary: args.summary });
    }
    this.q('UPDATE agents SET signed_off = 1, status = ? WHERE project_id = ? AND name = ?').run(note, p.id, agent);
    this.event(p, { actor: agent, type: 'signoff', headline: `${agent} signed off: ${note}`, summary: str(args.summary) });
    return { ok: true, handed_off: held.map((i) => `#${i.seq}`) };
  },
};

// ── shared by agents and the human ─────────────────────────────────────────

Object.assign(Hub.prototype, {
  createItem(p, actor, args) {
    const { headline: title, summary, detail } = layered(args.title ?? args.headline, args.summary, args.detail, 'title');
    const acceptance = str(args.acceptance);
    const priority = PRIORITY_RANK[args.priority] != null ? args.priority : 'soon';
    const parent = args.parent ? this.item(p, args.parent) : null;
    const human = actor === HUMAN;
    const stage = human ? (args.stage === 'proposed' ? 'proposed' : 'ready')
      : p.autonomy !== 'ask' && acceptance ? 'ready' : 'proposed';
    const t = this.now();
    const seq = this.q('SELECT next_seq FROM projects WHERE id = ?').get(p.id).next_seq;
    this.q('UPDATE projects SET next_seq = next_seq + 1 WHERE id = ?').run(p.id);
    const r = this.q(`INSERT INTO items (project_id, seq, title, summary, detail, acceptance, stage, priority, parent_id, created_by, stage_since, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, seq, title, summary, detail, acceptance, stage, priority, parent?.id ?? null, actor, t, t, t);
    const item = this.itemById(Number(r.lastInsertRowid));
    this.q('INSERT INTO transitions (item_id, stage, actor, at) VALUES (?, ?, ?, ?)').run(item.id, stage, actor, t);
    this.setDeps(p, item, args.depends_on);
    this.event(p, {
      item, actor, type: 'created',
      headline: human ? `You added #${seq}: ${title}` : `${actor} proposed #${seq}: ${title}`,
      summary, data: { stage },
    });
    return item;
  },

  refineItem(p, actor, item, args) {
    const changed = [];
    const set = {};
    if (args.title != null && str(args.title) && str(args.title) !== item.title) { set.title = layered(args.title).headline; changed.push('title'); }
    for (const k of ['summary', 'detail', 'acceptance']) {
      if (args[k] != null && str(args[k]) !== item[k]) { set[k] = str(args[k]); changed.push(k); }
    }
    if (args.priority && PRIORITY_RANK[args.priority] != null && args.priority !== item.priority) { set.priority = args.priority; changed.push(`priority → ${args.priority}`); }
    if (Object.keys(set).length) this.patch(item, set);
    if (Array.isArray(args.depends_on)) { this.setDeps(p, item, args.depends_on); changed.push('dependencies'); }
    const human = actor === HUMAN;
    const promote = item.stage === 'proposed' && !item.holder && item.acceptance && (human || p.autonomy !== 'ask') && args.ready !== false;
    if (promote) { this.move(item, 'ready', actor); changed.push('now ready'); }
    if (changed.length) {
      this.event(p, {
        item, actor, type: 'refined',
        headline: `${human ? 'You' : actor} refined #${item.seq}: ${changed.join(', ')}`,
        summary: set.acceptance ? `Done means: ${set.acceptance}` : '',
      });
    }
    return changed;
  },

  verdict(p, actor, item, verdict, { headline, summary = '', detail = '' }) {
    const who = actor === HUMAN ? 'You' : actor;
    if (verdict === 'accept') {
      this.move(item, 'done', actor, { holder: null, lease_until: null });
      this.event(p, { item, actor, type: 'accepted', headline: `${who} accepted #${item.seq}${headline ? `: ${headline}` : ''}`, summary, detail });
    } else {
      this.move(item, 'ready', actor, {
        holder: null, lease_until: null, rejections: item.rejections + 1,
        handoff: JSON.stringify({ kind: 'sent_back', by: actor, headline, summary, at: this.now() }),
      });
      this.event(p, { item, actor, type: 'sent_back', headline: `${who} sent back #${item.seq}: ${headline}`, summary, detail });
    }
  },
});

// ── human operations ───────────────────────────────────────────────────────

const HUMAN_OPS = {
  answer(p, { question, answer, decide }) {
    const q = this.q('SELECT * FROM questions WHERE id = ? AND project_id = ?').get(Number(question), p.id);
    if (!q) throw new UserError(`No question ${question}`, { status: 404 });
    const text = str(answer);
    if (!text) throw new UserError('answer is required');
    const item = this.itemById(q.item_id);
    if (!q.blocking && text.toLowerCase() === q.assumption.trim().toLowerCase()) {
      return HUMAN_OPS.confirm.call(this, p, { question });
    }
    this.q(`UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, seen_by_asker = 0 WHERE id = ?`)
      .run(text, HUMAN, this.now(), q.id);
    this.event(p, {
      item, actor: HUMAN, type: 'answered',
      headline: `You answered${item ? ` on #${item.seq}` : ''}: ${clip(text)}`,
      summary: `${q.asked_by} asked: ${q.question}`, data: { question: q.id },
    });
    if (!q.blocking && q.status === 'open') {
      // Overriding an assumption the agent already acted on: tell whoever is on it now.
      this.addNote(p, 'steer', `Change of course${item ? ` on #${item.seq}` : ''}: you assumed "${q.assumption}". Instead: ${text}`, item);
    }
    if (item && item.stage === 'waiting' && !this.openQuestions(item, { blocking: true }).length) {
      this.move(item, 'ready', HUMAN);
    }
    if (decide) this.addNote(p, 'decision', `${q.question} → ${text}`);
  },

  confirm(p, { question }) {
    const q = this.q('SELECT * FROM questions WHERE id = ? AND project_id = ?').get(Number(question), p.id);
    if (!q) throw new UserError(`No question ${question}`, { status: 404 });
    this.q(`UPDATE questions SET status = 'confirmed', answered_by = ?, answered_at = ?, seen_by_asker = 0 WHERE id = ?`).run(HUMAN, this.now(), q.id);
    this.event(p, { item: this.itemById(q.item_id), actor: HUMAN, type: 'assumption_confirmed', headline: `You confirmed ${q.asked_by}'s assumption: ${q.assumption}` });
  },

  accept(p, { item, note }) {
    const it = this.item(p, item);
    if (it.stage !== 'verifying') throw new UserError(`#${it.seq} is ${it.stage}, not verifying`, { status: 409 });
    this.verdict(p, HUMAN, it, 'accept', { headline: str(note) });
  },

  sendback(p, { item, note }) {
    const it = this.item(p, item);
    const { headline, summary } = layered(note, '', '', 'A reason for sending it back');
    if (!['verifying', 'done'].includes(it.stage)) throw new UserError(`#${it.seq} is ${it.stage}`, { status: 409 });
    this.verdict(p, HUMAN, it, 'reject', { headline, summary });
  },

  steer(p, { item, body }) {
    this.addNote(p, 'steer', body, item ? this.item(p, item) : null);
  },

  decide(p, { body }) {
    this.addNote(p, 'decision', body);
  },

  retire(p, { note }) {
    const n = this.q('SELECT * FROM notes WHERE id = ? AND project_id = ?').get(Number(note), p.id);
    if (!n) throw new UserError(`No note ${note}`, { status: 404 });
    this.q('UPDATE notes SET active = 0 WHERE id = ?').run(n.id);
    this.event(p, { item: this.itemById(n.item_id), actor: HUMAN, type: 'retired', headline: `You retired a ${n.kind === 'learning' ? 'field note' : n.kind}: ${clip(n.body, 100)}` });
  },

  comment(p, { item, body }) {
    const { headline, summary } = layered(body, '', '', 'comment');
    this.event(p, { item: item ? this.item(p, item) : null, actor: HUMAN, type: 'comment', headline, summary });
  },

  create(p, args) {
    return { item: `#${this.createItem(p, HUMAN, args).seq}` };
  },

  update(p, args) {
    const it = this.item(p, args.item);
    this.refineItem(p, HUMAN, it, args);
    if (args.stage && args.stage !== it.stage) {
      if (!['proposed', 'ready', 'dropped', 'done'].includes(args.stage)) throw new UserError(`You can move work to proposed, ready, done or dropped (not ${args.stage})`);
      const holder = it.holder;
      this.move(it, args.stage, HUMAN, { holder: null, lease_until: null });
      const verb = { ready: 'moved', proposed: 'moved', done: 'marked', dropped: 'dropped' }[args.stage];
      this.event(p, { item: it, actor: HUMAN, type: 'staged', headline: `You ${verb} #${it.seq}${args.stage !== 'dropped' ? ` to ${args.stage}` : ''}`, summary: str(args.note) });
      if (holder) this.addNote(p, 'steer', `#${it.seq} was ${args.stage === 'dropped' ? 'dropped' : `moved to ${args.stage}`} by the human; stop working on it.${args.note ? ` ${args.note}` : ''}`, null, holder);
    }
  },

  pick(p, { item }) {
    const it = this.item(p, item);
    if (!['proposed', 'ready'].includes(it.stage)) throw new UserError(`#${it.seq} is ${it.stage}`, { status: 409 });
    this.patch(it, { priority: 'now' });
    this.event(p, {
      item: it, actor: HUMAN, type: 'picked',
      headline: `You picked #${it.seq} as what matters most: ${it.title}`,
      summary: it.stage === 'proposed' ? 'The next agent to check in will shape it first, then it gets built.' : 'It goes to the front of the queue.',
    });
  },

  dismiss(p, { key }) {
    this.q('INSERT OR REPLACE INTO dismissals (project_id, key, at) VALUES (?, ?, ?)').run(p.id, str(key), this.now());
  },

  seen(p) {
    this.q('UPDATE projects SET seen_at = ? WHERE id = ?').run(this.now(), p.id);
  },

  settings(p, { name, mission, autonomy, parked }) {
    const changes = [];
    if (parked != null && !!parked !== !!p.parked) {
      this.q('UPDATE projects SET parked = ? WHERE id = ?').run(parked ? 1 : 0, p.id);
      this.event(p, { actor: HUMAN, type: 'parked', headline: parked ? 'You parked the project' : 'You unparked the project' });
      if (parked) this.addNote(p, 'steer', 'The project is parked. Finish or hand off what you hold; start nothing new.', null);
    }
    if (name != null && str(name) && str(name) !== p.name) { this.q('UPDATE projects SET name = ? WHERE id = ?').run(str(name), p.id); changes.push('name'); }
    if (mission != null && str(mission) !== p.mission) { this.q('UPDATE projects SET mission = ? WHERE id = ?').run(str(mission), p.id); changes.push('mission'); }
    if (autonomy && autonomy !== p.autonomy) {
      if (!AUTONOMY[autonomy]) throw new UserError('autonomy must be ask, balanced or full');
      this.q('UPDATE projects SET autonomy = ? WHERE id = ?').run(autonomy, p.id);
      changes.push('autonomy');
      this.addNote(p, 'steer', `Autonomy is now "${AUTONOMY[autonomy].label}": ${AUTONOMY[autonomy].agent}`, null);
    }
    if (changes.includes('mission')) this.event(p, { actor: HUMAN, type: 'mission', headline: 'You updated the mission', summary: str(mission) });
  },
};

Object.assign(Hub.prototype, {
  addNote(p, kind, body, item = null, target = null) {
    const text = str(body);
    if (!text) throw new UserError(`${kind} text is required`);
    const r = this.q('INSERT INTO notes (project_id, item_id, kind, target, author, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, item?.id ?? null, kind, target, HUMAN, text, this.now());
    this.event(p, {
      item, actor: HUMAN, type: kind,
      headline: kind === 'decision' ? `Decision: ${clip(text)}` : `You steered${item ? ` #${item.seq}` : ''}: ${clip(text)}`,
      summary: text.includes('\n') || text.length > 120 ? text : '',
      data: { note: Number(r.lastInsertRowid) },
    });
    return Number(r.lastInsertRowid);
  },

  humanOp(slug, action, args = {}) {
    const fn = HUMAN_OPS[action];
    if (!fn) throw new UserError(`Unknown action "${action}"`, { status: 404 });
    this.sweep();
    const p = this.project(slug, { create: action === 'create' && args.createProject });
    const result = this.tx(() => fn.call(this, p, args ?? {})) ?? {};
    this.changed(p);
    return { ok: true, ...result };
  },
});

export const AGENT_OP_NAMES = Object.keys(AGENT_OPS);
export const HUMAN_OP_NAMES = Object.keys(HUMAN_OPS);
