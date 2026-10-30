import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, LEASE_MS, LAND_GRACE } from '../src/core.js';
import { view } from '../src/insight.js';
import { Notifier, addChannel } from '../src/notify.js';
import { run } from '../src/runner.js';

// #177: the pitch's four promises, walked by one item from outcome to main. Each assertion names the one it guards.
const DIRECT = 'You direct, not dispatch';
const KEPT = 'Nothing is lost';
const VERIFIED = 'Done means verified on main';
const CAPACITY = 'Capacity follows the work';

function setup() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pillars-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  let now = Date.UTC(2026, 9, 30, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'settings', { path: repo, autonomy: 'full', runner: true });
  // A push channel that records what would reach the person's phone.
  const pushed = [];
  addChannel(hub.db, 'webhook', 'http://phone.test/hook', now);
  const notifier = new Notifier(hub, { fetch: async (url, o) => { pushed.push(JSON.parse(o.body)); return new Response(null, { status: 200 }); } });
  // A worker's own worktree, at the item's branch if someone started it, and one commit moved onto that branch.
  const commit = (agent, branch, file) => {
    const dir = `${repo}.worktrees/${agent}`;
    const has = git(repo, 'branch', '--list', branch);
    git(repo, 'worktree', 'add', '-q', '--detach', dir, has ? branch : 'main');
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${file}`);
    git(dir, 'update-ref', `refs/heads/${branch}`, 'HEAD');
  };
  return {
    hub, repo, git, commit, notifier, pushed,
    op: (agent, name, args = {}) => hub.agentOp('demo', name, agent, args),
    item: () => hub.item(hub.project('demo'), '#1'),
    tick: (ms) => { now += ms; },
    // Needs you: what the person has to act on.
    needs: () => view(hub, 'demo').attention.filter((a) => a.level === 'act'),
    // What the notifier would push right now, without waiting for its batch window.
    push: async () => { notifier.scan(); return notifier.flush(); },
  };
}

describe('the pitch, end to end', () => {
  test('one item walks every promise: directed, staffed, kept through a quiet worker, peer-verified, done on main', async () => {
    const w = setup();
    const { hub, op, item, needs } = w;

    // 1. An outcome goes in. Needs you asks what matters most, until it's picked.
    hub.humanOp('demo', 'create', { title: 'Greet visitors', summary: 'People should feel welcome', stage: 'proposed' });
    assert.deepEqual(needs().filter((a) => a.kind === 'direction').map((a) => a.headline), ['What matters most?'], `${DIRECT}: an unpicked outcome asks for direction`);
    await w.push();
    assert.equal(w.pushed.length, 1, `${DIRECT}: the question reaches the person`);
    assert.match(JSON.stringify(w.pushed[0]), /What matters most\?/, `${DIRECT}: the question reaches the person`);
    hub.humanOp('demo', 'pick', { item: '#1' });
    assert.ok(!needs().some((a) => a.kind === 'direction'), `${DIRECT}: once picked, it stops asking`);
    w.pushed.length = 0;

    // 2-5. The runner, already running for this project, staffs it from here on: nobody starts a worker.
    // Each worker it launches does what a real agent would; the runner only sees the hub's routes.
    const seen = []; // what each worker was handed by next
    const workers = [
      (name) => { // shapes the picked outcome into work
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.mode, 'shape', `${CAPACITY}: the first worker shapes the picked outcome`);
        op(name, 'refine', { item: '#1', acceptance: 'A greeting file is on main' });
        op(name, 'submit', { item: '#1', headline: 'Shaped: a greeting file' });
        return 0;
      },
      (name) => { // starts it, then goes quiet: crashed, no handoff
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.mode, 'work', `${CAPACITY}: shaped work gets a builder without anyone starting one`);
        w.commit(name, job.branch, 'greeting');
        op(name, 'progress', { item: '#1', headline: 'Greeting file written; README link next' });
        return 1;
      },
      (name) => { // picks it up after the lease, continues, hands off
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.item, '#1');
        const quiet = job.history?.find((h) => h.type === 'lease_expired');
        assert.ok(quiet, `${KEPT}: the next worker's history says the last one went quiet`);
        assert.match(quiet.summary, /Greeting file written; README link next/, `${KEPT}: and what it had done`);
        assert.ok(w.git(w.repo, 'branch', '--list', job.branch), `${KEPT}: its commits are still on the branch`);
        w.commit(name, job.branch, 'link');
        op(name, 'handoff', { item: '#1', headline: 'README link added; only the test is left', summary: 'Run npm test, then submit' });
        return 0;
      },
      (name) => { // finishes from the handoff and submits
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.last_handoff?.headline, 'README link added; only the test is left', `${KEPT}: the handoff note reaches the next worker`);
        assert.equal(job.last_handoff?.summary, 'Run npm test, then submit', `${KEPT}: with its summary`);
        w.commit(name, job.branch, 'test');
        op(name, 'submit', { item: '#1', headline: 'Greeting on main', evidence: [{ label: 'npm test: 3 passed' }] });
        assert.equal(item().stage, 'verifying', `${VERIFIED}: submitted work waits for a verifier`);
        assert.throws(() => op(name, 'review', { item: '#1', verdict: 'accept', headline: 'Looks good' }), /your own/i, `${VERIFIED}: its builder can't review it`);
        return 0;
      },
      (name) => { // a different agent verifies it
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.mode, 'review', `${VERIFIED}: a peer is routed to verify it`);
        op(name, 'review', { item: '#1', verdict: 'accept', headline: 'Greeting file present, test listed' });
        assert.equal(item().stage, 'landing', `${VERIFIED}: accepted is not done until main has it`);
        return 0;
      },
      (name) => { // lands it after the builder's grace
        op(name, 'checkin', { has: ['macos'] });
        const job = op(name, 'next');
        seen.push(job);
        assert.equal(job.mode, 'land', `${CAPACITY}: accepted work gets a lander`);
        const branch = item().branch;
        assert.throws(() => op(name, 'submit', { item: '#1', headline: 'Landed' }), /doesn't contain/, `${VERIFIED}: the hub won't call it done before git does`);
        assert.notEqual(item().stage, 'done', `${VERIFIED}: still not done`);
        w.git(w.repo, 'merge', '-q', '--ff-only', branch);
        op(name, 'submit', { item: '#1', headline: 'Landed' });
        assert.equal(item().stage, 'done', `${VERIFIED}: done once main contains the branch`);
        return 0;
      },
    ];

    // 6. At every poll of the runner, Needs you holds nothing (no person is needed while work flows) and nothing is pushed.
    // The runner treats a throwing routes() as the hub being down and a throwing launch as a failed worker,
    // and goes on. So a failed assertion in either stops the runner, and is thrown once it has.
    let failure, interrupt;
    const guard = (fn) => async (...a) => {
      try {
        return await fn(...a);
      } catch (e) {
        failure ??= e;
        interrupt();
        throw e;
      }
    };
    const polls = [];
    const routes = async () => {
      assert.ok(polls.length < 200, `${CAPACITY}: the work keeps moving (stuck at ${item().stage})`);
      polls.push(item().stage);
      // Until #185, the hub can't tell a runner is on duty, so before its first worker checks in Needs you
      // says no agent is working. From the first launch on, it must hold nothing.
      if (!n) return hub.route('', { runner: true });
      const acts = needs();
      assert.deepEqual(acts.map((a) => a.kind), [], `${DIRECT}: while work flows, Needs you is empty (stage ${item().stage})`);
      await w.push();
      assert.deepEqual(w.pushed, [], `${DIRECT}: while work flows, nothing is pushed (stage ${item().stage})`);
      return hub.route('', { runner: true });
    };
    let n = 0;
    const launch = async (r) => {
      const name = `w${++n}`;
      assert.ok(workers[n - 1], `${CAPACITY}: no more workers than the work needs (asked for a ${n}th for ${r.item} ${r.mode})`);
      const code = workers[n - 1](name);
      return { name, project: r.project, kill() {}, exited: Promise.resolve(code) };
    };
    const res = await run({
      // As `nuworq run` runs by default: it waits for work (a quiet worker's lease) rather than exit. It stops
      // after the six jobs; the route check below shows no seventh was due.
      routes: guard(routes), launch: guard(launch), workers: 2, maxRuns: workers.length, pollSeconds: 60, log: () => {},
      onInterrupt: (fn) => { interrupt = fn; },
      now: () => hub.now(), sleep: async (ms) => { w.tick(ms); await new Promise((r) => setImmediate(r)); },
    });
    if (failure) throw failure;

    assert.equal(res.launched, workers.length, `${CAPACITY}: one worker per job, no herd`);
    assert.deepEqual(hub.route('', { runner: true }), [], `${CAPACITY}: and none once it's done`);
    assert.equal(item().stage, 'done', `${VERIFIED}: the item ends done`);
    assert.ok(existsSync(join(w.repo, 'greeting')) && existsSync(join(w.repo, 'link')) && existsSync(join(w.repo, 'test')), `${KEPT}: every worker's commit is on main`);
    assert.equal(new Set(seen.map((j) => j.item)).size, 1, 'one item the whole way');
    // The quiet worker's lease ran out on its own clock: polls passed while nobody held it.
    assert.ok(polls.filter((s) => s === 'active').length >= LEASE_MS / 60_000, `${KEPT}: the item waited out the quiet worker's lease, then moved on`);
    assert.ok(polls.filter((s) => s === 'landing').length >= LAND_GRACE / 60_000, `${VERIFIED}: the builder's grace to land came first`);
    assert.deepEqual(needs(), [], `${DIRECT}: done leaves nothing for the person`);
    assert.deepEqual(w.pushed, [], `${DIRECT}: and nothing was pushed`);
  });
});
