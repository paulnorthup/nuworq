// What finished work came to, for other tools to read (GET /api/p/<project>/outcomes; documented in
// docs/API.md, which is the contract). Built only from what the hub already records.
import { HUMAN, courtOf, isHuman, isSystem } from './core.js';

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
// as the events already record them. The steer an override writes beside its answer is the same action.
export const HUMAN_ACTIONS = ['answered', 'accepted', 'sent_back', 'steer', 'decision', 'comment', 'assumption_confirmed'];
const PERSON = (col = 'actor') => `(${col} = '${HUMAN}' OR ${col} LIKE '@%')`;
const ACTIONS = `e.type IN (${HUMAN_ACTIONS.map((t) => `'${t}'`).join(', ')}) AND ${PERSON('e.actor')}
  AND NOT (e.type = 'steer' AND e.headline LIKE '%: Change of course%'
    AND EXISTS (SELECT 1 FROM events a WHERE a.type = 'answered' AND a.actor = e.actor AND a.at = e.at AND a.project_id = e.project_id))`;

// A person's actions on one item, ever.
export const humanActionsOn = (hub, item) => hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.item_id = ? AND ${ACTIONS}`).get(item.id).n;

// Over (from, to]: the person actions, the items that landed, actions per landed item, and how long work sat
// in your court (waiting on your answer, verifying by you, proposed for your approval: as Flow counts it)
// until you moved it on. Waits ended by an agent or an operator aren't yours to count.
export function humanCost(hub, p, from, to = hub.now()) {
  const actions = hub.q(`SELECT COUNT(*) AS n FROM events e WHERE e.project_id = ? AND e.at > ? AND e.at <= ? AND ${ACTIONS}`).get(p.id, from, to).n;
  const landed = hub.q(`SELECT COUNT(DISTINCT t.item_id) AS n FROM transitions t JOIN items i ON i.id = t.item_id
    WHERE i.project_id = ? AND t.stage = 'done' AND t.at > ? AND t.at <= ?`).get(p.id, from, to).n;
  const rows = hub.q(`SELECT t.item_id, t.stage, t.actor, t.at FROM transitions t JOIN items i ON i.id = t.item_id
    WHERE i.project_id = ? AND t.at <= ? ORDER BY t.item_id, t.at, t.id`).all(p.id, to);
  const waits = [];
  for (let k = 0; k + 1 < rows.length; k++) {
    const [a, b] = [rows[k], rows[k + 1]];
    if (a.item_id !== b.item_id || courtOf(a.stage, p.autonomy) !== 'you' || b.at <= from) continue;
    if (isHuman(b.actor)) waits.push(b.at - a.at);
  }
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
  const groups = new Map();
  for (const i of items) {
    const k = i.model ?? '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const by_model = [...groups].map(([model, list]) => {
    const rows = list.flatMap((i) => i.usage);
    const sum = (key) => rows.reduce((a, r) => a + (r[key] ?? 0), 0);
    return {
      model: model || null,
      landed: list.filter((i) => i.outcome === 'landed').length,
      dropped: list.filter((i) => i.outcome === 'dropped').length,
      sent_back: list.reduce((a, i) => a + i.sent_back, 0),
      stalls: list.reduce((a, i) => a + i.stalls, 0),
      escapes: list.filter((i) => i.escaped).length,
      median_cycle_ms: median(list.filter((i) => i.outcome === 'landed').map((i) => i.cycle_ms)),
      input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'),
      cost_usd: rows.length && rows.every((r) => r.cost_usd != null) ? sum('cost_usd') : null,
    };
  });
  // Peer reviewers, per model: what they accepted that landed, how much of it escaped, and how many of their
  // verdicts a person overturned.
  const v = verification(hub, finished.filter((it) => it.stage === 'done'), modelOf);
  const by_reviewer = v.by_model.filter((m) => m.reviewed || m.overturned).map((m) => ({ model: m.model, reviewed: m.reviewed, escapes: m.reviewed_escaped, overturned: m.overturned }));
  const cost = humanCost(hub, p, from, to);
  const human_actions = { total: cost.actions, landed: cost.landed, per_landed: cost.per_landed, median_wait_ms: cost.median_wait_ms };
  return { version: OUTCOMES_VERSION, project: p.slug, since: from, until: to, items, by_model, by_reviewer, human_actions };
}
