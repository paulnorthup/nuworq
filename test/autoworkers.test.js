import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { capacity, autoMax, run } from '../src/runner.js';

const GB = 1024 ** 3;
const roomy = { load: 2, cores: 10, free: 16 * GB };

// nuworq run --workers auto (#533): one more worker only while the machine has room, at least one, never past the cap.
describe('how many workers the machine has room for', () => {
  test('one more while the load is under 80% of the cores and memory is free', () => {
    assert.deepEqual(capacity(2, roomy, { max: 6 }), { workers: 3, holding: null });
  });

  test('holds on load, on memory, and at --max-workers, saying which', () => {
    assert.deepEqual(capacity(6, { ...roomy, load: 11.2 }, { max: 8 }), { workers: 6, holding: 'load 11.2 on 10 cores' });
    assert.deepEqual(capacity(3, { ...roomy, free: 1.5 * GB }, { max: 8 }), { workers: 3, holding: '1.5 GB memory free' });
    assert.deepEqual(capacity(5, roomy, { max: 5 }), { workers: 5, holding: '--max-workers 5' });
  });

  test('at least one while work waits, however busy the machine', () => {
    assert.deepEqual(capacity(0, { load: 40, cores: 10, free: 0 }, { max: 4 }), { workers: 1, holding: null });
  });

  test("waits a minute after starting one, so the load average counts it first", () => {
    assert.deepEqual(capacity(2, roomy, { max: 6, sinceStart: 30_000 }), { workers: 2, holding: null });
    assert.deepEqual(capacity(2, roomy, { max: 6, sinceStart: 60_000 }), { workers: 3, holding: null });
  });

  test('the default cap is half the cores, at least one', () => {
    assert.equal(autoMax(10), 5);
    assert.equal(autoMax(1), 1);
  });
});

describe('nuworq run --workers auto', () => {
  // A runner on a fake clock: each poll is 30 s; load(poll) says how busy the machine is then.
  async function runner({ load, polls = 8, took = async () => null }) {
    let t = 0, n = 0, interrupt;
    const lines = [], reports = [], started = [];
    const out = await run({
      routes: async () => { n++; return [{ project: 'p', name: 'p', item: '#1', title: 'top', mode: 'work', claimable: 10 }]; },
      launch: async (r) => {
        let end;
        const w = { name: `w${started.length + 1}`, project: r.project, exited: new Promise((res) => { end = res; }), kill: () => end(0) };
        started.push(w);
        return w;
      },
      took, claimed: async () => true,
      workers: 'auto', maxWorkers: 4, machine: () => ({ load: load(n), cores: 10, free: 16 * GB }),
      report: (s) => { reports.push(s); }, log: (l) => lines.push(l),
      now: () => t, pollSeconds: 30,
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { t += 30_000; if (n >= polls) interrupt(); },
    });
    return { out, lines, reports, started };
  }

  test('adds one a minute while there is room, then holds and says why once', async () => {
    const { lines, reports, started } = await runner({ load: (n) => (n < 5 ? 2 : 9.5) });
    // Polls 1, 3 (a minute later) and 5 would each add one; by poll 5 the load is 9.5 on 10 cores.
    assert.equal(started.length, 2);
    const holds = lines.filter((l) => l.startsWith('Holding'));
    assert.deepEqual(holds, ['Holding at 2: load 9.5 on 10 cores'], 'said once, not every poll');
    const last = reports.findLast((r) => !r.stopped);
    assert.equal(last.auto, true);
    assert.equal(last.workers, 4);
    assert.equal(last.holding, 'load 9.5 on 10 cores');
  });

  test('keeps one running even when the machine is busy from the start', async () => {
    const { started, lines } = await runner({ load: () => 30, polls: 4 });
    assert.equal(started.length, 1);
    assert.ok(lines.includes('Holding at 1: load 30.0 on 10 cores'));
  });

  test('never above --max-workers', async () => {
    const { started, lines } = await runner({ load: () => 1, polls: 12 });
    assert.equal(started.length, 4);
    assert.ok(lines.includes('Holding at 4: --max-workers 4'));
  });

  test('the start line names the project, and a later line what the worker took', async () => {
    const { lines } = await runner({ load: () => 30, polls: 3, took: async (w) => `#7 Fix the thing (review)` });
    assert.ok(lines.some((l) => /^▶ w1 → p$/.test(l)), 'not the route\'s top item, which it may not take');
    assert.ok(!lines.some((l) => l.includes('#1 top')));
    assert.deepEqual(lines.filter((l) => l.includes('took')), ['  w1 took #7 Fix the thing (review)'], 'once');
  });
});

describe('the hub hears why a runner holds, and what a worker took', () => {
  test('the runner report keeps auto and holding, and the project view shows them', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.reportRunner({ name: 'mac', machine: 'mac', running: 2, workers: 5, auto: true, holding: 'load 11.2 on 10 cores' });
    const [r] = hub.runnersFor('p');
    assert.equal(r.auto, true);
    assert.equal(r.holding, 'load 11.2 on 10 cores');
    hub.reportRunner({ name: 'fixed', machine: 'pc', running: 1, workers: 3 });
    const fixed = hub.runnersFor('p').find((x) => x.name === 'fixed');
    assert.ok(!fixed.auto && !('holding' in fixed), 'a fixed --workers N runner reads as before');
  });

  test("firstClaim names the item an agent took since then, and its mode", () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'Fix the thing', acceptance: 'x' });
    const t0 = hub.now();
    assert.equal(hub.firstClaim('w1', t0), null);
    hub.agentOp('p', 'claim', 'w1', { item: '#1' });
    assert.equal(hub.firstClaim('w1', t0), '#1 Fix the thing (work)');
    assert.equal(hub.firstClaim('w1', t0, { scope: ['other'] }), null);
  });
});
