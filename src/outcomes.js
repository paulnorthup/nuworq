// What finished work came to, for other tools to read (GET /api/p/<project>/outcomes; documented in
// docs/API.md, which is the contract). Built only from what the hub already records.
import { HUMAN, HOUR, isHuman, isSystem, dur, UserError } from './core.js';

const DAY = 24 * 60 * 60 * 1000;
export const OUTCOMES_VERSION = 1;

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

// Whether landed work held up (#176). It escaped when a later item names it in `fixes`. Its reviewer is whoever
// accepted it last (the verdict it landed on); a peer is an agent. A peer's accept is overturned when a person
// sent the work back after it, or the work escaped on a peer's verdict.
export function heldUp(hub, it) {
  const fixed_by = hub.q('SELECT seq FROM items WHERE fixes = ? ORDER BY seq').all(it.id).map((r) => `#${r.seq}`);
  const accepts = hub.q(`SELECT actor, at FROM events WHERE item_id = ? AND type = 'accepted' ORDER BY at, id`).all(it.id);
  const peer = (a) => !isHuman(a) && !isSystem(a);
  const last = accepts.at(-1) ?? null;
  const firstPeer = accepts.find((a) => peer(a.actor));
  const sentBack = !!firstPeer && !!hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type = 'sent_back' AND at >= ? AND (actor = ? OR actor LIKE '@%')`).get(it.id, firstPeer.at, HUMAN);
  const peerReviewed = !!last && peer(last.actor);
  return {
    escaped: fixed_by.length > 0, fixed_by,
    reviewer: last?.actor ?? null, peer_review: peerReviewed,
    overturned: sentBack || (peerReviewed && fixed_by.length > 0),
    peer_accepted: !!firstPeer,
  };
}

// Escapes and overturned peer verdicts over some landed items, per model: as builder (the implementer's model)
// and as reviewer (the peer whose accept it landed on). modelOf(agent) → model or null.
export function verification(hub, landed, modelOf) {
  const rows = landed.map((it) => ({ it, ...heldUp(hub, it) }));
  const models = new Map();
  const row = (m) => models.get(m ?? '') ?? models.set(m ?? '', { model: m ?? null, built: 0, built_escaped: 0, reviewed: 0, reviewed_escaped: 0, overturned: 0 }).get(m ?? '');
  for (const r of rows) {
    const b = row(modelOf(r.it.implementer));
    b.built++;
    if (r.escaped) b.built_escaped++;
    if (r.peer_review) {
      const v = row(modelOf(r.reviewer));
      v.reviewed++;
      if (r.escaped) v.reviewed_escaped++;
    }
    if (r.overturned) {
      const by = hub.q(`SELECT actor FROM events WHERE item_id = ? AND type = 'accepted' ORDER BY at, id`).all(r.it.id).map((a) => a.actor).find((a) => !isHuman(a) && !isSystem(a));
      row(modelOf(by)).overturned++;
    }
  }
  return {
    landed: rows.length, escaped: rows.filter((r) => r.escaped).length,
    peer_accepted: rows.filter((r) => r.peer_accepted).length, overturned: rows.filter((r) => r.overturned).length,
    by_model: [...models.values()],
  };
}

// What work costs a person (#175): each answer, verdict, steer, decision, comment and confirmation they made,
// as the events already record them. The steer an override writes beside its answer is the same action, and
// so is the answer an escalation's answer gives the operator question it carried up.
export const HUMAN_ACTIONS = ['answered', 'accepted', 'sent_back', 'steer', 'decision', 'comment', 'assumption_confirmed'];
const PERSON = (col = 'actor') => `(${col} = '${HUMAN}' OR ${col} LIKE '@%')`;
const ACTIONS = `e.type IN (${HUMAN_ACTIONS.map((t) => `'${t}'`).join(', ')}) AND ${PERSON('e.actor')}
  AND NOT (e.type = 'steer' AND e.headline LIKE '%: Change of course%'
    AND EXISTS (SELECT 1 FROM events a WHERE a.type = 'answered' AND a.actor = e.actor AND a.at = e.at AND a.project_id = e.project_id))
  AND NOT (e.type = 'answered'
    AND EXISTS (SELECT 1 FROM questions x WHERE x.escalates = json_extract(e.data, '$.question') AND x.answered_at = e.at))`;

// A person's actions on one item, ever.
export const humanActionsOn = (hub, item) => hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.item_id = ? AND ${ACTIONS}`).get(item.id).n;

// How long act-level Needs you entries (src/insight.js) waited until a person resolved them, for those resolved
// in (from, to], each from when it reached you: a blocking question to you (a reporter's once the hub asks you
// instead; an operator's only as its escalation), a review while agents don't review, a shaped proposal under
// 'ask'. Entries an agent or operator resolved aren't yours to count.
function waitsForYou(hub, p, from, to) {
  const waits = [];
  const qs = hub.q(`SELECT at, reporter, answered_by, answered_at FROM questions WHERE project_id = ? AND blocking = 1
    AND audience != 'operator' AND status = 'answered' AND answered_at > ? AND answered_at <= ?`).all(p.id, from, to);
  for (const q of qs) {
    const start = q.reporter ? q.at + p.reporter_wait * HOUR : q.at;
    if (isHuman(q.answered_by) && q.answered_at > start) waits.push(q.answered_at - start);
  }
  if (p.autonomy === 'full') return waits; // agents review, and shaped proposals go straight to ready
  const rows = hub.q(`SELECT t.item_id, t.stage, t.actor, t.at FROM transitions t WHERE t.item_id IN (SELECT t2.item_id FROM transitions t2
      JOIN items i ON i.id = t2.item_id WHERE i.project_id = ? AND t2.at > ? AND t2.at <= ?) AND t.at <= ?
    ORDER BY t.item_id, t.at, t.id`).all(p.id, from, to, to);
  for (let k = 0; k + 1 < rows.length; k++) {
    const [a, b] = [rows[k], rows[k + 1]];
    if (a.item_id !== b.item_id || b.at <= from || !isHuman(b.actor)) continue;
    if (a.stage === 'verifying') waits.push(b.at - a.at);
    if (a.stage === 'proposed' && p.autonomy === 'ask') {
      // It reaches you once shaped; a raw idea you moved on yourself never sat in Needs you.
      const shaped = hub.q(`SELECT MAX(at) AS at FROM events WHERE item_id = ? AND type = 'shaped' AND at >= ? AND at <= ?`).get(a.item_id, a.at, b.at).at;
      if (shaped != null) waits.push(b.at - shaped);
    }
  }
  return waits;
}

// Over (from, to]: the person actions, the items that landed, actions per landed item, and the median wait of
// what needed you until you resolved it.
export function humanCost(hub, p, from, to = hub.now()) {
  const actions = hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.project_id = ? AND e.at > ? AND e.at <= ? AND ${ACTIONS}`).get(p.id, from, to).n;
  const landed = hub.q(`SELECT COUNT(DISTINCT t.item_id) AS n FROM transitions t JOIN items i ON i.id = t.item_id
    WHERE i.project_id = ? AND t.stage = 'done' AND t.at > ? AND t.at <= ?`).get(p.id, from, to).n;
  const waits = waitsForYou(hub, p, from, to);
  return { actions, landed, per_landed: landed ? Math.round((10 * actions) / landed) / 10 : null, median_wait_ms: median(waits), waits: waits.length };
}

// since/until: ms, the window an item must have finished (done or dropped) in. Default: the last 30 days.
export function outcomes(hub, slug, { since, until } = {}) {
  const p = hub.project(slug);
  const to = Number.isFinite(Number(until)) && until !== '' && until != null ? Number(until) : hub.now();
  const from = Number.isFinite(Number(since)) && since !== '' && since != null ? Number(since) : to - 30 * DAY;
  const finished = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage IN ('done', 'dropped') AND stage_since >= ? AND stage_since <= ?
    ORDER BY stage_since, seq`).all(p.id, from, to);
  const modelOf = (agent) => (agent ? hub.q('SELECT model FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent)?.model || null : null);
  const items = finished.map((it) => {
    const claimed = hub.q(`SELECT MIN(at) AS at FROM events WHERE item_id = ? AND type = 'claimed'`).get(it.id).at;
    const usage = (hub.usageOf(it)?.rows ?? []).filter((r) => !r.superseded)
      .map((r) => ({ agent: r.agent, model: r.model, source: r.source, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }));
    const held = it.stage === 'done' ? heldUp(hub, it) : null;
    return {
      item: `#${it.seq}`, title: it.title, size: it.size || null, repo: hub.repoOf(p, it) || null,
      outcome: it.stage === 'done' ? 'landed' : 'dropped',
      done_at: it.stage_since,
      cycle_ms: claimed != null ? it.stage_since - claimed : null,
      sent_back: it.rejections, stalls: it.stalls, attempts: it.attempts,
      implementer: it.implementer || null, model: modelOf(it.implementer),
      reviewer: held?.reviewer ?? null, reviewer_model: held?.peer_review ? modelOf(held.reviewer) : null,
      escaped: held?.escaped ?? false, fixed_by: held?.fixed_by ?? [], overturned: held?.overturned ?? false,
      human_actions: humanActionsOn(hub, it),
      usage,
    };
  });
  const by_model = groupBy(items, (i) => i.model).map(([model, list]) => ({ model, ...tally(list) }));
  const by_agent = groupBy(items, (i) => i.implementer).map(([agent, list]) => ({ agent, model: list.find((i) => i.model)?.model ?? null, ...tally(list) }));
  // Peer reviewers, per model: what they accepted that landed, how much of it escaped, and how many of their
  // verdicts a person overturned.
  const v = verification(hub, finished.filter((it) => it.stage === 'done'), modelOf);
  const by_reviewer = v.by_model.filter((m) => m.reviewed || m.overturned).map((m) => ({ model: m.model, reviewed: m.reviewed, escapes: m.reviewed_escaped, overturned: m.overturned }));
  const cost = humanCost(hub, p, from, to);
  const human_actions = { total: cost.actions, landed: cost.landed, per_landed: cost.per_landed, median_wait_ms: cost.median_wait_ms };
  return { version: OUTCOMES_VERSION, project: p.slug, since: from, until: to, items, by_model, by_agent, by_reviewer, human_actions };
}

// Finished items (outcomes().items) grouped by key(item): [[key or null, items]], in first-seen order.
function groupBy(items, key) {
  const groups = new Map();
  for (const i of items) {
    const k = key(i) ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  return [...groups].map(([k, list]) => [k || null, list]);
}

// What some finished items came to: outcomes, tokens and cost (null if any part is unpriced or there is no
// usage), and per landed item the cost, the median cycle time and how often it escaped.
function tally(list) {
  const rows = list.flatMap((i) => i.usage);
  const sum = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
  const landed = list.filter((i) => i.outcome === 'landed');
  const cost = rows.length && rows.every((r) => r.cost_usd != null) ? sum('cost_usd') : null;
  const escapes = list.filter((i) => i.escaped).length;
  return {
    landed: landed.length,
    dropped: list.length - landed.length,
    sent_back: list.reduce((a, i) => a + i.sent_back, 0),
    stalls: list.reduce((a, i) => a + i.stalls, 0),
    escapes,
    median_cycle_ms: median(landed.map((i) => i.cycle_ms)),
    input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
    cost_usd: cost,
    cost_per_landed: cost != null && landed.length ? Math.round((100 * cost) / landed.length) / 100 : null,
    escape_rate: landed.length ? Math.round((100 * escapes) / landed.length) / 100 : null,
  };
}

// ── Across a workspace (#237): every project over a period, against the one before ──

export const PERIODS = { '14d': 14 * DAY, '90d': 90 * DAY, all: null };
const MIN_LANDED = 3; // fewer landed items than this in a group or a period say nothing worth deciding on

// One project's figures over [from, to]: landed, median cycle time, cost, the owner's actions and median wait,
// and escapes. raw: the finished items and the owner's waits, for figures across projects.
function projectFigures(hub, p, from, to) {
  const o = outcomes(hub, p.slug, { since: from, until: to });
  const t = tally(o.items);
  const waits = waitsForYou(hub, p, from, to);
  return {
    figures: {
      landed: t.landed, median_cycle_ms: t.median_cycle_ms, cost_usd: t.cost_usd, cost_per_landed: t.cost_per_landed,
      human_actions: o.human_actions.total, median_wait_ms: median(waits), escapes: t.escapes,
    },
    items: o.items, waits,
  };
}

// GET /api/outcomes?period=14d|90d|all: one row per project with the previous period's figures beside them
// (none for all), the same items by implementer model and agent across the workspace, and one takeaway.
// scope: the project slugs a token may read (null: all).
export function workspaceOutcomes(hub, { period = '14d', scope = null } = {}) {
  if (!Object.hasOwn(PERIODS, period)) throw new UserError(`"${period}" is not a period`, { status: 400, hint: `One of: ${Object.keys(PERIODS).join(', ')}.` });
  const to = hub.now();
  const span = PERIODS[period];
  const from = span == null ? 0 : to - span;
  const items = [], waits = [];
  const projects = hub.projects().filter((p) => !scope || scope.includes(p.slug)).map((p) => {
    const now = projectFigures(hub, p, from, to);
    items.push(...now.items);
    waits.push(...now.waits);
    const before = span == null ? null : projectFigures(hub, p, from - span, from - 1).figures;
    return { project: p.slug, name: p.name, ...now.figures, previous: before };
  });
  const by_model = groupBy(items, (i) => i.model).map(([model, list]) => ({ model, ...tally(list) }));
  const by_agent = groupBy(items, (i) => i.implementer).map(([agent, list]) => ({ agent, model: list.find((i) => i.model)?.model ?? null, ...tally(list) }));
  const total = tally(items);
  const summary = { ...total, median_wait_ms: median(waits) };
  return {
    version: OUTCOMES_VERSION, period, since: from, until: to,
    takeaway: takeaway({ summary, projects, by_model }),
    summary, projects, by_model, by_agent,
  };
}

const usd = (n) => `$${n.toFixed(2)}`;

// The one decision the figures suggest, or null when there is too little to go on. In order: the owner is the
// wait; too much landed work needs fixing; one model lands for much less than another; a project slowed down.
export function takeaway({ summary, projects, by_model }) {
  if (summary.landed < MIN_LANDED) return null;
  const { median_wait_ms: wait, median_cycle_ms: cycle } = summary;
  if (wait != null && wait >= HOUR && cycle && wait >= cycle / 4) {
    return `Your answers are the wait: median ${dur(wait)} against ${dur(cycle)} per item. Record decisions and prefer assumptions so agents ask less.`;
  }
  if (summary.escape_rate != null && summary.escape_rate >= 0.2) {
    return `${Math.round(summary.escape_rate * 100)}% of landed work needed a fix later. Ask for stronger evidence before accepting, or review with another model.`;
  }
  const priced = by_model.filter((m) => m.model && m.landed >= MIN_LANDED && m.cost_per_landed != null).sort((a, b) => a.cost_per_landed - b.cost_per_landed);
  if (priced.length >= 2) {
    const [cheap, dear] = [priced[0], priced.at(-1)];
    if (dear.cost_per_landed >= 1.5 * cheap.cost_per_landed && (cheap.escape_rate ?? 0) <= (dear.escape_rate ?? 0) + 0.1) {
      return `${cheap.model} lands for ${usd(cheap.cost_per_landed)} an item vs ${usd(dear.cost_per_landed)} for ${dear.model}, with as few escapes: prefer it.`;
    }
  }
  const slowed = projects.filter((p) => p.previous && p.previous.landed >= MIN_LANDED && p.landed <= p.previous.landed / 2)
    .sort((a, b) => (b.previous.landed - b.landed) - (a.previous.landed - a.landed))[0];
  if (slowed) return `${slowed.name} landed ${slowed.landed} vs ${slowed.previous.landed} the period before: give it more agents or see what holds it.`;
  return null;
}
