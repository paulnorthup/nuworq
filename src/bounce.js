// Why an item keeps bouncing, from its history (#564): what happened, what it waits on now, and whether a person can
// help. Only real failures count: a send-back, or a lease lapsed because its agent went quiet. A lapse while the
// hub was down, or after a worker's session ended or its runner restarted, is nobody's failure (cause, Hub.sweep).
// It reaches Needs you only with a step for a person: answer a question, start an agent with a missing capability,
// or clarify work that really bounces (the same reason from two reviewers, or three failures on the same commit).
import { OPERATOR_TAGS } from './protocol.js';

const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
const DAY = 86_400_000;
// A send-back's reason as a reviewer wrote it: "x sent back #4: <reason>; #4 …" → the reason, for comparing two.
const reasonOf = (e) => String(e.headline).replace(/^.*? sent back #\d+: /, '').replace(/; #\d+ (?:is back in the queue|goes back to .*)$/, '').trim();
const same = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A lapse's cause: recorded since #564; before that, a runner's worker or a signed-off agent ended its session.
function causeOf(e, agents) {
  const d = json(e.data, {});
  if (d.cause != null) return d.cause;
  const a = agents.find((x) => x.name === d.agent);
  return a && (a.runner || a.signed_off) ? 'session' : '';
}

// Who could take it: "an operator with claude-cli", "an agent with docker".
function capability(tags) {
  const op = tags.includes('operator') || tags.some((t) => OPERATOR_TAGS.includes(t));
  const rest = tags.filter((t) => t !== 'operator');
  return op ? `an operator${rest.length ? ` with ${rest.join(' and ')}` : ''}` : `an agent with ${tags.join(' and ')}`;
}

// null unless it failed for real at least twice. Otherwise { failures, happened, waits, step, line }; step is null
// (one line on the item, no card) or one of { kind: 'answer', question }, { kind: 'capability', target, missing },
// { kind: 'clarify', why }.
export function bounceOf(hub, p, it, { agents, openQs, unmet, t }) {
  const events = hub.q(`SELECT * FROM events WHERE item_id = ? AND type IN ('sent_back', 'lease_expired', 'submitted') ORDER BY at, id`).all(it.id);
  const lapses = events.filter((e) => e.type === 'lease_expired' && json(e.data, {}).agent && ['active', 'proposed', undefined].includes(json(e.data, {}).stage)
    && !/while landing/.test(e.headline));
  const excused = lapses.filter((e) => causeOf(e, agents));
  const quiet = lapses.filter((e) => !causeOf(e, agents));
  const sendbacks = events.filter((e) => e.type === 'sent_back');
  // Each real failure, with the commit it failed on: the newest submission before it.
  let head = null;
  const failures = [];
  for (const e of events) {
    if (e.type === 'submitted') head = json(e.data, {}).git?.commits?.[0]?.hash ?? head;
    else if (e.type === 'sent_back' || quiet.includes(e)) failures.push({ e, head });
  }
  if (failures.length < 2) return null;

  // What happened, in plain words.
  const last = sendbacks.at(-1);
  const restarts = excused.filter((e) => causeOf(e, agents) === 'restart').length;
  const happened = [
    last && `${last.actor === 'github' ? 'GitHub' : last.actor} sent it back${sendbacks.length > 1 ? ` (${times(sendbacks.length)} in all)` : ''}: "${reasonOf(last)}"`,
    quiet.length && `agents went quiet on it ${times(quiet.length)}`,
    excused.length && `${excused.length === 1 ? 'one lease' : `${excused.length} leases`} lapsed ${restarts === excused.length ? 'while the hub restarted' : restarts ? 'while the hub restarted or a worker stopped' : 'when a worker stopped or its runner restarted'}, not counted`,
  ].filter(Boolean).join('; ');

  // What it waits on now, and whether a person can help.
  const fit = agents.filter((a) => t - a.last_seen < DAY).map((a) => json(a.has, []));
  const missingOf = (i) => json(i.needs, []).filter((tag) => !fit.some((has) => has.includes(tag)));
  const toPerson = (i) => openQs.find((q) => q.item_id === i.id && q.audience !== 'operator' && (!q.reporter || q.held_reply));
  const deps = unmet(it);
  let waits, step = null;
  const ask = [it, ...deps].map((i) => ({ i, q: toPerson(i) })).find((x) => x.q);
  const lacking = [it, ...deps].map((i) => ({ i, missing: missingOf(i) })).find((x) => x.missing.length);
  if (ask) {
    waits = `your answer to question ${ask.q.id}${ask.i === it ? '' : ` on #${ask.i.seq}`}: "${ask.q.question}"`;
    step = { kind: 'answer', question: ask.q, on: ask.i };
  } else if (deps.length) {
    waits = deps.map((d) => {
      const needs = json(d.needs, []);
      return `#${d.seq}${needs.length ? ` needs ${capability(needs)}` : d.holder ? ` (${d.holder} is on it)` : ` (${d.stage})`}`;
    }).join('; ');
    if (lacking) step = { kind: 'capability', target: lacking.i, missing: lacking.missing };
  } else if (lacking) {
    waits = `${capability(lacking.missing)}, and none has been here in a day`;
    step = { kind: 'capability', target: lacking.i, missing: lacking.missing };
  } else if (it.stage === 'verifying') waits = 'a reviewer';
  else if (it.holder) waits = `${it.holder}, who is on it`;
  else waits = 'nothing: it is ready for any worker';

  // A real bounce: two reviewers sent it back for the same reason, or the last three failures were on one commit.
  if (!step) {
    const twice = sendbacks.some((a, n) => sendbacks.slice(n + 1).some((b) => b.actor !== a.actor && same(reasonOf(a), reasonOf(b))));
    const lastThree = failures.slice(-3);
    const stuck = lastThree.length === 3 && lastThree.every((f) => f.head === lastThree[0].head);
    if (twice) step = { kind: 'clarify', why: 'two reviewers sent it back for the same reason' };
    else if (stuck) step = { kind: 'clarify', why: `it failed ${times(lastThree.length)} with no new commits between` };
  }
  const line = `Bounced ${times(failures.length)}: ${happened}. Now it waits on ${waits}.`;
  return { failures: failures.length, happened, waits, step, line };
}
