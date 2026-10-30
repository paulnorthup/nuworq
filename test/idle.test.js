import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';

// One project with ready work and nobody on it; the clock moves.
function setup({ staffed = true } = {}) {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: 'Build it', acceptance: 'works' });
  if (staffed) hub.humanOp('p', 'settings', { runner: true });
  const report = (r) => hub.reportRunner({ name: 'mini', machine: 'mini.local', workers: 1, poll_seconds: 30, ...r });
  const idle = () => view(hub, 'p').attention.find((a) => a.kind === 'no-agents');
  return { hub, report, idle, tick: (ms) => (t += ms) };
}
const steps = (a) => a.how.map((s) => s.do);

describe('Needs you says why nothing is working (#173)', () => {
  test('no runner up: says where and when one was last seen, with steps to start one', () => {
    const { report, idle, tick } = setup();
    let a = idle();
    assert.equal(a.cause, 'no-runner');
    assert.equal(a.sub, 'No runner has ever reported here');
    report({});
    assert.equal(idle(), undefined, 'a runner up for the project is capacity');
    tick(10 * MIN);
    a = idle();
    assert.equal(a.cause, 'no-runner');
    assert.equal(a.sub, 'No runner is up: mini was last seen 10m ago on mini.local');
    assert.deepEqual(a.how.map((s) => s.where), ['nuworq run --workers 1', 'nuworq run --workers 1 --install']);
    assert.match(steps(a)[0], /^On mini\.local, start a runner/);
    assert.ok(a.how[0].check);
  });

  test('runners up but the project not staffed: the fix is the one button', () => {
    const { report, idle } = setup({ staffed: false });
    report({});
    const a = idle();
    assert.equal(a.cause, 'unstaffed');
    assert.equal(a.staff, true);
    assert.match(a.why, /mini is up, but this project doesn't let `nuworq run` start workers/);
    assert.match(steps(a)[0], /Let nuworq run staff this project/);
  });

  test('every runner skips it: the reason it gave', () => {
    const { hub, report, idle } = setup();
    report({ skipping: [{ project: 'p', reason: "couldn't update its checkout: fatal: could not read from remote", until: hub.now() + 10 * MIN }] });
    const a = idle();
    assert.equal(a.cause, 'skipping');
    assert.match(a.sub, /Every runner skips this project: couldn't update its checkout/);
    assert.match(a.why, /for 10m/);
    assert.match(steps(a)[0], /^On mini\.local, fix what the runner said/);
  });

  test('runners paused: until when, and why', () => {
    const { hub, report, idle } = setup();
    report({ paused: { until: hub.now() + 5 * MIN, reason: '3 workers in a row failed within seconds' } });
    const a = idle();
    assert.equal(a.cause, 'paused');
    assert.match(a.why, /mini paused itself for 5m: 3 workers in a row failed within seconds/);
    assert.equal(a.how.length, 1);
  });

  test('the budget is spent: the runner stopped at --max-usd', () => {
    const { report, idle } = setup();
    report({ stopped: 'reached --max-usd 5 ($5.12 spent)' });
    const a = idle();
    assert.equal(a.cause, 'budget');
    assert.match(a.sub, /reached --max-usd 5/);
    assert.match(a.how[0].where, /--max-usd/);
  });

  test("an agent that only checked in and looked doesn't hide it; a claim, or held work, does", () => {
    const { hub, idle, tick } = setup({ staffed: false });
    hub.agentOp('p', 'checkin', 'planner');
    hub.agentOp('p', 'look', 'planner', {});
    hub.agentOp('p', 'comment', 'planner', { headline: 'Looks good' });
    assert.equal(idle()?.cause, 'no-runner', 'a reading session is not capacity');
    hub.humanOp('p', 'create', { title: 'Another', acceptance: 'works' });
    hub.agentOp('p', 'next', 'w1');
    assert.equal(idle(), undefined, 'held work is capacity');
    hub.agentOp('p', 'handoff', 'w1', { item: '#1', headline: 'Back to the queue' });
    assert.equal(idle(), undefined, 'a claim in the last 30 minutes still counts');
    tick(31 * MIN);
    assert.equal(idle()?.cause, 'no-runner');
  });
});
