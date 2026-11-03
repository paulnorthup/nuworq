import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { capacity, autoMax, cpuBusy, cpuSampler, vmAvailable, run } from '../src/runner.js';

const GB = 1024 ** 3;
const roomy = { busy: 0.2, cores: 10, free: 16 * GB };

// nuworq run --workers auto (#533): one more worker only while the machine has room, at least one, never past the cap.
describe('how many workers the machine has room for', () => {
  test('one more while the CPUs are under 80% busy and memory is free', () => {
    assert.deepEqual(capacity(2, roomy, { max: 6 }), { workers: 3, holding: null });
  });

  test('#790: a Mac whose load average is 13 on 10 cores but whose CPUs are 20% busy takes one more', () => {
    assert.deepEqual(capacity(1, { busy: 0.2, load: 13, cores: 10, free: 12 * GB }), { workers: 2, holding: null });
  });

  test('holds on CPU, on memory, and at --max-workers, saying which', () => {
    assert.deepEqual(capacity(3, { ...roomy, busy: 0.86 }, { max: 8 }), { workers: 3, holding: 'CPU 86% busy on 10 cores' });
    assert.deepEqual(capacity(3, { ...roomy, free: 1.5 * GB }, { max: 8 }), { workers: 3, holding: '1.5 GB memory free' });
    assert.deepEqual(capacity(5, roomy, { max: 5 }), { workers: 5, holding: '--max-workers 5' });
  });

  test('at least one while work waits, however busy the machine', () => {
    assert.deepEqual(capacity(0, { busy: 1, cores: 10, free: 0 }, { max: 4 }), { workers: 1, holding: null });
  });

  test("waits a minute after starting one, so the CPU shows it first; and until there's a measure", () => {
    assert.deepEqual(capacity(2, roomy, { max: 6, sinceStart: 30_000 }), { workers: 2, holding: null });
    assert.deepEqual(capacity(2, roomy, { max: 6, sinceStart: 60_000 }), { workers: 3, holding: null });
    assert.deepEqual(capacity(2, { ...roomy, busy: null }, { max: 6 }), { workers: 2, holding: null });
  });

  // os.cpus() times in ms.
  const core = (user, idle, sys = 0) => ({ model: 'm', speed: 1, times: { user, nice: 0, sys, idle, irq: 0 } });
  test('busy share from two os.cpus() snapshots, across all cores', () => {
    const before = [core(1000, 9000), core(500, 9500), core(0, 0)];
    // Core 0: 300 busy of 1000; core 1: 100 busy (user 50, sys 50) of 1000; core 2 didn't move.
    const after = [core(1300, 9700), core(550, 10400, 50), core(0, 0)];
    assert.equal(cpuBusy(before, after), 400 / 2000);
    assert.equal(cpuBusy(after, after), null, 'no counter moved');
    assert.equal(cpuBusy([], after), null, 'no sample before');
  });

  test('the sampler measures since its last sample, at most every few seconds', () => {
    let t = 0, i = 0;
    const samples = [[core(0, 0)], [core(800, 200)], [core(900, 1100)]];
    const busy = cpuSampler(() => samples[i++], { now: () => t, minMs: 5_000 });
    assert.equal(busy(), null, 'too soon: nothing measured yet');
    t = 30_000;
    assert.equal(busy(), 0.8);
    t = 31_000;
    assert.equal(busy(), 0.8, 'asked again in the same round: the last measure');
    t = 60_000;
    assert.equal(busy(), 0.1);
  });

  // Paul's 64 GB Mac (Q253): os.freemem() read 1 GB while vm_stat held 28 GB inactive.
  const vmStat = (free, inactive, speculative = 0) => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               ${free}.
Pages active:                           1500000.
Pages inactive:                           ${inactive}.
Pages speculative:                          ${speculative}.
Pages throttled:                                0.
Pages wired down:                        400000.
`;
  test('#790: on macOS, available memory counts inactive and speculative pages, not only free ones', () => {
    assert.equal(vmAvailable(vmStat(37972, 1862894, 1000)), (37972 + 1862894 + 1000) * 16384);
    const free = vmAvailable(vmStat(65536, 1835008)); // 1 GB free, 28 GB inactive
    assert.equal(free, 29 * GB);
    assert.deepEqual(capacity(1, { busy: 0.4, cores: 10, free }), { workers: 2, holding: null });
    assert.equal(vmAvailable(''), null, 'not vm_stat: fall back to os.freemem()');
    assert.equal(vmAvailable('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 5.\n'), null);
  });

  test('the default cap is half the cores, at least one', () => {
    assert.equal(autoMax(10), 5);
    assert.equal(autoMax(1), 1);
  });
});

describe('nuworq run --workers auto', () => {
  // A runner on a fake clock: each poll is 30 s; busy(poll) says how busy its CPUs are then.
  async function runner({ busy, polls = 8, took = async () => null }) {
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
      workers: 'auto', maxWorkers: 4, machine: () => ({ busy: busy(n), load: 13, cores: 10, free: 16 * GB }),
      report: (s) => { reports.push(s); }, log: (l) => lines.push(l),
      now: () => t, pollSeconds: 30,
      onInterrupt: (fn) => { interrupt = fn; },
      sleep: async () => { t += 30_000; if (n >= polls) interrupt(); },
    });
    return { out, lines, reports, started };
  }

  test('adds one a minute while there is room, then holds and says why once', async () => {
    // The load average is 13 on 10 cores throughout (#790): only the CPU time counts.
    const { lines, reports, started } = await runner({ busy: (n) => (n < 5 ? 0.2 : 0.86) });
    // Polls 1, 3 (a minute later) and 5 would each add one; by poll 5 the CPUs are 86% busy.
    assert.equal(started.length, 2);
    const holds = lines.filter((l) => l.startsWith('Holding'));
    assert.deepEqual(holds, ['Holding at 2: CPU 86% busy on 10 cores'], 'said once, not every poll');
    const last = reports.findLast((r) => !r.stopped);
    assert.equal(last.auto, true);
    assert.equal(last.workers, 4);
    assert.equal(last.holding, 'CPU 86% busy on 10 cores');
  });

  test('keeps one running even when the machine is busy from the start', async () => {
    const { started, lines } = await runner({ busy: () => 1, polls: 4 });
    assert.equal(started.length, 1);
    assert.ok(lines.includes('Holding at 1: CPU 100% busy on 10 cores'));
  });

  test('never above --max-workers', async () => {
    const { started, lines } = await runner({ busy: () => 0.1, polls: 12 });
    assert.equal(started.length, 4);
    assert.ok(lines.includes('Holding at 4: --max-workers 4'));
  });

  test('the start line names the project, and a later line what the worker took', async () => {
    const { lines } = await runner({ busy: () => 1, polls: 3, took: async (w) => `#7 Fix the thing (review)` });
    assert.ok(lines.some((l) => /^▶ w1 → p$/.test(l)), 'not the route\'s top item, which it may not take');
    assert.ok(!lines.some((l) => l.includes('#1 top')));
    assert.deepEqual(lines.filter((l) => l.includes('took')), ['  w1 took #7 Fix the thing (review)'], 'once');
  });
});

describe('the hub hears why a runner holds, and what a worker took', () => {
  test('the runner report keeps auto and holding, and the project view shows them', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.reportRunner({ name: 'mac', machine: 'mac', running: 2, workers: 5, auto: true, holding: 'CPU 86% busy on 10 cores' });
    const [r] = hub.runnersFor('p');
    assert.equal(r.auto, true);
    assert.equal(r.holding, 'CPU 86% busy on 10 cores');
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
