import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, LAND_GRACE } from '../src/core.js';

// A real repo with main, a hub whose project lives there, and agents that work in their own worktrees.
function setup() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-land-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  let now = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'settings', { path: repo });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const worktree = (agent) => {
    const dir = `${repo}.worktrees/${agent}`;
    git(repo, 'worktree', 'add', '-q', '--detach', dir, 'main');
    return dir;
  };
  // What a worker does in its worktree: the item's branch from main, one commit.
  const build = (dir, branch, file) => {
    git(dir, 'switch', '-q', '-c', branch, 'main');
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${file}`);
  };
  const item = (n) => hub.item(hub.project('demo'), `#${n}`);
  return { hub, repo, git, op, worktree, build, item, tick: (ms) => { now += ms; } };
}

describe('landing: done means on main', () => {
  test('claim names a branch; accept sends it to landing; the builder lands it; git confirms done', () => {
    const { hub, repo, git, op, worktree, build, item } = setup();
    hub.humanOp('demo', 'create', { title: 'Add a greeting file', acceptance: 'greeting exists' });
    op('a1', 'checkin');
    const job = op('a1', 'next');
    assert.equal(job.mode, 'work');
    assert.equal(job.branch, 'nuworq/1-add-a-greeting-file');
    assert.match(job.hint, /git switch -c nuworq\/1-add-a-greeting-file main/);
    assert.match(job.hint, /never in .* itself/);

    const wt = worktree('a1');
    build(wt, job.branch, 'greeting');
    op('a1', 'submit', { item: '#1', headline: 'Greeting added', evidence: [{ label: 'ls: greeting' }] });
    assert.equal(item(1).stage, 'verifying');

    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'landing', 'accepted, but main does not have it yet');

    op('a2', 'checkin');
    assert.notEqual(op('a2', 'next').mode, 'land', 'the builder lands its own work first');
    const land = op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, new RegExp(`git -C ${repo} merge --ff-only nuworq/1-add-a-greeting-file`));

    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Landed' }), /main doesn't contain nuworq\/1-add-a-greeting-file yet/);
    git(repo, 'merge', '-q', '--ff-only', 'nuworq/1-add-a-greeting-file');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
    const landed = hub.q(`SELECT * FROM events WHERE type = 'landed'`).get();
    assert.match(landed.headline, /a1 landed #1 on main/);
  });

  test('after the grace period any agent may land it; a quiet lander frees the job', () => {
    const { hub, op, worktree, build, item, tick } = setup();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    op('a1', 'checkin');
    const job = op('a1', 'next');
    build(worktree('a1'), job.branch, 'thing');
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a2', 'checkin');
    tick(LAND_GRACE);
    assert.equal(op('a2', 'next').mode, 'land');
    assert.equal(item(1).holder, 'a2');
    tick(21 * 60_000);
    hub.sweep();
    assert.equal(item(1).stage, 'landing');
    assert.equal(item(1).holder, null);
  });

  test('conflicts that change the approved work send it back for review instead of landing', () => {
    const { hub, op, worktree, build, item } = setup();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    op('a1', 'checkin');
    build(worktree('a1'), op('a1', 'next').branch, 'thing');
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    op('a1', 'submit', { item: '#1', headline: 'Rebased', conflicts: 'Both changed the README intro; I kept both paragraphs.' });
    assert.equal(item(1).stage, 'verifying');
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'rebased'`).get());
  });

  test('work already on main is done at accept; work with no repo is done at accept as before', () => {
    const { hub, repo, git, op, worktree, build, item } = setup();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    op('a1', 'checkin');
    build(worktree('a1'), op('a1', 'next').branch, 'thing');
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    git(repo, 'merge', '-q', '--ff-only', 'nuworq/1-thing');
    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'done');
    assert.match(hub.q(`SELECT headline FROM events WHERE type = 'landed'`).get().headline, /already on main/);

    const plain = new Hub();
    plain.tx(() => plain.project('solo', { create: true }));
    plain.humanOp('solo', 'create', { title: 'No repo', acceptance: 'x' });
    plain.agentOp('solo', 'checkin', 'b');
    plain.agentOp('solo', 'next', 'b');
    plain.agentOp('solo', 'submit', 'b', { item: '#1', headline: 'Done' });
    plain.humanOp('solo', 'accept', { item: '#1' });
    assert.equal(plain.item(plain.project('solo'), '#1').stage, 'done');
  });

  test('when something lands, agents still building are told to rebase until their branch has it', () => {
    const { hub, repo, git, op, worktree, build, tick } = setup();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    op('a1', 'checkin');
    op('a2', 'checkin');
    const one = op('a1', 'next');
    const two = op('a2', 'next');
    const wt1 = worktree('a1');
    const wt2 = worktree('a2');
    build(wt1, one.branch, 'first');
    build(wt2, two.branch, 'second');
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    git(repo, 'merge', '-q', '--ff-only', one.branch);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });

    const nudge = op('a2', 'progress', { item: '#2', headline: 'Still going' }).heads_up;
    assert.match(nudge, /main moved since you started: #1 landed\. Rebase now/);
    git(wt2, 'rebase', '-q', 'main');
    assert.equal(op('a2', 'progress', { item: '#2' }).heads_up, undefined);
  });

  test('a branch behind main is flagged at submit, so the review sees what will land', () => {
    const { hub, repo, git, op, worktree, build } = setup();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    op('a1', 'checkin');
    build(worktree('a1'), op('a1', 'next').branch, 'thing');
    writeFileSync(join(repo, 'other'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'someone else landed');
    const r = op('a1', 'submit', { item: '#1', headline: 'Done' });
    assert.match(r.hint, /nuworq\/1-thing is 1 commit\(s\) behind main; rebase onto main/);
  });
});
