import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';

// "main moved since you started" without git on the request path (#535): heartbeats, checkin and the view read
// what refreshBehind found, off the request path.
function setup() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-headsup-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  let now = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'settings', { path: repo });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const build = (agent, branch, file) => {
    const dir = `${repo}.worktrees/${agent}`;
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${file}`);
    return dir;
  };
  return { hub, repo, git, op, build, tick: (ms) => { now += ms; } };
}

// git, counted: a git first on PATH that logs each call, then runs the real one.
function countGit() {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-gitcount-'));
  const log = join(dir, 'calls');
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const was = process.env.PATH;
  process.env.PATH = `${dir}:${was}`;
  return { calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []), restore: () => { process.env.PATH = was; } };
}

describe('no request path runs git to say main moved', () => {
  test('heartbeats, checkin and the view spawn no git, and still say when to rebase, and when not', async () => {
    const { hub, repo, git, op, build, tick } = setup();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    const one = op('a1', 'next'), two = op('a2', 'next');
    build('a1', one.branch, 'first');
    const wt2 = build('a2', two.branch, 'second');
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    git(repo, 'merge', '-q', '--ff-only', one.branch);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    await hub.refreshBehind();

    const git_ = countGit();
    let beat, again, page;
    try {
      beat = op('a2', 'progress', { item: '#2' });
      again = op('a2', 'progress', { item: '#2', headline: 'Still going' });
      op('a2', 'checkin');
      page = view(hub, 'demo');
    } finally { git_.restore(); }
    assert.deepEqual(git_.calls(), [], 'no git on a heartbeat, a progress, a checkin or the view');
    assert.match(beat.heads_up, /^main moved since you started: #1 landed\. Rebase now \(git rebase main\), while any conflicts are small\.$/);
    assert.equal(again.heads_up, beat.heads_up);
    assert.ok(page);

    // Rebased: the next refresh sees it, and the heads-up goes.
    git(wt2, 'rebase', '-q', 'main');
    await hub.refreshBehind();
    assert.equal(op('a2', 'progress', { item: '#2' }).heads_up, undefined);
  });

  test("a branch whose heads haven't moved keeps its answer without running merge-base", async () => {
    const { hub, repo, git, op, build, tick } = setup();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    const one = op('a1', 'next'), two = op('a2', 'next');
    build('a1', one.branch, 'first');
    build('a2', two.branch, 'second');
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    git(repo, 'merge', '-q', '--ff-only', one.branch);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    await hub.refreshBehind();
    const g = countGit();
    try { await hub.refreshBehind(); } finally { g.restore(); }
    assert.ok(g.calls().length > 0, 'it looks at the heads');
    assert.ok(!g.calls().some((c) => c.includes('merge-base')), g.calls().join('\n'));
  });

  test('a landing refreshes it soon after, off the request', async () => {
    const { hub, repo, git, op, build, tick } = setup();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    const one = op('a1', 'next'), two = op('a2', 'next');
    build('a1', one.branch, 'first');
    build('a2', two.branch, 'second');
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    git(repo, 'merge', '-q', '--ff-only', one.branch);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(op('a2', 'progress', { item: '#2' }).heads_up, undefined, 'not yet: the check runs after this request');
    for (let i = 0; i < 50 && !hub._behind.size; i++) await new Promise((r) => setTimeout(r, 20));
    assert.match(op('a2', 'progress', { item: '#2' }).heads_up, /main moved since you started: #1 landed/);
  });
});
