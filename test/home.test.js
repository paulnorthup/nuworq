import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { homeView } from '../src/insight.js';
import { createServer } from '../src/server.js';

const MIN = 60_000;

// Projects P1 (stewarded by @a) and P2 (stewarded by @b), and @o, who owns the hub.
function setup() {
  let t = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => t });
  const auth = new Auth(hub.db);
  auth.addPerson('a', 'steward');
  auth.addPerson('b', 'steward');
  auth.addPerson('o', 'owner');
  auth.addPerson('v', 'viewer');
  for (const [slug, steward] of [['p1', '@a'], ['p2', '@b']]) {
    hub.tx(() => hub.project(slug, { create: true }));
    hub.humanOp(slug, 'settings', { autonomy: 'full' }, '@o');
    hub.humanOp(slug, 'stewards', { set: [steward] }, '@o');
    hub.humanOp(slug, 'create', { title: `Build ${slug}`, acceptance: 'x' });
    hub.humanOp(slug, 'create', { title: `More ${slug}`, acceptance: 'x' });
  }
  return { hub, auth, advance: (ms) => (t += ms) };
}

// Each project gets a blocking question for its steward; P2 also has work in flight.
function busy(hub, advance) {
  hub.agentOp('p1', 'claim', 'bot1', { item: '#1' });
  hub.agentOp('p1', 'ask', 'bot1', { item: '#1', question: 'Postgres or SQLite?', blocking: true });
  advance(MIN);
  hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
  hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
  hub.agentOp('p2', 'claim', 'bot3', { item: '#2' });
}

describe('the home: what needs you across every project', () => {
  test('each person sees only their own act entries, tagged with the project, and every project as one line', () => {
    const { hub, advance } = setup();
    busy(hub, advance);
    const a = homeView(hub, { viewer: '@a' });
    assert.deepEqual(a.needs.map((n) => [n.headline, n.project]), [['Postgres or SQLite?', { slug: 'p1', name: 'p1' }]]);
    assert.ok(a.needs[0].question.id, 'with what the action needs');
    const b = homeView(hub, { viewer: '@b' });
    assert.deepEqual(b.needs.map((n) => [n.headline, n.project.slug]), [['Which region?', 'p2']]);
    for (const h of [a, b]) {
      assert.deepEqual(h.projects.map((p) => p.slug), ['p1', 'p2']);
      assert.ok(h.projects.every((p) => p.pulse.state && p.pulse.sentence && typeof p.needs === 'number'));
    }
    assert.deepEqual(a.worth_knowing, [{ slug: 'p2', name: 'p2', count: 1 }], "@b's question is worth knowing for @a");
    assert.deepEqual(a.motion.map((m) => [m.project.slug, m.item, m.agent]), [['p2', '#2', 'bot3']], 'parked-by-question work is not in motion');

    // Without stewards, the owner owns both: oldest first, across projects.
    for (const slug of ['p1', 'p2']) hub.humanOp(slug, 'stewards', { set: [] }, '@o');
    const o = homeView(hub, { viewer: '@o' });
    assert.deepEqual(o.needs.map((n) => n.project.slug), ['p1', 'p2']);
    assert.equal(o.pulse.state, 'needs-you');
    assert.equal(o.pulse.sentence, '2 things across 2 projects need you. 1 agent working on 1 item.');
  });

  test('the pulse is the most urgent unparked state; nothing needing you has no needs at all', () => {
    const { hub, advance } = setup();
    // A runner is up for both, so nobody needs to start anything (#173: checking in alone isn't capacity).
    for (const p of ['p1', 'p2']) hub.humanOp(p, 'settings', { runner: true }, '@o');
    hub.reportRunner({ name: 'mini', machine: 'mini.local', workers: 1 });
    let h = homeView(hub, { viewer: '@a' });
    assert.equal(h.pulse.state, 'stalled', 'ready work, nobody on it');
    assert.equal(h.pulse.sentence, 'Nothing needs you. Nothing is moving: work is waiting in 2 projects.');
    assert.deepEqual(h.needs, []);

    hub.agentOp('p1', 'claim', 'bot1', { item: '#1' });
    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'claim', 'bot3', { item: '#2' });
    hub.agentOp('p1', 'claim', 'bot4', { item: '#2' });
    h = homeView(hub, { viewer: '@a' });
    assert.equal(h.pulse.state, 'flowing');
    assert.equal(h.pulse.sentence, 'Nothing needs you. 4 agents working on 4 items across 2 projects.');

    // A parked project is listed, but neither its state nor its agents set the pulse.
    for (const it of ['#1', '#2']) hub.agentOp('p1', 'handoff', it === '#1' ? 'bot1' : 'bot4', { item: it, headline: 'later' });
    advance(MIN);
    hub.humanOp('p2', 'settings', { parked: true }, '@o');
    h = homeView(hub, { viewer: '@a' });
    assert.equal(h.projects.find((p) => p.slug === 'p2').parked, true);
    assert.equal(h.projects.find((p) => p.slug === 'p2').pulse.state, 'parked');
    assert.equal(h.pulse.state, 'stalled');
    assert.equal(h.pulse.sentence, 'Nothing needs you. Nothing is moving: work is waiting in 1 project.');

    // What a parked project already asked still needs you (#152): the pulse, the list and its line agree.
    hub.humanOp('p2', 'settings', { parked: false }, '@o');
    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
    assert.equal(homeView(hub, { viewer: '@b' }).pulse.state, 'needs-you');
    hub.humanOp('p2', 'settings', { parked: true }, '@o');
    h = homeView(hub, { viewer: '@b' });
    const line = h.projects.find((p) => p.slug === 'p2');
    assert.equal(h.pulse.state, 'needs-you');
    assert.equal(h.needs.length, line.needs, 'the list and the line count the same');
    assert.deepEqual(h.needs.map((a) => [a.project.slug, a.kind]), [['p2', 'question']]);
    assert.match(h.pulse.sentence, /^1 thing needs you\./);
  });

  test('a parked project with a blocking question and work to verify: pulse, list, line and badge all say 2 (#152)', () => {
    const { hub } = setup();
    hub.humanOp('p2', 'settings', { autonomy: 'balanced' }, '@o'); // the human verifies
    hub.agentOp('p2', 'claim', 'bot2', { item: '#1' });
    hub.agentOp('p2', 'ask', 'bot2', { item: '#1', question: 'Which region?', blocking: true });
    hub.agentOp('p2', 'claim', 'bot3', { item: '#2' });
    hub.agentOp('p2', 'submit', 'bot3', { item: '#2', headline: 'Built', evidence: [{ label: 'tests pass' }] });
    const before = homeView(hub, { viewer: '@b' });
    const mine = (h) => h.needs.filter((a) => a.project.slug === 'p2');
    hub.humanOp('p2', 'settings', { parked: true }, '@o');
    const h = homeView(hub, { viewer: '@b' });
    const line = h.projects.find((p) => p.slug === 'p2');
    assert.equal(line.pulse.state, 'parked');
    assert.deepEqual(mine(h).map((a) => a.kind).sort(), mine(before).map((a) => a.kind).filter((k) => k !== 'direction').sort());
    assert.deepEqual(mine(h).map((a) => a.kind).sort(), ['question', 'review']);
    assert.equal(line.needs, 2);
    assert.equal(h.pulse.act, h.needs.length);
    assert.equal(h.pulse.state, 'needs-you');
  });

  test('over HTTP: one request; Mark all seen covers every project; agents and viewers are refused', async () => {
    const { hub, auth, advance } = setup();
    busy(hub, advance);
    advance(MIN);
    hub.humanOp('p1', 'answer', { question: homeView(hub, { viewer: '@a' }).needs[0].question.id, answer: 'SQLite' }, '@a');
    hub.agentOp('p1', 'claim', 'bot1', { item: '#1' });
    hub.agentOp('p1', 'submit', 'bot1', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    hub.agentOp('p2', 'propose', 'bot3', { title: 'An idea' });
    const tok = (name, role, person) => auth.createToken(name, role, person ? { person } : {});
    const a = tok('a-l', 'human', 'a'), v = tok('v-l', 'human', 'v'), bot = tok('bot', 'agent');
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const call = (t, method, path) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })
      .then(async (r) => ({ status: r.status, json: await r.json() }));
    try {
      const h = await call(a, 'GET', '/api/home');
      assert.equal(h.status, 200);
      assert.deepEqual(Object.keys(h.json).sort(), ['motion', 'needs', 'projects', 'pulse', 'worth_knowing']);
      assert.ok(h.json.pulse.since.counts.submitted >= 1 && h.json.pulse.since.counts.proposed >= 1, JSON.stringify(h.json.pulse.since.counts));
      assert.ok(!h.json.needs.some((n) => n.kind === 'question'), 'the answered question is gone');
      assert.equal(h.json.projects.length, 2);

      assert.equal((await call(bot, 'GET', '/api/home')).status, 403);
      assert.equal((await call(v, 'POST', '/api/home/seen')).status, 403);
      assert.equal((await call(v, 'GET', '/api/home')).status, 200, 'a viewer may look');

      advance(MIN);
      assert.deepEqual((await call(a, 'POST', '/api/home/seen')).json, { ok: true });
      const after = (await call(a, 'GET', '/api/home')).json;
      assert.equal(after.pulse.since.counts.updates, 0);
      for (const p of ['p1', 'p2']) assert.equal(hub.project(p).seen_at, hub.now(), `${p} marked seen`);
    } finally { server.close(); }
  });
});
