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
export const heldUp = (hub, it) => { const { first_peer, ...r } = heldUpAll(hub, [it]).get(it.id); return r; };

// heldUp for many items in three queries, not three per item (#537): item id → its answer, with first_peer, the
// peer whose accept a person later overturned (verification counts it).
const ids = (items) => JSON.stringify(items.map((it) => it.id));
const byItem = (rows) => {
  const m = new Map();
  for (const r of rows) (m.get(r.item_id) ?? m.set(r.item_id, []).get(r.item_id)).push(r);
  return m;
};
export function heldUpAll(hub, items) {
  const list = ids(items);
  const fixes = byItem(hub.q('SELECT fixes AS item_id, seq FROM items WHERE fixes IN (SELECT value FROM json_each(?)) ORDER BY seq').all(list));
  const accepts = byItem(hub.q(`SELECT item_id, actor, at FROM events WHERE item_id IN (SELECT value FROM json_each(?)) AND type = 'accepted' ORDER BY at, id`).all(list));
  const backs = byItem(hub.q(`SELECT item_id, at FROM events WHERE item_id IN (SELECT value FROM json_each(?)) AND type = 'sent_back' AND (actor = ? OR actor LIKE '@%')`).all(list, HUMAN));
  const peer = (a) => !isHuman(a) && !isSystem(a);
  const out = new Map();
  for (const it of items) {
    const fixed_by = (fixes.get(it.id) ?? []).map((r) => `#${r.seq}`);
    const acc = accepts.get(it.id) ?? [];
    const last = acc.at(-1) ?? null;
    const firstPeer = acc.find((a) => peer(a.actor));
    const sentBack = !!firstPeer && (backs.get(it.id) ?? []).some((b) => b.at >= firstPeer.at);
    const peerReviewed = !!last && peer(last.actor);
    out.set(it.id, {
      escaped: fixed_by.length > 0, fixed_by,
      reviewer: last?.actor ?? null, peer_review: peerReviewed,
      overturned: sentBack || (peerReviewed && fixed_by.length > 0),
      peer_accepted: !!firstPeer, first_peer: firstPeer?.actor ?? null,
    });
  }
  return out;
}

// Escapes and overturned peer verdicts over some landed items, per model: as builder (the implementer's model)
// and as reviewer (the peer whose accept it landed on). modelOf(agent) → model or null.
export function verification(hub, landed, modelOf, held = heldUpAll(hub, landed)) {
  const rows = landed.map((it) => ({ it, ...held.get(it.id) }));
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
    if (r.overturned) row(modelOf(r.first_peer)).overturned++;
  }
  return {
    landed: rows.length, escaped: rows.filter((r) => r.escaped).length,
    peer_accepted: rows.filter((r) => r.peer_accepted).length, overturned: rows.filter((r) => r.overturned).length,
    by_model: [...models.values()],
  };
}

// What work costs a person (#175): each answer, verdict, steer, decision, comment and confirmation they made,
// as the events already record them. The steer an override writes beside its answer is the same action, and
// so is the answer an escalation's answer gives the operator question it carried up. Setting the autonomy and
// parking the project count as before #550, when the hub's notice to agents recorded them as steers.
export const HUMAN_ACTIONS = ['answered', 'accepted', 'sent_back', 'steer', 'decision', 'comment', 'assumption_confirmed', 'autonomy', 'parked'];
const PERSON = (col = 'actor') => `(${col} = '${HUMAN}' OR ${col} LIKE '@%')`;
// Built when first used: core.js imports this file (#349), so its exports aren't there while this one loads.
const ACTIONS = () => `e.type IN (${HUMAN_ACTIONS.map((t) => `'${t}'`).join(', ')}) AND ${PERSON('e.actor')}
  AND NOT (e.type = 'parked' AND e.headline LIKE '%unparked%')
  AND NOT (e.type = 'steer' AND e.headline LIKE '%: Change of course%'
    AND EXISTS (SELECT 1 FROM events a WHERE a.type = 'answered' AND a.actor = e.actor AND a.at = e.at AND a.project_id = e.project_id))
  AND NOT (e.type = 'answered'
    AND EXISTS (SELECT 1 FROM questions x WHERE x.escalates = json_extract(e.data, '$.question') AND x.answered_at = e.at))`;

// A person's actions on one item, ever.
export const humanActionsOn = (hub, item) => hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.item_id = ? AND ${ACTIONS()}`).get(item.id).n;
// The same for many items in one query: item id → count (#537).
const humanActionsAll = (hub, items) => new Map(hub.q(`SELECT e.item_id, COUNT(*) AS n FROM events e
  WHERE e.item_id IN (SELECT value FROM json_each(?)) AND ${ACTIONS()} GROUP BY e.item_id`).all(ids(items)).map((r) => [r.item_id, r.n]));

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
  const actions = hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.project_id = ? AND e.at > ? AND e.at <= ? AND ${ACTIONS()}`).get(p.id, from, to).n;
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
  const models = new Map(hub.q('SELECT name, model FROM agents WHERE project_id = ?').all(p.id).map((a) => [a.name, a.model || null]));
  const modelOf = (agent) => (agent ? models.get(agent) ?? null : null);
  // What every finished item needs from its events, in one query each, not one per item (#537).
  const claims = new Map(hub.q(`SELECT item_id, MIN(at) AS at FROM events WHERE item_id IN (SELECT value FROM json_each(?)) AND type = 'claimed' GROUP BY item_id`).all(ids(finished)).map((r) => [r.item_id, r.at]));
  const landed = finished.filter((it) => it.stage === 'done');
  const helds = heldUpAll(hub, landed);
  const actions = humanActionsAll(hub, finished);
  const items = finished.map((it) => {
    const claimed = claims.get(it.id) ?? null;
    const usage = (hub.usageOf(it)?.rows ?? []).filter((r) => !r.superseded)
      .map((r) => ({ agent: r.agent, model: r.model, source: r.source, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cost_usd: r.cost_usd }));
    const held = it.stage === 'done' ? helds.get(it.id) : null;
    // No model from checkin in this project (#306): the one the implementer's own usage rows name, if just one.
    const reported = [...new Set(usage.filter((r) => r.agent === it.implementer && r.model).map((r) => r.model))];
    return {
      item: `#${it.seq}`, title: it.title, size: it.size || null, difficulty: it.difficulty || 'standard', rated: !!it.difficulty,
      repo: hub.repoOf(p, it) || null,
      outcome: it.stage === 'done' ? 'landed' : 'dropped',
      done_at: it.stage_since,
      cycle_ms: claimed != null ? it.stage_since - claimed : null,
      sent_back: it.rejections, stalls: it.stalls, attempts: it.attempts,
      implementer: it.implementer || null, model: modelOf(it.implementer) ?? (reported.length === 1 ? reported[0] : null),
      reviewer: held?.reviewer ?? null, reviewer_model: held?.peer_review ? modelOf(held.reviewer) : null,
      escaped: held?.escaped ?? false, fixed_by: held?.fixed_by ?? [], overturned: held?.overturned ?? false,
      human_actions: actions.get(it.id) ?? 0,
      usage,
    };
  });
  const by_model = groupBy(items, (i) => i.model).map(([model, list]) => ({ model, ...tally(list) }));
  const by_agent = groupBy(items, (i) => i.implementer).map(([agent, list]) => ({ agent, model: list.find((i) => i.model)?.model ?? null, ...tally(list) }));
  // Peer reviewers, per model: what they accepted that landed, how much of it escaped, and how many of their
  // verdicts a person overturned.
  const v = verification(hub, landed, modelOf, helds);
  const by_reviewer = v.by_model.filter((m) => m.reviewed || m.overturned).map((m) => ({ model: m.model, reviewed: m.reviewed, escapes: m.reviewed_escaped, overturned: m.overturned }));
  const cost = humanCost(hub, p, from, to);
  const human_actions = { total: cost.actions, landed: cost.landed, per_landed: cost.per_landed, median_wait_ms: cost.median_wait_ms };
  return { version: OUTCOMES_VERSION, project: p.slug, since: from, until: to, items, by_model, by_agent, by_reviewer, human_actions, jobs: jobsTaken(hub, p, from, to) };
}

// ── Each job an agent took (#348): what it was, on what, and how it came out ──

// The events that end a job, per job: its taker finished it.
const FINISHED = { work: ['submitted'], review: ['accepted', 'sent_back'], shape: ['shaped'], land: ['landed', 'pushed', 'rebased', 'submitted'], tidy: ['submitted'] };
const TAKES = ['claimed', 'shaping', 'review_started', 'landing'];
// Every event that can change a job's result: its take, its end, and the verdicts and lapses after it (#537).
export const JOB_EVENTS = [...new Set([...TAKES, ...Object.values(FINISHED).flat(), 'accepted', 'sent_back', 'handoff', 'lease_expired'])];

// Every job taken in [from, to], oldest first: { item, job, agent, model, difficulty, trial, at, result }.
// A building job's result: landed (without being sent back), escaped (landed, and a later item repairs it), sent
// back, not chosen (a race kept another attempt), stalled (handed off, or its lease lapsed), or open (still going,
// or accepted and not landed yet). Any other job: done, stalled or open.
export function jobsTaken(hub, p, from, to = hub.now()) {
  const takes = hub.q(`SELECT e.*, i.seq, i.stage AS item_stage FROM events e JOIN items i ON i.id = e.item_id
    WHERE e.project_id = ? AND e.type IN (${TAKES.map(() => '?').join(', ')}) AND e.at >= ? AND e.at <= ? ORDER BY e.at, e.id`).all(p.id, ...TAKES, from, to);
  // Every event of the items taken, in one query, grouped by item in id order (#537); and the items later repaired.
  const taken = [...new Set(takes.map((e) => e.item_id))];
  const events = byItem(hub.q(`SELECT item_id, id, type, actor, data FROM events WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, id`).all(JSON.stringify(taken)));
  const repaired = new Set(hub.q(`SELECT DISTINCT fixes FROM items WHERE fixes IN (SELECT value FROM json_each(?))`).all(JSON.stringify(taken)).map((r) => r.fixes));
  return takes.map((e) => {
    const d = JSON.parse(e.data || '{}');
    const job = d.job ?? { shaping: 'shape', review_started: 'review', landing: 'land' }[e.type] ?? 'work';
    const after = (events.get(e.item_id) ?? []).filter((x) => x.id > e.id);
    const mine = (x) => x.actor === e.actor;
    const lapsed = (x) => x.type === 'lease_expired' && (JSON.parse(x.data || '{}').agent ?? (job === 'review' ? e.actor : null)) === e.actor;
    let result = 'open';
    const end = after.findIndex((x) => (mine(x) && (FINISHED[job].includes(x.type) || x.type === 'handoff')) || lapsed(x));
    if (end >= 0) {
      const x = after[end];
      if (x.type === 'handoff' || x.type === 'lease_expired') result = 'stalled';
      else if (job !== 'work') result = 'done';
      else {
        // Built and submitted: the verdict that follows decides it.
        const verdict = after.slice(end + 1).find((v) => v.type === 'accepted' || v.type === 'sent_back');
        const kept = verdict && JSON.parse(verdict.data || '{}').kept;
        if (verdict?.type === 'sent_back') result = 'sent_back';
        else if (verdict && kept && kept !== e.actor) result = 'not_chosen';
        else if (verdict && e.item_stage === 'done') result = repaired.has(e.item_id) ? 'escaped' : 'landed';
      }
    }
    return { item: `#${e.seq}`, job, agent: e.actor, model: d.model || null, difficulty: d.difficulty ?? 'standard', trial: d.trial ?? null, at: e.at, result };
  });
}

// ── Calibration (#348): does difficulty predict what an item costs and how many attempts it takes, better than size? ──

// Over landed items (outcomes().items): per difficulty and per size, how many, the median cost and the mean attempts;
// and for each, the spread: the dearest group's median cost over the cheapest's (groups of MIN_LANDED or more,
// priced). predicts: 'difficulty' or 'size' when one spreads cost at least 1.25 times as much as the other, 'neither'
// when they spread about the same, null when there is too little to tell.
export function calibration(items) {
  const landed = items.filter((i) => i.outcome === 'landed');
  const costOf = (i) => (i.usage.length && i.usage.every((r) => r.cost_usd != null) ? i.usage.reduce((a, r) => a + r.cost_usd, 0) : null);
  const group = (key, order) => order.map((k) => {
    const list = landed.filter((i) => key(i) === k);
    const cost = median(list.map(costOf));
    return {
      key: k, landed: list.length, rated: list.filter((i) => i.rated).length,
      median_cost: cost == null ? null : Math.round(cost * 100) / 100,
      mean_attempts: list.length ? Math.round((10 * list.reduce((a, i) => a + Math.max(i.attempts, 1), 0)) / list.length) / 10 : null,
    };
  });
  const spread = (rows, field) => {
    const known = rows.filter((r) => r.landed >= MIN_LANDED && r[field] != null && r[field] > 0).map((r) => r[field]);
    return known.length >= 2 ? Math.round((100 * Math.max(...known)) / Math.min(...known)) / 100 : null;
  };
  const by_difficulty = group((i) => i.difficulty, ['rote', 'standard', 'hard']);
  const by_size = group((i) => i.size ?? 'small', ['small', 'large']);
  const d = { cost: spread(by_difficulty, 'median_cost'), attempts: spread(by_difficulty, 'mean_attempts') };
  const s = { cost: spread(by_size, 'median_cost'), attempts: spread(by_size, 'mean_attempts') };
  const predicts = d.cost == null || s.cost == null ? (d.cost != null && d.cost >= 1.25 ? 'difficulty' : null)
    : d.cost >= 1.25 * s.cost ? 'difficulty' : s.cost >= 1.25 * d.cost ? 'size' : 'neither';
  return { landed: landed.length, rated: landed.filter((i) => i.rated).length, by_difficulty, by_size, spread: { difficulty: d, size: s }, predicts };
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
export function tally(list) {
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
  const items = [], waits = [], jobs = [];
  const projects = hub.projects().filter((p) => !scope || scope.includes(p.slug)).map((p) => {
    const now = projectFigures(hub, p, from, to);
    jobs.push(...pricedJobs(hub, p, from, to));
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
    summary, projects, by_model, by_agent, calibration: calibration(items), routing: routingResults(jobs),
  };
}

// ── Model routing (#349): each model's results per cell (job and difficulty), and what routing saved ──

// Every finished job in [from, to] that names its model, with what it cost: the usage its agent recorded on the
// item, shared evenly among that agent's jobs there. cost_usd null: not known (a local model, or nothing recorded).
export function pricedJobs(hub, p, from, to) {
  const jobs = jobsTaken(hub, p, from, to).filter((j) => j.model && j.result !== 'open' && j.result !== 'not_chosen');
  // Where llm-proxy measured an agent on an item, its rows stand in for what was reported, so nothing counts twice.
  const spent = new Map();
  for (const r of hub.q('SELECT u.agent, u.cost_usd, u.source, i.seq FROM usage u JOIN items i ON i.id = u.item_id WHERE u.project_id = ?').all(p.id)) {
    const k = `#${r.seq} ${r.agent}`;
    const s = spent.get(k) ?? { measured: { usd: 0, known: true, any: false }, reported: { usd: 0, known: true, any: false } };
    const to = r.source === 'llm-proxy' ? s.measured : s.reported;
    to.any = true;
    if (r.cost_usd == null) to.known = false; else to.usd += r.cost_usd;
    spent.set(k, s);
  }
  for (const [k, s] of spent) spent.set(k, s.measured.any ? s.measured : s.reported);
  const share = new Map();
  for (const j of jobs) share.set(`${j.item} ${j.agent}`, (share.get(`${j.item} ${j.agent}`) ?? 0) + 1);
  return jobs.map((j) => {
    const s = spent.get(`${j.item} ${j.agent}`);
    return { ...j, clean: j.result === 'landed' || j.result === 'done', cost_usd: s?.known ? s.usd / share.get(`${j.item} ${j.agent}`) : null };
  });
}

// Per cell, each model's attempts, clean ones, clean rate and full cost per clean job (everything its attempts
// cost, rework included, over the clean ones; null unless every attempt is priced), best rate first. saved_usd:
// against running each cell's clean jobs on its dearest model per clean job, what the cheaper ones saved.
export function routingResults(jobs) {
  const cells = new Map();
  for (const j of jobs) {
    const key = `${j.job} ${j.difficulty}`;
    const models = cells.get(key) ?? new Map();
    const m = models.get(j.model) ?? { model: j.model, attempts: 0, clean: 0, usd: 0, priced: true };
    m.attempts++;
    if (j.clean) m.clean++;
    if (j.cost_usd == null) m.priced = false; else m.usd += j.cost_usd;
    models.set(j.model, m);
    cells.set(key, models);
  }
  let saved = 0, priced = false;
  const out = [...cells].map(([key, models]) => {
    const [job, difficulty] = key.split(' ');
    const rows = [...models.values()].map((m) => ({
      model: m.model, attempts: m.attempts, clean: m.clean, rate: Math.round((100 * m.clean) / m.attempts) / 100,
      cost_per_clean: m.priced && m.clean ? Math.round((100 * m.usd) / m.clean) / 100 : null,
    })).sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);
    const known = rows.filter((r) => r.cost_per_clean != null);
    const dear = known.reduce((a, r) => (!a || r.cost_per_clean > a.cost_per_clean ? r : a), null);
    for (const r of known) if (r !== dear) { saved += r.clean * (dear.cost_per_clean - r.cost_per_clean); priced = true; }
    return { job, difficulty, models: rows };
  }).sort((a, b) => b.models.reduce((n, m) => n + m.attempts, 0) - a.models.reduce((n, m) => n + m.attempts, 0));
  return { cells: out, saved_usd: priced ? Math.round(saved * 100) / 100 : null };
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
