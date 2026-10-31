import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Hub, branchesSettled } from '../src/core.js';
import { prMerged } from '../src/github.js';
import { prClient } from '../src/ghapp.js';
import { sweep, sweepLine, cleanBranch, run, SWEEP_EVERY_MS } from '../src/runner.js';

// No leftovers (#444): worktrees and branches of finished work go, and nothing that holds work is touched.
const git = async (args) => (await promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])).stdout;
const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// A checkout (home) of a bare origin, with a commit on main.
function checkout() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-sweep-')));
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const home = join(dir, 'app');
  g(dir, 'clone', '-q', origin, home);
  writeFileSync(join(home, 'f'), 'x');
  g(home, 'add', '.');
  g(home, 'commit', '-qm', 'init');
  g(home, 'push', '-q', 'origin', 'main');
  const wt = (name, branch, { push = true, commit = true } = {}) => {
    const path = `${home}.worktrees/${name}`;
    if (!branch) { g(home, 'worktree', 'add', '-q', '--detach', path, 'origin/main'); return path; }
    g(home, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
    if (commit) { writeFileSync(join(path, name), name); g(path, 'add', '.'); g(path, 'commit', '-qm', name); }
    if (push) g(path, 'push', '-q', 'origin', branch);
    return path;
  };
  return { dir, home, origin, wt, branches: () => g(home, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').sort() };
}

describe('the sweep (#444)', () => {
  test('removes finished work that is all on origin; keeps uncommitted and unpushed work, open items, running workers and home', async () => {
    const c = checkout();
    try {
      c.wt('done', 'nuworq/1-done');
      const dirty = c.wt('dirty', 'nuworq/2-dirty');
      writeFileSync(join(dirty, 'wip'), 'not committed');
      c.wt('unpushed', 'nuworq/3-unpushed', { push: false });
      g(c.home, 'worktree', 'remove', `${c.home}.worktrees/unpushed`); // its branch stays, with a commit origin lacks
      c.wt('open', 'nuworq/4-open');
      const running = c.wt('running', 'nuworq/5-running');
      c.wt('idle');
      c.wt('fresh');
      g(c.home, 'worktree', 'add', '-q', '--detach', join(c.dir, 'old-name.worktrees', 'renamed'), 'origin/main'); // made before the checkout was renamed
      g(c.home, 'worktree', 'add', '-q', '--detach', join(c.dir, 'elsewhere', 'mine'), 'origin/main'); // a person's own: not nuworq's
      c.wt('gone');
      rmSync(`${c.home}.worktrees/gone`, { recursive: true }); // a stale record: its folder was deleted by hand
      c.wt('landed', 'nuworq/6-landed'); // its worktree went at exit; its branch stays
      g(c.home, 'worktree', 'remove', `${c.home}.worktrees/landed`);

      const finished = new Set(['nuworq/1-done', 'nuworq/2-dirty', 'nuworq/3-unpushed', 'nuworq/5-running', 'nuworq/6-landed', 'main']);
      const idle = async (path) => (/\/(idle|renamed|mine)$/.test(path) ? 2 * 24 * 3600_000 : 60_000);
      const args = { home: c.home, finished, git, idle, keep: [running] };

      const dry = await sweep({ ...args, dryRun: true });
      assert.deepEqual(dry.worktrees.sort(), ['app.worktrees/done', 'app.worktrees/idle', 'old-name.worktrees/renamed']);
      assert.deepEqual(dry.branches.sort(), ['nuworq/1-done', 'nuworq/6-landed']);
      assert.equal(dry.pruned, 1);
      assert.ok(existsSync(`${c.home}.worktrees/done`), 'a dry run removes nothing');
      assert.ok(c.branches().includes('nuworq/1-done'));
      assert.equal(sweepLine('app', dry, { dryRun: true }), 'Sweep (dry run) app: would remove 3 worktrees and 2 branches, would prune 1 stale record; kept 2 (1 uncommitted changes, 1 commits origin lacks)');

      const r = await sweep(args);
      assert.deepEqual(r.worktrees.sort(), ['app.worktrees/done', 'app.worktrees/idle', 'old-name.worktrees/renamed']);
      assert.deepEqual(r.branches.sort(), ['nuworq/1-done', 'nuworq/6-landed']);
      assert.deepEqual(r.kept.sort((a, b) => a.what.localeCompare(b.what)), [
        { what: 'app.worktrees/dirty', why: 'uncommitted changes' },
        { what: 'nuworq/3-unpushed', why: 'commits origin lacks' },
      ]);
      assert.equal(sweepLine('app', r), 'Swept app: removed 3 worktrees and 2 branches, pruned 1 stale record; kept 2 (1 uncommitted changes, 1 commits origin lacks)');
      assert.ok(!existsSync(`${c.home}.worktrees/done`) && !existsSync(`${c.home}.worktrees/idle`));
      for (const kept of ['dirty', 'open', 'running', 'fresh']) assert.ok(existsSync(`${c.home}.worktrees/${kept}`), kept);
      assert.ok(existsSync(join(c.dir, 'elsewhere', 'mine')), 'not in a .worktrees folder: left alone');
      assert.deepEqual(c.branches(), ['main', 'nuworq/2-dirty', 'nuworq/3-unpushed', 'nuworq/4-open', 'nuworq/5-running']);
      assert.equal(g(c.home, 'symbolic-ref', '--short', 'HEAD'), 'main', 'home is untouched');
      assert.match(g(c.home, 'worktree', 'list'), /dirty/);
      assert.doesNotMatch(g(c.home, 'worktree', 'list'), /gone/, 'the stale record is pruned');

      // Again: nothing left to take.
      assert.equal(sweepLine('app', await sweep(args)), 'Swept app: nothing to remove; kept 2 (1 uncommitted changes, 1 commits origin lacks)');
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  test('a checkout that was moved: its worktrees are repaired, then swept; a dry run keeps them and says why', async () => {
    const c = checkout();
    try {
      c.wt('old');
      const moved = join(c.dir, 'renamed');
      execFileSync('mv', [c.home, moved]); // the worktree's .git now names a checkout that isn't there
      const idle = async () => 2 * 24 * 3600_000;
      const dry = await sweep({ home: moved, finished: new Set(), git, idle, dryRun: true });
      assert.deepEqual(dry.kept.map((k) => [k.what, k.why]), [['app.worktrees/old', "git can't read it"]]);
      assert.equal(sweepLine('app', dry, { dryRun: true }), "Sweep (dry run) app: nothing to remove; kept 1 (1 git can't read it)");
      const r = await sweep({ home: moved, finished: new Set(), git, idle });
      assert.deepEqual(r.worktrees, ['app.worktrees/old']);
      assert.ok(!existsSync(`${c.home}.worktrees/old`));
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  test("a worker's branch goes at exit once its item is done and it is on origin, not before", async () => {
    const c = checkout();
    try {
      c.wt('a', 'nuworq/1-a');
      c.wt('b', 'nuworq/2-b', { push: false });
      g(c.home, 'worktree', 'remove', `${c.home}.worktrees/a`);
      g(c.home, 'worktree', 'remove', `${c.home}.worktrees/b`);
      assert.equal(await cleanBranch(c.home, 'nuworq/1-a', new Set(), git), false, 'not finished yet');
      assert.equal(await cleanBranch(c.home, 'nuworq/2-b', new Set(['nuworq/2-b']), git), false, 'unpushed');
      assert.equal(await cleanBranch(c.home, 'nuworq/1-a', new Set(['nuworq/1-a']), git), true);
      assert.deepEqual(c.branches(), ['main', 'nuworq/2-b']);
    } finally { rmSync(c.dir, { recursive: true, force: true }); }
  });

  test('nuworq run sweeps when the last sweep is a week old, once', async () => {
    let t = 10 * SWEEP_EVERY_MS;
    const swept = [];
    const once = (sweptAt) => run({
      routes: async () => [], launch: async () => { throw new Error('none'); }, log: () => {}, untilIdle: true,
      sweep: async () => { swept.push(t); }, sweptAt, now: () => t, sleep: async () => {},
    });
    await once(t - 60_000);
    assert.deepEqual(swept, [], 'swept a minute ago');
    await once(t - SWEEP_EVERY_MS);
    assert.deepEqual(swept, [t]);
    // A sweep that fails is said, and the runner goes on.
    const said = [];
    const r = await run({ routes: async () => [], launch: async () => {}, log: (l) => said.push(l), untilIdle: true, sweep: async () => { throw new Error('git broke'); }, now: () => t, sleep: async () => {} });
    assert.match(r.why, /no work/);
    assert.ok(said.includes('The sweep failed: git broke'), said.join('\n'));
  });
});

describe('landed branches leave GitHub (#444)', () => {
  const world = () => {
    const hub = new Hub();
    hub.tx(() => hub.project('g', { create: true }));
    hub.humanOp('g', 'remote', { add: 'github.com/acme/api' });
    const p = hub.project('g');
    const calls = [];
    hub.github = { covers: () => true, async deleteBranch(a) { calls.push(a); if (a.branch.includes('fail')) throw new Error('GitHub said no'); return { deleted: true }; } };
    const merge = (title, branch) => {
      const it = hub.humanOp('g', 'create', { title, acceptance: 'x' }).item;
      const item = hub.item(p, it);
      hub.patch(item, { stage: 'landing', branch: branch ?? `nuworq/${item.seq}-x` });
      hub.q(`INSERT INTO prs (project_id, repo, number, item_id, url, title, state, head_ref, head_sha, updated_at) VALUES (?, 'github.com/acme/api', ?, ?, '', ?, 'open', ?, '', 0)`)
        .run(p.id, item.seq, item.id, title, item.branch);
      hub.tx(() => prMerged(hub, p, hub.q('SELECT * FROM prs WHERE number = ?').get(item.seq), { sha: 'f'.repeat(40) }));
      return hub.item(p, it);
    };
    return { hub, p, calls, merge };
  };

  test("when an item lands, the hub deletes its branch on GitHub as its app, and says so", async () => {
    const { hub, calls, merge } = world();
    const item = merge('One');
    await branchesSettled(hub);
    assert.equal(item.stage, 'done');
    assert.deepEqual(calls, [{ repo: 'github.com/acme/api', branch: item.branch }]);
    assert.equal(hub.q(`SELECT headline FROM events WHERE item_id = ? AND type = 'branch_deleted'`).get(item.id).headline, `nuworq deleted ${item.branch} on github.com/acme/api`);
  });

  test("only the branch the hub named for that item; a failure goes on the record with the command", async () => {
    const { hub, calls, merge } = world();
    merge('Main', 'main');
    merge('Other', 'nuworq/99-not-this-one');
    await branchesSettled(hub);
    assert.deepEqual(calls, [], "never main or another item's branch");
    hub.github.deleteBranch = async () => { throw new Error('GitHub said no'); };
    const third = merge('Third');
    await branchesSettled(hub);
    const ev = hub.q(`SELECT headline, summary FROM events WHERE item_id = ? AND type = 'branch_delete_failed'`).get(third.id);
    assert.equal(ev.headline, `The hub couldn't delete ${third.branch} on github.com/acme/api: GitHub said no`);
    assert.equal(ev.summary, `Delete it: git push origin --delete ${third.branch}`);
  });

  test("the GitHub client deletes refs/heads/<branch>; one already gone is fine", async () => {
    const seen = [];
    const answers = [204, 422, 500];
    const app = { now: () => 0, mint: async () => ({ token: 't', expires_at: new Date(3600_000).toISOString() }), call: async (method, path) => { seen.push(`${method} ${path}`); const status = answers.shift(); return { status, json: status === 500 ? { message: 'boom' } : {} }; } };
    const gh = prClient(app);
    assert.deepEqual(await gh.deleteBranch({ repo: 'github.com/acme/api', branch: 'nuworq/7-a b' }), { deleted: true });
    assert.deepEqual(await gh.deleteBranch({ repo: 'github.com/acme/api', branch: 'nuworq/7-a' }), { deleted: false });
    await assert.rejects(gh.deleteBranch({ repo: 'github.com/acme/api', branch: 'nuworq/7-a' }), /GitHub didn't delete nuworq\/7-a \(500: boom\)/);
    assert.equal(seen[0], 'DELETE /repos/acme/api/git/refs/heads/nuworq/7-a%20b');
  });

  test("/api/finished lists the branches of done and dropped items", () => {
    const { hub, p, merge } = world();
    const done = merge('Done');
    const it = hub.humanOp('g', 'create', { title: 'Open', acceptance: 'x' }).item;
    hub.patch(hub.item(p, it), { branch: 'nuworq/50-open' });
    assert.deepEqual(hub.finishedBranches('g'), [done.branch]);
    assert.deepEqual(hub.finishedBranches('g', { scope: ['other'] }), []);
    assert.deepEqual(hub.finishedBranches('nope'), []);
  });
});
