// A worker exiting leaves the checkout's other branches where they were (#618, security review #596): its sandbox
// writes the shared checkout's refs so it can commit, so the runner puts back whatever else it moved.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refsOf, restoreRefs, restoredLine } from '../src/runner.js';

const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const git = async (args) => (await promisify(execFile)('git', args)).stdout;
const commit = (cwd, m) => { sh(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', m); return sh(cwd, 'rev-parse', 'HEAD'); };

// origin with main; the person's checkout of it, with a branch of their own and a tag; a worker's worktree on its
// item branch, and a sibling's on its own.
function setup() {
  const origin = mkdtempSync(join(tmpdir(), 'nuworq-origin-'));
  sh(origin, 'init', '-q', '-b', 'main');
  commit(origin, 'one');
  const home = mkdtempSync(join(tmpdir(), 'nuworq-home-'));
  execFileSync('git', ['clone', '-q', origin, home]);
  sh(home, 'branch', 'mine');
  sh(home, 'tag', 'v1');
  const wt = `${home}.worktrees/w1`, sib = `${home}.worktrees/w2`;
  sh(home, 'worktree', 'add', '-q', '-b', 'nuworq/7-thing', wt, 'main');
  sh(home, 'worktree', 'add', '-q', '-b', 'nuworq/8-other', sib, 'main');
  return { origin, home, wt, sib, main: sh(home, 'rev-parse', 'main') };
}

describe("a worker exiting leaves the checkout's other branches where they were", () => {
  test('main, a branch of the person and a tag go back; its own branch and a sibling\'s stay', async () => {
    const { home, wt, sib, main } = setup();
    const before = await refsOf(home, git);
    // The worker commits on its own branch, as it should, and a sibling on its own...
    const own = commit(wt, 'its work');
    const theirs = commit(sib, 'sibling work');
    // ...but also points the person's main and their branch at its commit, deletes the tag, and makes a branch.
    sh(wt, 'update-ref', 'refs/heads/main', own);
    sh(wt, 'update-ref', 'refs/heads/mine', own);
    sh(wt, 'update-ref', '-d', 'refs/tags/v1');
    sh(wt, 'branch', 'stray', own);

    const r = await restoreRefs(home, before, git, { own: ['nuworq/7-thing'], live: ['nuworq/8-other'] });
    assert.deepEqual(r.restored.map((x) => x.ref).sort(), ['refs/heads/main', 'refs/heads/mine', 'refs/tags/v1']);
    assert.equal(sh(home, 'rev-parse', 'main'), main, "the person's main is where it was");
    assert.equal(sh(home, 'rev-parse', 'mine'), main);
    assert.equal(sh(home, 'rev-parse', 'v1'), main, 'the tag is back');
    assert.equal(sh(home, 'rev-parse', 'nuworq/7-thing'), own, 'its own branch keeps its work');
    assert.equal(sh(home, 'rev-parse', 'nuworq/8-other'), theirs, "a sibling's branch keeps the sibling's work");
    assert.deepEqual(r.created, ['refs/heads/stray'], 'a branch it made is named, not deleted');
    const line = restoredLine(home, r.restored.find((x) => x.ref === 'refs/heads/main'));
    assert.match(line, new RegExp(`^main was moved to ${own.slice(0, 7)} while the worker ran; it is back at ${main.slice(0, 7)} \\(if that move was yours: git -C .* update-ref refs/heads/main ${own}\\)$`));
  });

  test('a pull to what origin has is left alone, and so is nothing at all', async () => {
    const { origin, home } = setup();
    const before = await refsOf(home, git);
    const upstream = commit(origin, 'landed');
    sh(home, 'fetch', '-q', 'origin');
    sh(home, 'update-ref', 'refs/heads/main', upstream); // the person (or an operator) pulled
    const r = await restoreRefs(home, before, git, { own: ['nuworq/7-thing'] });
    assert.deepEqual(r, { restored: [], created: [] });
    assert.equal(sh(home, 'rev-parse', 'main'), upstream);
  });

  test('the runner snapshots refs before a worker starts and puts them back when it exits', () => {
    const cli = readFileSync(new URL('../bin/nuworq.js', import.meta.url), 'utf8');
    assert.match(cli, /const refsBefore = worktree \? await refsOf\(home, git\)/);
    assert.match(cli, /if \(refsBefore\) await guardRefs\(\{ home, branch, name, project: target\.slug, before: refsBefore \}\);/);
    assert.match(cli, /await git\(\['-C', home, 'fetch', '-q', '--prune', 'origin'\]\)[^\n]*\n\s*const g = await restoreRefs\(home, before, git, \{ own: \[branch\], live: siblings \}\)/, "origin's refs are fetched first, so a worker can't fake a pull");
    assert.match(cli, /\.call\('comment', \{/, 'and it says so on the hub');
  });
});
