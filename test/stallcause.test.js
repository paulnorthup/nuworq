import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { run, stopHeadline } from '../src/runner.js';
import { outcomes, workspaceOutcomes, stallCause } from '../src/outcomes.js';
import { stallSection } from '../web/analytics.js';

// #754: every stall says why. A runner's worker that stops leaves a hand-back naming the cause, lapsed review and
// landing leases carry one as building ones do, and outcomes breaks stalls down by it.

// A hub with one item, on a project the runner staffs.
function hubWith() {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { runner: true, autonomy: 'full' });
  hub.humanOp('p', 'create', { title: 'Build it', acceptance: 'works' });
  return { hub, item: '#1', later: (ms) => { t += ms; } };
}

// The supervising loop on that hub: each worker takes the item with next, and the runner signs it off as the CLI
// does (bin/nuworq.js), saying why it stopped.
function runner(hub) {
  let t = 0;
  const workers = [];
  return {
    workers,
    opts: {
      routes: async () => hub.route('', { runner: true }),
      launch: async (r) => {
        let finish;
        const w = { name: `w${workers.length + 1}`, project: r.project, signals: [], exited: new Promise((res) => { finish = res; }) };
        Object.assign(w, { finish, kill: (sig) => w.signals.push(sig) });
        hub.agentOp(r.project, 'next', w.name);
        workers.push(w);
        return w;
      },
      signoff: async (w) => hub.agentOp(w.project, 'signoff', w.name, { headline: stopHeadline(w.stopped), stopped: w.stopped }),
      log: () => {}, now: () => t, sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1, maxRuns: 1, workers: 1,
    },
  };
}
async function until(cond, what, ms = 10_000) {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const handoff = (hub) => {
  const e = hub.q("SELECT headline, data FROM events WHERE type = 'handoff'").get();
  return e && { headline: e.headline, data: JSON.parse(e.data) };
};

describe("a runner's worker that stops hands its item back saying why (#754)", () => {
  test('one that exits non-zero: the exit code', async () => {
    const { hub } = hubWith();
    const r = runner(hub);
    const p = run(r.opts);
    await until(() => r.workers.length, 'a worker');
    r.workers[0].finish(1);
    await p;
    const h = handoff(hub);
    assert.deepEqual(h.data, { stage: 'active', cause: 'exited', code: 1 });
    assert.match(h.headline, /Worker exited 1$/);
  });

  test('one stopped by --max-minutes: a timeout', async () => {
    const { hub } = hubWith();
    const r = runner(hub);
    const p = run({ ...r.opts, maxMinutes: 1 });
    await until(() => r.workers[0]?.signals.includes('SIGTERM'), 'SIGTERM past its minutes');
    r.workers[0].finish('SIGTERM');
    await p;
    const h = handoff(hub);
    assert.deepEqual(h.data, { stage: 'active', cause: 'timeout', minutes: 1 });
    assert.match(h.headline, /Worker stopped: ran past 1m$/);
  });

  test('one stopped by its budget (--worker-usd): budget', async () => {
    const { hub } = hubWith();
    const r = runner(hub);
    const p = run({ ...r.opts, workerUsd: 5, maxUsd: 100 });
    await until(() => r.workers.length, 'a worker');
    r.workers[0].spent = () => 6;
    await until(() => r.workers[0].signals.includes('SIGTERM'), 'SIGTERM past its cap');
    r.workers[0].finish('SIGTERM');
    await p;
    assert.deepEqual(handoff(hub).data, { stage: 'active', cause: 'budget', usd: 5 });
  });

  test("a land job's cap is a budget stop too, and Ctrl-C an interrupt", async () => {
    {
      const { hub } = hubWith();
      const r = runner(hub);
      const p = run(r.opts);
      await until(() => r.workers.length, 'a worker');
      Object.assign(r.workers[0], { cap: 2, spent: () => 3 });
      await until(() => r.workers[0].signals.includes('SIGTERM'), 'SIGTERM past the land cap');
      r.workers[0].finish('SIGTERM');
      await p;
      assert.deepEqual(handoff(hub).data, { stage: 'active', cause: 'budget', usd: 2 });
    }
    {
      const { hub } = hubWith();
      const r = runner(hub);
      let interrupt;
      const p = run({ ...r.opts, onInterrupt: (fn) => { interrupt = fn; } });
      await until(() => r.workers.length, 'a worker');
      interrupt();
      r.workers[0].finish(143);
      await p;
      assert.deepEqual(handoff(hub).data, { stage: 'active', cause: 'interrupted' });
    }
  });

  test('an agent that hands back itself, or signs off holding work, says so; an unknown stopped is a plain signoff', () => {
    const { hub, item } = hubWith();
    hub.agentOp('p', 'claim', 'a1', { item });
    hub.agentOp('p', 'handoff', 'a1', { item, headline: 'Out of ideas' });
    hub.agentOp('p', 'claim', 'a2', { item });
    hub.agentOp('p', 'signoff', 'a2', { headline: 'Done for today', stopped: { cause: 'nonsense' } });
    const causes = hub.q("SELECT json_extract(data, '$.cause') AS c FROM events WHERE type = 'handoff' ORDER BY id").all().map((r) => r.c);
    assert.deepEqual(causes, ['handoff', 'signoff']);
  });
});

describe('lapsed review and landing leases carry their cause (#754)', () => {
  test('a review that lapses, and a land job that lapses, record data.cause as building ones do', () => {
    const { hub, item, later } = hubWith();
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built' });
    assert.equal(hub.agentOp('p', 'next', 'r1').mode, 'review');
    later(2 * MIN);
    hub.sweep();
    later(30 * MIN);
    hub.sweep();
    const review = hub.q("SELECT data FROM events WHERE type = 'lease_expired'").get();
    assert.deepEqual(JSON.parse(review.data), { stage: 'verifying', cause: '' }, 'its reviewer went quiet');

    const p = hub.project('p');
    hub.q("UPDATE items SET stage = 'landing', holder = 'l1', lease_until = ? WHERE project_id = ?").run(hub.now() + MIN, p.id);
    later(2 * MIN);
    hub.sweep();
    const landing = hub.q("SELECT data FROM events WHERE type = 'lease_expired' ORDER BY id DESC").get();
    assert.deepEqual(JSON.parse(landing.data), { agent: 'l1', stage: 'landing', cause: '' });
  });
});

describe('outcomes breaks stalls down by cause (#754)', () => {
  test('each stalled job names its cause, and stalls_by_cause counts them, most first', () => {
    const { hub, item, later } = hubWith();
    for (const [agent, end] of [['a1', 'handoff'], ['a2', 'exited'], ['a3', 'exited'], ['a4', 'quiet']]) {
      hub.agentOp('p', 'claim', agent, { item });
      later(MIN);
      if (end === 'handoff') hub.agentOp('p', 'handoff', agent, { item, headline: 'Stuck' });
      if (end === 'exited') hub.agentOp('p', 'signoff', agent, { headline: 'Worker exited 1', stopped: { cause: 'exited', code: 1 } });
      if (end === 'quiet') { later(30 * MIN); hub.sweep(); }
      if (hub.item(hub.project('p'), item).stage === 'waiting') hub.humanOp('p', 'unpark', { item }); // the third hand-back parks it (#734)
    }
    const o = outcomes(hub, 'p', { since: 0 });
    assert.deepEqual(o.jobs.map((j) => [j.agent, j.result, j.cause]),
      [['a1', 'stalled', 'handoff'], ['a2', 'stalled', 'exited'], ['a3', 'stalled', 'exited'], ['a4', 'stalled', 'quiet']]);
    assert.deepEqual(o.stalls_by_cause, [{ cause: 'exited', stalls: 2 }, { cause: 'quiet', stalls: 1 }, { cause: 'handoff', stalls: 1 }]);
    assert.deepEqual(workspaceOutcomes(hub, { period: 'all' }).stalls_by_cause, o.stalls_by_cause);
  });

  test('events from before causes were kept count as unrecorded', () => {
    const ev = (type, data) => ({ type, data: JSON.stringify(data) });
    assert.equal(stallCause(ev('handoff', { stage: 'active' })), 'unrecorded');
    assert.equal(stallCause(ev('lease_expired', { agent: 'l1' })), 'unrecorded');
    assert.equal(stallCause(ev('lease_expired', { agent: 'a', cause: '' })), 'quiet');
    assert.equal(stallCause(ev('lease_expired', { agent: 'a', cause: 'restart' })), 'restart');
  });
});

describe("Analytics' Why work stalled (#754)", () => {
  test('the commonest cause first in words, then the top causes as bars, the rest in one line', () => {
    const html = stallSection([{ cause: 'exited', stalls: 8 }, { cause: 'quiet', stalls: 4 }, { cause: 'timeout', stalls: 2 },
      { cause: 'budget', stalls: 1 }, { cause: 'handoff', stalls: 1 }, { cause: 'restart', stalls: 1 }, { cause: 'unrecorded', stalls: 1 }]);
    assert.match(html, /data-new="stall-causes">Why work stalled<\/h2><span class="count">18<\/span>/);
    assert.match(html, /Worker exited is the most common: 8 of 18 stalls \(a crash, or a context or API error\)\./);
    const bars = [...html.matchAll(/<dt>([^<]+)<\/dt>\s*<dd><span class="bar" style="width:(\d+)%/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(bars, [['Worker exited', 100], ['Went quiet', 50], ['Ran out of time', 25], ['Hit its spending cap', 13], ['Handed back', 13]]);
    assert.match(html, /Other causes <span class="s">2<\/span>/);
    assert.equal(stallSection([]), '', 'nothing stalled: no section');
  });
});
