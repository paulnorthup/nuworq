import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub, MIN, HOUR, DAY } from '../src/core.js';
import { view } from '../src/insight.js';
import { Notifier, addChannel } from '../src/notify.js';

// A person hears about spend before it surprises them (#767): a push at 80% of a project's daily budget, and when
// one worker passes $50 or 60 minutes. Each once per day per project, or per worker run.

let sink, sinkUrl;
const got = [];
before(async () => {
  sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { got.push({ path: req.url, body }); res.writeHead(200).end(); });
  });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  sinkUrl = `http://127.0.0.1:${sink.address().port}`;
});
after(() => { sink.closeAllConnections(); sink.close(); });

const START = Date.UTC(2026, 10, 2, 20); // 20:00 UTC: the day's budget resets in 4h

function world() {
  got.length = 0;
  const clock = { t: START };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: 'Build the thing', acceptance: 'it works' });
  hub.humanOp('p', 'settings', { runner: true, run_budget: 20 });
  const cards = (kind) => view(hub, 'p').attention.filter((a) => a.kind === kind);
  const spend = (agent, usd) => {
    hub.agentOp('p', 'checkin', agent);
    hub.agentOp('p', 'usage', agent, { usage: { input_tokens: 1, output_tokens: 1, cost_usd: usd } });
  };
  // The runner's poll: its workers, when each started, and what each has spent so far.
  const report = (runs) => hub.reportRunner({
    name: 'mac', running: runs.length, workers: 2, poll_seconds: 30, live: runs.map((r) => r.name),
    runs: runs.map((r) => ({ name: r.name, project: 'p', since: r.since })),
    spending: runs.filter((r) => r.usd).map((r) => ({ name: r.name, project: 'p', usd: r.usd })),
  }, { name: 'mac', runner: true });
  return { hub, clock, cards, spend, report };
}

// Every push the scan and its batch window make, waited for.
async function pushes(hub, n) {
  n.scan();
  if (n.batch) await n.flush();
  return got.splice(0).map((g) => ({ path: g.path, ...JSON.parse(g.body) }));
}

describe('spend alerts', () => {
  test("80% of the daily budget: one act card naming the project, the spend and the reset, and one push per channel", async () => {
    const { hub, clock, cards, spend } = world();
    spend('a', 15.99);
    assert.deepEqual(cards('budget-near'), [], 'under 80%: nothing');
    spend('b', 0.01);
    const [c, ...rest] = cards('budget-near');
    assert.equal(rest.length, 0, 'one card');
    assert.equal(c.level, 'act');
    assert.equal(c.priority, 'now');
    assert.match(c.headline, /^p has spent \$16\.00 of its \$20\.00 daily budget/);
    assert.match(c.headline, /resets at 00:00 UTC, in 4h/);
    assert.deepEqual(c.actions, ['raise-budget', 'pause-runners']);

    addChannel(hub.db, 'webhook', `${sinkUrl}/hook`, clock.t);
    addChannel(hub.db, 'slack', `${sinkUrl}/slack`, clock.t);
    const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 60_000, retryDelay: 0 });
    const first = await pushes(hub, n);
    assert.deepEqual(first.map((m) => m.path).sort(), ['/hook', '/slack'], 'one push per channel');
    const hook = first.find((m) => m.path === '/hook');
    assert.equal(hook.entries.filter((e) => e.kind === 'budget-near').length, 1);
    assert.match(hook.text, /budget: p has spent \$16\.00 of its \$20\.00 daily budget/);
    assert.match(hook.text, /resets at 00:00 UTC/);

    spend('c', 2);
    assert.deepEqual(await pushes(hub, n), [], 'more spend the same day: no second push');
    clock.t += 2 * HOUR; // past the notifier's hour of forgetting
    hub.humanOp('p', 'settings', { run_paused: true });
    assert.deepEqual(cards('budget-near'), [], 'paused: the person acted, so the card goes');
    await pushes(hub, n);
    clock.t += 90 * MIN;
    hub.humanOp('p', 'settings', { run_paused: false });
    assert.equal(cards('budget-near').length, 1, 'back with the same day');
    assert.deepEqual(await pushes(hub, n), [], 'still once per day');

    clock.t += DAY; // the next day: nothing spent yet
    assert.deepEqual(cards('budget-near'), []);
    spend('d', 17);
    assert.equal((await pushes(hub, n)).length, 2, 'a new day: it may push again');
    n.stop();
  });

  test('no budget, or an unstaffed project: no card', () => {
    const { hub, cards, spend } = world();
    hub.humanOp('p', 'settings', { run_budget: '' });
    spend('a', 500);
    assert.deepEqual(cards('budget-near'), []);
  });

  test('a worker past $50 or 60 minutes: one card naming the item, the worker and the spend, with Stop it', async () => {
    const { hub, clock, cards, report } = world();
    hub.agentOp('p', 'checkin', 'w1', { role: 'worker', runner: 'mac' });
    hub.agentOp('p', 'claim', 'w1', { item: '#1' });
    report([{ name: 'w1', since: clock.t, usd: 49.5 }]);
    assert.deepEqual(cards('run-spend'), [], '$49.50 after no time: nothing');
    report([{ name: 'w1', since: clock.t, usd: 50.25 }]);
    const [c, ...rest] = cards('run-spend');
    assert.equal(rest.length, 0);
    assert.equal(c.level, 'act');
    assert.equal(c.item, '#1');
    assert.equal(c.agent, 'w1');
    assert.match(c.headline, /^w1 has spent \$50\.25 on #1/);
    assert.deepEqual(c.actions, ['stop-worker']);

    addChannel(hub.db, 'webhook', `${sinkUrl}/hook`, clock.t);
    const n = new Notifier(hub, { baseUrl: 'http://hub.test', windowMs: 60_000, retryDelay: 0 });
    const [m] = await pushes(hub, n);
    assert.match(m.text, /#1 .*w1 has spent \$50\.25 on #1/);
    report([{ name: 'w1', since: START, usd: 60 }]);
    clock.t += 2 * HOUR;
    report([{ name: 'w1', since: START, usd: 70 }]);
    assert.deepEqual(await pushes(hub, n), [], 'once per worker run');

    // Stop it: the card goes, and the runner hears to stop w1 on its next poll, until w1 is gone.
    hub.humanOp('p', 'stop', { agent: 'w1' });
    assert.deepEqual(cards('run-spend'), []);
    assert.deepEqual(hub.runnerStops('mac', ['w1', 'w2']), ['w1']);
    assert.deepEqual(hub.runnerStops('other', ['w1']), [], "only its own runner's");
    assert.deepEqual(hub.runnerStops('mac', ['w2']), [], 'gone: forgotten');
    assert.deepEqual(hub.runnerStops('mac', ['w1']), []);
    assert.ok(hub.q("SELECT 1 FROM events WHERE type = 'runner' AND headline LIKE '%stop w1%'").get(), 'on the record');
    n.stop();
  });

  test('a worker running past 60 minutes, whatever it spent, gets the card; under that and $50, none', () => {
    const { hub, clock, cards, report } = world();
    report([{ name: 'w2', since: clock.t - 59 * MIN, usd: 10 }]);
    assert.deepEqual(cards('run-spend'), []);
    report([{ name: 'w2', since: clock.t - 61 * MIN }]);
    const [c] = cards('run-spend');
    assert.match(c.headline, /^w2 has run 1h$/);
    assert.equal(c.item, null, 'between jobs: no item');
    assert.throws(() => hub.humanOp('p', 'stop', { agent: 'nobody' }), /isn't running/);
  });
});
