import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, HANDBACKS, LIMITS } from '../src/core.js';
import { view } from '../src/insight.js';

// #734: work that keeps killing its worker reaches a person. A runner signs off a worker that exits; signoff hands its
// item back. Handed back HANDBACKS times with nothing submitted, it is parked, and an operator is asked first: a
// person sees it only when no operator is here, or when the operator escalates it.
const MIN = 60_000, HOUR = 60 * MIN;
function world(file) {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ ...(file ? { file } : {}), clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const add = (title) => hub.humanOp('p', 'create', { title, acceptance: 'x' }).item;
  const it = (ref) => hub.item(hub.project('p'), ref);
  // A runner's worker: checks in, takes the next job, and dies (the runner signs it off).
  const dies = (name, note) => {
    hub.agentOp('p', 'checkin', name, {});
    const n = hub.agentOp('p', 'next', name);
    hub.agentOp('p', 'signoff', name, note ? { headline: note } : {});
    return n.item;
  };
  const parked = () => view(hub, 'p').attention.filter((a) => a.kind === 'kept-parked');
  return { hub, add, it, dies, parked, later: (ms) => { t += ms; }, now: () => t };
}

describe('work handed back again and again is parked for an operator, then a person (#734)', () => {
  test(`handed back ${HANDBACKS} times by exiting workers: parked, not offered again, and an operator asked first`, () => {
    const { hub, add, it, dies, parked } = world();
    const k = add('Crashes its worker');
    assert.equal(dies('w1'), k);
    assert.equal(dies('w2'), k);
    assert.equal(it(k).stage, 'ready', 'twice is not yet a pattern');
    assert.equal(dies('w3', 'Exited: out of memory in the build'), k);
    const item = it(k);
    assert.equal(item.stage, 'waiting');
    assert.equal(item.parked_by, 'nuworq');
    assert.notEqual(hub.agentOp('p', 'checkin', 'w4', {}) && hub.agentOp('p', 'next', 'w4', { claim: false }).item, k, 'not offered again');
    assert.throws(() => hub.agentOp('p', 'claim', 'w4', { item: k }), (e) => e.status === 409 && /handed back 3 times with nothing submitted, and waits for an operator or a person to look/.test(e.message));
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'kept_parked' AND actor = 'nuworq'`).get(), 'the history says why');

    // The hub asked an operator, with the hand-backs as evidence. No operator here for a day: the question is the person's card.
    const q = hub.q(`SELECT * FROM questions WHERE item_id = ? AND asked_by = 'nuworq' AND audience = 'operator' AND status = 'open'`).get(item.id);
    assert.match(q.question, new RegExp(`^${k} was handed back 3 times with nothing submitted; nuworq parked it`));
    assert.match(q.context, /Exited: out of memory in the build/);
    assert.match(q.context, /answer with what you found and did: your answer hands it back to agents/);
    assert.equal(JSON.parse(q.evidence).length, 3);
    assert.equal(parked().length, 0, 'the question holds it, not a second card');
    const card = view(hub, 'p').attention.find((a) => a.key === `q:${q.id}`);
    assert.equal(card.level, 'act');
    assert.match(card.sub, /no operator connected, so you can do it/);

    // An operator here: nothing for the person; its next hands it the question; its answer hands the work back.
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    assert.ok(!view(hub, 'p').attention.some((a) => a.level === 'act' && a.kind !== 'no-agents'), 'Needs you is empty');
    const n = hub.agentOp('p', 'next', 'op');
    assert.equal(n.mode, 'answer');
    assert.match(n.question.question, /was handed back 3 times/);
    hub.agentOp('p', 'answer', 'op', { question: q.id, answer: 'The build ran out of memory; split the fixtures into #2. Ready again.' });
    assert.equal(it(k).stage, 'ready');
    assert.equal(it(k).parked_by, '');
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'unparked' AND item_id = ?`).get(item.id), 'answering is what unparked it');
    // The count starts over.
    dies('w5'); dies('w6');
    assert.equal(it(k).stage, 'ready');
  });

  test('a person may unpark it instead: the hub withdraws its question, and the count starts over', () => {
    const { hub, add, it, dies, parked } = world();
    const k = add('Crashes its worker');
    dies('w1'); dies('w2'); dies('w3');
    const id = it(k).id;
    hub.humanOp('p', 'unpark', { item: k });
    assert.equal(it(k).stage, 'ready');
    assert.equal(hub.q(`SELECT status FROM questions WHERE item_id = ? AND asked_by = 'nuworq'`).get(id).status, 'withdrawn');
    dies('w5'); dies('w6');
    assert.equal(it(k).stage, 'ready');
    assert.equal(parked().length, 0);
  });

  test('past the open-question limit, the card stays the person\'s, as before', () => {
    const { hub, add, it, dies, parked } = world();
    const k = add('Crashes its worker');
    const p = hub.project('p');
    for (let i = 0; i < LIMITS.openQuestions; i++) hub.q(`INSERT INTO questions (project_id, asked_by, question, context, options, blocking, assumption, at, audience) VALUES (?, 'x', ?, '', '[]', 0, 'later', ?, 'operator')`).run(p.id, `q${i}`, hub.now());
    dies('w1'); dies('w2'); dies('w3', 'Exited: out of memory in the build');
    assert.equal(it(k).stage, 'waiting');
    const cards = parked();
    assert.equal(cards.length, 1);
    assert.equal(cards[0].level, 'act');
    assert.match(cards[0].sub, /last: w3: "Exited: out of memory in the build"/);
    assert.match(cards[0].why, /clarify it, split it or drop it, and unpark it/);
  });

  test('a handoff with a note counts the same, past the same limit; one or two never park', () => {
    const { hub, add, it } = world();
    const k = add('Big');
    const handoff = (name) => {
      hub.agentOp('p', 'claim', name, { item: k });
      hub.agentOp('p', 'handoff', name, { item: k, headline: 'Low on context', summary: 'Tests written; the parser is next.' });
    };
    handoff('a1');
    assert.equal(it(k).stage, 'ready');
    handoff('a2');
    assert.equal(it(k).stage, 'ready');
    handoff('a3');
    assert.equal(it(k).stage, 'waiting');
    assert.match(hub.q(`SELECT context FROM questions WHERE asked_by = 'nuworq' AND status = 'open'`).get().context, /- a3 handed off #\d+: Low on context/);
  });

  test('a submit or a send-back starts the count over; reviewers letting go never count', () => {
    const { hub, add, it } = world();
    hub.humanOp('p', 'settings', { autonomy: 'full' }); // agents peer-review
    const k = add('Reviewed');
    const handoff = (name) => { hub.agentOp('p', 'claim', name, { item: k }); hub.agentOp('p', 'handoff', name, { item: k, headline: 'stopping' }); };
    handoff('a1'); handoff('a2');
    hub.agentOp('p', 'claim', 'a3', { item: k });
    hub.agentOp('p', 'submit', 'a3', { item: k, headline: 'done', evidence: ['tests'] });
    for (const r of ['r1', 'r2', 'r3']) { hub.agentOp('p', 'claim', r, { item: k }); hub.agentOp('p', 'handoff', r, { item: k, headline: 'no time' }); }
    assert.equal(it(k).stage, 'verifying', 'three reviewers let it go: still verifying');
    hub.agentOp('p', 'claim', 'r4', { item: k });
    hub.agentOp('p', 'review', 'r4', { item: k, verdict: 'reject', headline: 'missing a test' });
    handoff('a4'); handoff('a5');
    assert.equal(it(k).stage, 'ready', 'two since the send-back');
    handoff('a6');
    assert.equal(it(k).stage, 'waiting');
  });

  test('a lease that lapsed while the hub was down still counts for nothing', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-handbacks-')), 'hub.db');
    const w = world(file);
    const k = w.add('Survives restarts');
    w.dies('w1'); w.dies('w2');
    w.hub.agentOp('p', 'claim', 'before-restart', { item: k });
    w.hub.db.close();
    const after = new Hub({ file, clock: () => w.now() + HOUR }); // down for an hour; the lease ran out meanwhile
    after.sweep();
    const it = after.item(after.project('p'), k);
    assert.equal(it.stage, 'ready', 'two hand-backs and a restart: not parked');
    assert.equal(after.q(`SELECT json_extract(data, '$.cause') AS c FROM events WHERE type = 'lease_expired'`).get().c, 'restart');
    assert.ok(!view(after, 'p').attention.some((a) => a.kind === 'kept-parked' || a.kind === 'struggling'));
    after.db.close();
  });
});
