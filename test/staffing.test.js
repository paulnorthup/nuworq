import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { plan } from '../src/runner.js';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 30, 20); // 20:00 UTC: four hours before the day rolls over

// One project nuworq run may staff, with three ready items.
function world(opts = {}) {
  const clock = { t: START };
  const hub = new Hub({ clock: () => clock.t, ...opts });
  hub.tx(() => hub.project('p', { create: true }));
  for (const t of ['A', 'B', 'C']) hub.humanOp('p', 'create', { title: t, acceptance: 'x' });
  hub.humanOp('p', 'settings', { runner: true });
  const p = () => hub.project('p');
  const routed = () => hub.route('', { runner: true }).map((r) => r.project);
  return { hub, clock, p, routed, set: (s) => hub.humanOp('p', 'settings', s) };
}

// Staffing is set on the hub and runners carry it out (#174).
describe('staffing', () => {
  test('a new project asks once whether nuworq run may staff it; off until answered', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('fresh', { create: true }));
    const s = () => view(hub, 'fresh').project.staffing;
    assert.equal(s().asked, false, 'asks');
    assert.equal(view(hub, 'fresh').project.runner, false, 'the default is off: workers cost money, so the person decides');
    hub.humanOp('fresh', 'settings', { runner: false });
    assert.equal(s().asked, true, '"Not now" is an answer: it doesn\'t ask again');
    assert.equal(view(hub, 'fresh').project.runner, false);
    hub.tx(() => hub.project('other', { create: true }));
    hub.humanOp('other', 'settings', { runner: true });
    assert.deepEqual([view(hub, 'other').project.staffing.asked, view(hub, 'other').project.runner], [true, true]);
  });

  test('projects from before #174 are not asked', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-staffing-')), 'hub.db');
    const hub = new Hub({ file });
    hub.tx(() => hub.project('old', { create: true }));
    hub.db.close();
    const db = new DatabaseSync(file);
    db.exec('ALTER TABLE projects DROP COLUMN staff_asked; PRAGMA user_version = 0'); // as a database from before #174 was
    db.close();
    const again = new Hub({ file });
    assert.equal(view(again, 'old').project.staffing.asked, true);
    again.db.close();
  });

  test('the worker limit reaches runners and caps how many work there at once', () => {
    const { hub, set } = world();
    assert.equal(hub.route('', { runner: true })[0].limit, null, 'blank: each runner\'s own --workers');
    set({ run_workers: 2 });
    const [r] = hub.route('', { runner: true });
    assert.equal(r.limit, 2);
    assert.equal(r.claimable, 3);
    assert.equal(plan([r], [], { workers: 5 }).length, 2, 'two at once, though three items wait and five may run');
    assert.equal(plan([{ ...r, holders: ['someone'] }], [], { workers: 5 }).length, 1, 'an agent already working there counts');
    assert.equal(plan([r], [{ name: 'w1', project: 'p' }], { workers: 5 }).length, 1, "and so does this runner's worker that hasn't claimed yet");
    assert.equal(plan([{ ...r, limit: null }], [], { workers: 5 }).length, 3, 'no limit: as before');
    set({ run_workers: '' });
    assert.equal(hub.route('', { runner: true })[0].limit, null, 'cleared');
    assert.throws(() => set({ run_workers: 0 }), /1 to 100/);
    assert.throws(() => set({ run_workers: 2.5 }), /1 to 100/);
  });

  test('a paused project gets no new workers; other agents and running work carry on', () => {
    const { hub, set, routed } = world();
    hub.agentOp('p', 'checkin', 'w1');
    hub.agentOp('p', 'next', 'w1');
    set({ run_paused: true });
    assert.deepEqual(routed(), [], 'runners are sent nowhere');
    assert.deepEqual(hub.route('').map((r) => r.project), ['p'], 'an agent someone started still finds the work');
    assert.equal(hub.item(hub.project('p'), '#1').holder, 'w1', 'the running worker keeps its item');
    assert.equal(view(hub, 'p').project.staffing.stopped, 'paused');
    set({ run_paused: false });
    assert.deepEqual(routed(), ['p']);
  });

  test("today's recorded spend, every runner and source, stops new workers at the budget until the UTC day rolls over", () => {
    const { hub, clock, p, set, routed } = world();
    set({ run_budget: 5 });
    hub.recordUsage(p(), null, 'w1', { input_tokens: 1, output_tokens: 1, cost_usd: 3 }, 'runner');
    assert.deepEqual(routed(), ['p'], '$3 of $5');
    hub.recordUsage(p(), null, 'w2', { input_tokens: 1, output_tokens: 1, cost_usd: 2 }, 'agent');
    assert.deepEqual(routed(), [], '$5 of $5: no new workers');
    const s = view(hub, 'p').project.staffing;
    assert.deepEqual([s.budget, s.spent_today, s.stopped], [5, 5, 'budget']);
    clock.t += 3 * 60 * 60 * 1000;
    assert.deepEqual(routed(), [], 'still the same UTC day');
    clock.t = START + DAY / 6 + 1; // 00:00:00.001 UTC the next day
    assert.deepEqual(routed(), ['p'], 'a new day, a new budget');
    assert.equal(view(hub, 'p').project.staffing.spent_today, 0);
    set({ run_budget: '' });
    assert.equal(view(hub, 'p').project.staffing.budget, null);
    assert.throws(() => set({ run_budget: 0 }), /more than 0/);
    assert.throws(() => set({ run_budget: 'lots' }), /more than 0/);
  });

  // #762: route() stops new workers, but one worker took item after item past the budget through next.
  test("a spent budget stops a runner worker's next claiming work; reviews still come, and a session only hears it", () => {
    const { hub, p, set } = world();
    set({ run_budget: 5, autonomy: 'full' });
    // Each worker calls with a worker token of its own: with only the runner's, w1 couldn't review w0's build (#937).
    const RUNNER = { token: { name: 'w1.worker', runner: 'mac', worker: 'w1' } };
    const W0 = { token: { name: 'w0.worker', runner: 'mac', worker: 'w0' } };
    hub.agentOp('p', 'checkin', 'w0', {}, W0);
    hub.agentOp('p', 'next', 'w0', {}, W0);
    hub.agentOp('p', 'submit', 'w0', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] }, W0);
    hub.recordUsage(p(), null, 'w0', { input_tokens: 1, output_tokens: 1, cost_usd: 6 }, 'runner');
    hub.agentOp('p', 'checkin', 'w1', {}, RUNNER);
    const review = hub.agentOp('p', 'next', 'w1', {}, RUNNER);
    assert.equal(review.mode, 'review', 'work already submitted is still reviewed');
    assert.equal(hub.item(p(), '#1').holder, 'w1');
    hub.agentOp('p', 'review', 'w1', { item: '#1', verdict: 'reject', headline: 'Not yet' }, RUNNER);
    const idle = hub.agentOp('p', 'next', 'w1', {}, RUNNER);
    assert.equal(idle.mode, 'idle');
    assert.match(idle.hint, /\$5\.00 budget .* is spent \(\$6\.00\).*resets at 00:00 UTC, in 4h/);
    assert.deepEqual(hub.q("SELECT seq FROM items WHERE project_id = ? AND holder = 'w1'").all(p().id), [], 'claims nothing');
    hub.agentOp('p', 'checkin', 'me');
    const session = hub.agentOp('p', 'next', 'me');
    assert.equal(session.mode, 'work', 'an attended session is not refused');
    assert.match(session.budget, /budget .* is spent/);
  });

  test('turning staffing on from Settings sets a $20 daily budget when there was none', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('q', { create: true }));
    hub.humanOp('q', 'settings', { runner: true });
    assert.equal(view(hub, 'q').project.staffing.budget, 20, 'the Settings field shows it');
    hub.humanOp('q', 'settings', { runner: false });
    hub.humanOp('q', 'settings', { run_budget: 7 });
    hub.humanOp('q', 'settings', { runner: true });
    assert.equal(hub.project('q').run_budget, 7, 'a budget already set is kept');
    hub.tx(() => hub.project('r', { create: true }));
    hub.humanOp('r', 'settings', { runner: true, run_budget: '' });
    assert.equal(hub.project('r').run_budget, null, 'cleared on purpose in the same change: no budget');
  });

  test("a running worker's spend so far, as its runner reports it, counts toward the daily budget before it exits (#761)", () => {
    const { hub, clock, p, set, routed } = world();
    set({ run_budget: 10 });
    const report = (usd, extra = {}) => hub.reportRunner({ name: 'mac', running: 1, workers: 1, poll_seconds: 30, live: ['w1'], spending: [{ name: 'w1', project: 'p', usd }], ...extra }, { runner: true });
    report(4);
    assert.deepEqual(routed(), ['p'], '$4 of $10 so far');
    report(12);
    assert.deepEqual(routed(), [], '$12 of $10 while it still runs: no new workers');
    assert.equal(view(hub, 'p').project.staffing.spent_today, 12);
    // It exits and its usage is recorded: that record counts, not its last report too.
    hub.agentOp('p', 'checkin', 'w1');
    hub.agentOp('p', 'usage', 'w1', { usage: { input_tokens: 1, output_tokens: 1, cost_usd: 12.5 } });
    assert.equal(view(hub, 'p').project.staffing.spent_today, 12.5, 'counted once');
    // A runner that went quiet no longer counts what it last said.
    report(3, { live: ['w2'], spending: [{ name: 'w2', project: 'p', usd: 3 }] });
    set({ run_budget: 20 });
    assert.equal(view(hub, 'p').project.staffing.spent_today, 15.5);
    clock.t += 5 * 30_000;
    assert.equal(view(hub, 'p').project.staffing.spent_today, 12.5, 'down: its workers are gone');
  });

  test("live spend counts only a runner's own workers (#782)", () => {
    const { hub, p, set } = world();
    set({ run_budget: 10 });
    const said = (w, usd, opts, extra = {}) => hub.reportRunner({ name: 'mac', poll_seconds: 30, live: [w], spending: [{ name: w, project: 'p', usd }], ...extra }, opts);
    const stopped = () => hub.staffing(p()).stopped;
    said('w1', 50, { name: '' });
    assert.equal(stopped(), null, "a non-runner agent token's report counts nothing");
    hub.agentOp('p', 'checkin', 'w9', { role: 'worker', runner: 'other' });
    said('w9', 50, { name: 'mac', runner: true });
    assert.equal(stopped(), null, "another runner's worker counts nothing");
    hub.reportRunner({ name: 'mac', poll_seconds: 30, live: [], spending: [{ name: 'w3', project: 'p', usd: 50 }] }, { name: 'mac', runner: true });
    assert.equal(stopped(), null, "a worker the runner doesn't vouch for counts nothing");
    set({ run_budget: 1000 });
    said('w1', 1e9, { name: 'mac', runner: true });
    assert.equal(hub.staffing(p()).spent_today, 100, 'an absurd amount counts at most the ceiling');
    said('w1', 1e9, { name: 'mac', runner: true }, { worker_usd: 25 });
    assert.equal(hub.staffing(p()).spent_today, 25, "at most the runner's per-worker cap");
    set({ run_budget: 10 });
    said('w1', 12, { name: 'mac', runner: true });
    assert.equal(stopped(), 'budget', "a real runner's worker still counts");
  });

  test('each change is on the record', () => {
    const { hub, set } = world();
    set({ run_workers: 3, run_budget: 12.5, run_paused: true });
    const heads = hub.q("SELECT headline FROM events WHERE type = 'runner' ORDER BY id").all().map((e) => e.headline);
    assert.ok(heads.some((h) => /at most 3 workers/.test(h)));
    assert.ok(heads.some((h) => /daily budget of \$12\.50/.test(h)));
    assert.ok(heads.some((h) => /paused staffing/.test(h)));
  });
});
