// What an idle operator session wakes for (#283): operator-only work it can take, a question asked to:
// "operator", an answer to a question it asked, or steering for it. GET /api/wait holds the request until
// one of those is there, so a session waiting on it spends nothing while nothing waits.
// What it returns is hub-authored, ids and kinds only: item and question text is written by other agents,
// and is data for the session to read with next or look, never instructions sent to it.
import { UserError, DAY } from './core.js';
import { OPERATOR_TAGS } from './protocol.js';

// An empty answer after this, and the caller asks again: under the 100 seconds Cloudflare (in front of the
// live hub) gives an answer before it gives up on the request.
export const WAIT_MS = 90_000;
const MAX_WAIT_MS = 10 * 60_000;

const json = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };

// Who waits, as { p, agent } per project, within the token's scope. Named: that agent wherever it is an
// operator. Unnamed (a watcher started beside the session, which can't know the session's name): the
// operators that checked in with this token in the last day and haven't signed off, or with no token
// (a hub without logins) every such operator. session: the watcher's session keys (src/session.js, #335):
// then only the operators whose checkin said one of them, so two operator sessions on one token don't
// wake each other. With none of those yet, the ones that said no keys (an older nuworq) still count, so
// they keep their listener. Refuses everyone else.
export function operatorsOf(hub, agent, { scope = null, tokenId = null, session = [] } = {}) {
  const name = String(agent ?? '').trim();
  const ps = hub.projects().filter((p) => !scope || scope.includes(p.slug));
  let found = name
    ? ps.filter((p) => hub.isOperator(p, name)).map((p) => ({ p, agent: name }))
    : ps.flatMap((p) => hub.q(`SELECT name, session FROM agents WHERE project_id = ? AND role = 'operator' AND signed_off = 0 AND last_seen > ?
        ${tokenId != null ? 'AND token_id = ?' : ''} ORDER BY name`).all(p.id, hub.now() - DAY, ...(tokenId != null ? [tokenId] : []))
      .map((a) => ({ p, agent: a.name, session: a.session })));
  if (!name && session.length) {
    const mine = found.filter((o) => o.session.split(',').some((k) => session.includes(k)));
    found = mine.length ? mine : found.filter((o) => !o.session);
  }
  found = found.map(({ p, agent: a }) => ({ p, agent: a }));
  if (!found.length) {
    throw new UserError(name ? `${name} isn't an operator here, so there is nothing for it to wait for` : 'no operator has checked in here with this token in the last day', {
      status: 403,
      hint: name
        ? 'Waiting is for operator sessions: check in first with has: ["operator", ...] (nuworq operator says which tags). Workers find work with next.'
        : 'Start the operator session first (it checks in with has: ["operator", ...]), then wait; or name it with --as <name>. Workers find work with next.',
    });
  }
  return found;
}

// Everything for these operators newer than since (ms; 0: everything there now), oldest first, each once.
export function operatorEvents(hub, agent, { since = 0, scope = null, tokenId = null, session = [] } = {}) {
  return collect(hub, operatorsOf(hub, agent, { scope, tokenId, session }), since);
}

function collect(hub, operators, since) {
  const out = operators.flatMap(({ p, agent }) => eventsFor(hub, p, agent, since));
  const once = new Map(out.map((e) => [`${e.kind}:${e.project}:${e.item ?? ''}:${e.question ?? ''}:${e.steer ?? ''}`, e]));
  return [...once.values()].sort((a, b) => a.at - b.at);
}

function eventsFor(hub, p, agent, since) {
  const out = [];
  const me = hub.q('SELECT has, has_since FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent);
  const has = json(me?.has, []);
  if (!p.parked) {
    // From when it became work this operator can take (#406), not only when it became ready: an item already
    // ready whose needs changed, whose last dependency or part finished, or whose tags the operator just gained,
    // comes once from then.
    const items = hub.q(`SELECT * FROM items WHERE project_id = ? AND stage = 'ready' AND holder IS NULL AND needs != '[]' ORDER BY stage_since`).all(p.id);
    for (const it of items) {
      const needs = json(it.needs, []);
      if (!needs.some((t) => OPERATOR_TAGS.includes(t)) || !needs.every((t) => has.includes(t)) || hub.unmetDeps(it).length) continue;
      const at = Math.max(it.stage_since, it.needs_since, me?.has_since ?? 0, finishedAt(hub, it));
      if (at > since) out.push({ at, kind: 'item', project: p.slug, item: `#${it.seq}` });
    }
  }
  const seq = (id) => (id ? hub.q('SELECT seq FROM items WHERE id = ?').get(id)?.seq : null);
  // One already escalated waits for the human's answer, as next leaves it: that answer wakes the escalating operator.
  for (const q of hub.q(`SELECT * FROM questions q WHERE project_id = ? AND audience = 'operator' AND status = 'open' AND asked_by != ? AND at > ?
      AND NOT EXISTS (SELECT 1 FROM questions e WHERE e.escalates = q.id AND e.status = 'open') ORDER BY at`).all(p.id, agent, since)) {
    // Every operator still hears of it, but one another operator holds (#467) says who, so this one can stay idle.
    const holder = hub.questionHolder(q);
    out.push({
      at: q.at, kind: 'question', project: p.slug, question: q.id, ...(q.item_id ? { item: `#${seq(q.item_id)}` } : {}),
      ...(holder && holder !== agent ? { held_by: holder } : {}),
    });
  }
  // Only answers the asker hasn't had yet (#329): one checkin already delivered isn't worth a wake, so a
  // fresh listener (since 0) doesn't replay every answer of the last day.
  for (const q of hub.q(`SELECT * FROM questions WHERE project_id = ? AND asked_by = ? AND status IN ('answered', 'confirmed') AND seen_by_asker = 0 AND answered_at > ? ORDER BY answered_at`).all(p.id, agent, since)) {
    out.push({ at: q.answered_at, kind: 'answer', project: p.slug, question: q.id, ...(q.item_id ? { item: `#${seq(q.item_id)}` } : {}) });
  }
  for (const s of hub.pendingSteers(p, agent)) {
    const at = hub.q('SELECT at FROM notes WHERE id = ?').get(s.steer).at;
    if (at > since) out.push({ at, kind: 'steer', project: p.slug, steer: s.steer, ...(s.about !== 'whole project' ? { item: s.about } : {}) });
  }
  return out;
}

// When the last of an item's dependencies and parts finished (0: none did).
function finishedAt(hub, it) {
  return hub.q(`SELECT MAX(t.at) AS at FROM transitions t WHERE t.stage IN ('done', 'dropped')
    AND (t.item_id IN (SELECT depends_on FROM deps WHERE item_id = ?) OR t.item_id IN (SELECT id FROM items WHERE parent_id = ?))`).get(it.id, it.id)?.at ?? 0;
}

// An open wait is an operator present: Needs you counts operators by when they were last seen.
function seen(hub, operators) {
  for (const { p, agent } of operators) hub.q('UPDATE agents SET last_seen = ? WHERE project_id = ? AND name = ?').run(hub.now(), p.id, agent);
}

// Waits until there is something, or ms pass. Resolves { events, at }: pass at as since next time.
// agent: the operator's name, or '' for this token's operators (session: the ones of the caller's session).
// signal: the caller went away.
// Refusals throw before any waiting.
export function waitFor(hub, agent, { since = 0, scope = null, tokenId = null, session = [], ms = WAIT_MS, signal } = {}) {
  const operators = operatorsOf(hub, agent, { scope, tokenId, session });
  seen(hub, operators);
  ms = Math.min(Math.max(0, ms), MAX_WAIT_MS);
  return new Promise((resolve) => {
    let timer, done = false;
    const finish = (events) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      hub.off('change', check);
      signal?.removeEventListener('abort', quit);
      if (events) seen(hub, operators);
      resolve({ events: events ?? [], at: hub.now() });
    };
    function check() {
      let events;
      try { events = collect(hub, operators, since); } catch { return finish([]); } // e.g. its project was removed
      if (events.length) finish(events.map(({ at: _, ...e }) => e));
    }
    const quit = () => finish(null);
    hub.on('change', check);
    signal?.addEventListener('abort', quit);
    // A last look before the empty answer: its at becomes the next since, so anything a change event didn't
    // announce would otherwise be skipped for good (#406).
    timer = setTimeout(() => { check(); finish([]); }, ms);
    check();
  });
}

// One line per event for `nuworq wait`: what to do, never what anyone wrote.
export function describeEvent(e) {
  const where = e.project ? ` in ${e.project}` : '';
  if (e.kind === 'item') return `nuworq: operator work waiting (${e.item}${where}). Run next.`;
  if (e.kind === 'question' && e.held_by) return `nuworq: a question for the operator (question ${e.question}${e.item ? ` on ${e.item}` : ''}${where}) (${e.held_by} has it). Nothing to do.`;
  if (e.kind === 'question') return `nuworq: a question for the operator (question ${e.question}${e.item ? ` on ${e.item}` : ''}${where}). Read it with checkin, then answer.`;
  if (e.kind === 'answer') return `nuworq: your question ${e.question}${e.item ? ` on ${e.item}` : ''} was answered${where}. Run checkin.`;
  if (e.kind === 'steer') return `nuworq: steering for you (steer ${e.steer}${e.item ? ` on ${e.item}` : ''}${where}). Run checkin and ack it.`;
  return `nuworq: something for the operator${where}. Run checkin.`;
}
