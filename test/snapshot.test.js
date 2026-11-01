import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { view, homeView } from '../src/insight.js';
import { seedHub, SLUG } from './seedhub.js';

// One seeded hub for the whole file: building it is the slow part.
const { hub, names } = seedHub({ items: 200, agents: 150 });
const p = hub.project(SLUG);
const plain = (x) => JSON.parse(JSON.stringify(x));

// The per-agent counts the project page showed before #538, one query each, kept as the reference.
function recordBefore(name) {
  const rec = hub.q(`SELECT SUM(type = 'submitted') AS submitted, SUM(type = 'claimed') AS claimed, SUM(type = 'handoff') AS handoffs,
      SUM(type = 'question') AS questions, SUM(type = 'assumption') AS assumptions, SUM(type = 'created') AS proposed,
      SUM(type = 'accepted') AS reviews, SUM(type = 'learned') AS learned FROM events WHERE project_id = ? AND actor = ?`).get(p.id, name);
  const races = hub.q(`SELECT COUNT(*) AS entered, COALESCE(SUM(a.stage = 'chosen'), 0) AS won FROM attempts a JOIN items i ON i.id = a.item_id
      WHERE i.project_id = ? AND a.agent = ?`).get(p.id, name);
  return {
    landed: hub.q(`SELECT COUNT(*) AS n FROM items WHERE project_id = ? AND implementer = ? AND stage = 'done'`).get(p.id, name).n,
    sent_back: hub.q(`SELECT COUNT(*) AS n FROM events e JOIN items i ON i.id = e.item_id WHERE e.project_id = ? AND e.type = 'sent_back' AND i.implementer = ?`).get(p.id, name).n,
    stalls: hub.q(`SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND type = 'lease_expired' AND json_extract(data, '$.agent') = ?`).get(p.id, name).n,
    claimed: rec.claimed ?? 0, submitted: rec.submitted ?? 0, handoffs: rec.handoffs ?? 0, questions: rec.questions ?? 0,
    assumptions: rec.assumptions ?? 0, proposed: rec.proposed ?? 0, reviews: rec.reviews ?? 0, learned: rec.learned ?? 0,
    races: races.entered, races_won: races.won,
  };
}

// The statements a call runs.
function statements(fn) {
  let n = 0;
  const q = hub.q;
  hub.q = (sql) => {
    const s = q.call(hub, sql);
    return { get: (...a) => (n++, s.get(...a)), all: (...a) => (n++, s.all(...a)), run: (...a) => (n++, s.run(...a)) };
  };
  try { fn(); } finally { hub.q = q; }
  return n;
}

describe('a project loads once per request (#538)', () => {
  test('the seeded hub has work in every stage that matters', () => {
    const stages = new Map(hub.q('SELECT stage, COUNT(*) AS n FROM items WHERE project_id = ? GROUP BY stage').all(p.id).map((r) => [r.stage, r.n]));
    for (const s of ['ready', 'active', 'verifying', 'done', 'waiting']) assert.ok(stages.get(s) > 0, `some ${s}`);
    assert.ok(hub.q('SELECT COUNT(*) AS n FROM deps').get().n > 10, 'dependencies');
    assert.ok(hub.q("SELECT COUNT(*) AS n FROM events WHERE type = 'sent_back'").get().n > 0, 'send-backs');
  });

  test("the snapshot's dependencies, jobs and records equal the per-row queries, for every item and agent", () => {
    const snap = hub.snap(p);
    for (const it of snap.items) assert.deepEqual(plain(hub.unmetDeps(it, snap)), plain(hub.unmetDeps(it, null)), `#${it.seq}`);
    const agents = hub.q('SELECT * FROM agents WHERE project_id = ?').all(p.id);
    assert.ok(agents.some((a) => hub.presenceOf(p, a, null).job), 'some agent holds work');
    for (const a of agents) {
      assert.deepEqual(hub.presenceOf(p, a, snap), hub.presenceOf(p, a, null), a.name);
      const rec = snap.records.get(a.name) ?? {};
      const got = Object.fromEntries(Object.keys(recordBefore(a.name)).map((k) => [k, rec[k] ?? 0]));
      assert.deepEqual(got, recordBefore(a.name), a.name);
    }
  });

  test('a snapshot lasts until something changes, and a rolled-back change leaves none behind', () => {
    const snap = hub.snap(p);
    assert.equal(hub.snap(p), snap, 'reads with no write between them share one load');
    view(hub, SLUG);
    assert.equal(hub.current(p.id), snap, 'a view writes nothing');
    const ready = view(hub, SLUG).queue.find((q) => !q.blocked_by.length && !q.needs.length);
    hub.agentOp(SLUG, 'claim', names[7], { item: ready.item });
    assert.equal(hub.current(p.id), null, 'a claim is a change');
    const after = view(hub, SLUG);
    assert.ok(!after.queue.some((q) => q.item === ready.item), 'the claimed item left the queue');
    assert.ok(after.agents.find((a) => a.name === names[7]).holding.includes(ready.item), 'and its agent holds it');

    // Inside a transaction that fails after a write, a snapshot built on the write goes with it.
    const before = hub.snap(p).items.find((i) => `#${i.seq}` === ready.item).title;
    assert.throws(() => hub.tx(() => {
      hub.q('UPDATE items SET title = ? WHERE project_id = ? AND seq = ?').run('Renamed', p.id, Number(ready.item.slice(1)));
      assert.equal(hub.snap(p).items.find((i) => `#${i.seq}` === ready.item).title, 'Renamed');
      throw new Error('undone');
    }), /undone/);
    assert.equal(hub.snap(p).items.find((i) => `#${i.seq}` === ready.item).title, before);
  });

  test("agents' calls and the views run a bounded number of statements, whatever the number of items and agents", () => {
    const agent = names[40];
    for (const [call, fn, most] of [
      ['checkin', () => hub.agentOp(SLUG, 'checkin', agent, {}), 60],
      ['next', () => hub.agentOp(SLUG, 'next', names[41], { claim: false }), 60],
      ['look', () => hub.agentOp(SLUG, 'look', agent, {}), 60],
      ['route', () => hub.route(names[42]), 40],
      ['light view', () => view(hub, SLUG, { light: true }), 120],
      ['home', () => homeView(hub), 200],
    ]) {
      fn();
      const n = statements(fn);
      assert.ok(n <= most, `${call} ran ${n} statements, more than ${most}`);
    }
  });
});
