import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN, dur } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { view } from '../src/insight.js';
import { run } from '../src/runner.js';

// A hub whose clock the test moves, with "on" staffed by nuworq run and "off" not.
function hub() {
  let t = Date.UTC(2026, 9, 30, 9);
  const h = new Hub({ clock: () => t });
  for (const s of ['on', 'also', 'off']) h.tx(() => h.project(s, { create: true }));
  h.humanOp('on', 'settings', { runner: true });
  h.humanOp('also', 'settings', { runner: true });
  return { h, tick: (ms) => (t += ms) };
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));

describe('the hub knows which runners are up (#171)', () => {
  test("a runner's report round-trips to the project page, and doesn't count as an agent being here", async () => {
    const { h, tick } = hub();
    const server = createServer(h);
    const base = await listen(server);
    try {
      const r = await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        name: 'mini', machine: 'mini.local', running: 1, workers: 3, spent: 1.234, poll_seconds: 30,
        skipping: [{ project: 'also', reason: 'no checkout of it here' }, { project: 'x', reason: "couldn't fetch", until: h.now() + 10 * MIN }],
        paused: null,
      }) });
      assert.equal(r.status, 200, await r.text());
      const [mini] = view(h, 'on').runners;
      assert.deepEqual(mini, { name: 'mini', machine: 'mini.local', seen_at: h.now(), state: 'up', last_seen: dur(0), running: 1, workers: 3, spent: 1.23, stopped: null, paused: null, skipping: null, skipping_others: 2 });
      // Where it skips: the project says so, with why.
      const [there] = view(h, 'also').runners;
      assert.equal(there.state, 'skipping');
      assert.deepEqual(there.skipping, { reason: 'no checkout of it here' });
      // A project nuworq run doesn't staff lists no runners.
      assert.deepEqual(view(h, 'off').runners, []);
      // Bookkeeping only: no agent appeared anywhere, and nothing was logged as activity.
      assert.equal(h.q('SELECT COUNT(*) AS n FROM agents').get().n, 0);
      assert.equal(h.q("SELECT COUNT(*) AS n FROM events WHERE actor = 'mini'").get().n, 0);

      // Paused, then stopped: each shows with its reason.
      tick(MIN);
      await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'mini', machine: 'mini.local', workers: 3, paused: { until: h.now() + 5 * MIN, reason: '3 workers in a row failed within seconds' } }) });
      const paused = view(h, 'on').runners[0];
      assert.equal(paused.state, 'paused');
      assert.deepEqual(paused.paused, { reason: '3 workers in a row failed within seconds', for: '5m' });
      await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'mini', stopped: 'interrupted' }) });
      assert.equal(view(h, 'on').runners[0].state, 'stopped');
      assert.equal(view(h, 'on').runners[0].stopped, 'interrupted');
      // Junk is refused with a hint, not stored.
      const bad = await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).hint, /name/);
    } finally { server.close(); }
  });

  test('a silent runner turns down after 3 of its poll intervals, saying when and where it was last seen', () => {
    const { h, tick } = hub();
    h.reportRunner({ name: 'mini', machine: 'mini.local', workers: 1, poll_seconds: 60 });
    tick(3 * MIN);
    assert.equal(view(h, 'on').runners[0].state, 'up', 'exactly 3 intervals: not yet');
    tick(1000);
    const down = view(h, 'on').runners[0];
    assert.equal(down.state, 'down');
    assert.equal(down.last_seen, '3m');
    assert.equal(down.machine, 'mini.local');
    // Coming back is a change worth redrawing for; the same report again is not.
    assert.equal(h.reportRunner({ name: 'mini', machine: 'mini.local', workers: 1, poll_seconds: 60 }), true);
    assert.equal(h.reportRunner({ name: 'mini', machine: 'mini.local', workers: 1, poll_seconds: 60 }), false);
    assert.equal(view(h, 'on').runners[0].state, 'up');
    // Gone for a week: no longer listed.
    tick(8 * 24 * 60 * MIN);
    assert.deepEqual(view(h, 'on').runners, []);
  });

  test("an agent token may post it; a runner token's name wins, and its scope limits where it shows", async () => {
    const { h } = hub();
    const auth = new Auth(h.db);
    const token = auth.createToken('ci-token', 'agent', { runner: 'ci', projects: ['on'] });
    const server = createServer(h, { auth: 'required' });
    const base = await listen(server);
    try {
      const r = await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'pretend', machine: 'box', workers: 2 }) });
      assert.equal(r.status, 200, await r.text());
      assert.deepEqual(view(h, 'on').runners.map((x) => [x.name, x.machine]), [['ci', 'box']]);
      assert.deepEqual(view(h, 'also').runners, [], "outside its token's projects");
      assert.equal((await fetch(`${base}/api/runner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status, 401);
    } finally { server.close(); }
  });

  test('the run loop posts its state once per poll, and once more when it stops', async () => {
    const reports = [];
    let polls = 0, interrupt;
    const out = await run({
      routes: async () => { polls++; return [{ project: 'p', name: 'p', item: '#1', title: 't', mode: 'work', claimable: 1 }]; },
      launch: async () => { throw Object.assign(new Error('no checkout of p here'), { skip: true }); },
      report: (s) => { reports.push(s); },
      workers: 2, pollSeconds: 45, log: () => {},
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { if (polls >= 3) interrupt(); },
    });
    assert.equal(out.why, 'interrupted');
    assert.equal(polls, 3);
    assert.equal(reports.length, 4, '3 polls, then the stop');
    assert.deepEqual(reports[0], { running: 0, workers: 2, spent: 0, poll_seconds: 45, live: [], skipping: [{ project: 'p', reason: 'no checkout of p here' }], paused: null });
    assert.equal(reports.at(-1).stopped, 'interrupted');
  });

  test("a report that fails doesn't stop the loop", async () => {
    let polls = 0, interrupt;
    const out = await run({
      routes: async () => { polls++; return []; },
      launch: async () => ({}),
      report: () => { throw new Error('hub said no'); },
      log: () => {}, onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { if (polls >= 2) interrupt(); },
    });
    assert.equal(out.why, 'interrupted');
    assert.equal(polls, 2);
  });
});
