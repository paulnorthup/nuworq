import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN, HOUR, VOUCH_IDLE_MS } from '../src/core.js';
import { runnerGit } from '../src/runner.js';

// #736: a runner vouched for every worker it had running, so a worker whose CLI hung held its item for days. Now the
// vouching renews a lease only while the worker itself is heard from: a call, progress or a push within 2 hours.
function hubWith() {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const item = hub.agentOp('p', 'propose', 'w1', { title: 'Build it', acceptance: 'works' }).item;
  hub.agentOp('p', 'claim', 'w1', { item });
  // A runner's worker: its lapses used to be excused as the session ending (cause 'session').
  hub.q("UPDATE agents SET runner = 'mac' WHERE name = 'w1'").run();
  const it = () => hub.item(hub.project('p'), item);
  return { hub, item, it, later: (ms) => { t += ms; } };
}
// The runner reports every 5 minutes, naming w1 as running, for this long; the hub sweeps after each report.
const vouch = (s, ms, each = () => {}) => {
  for (let m = 0; m < ms; m += 5 * MIN) { s.later(5 * MIN); each(m); s.hub.renewWorkers(['w1']); s.hub.sweep(); }
};

describe('a stuck worker gives its item back (#736)', () => {
  test('vouched for but silent: renewals stop after 2 hours, and the lease lapses as a stall', () => {
    const s = hubWith();
    vouch(s, VOUCH_IDLE_MS - 10 * MIN);
    assert.equal(s.it().holder, 'w1', 'kept while it might still be working');
    vouch(s, 40 * MIN);
    assert.equal(s.it().holder, null, 'no call, progress or push for 2 hours: the runner no longer keeps it');
    assert.equal(s.it().stage, 'ready');
    assert.equal(s.it().stalls, 1);
    const [e] = s.hub.q("SELECT data FROM events WHERE type = 'lease_expired'").all();
    assert.equal(JSON.parse(e.data).cause, '', 'it went quiet: a stall that counts, not a session ending');
  });

  test('a long test run that calls progress every 15 minutes keeps its item', () => {
    const s = hubWith();
    vouch(s, 4 * HOUR, (m) => { if (m % (15 * MIN) === 0) s.hub.agentOp('p', 'progress', 'w1', { item: s.item }); });
    assert.equal(s.it().holder, 'w1');
    assert.equal(s.it().stalls, 0);
  });

  test('a push through the hub counts as heard from', () => {
    const s = hubWith();
    vouch(s, 4 * HOUR, (m) => { if (m % HOUR === 0) s.hub.heard(s.hub.project('p'), 'w1'); });
    assert.equal(s.it().holder, 'w1');
  });

  test("a worker whose runner stopped soon after its last call is still the session ending, not a stall", () => {
    const s = hubWith();
    vouch(s, 30 * MIN, () => s.hub.agentOp('p', 'look', 'w1', {}));
    s.later(30 * MIN);
    s.hub.sweep();
    const [e] = s.hub.q("SELECT data FROM events WHERE type = 'lease_expired'").all();
    assert.equal(JSON.parse(e.data).cause, 'session');
  });
});

describe("the runner's git calls time out (#736)", () => {
  test('a git that hangs is killed, so a finished worker leaves running', async () => {
    // A stand-in for git that never exits, as a fetch from a stalled remote.
    const git = runnerGit({ timeout: 300, file: process.execPath });
    const t0 = Date.now();
    await assert.rejects(git(['-e', 'setInterval(() => {}, 1000)']), (e) => e.killed === true);
    assert.ok(Date.now() - t0 < 5_000, 'gave up at the timeout');
    assert.equal((await runnerGit({ file: process.execPath })(['-e', 'process.stdout.write("ok")'])), 'ok', 'a call that finishes returns its output');
  });
});
