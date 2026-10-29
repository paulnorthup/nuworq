import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub, LAND_GRACE } from '../src/core.js';
import { mirrorSource, mirrorPath, isRepo, sshCommandFor, fetchMirror } from '../src/git.js';

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

// The hub on a server, agents on other machines, GitHub in between. A bare repo plays GitHub; each
// agent has its own clone (its "Mac"); the hub knows only the remote and keeps its own mirror.
function remote({ reachable = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-remote-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'github', 'acme', 'app.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const clone = (name) => {
    const dir = join(root, name);
    git(root, 'clone', '-q', origin, dir);
    return dir;
  };
  const seed = clone('seed');
  writeFileSync(join(seed, 'README'), 'hi\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');

  let now = Date.UTC(2026, 9, 29, 9);
  const repos = join(root, 'hub', 'repos');
  const hub = new Hub({ clock: () => now, repos });
  hub.tx(() => hub.project('demo', { create: true }));
  // Learned from a checkin on another machine: a folder that isn't on the hub's, and the repository.
  hub.agentOp('demo', 'checkin', 'a1', {}, { root: '/Users/someone/app', remote: reachable ? origin : join(root, 'gone.git') });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  // What the hint says to do on a claim: the branch from origin/main, one commit.
  const build = (dir, branch, file) => {
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'switch', '-q', '-c', branch, 'origin/main');
    writeFileSync(join(dir, file), `${file}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `add ${file}`);
  };
  const push = (dir, ...a) => git(dir, 'push', '-q', 'origin', ...a);
  const rebase = (dir, branch) => {
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'switch', '-q', branch);
    git(dir, 'rebase', '-q', 'origin/main');
  };
  const item = (n) => hub.item(hub.project('demo'), `#${n}`);
  return { hub, root, origin, repos, git, clone, op, build, push, rebase, item, tick: (ms) => { now += ms; } };
}

describe('landing through GitHub, when the hub has no checkout', () => {
  test('claim, push, submit, accept, land with a push to main, submit: done', () => {
    const { hub, origin, repos, git, clone, op, build, push, rebase, item } = remote();
    hub.humanOp('demo', 'create', { title: 'Add a greeting file', acceptance: 'greeting exists' });
    const job = op('a1', 'next');
    assert.equal(job.mode, 'work');
    const b = 'nuworq/1-add-a-greeting-file';
    assert.equal(job.branch, b);
    assert.match(job.hint, /git fetch origin, then git switch -c nuworq\/1-add-a-greeting-file origin\/main \(or git switch nuworq\/1-add-a-greeting-file if it exists\)/);
    assert.match(job.hint, /push the branch \(git push origin nuworq\/1-add-a-greeting-file\)/);
    assert.doesNotMatch(job.hint, /git switch -c \S+ main\b/);

    const mac = clone('mac');
    build(mac, b, 'greeting');
    push(mac, '-u', b);
    const sub = op('a1', 'submit', { item: '#1', headline: 'Greeting added', evidence: [{ label: 'ls: greeting' }] });
    assert.doesNotMatch(sub.hint, /isn't on origin/);
    assert.equal(item(1).stage, 'verifying');
    const git1 = JSON.parse(hub.q(`SELECT data FROM events WHERE type = 'submitted'`).get().data).git;
    assert.equal(git1.branch, b, "the hub's mirror sees the pushed branch");
    assert.deepEqual(git1.commits.map((c) => c.subject), ['add greeting']);

    // The mirror: bare, under the hub's repos folder, named after the remote.
    const m = mirrorPath(repos, hub.remotesOf(hub.project('demo'))[0]);
    assert.equal(m, join(repos, ...origin.split('/').filter(Boolean)), 'the remote keeps its case and path');
    assert.ok(isRepo(m) && git(m, 'rev-parse', '--is-bare-repository') === 'true');

    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'landing', 'accepted, but main on GitHub does not have it yet');

    const land = op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /git fetch origin, then git switch nuworq\/1-add-a-greeting-file, then git rebase origin\/main/);
    assert.match(land.hint, /git push origin nuworq\/1-add-a-greeting-file:main\. If it is rejected as non-fast-forward, main moved: go back to step 1/);
    assert.match(land.hint, /git push origin nuworq\/1-add-a-greeting-file --force-with-lease/);
    assert.doesNotMatch(land.hint, /merge --ff-only/);
    assert.doesNotMatch(land.hint, /Push it first/, 'origin has the branch already');

    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Landed' }), /main doesn't contain nuworq\/1-add-a-greeting-file yet/);
    rebase(mac, b);
    push(mac, `${b}:main`);
    push(mac, b, '--force-with-lease');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
    assert.match(hub.q(`SELECT headline FROM events WHERE type = 'landed'`).get().headline, /a1 landed #1 on main/);
    assert.equal(git(origin, 'rev-parse', 'main'), git(mac, 'rev-parse', b), 'GitHub main is the branch');
  });

  test('a push to main that main moved under is rejected; fetch, rebase and push again lands it', () => {
    const { hub, origin, git, clone, op, build, push, rebase, item, tick } = remote();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    op('a2', 'checkin');
    const one = op('a1', 'next'), two = op('a2', 'next');
    const mac1 = clone('mac1'), mac2 = clone('mac2');
    build(mac1, one.branch, 'first');
    build(mac2, two.branch, 'second');
    push(mac1, '-u', one.branch);
    push(mac2, '-u', two.branch);
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    op('a2', 'submit', { item: '#2', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    hub.humanOp('demo', 'accept', { item: '#2' });
    assert.equal(op('a1', 'next').mode, 'land');
    assert.equal(op('a2', 'next').mode, 'land');

    // a2 rebases first; then a1 lands, so a2's push to main is no longer a fast-forward.
    rebase(mac2, two.branch);
    rebase(mac1, one.branch);
    push(mac1, `${one.branch}:main`);
    push(mac1, one.branch, '--force-with-lease');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');

    assert.throws(() => push(mac2, `${two.branch}:main`), (e) => /rejected/.test(e.stderr) && /fetch first|non-fast-forward/.test(e.stderr));
    const stuck = (() => { try { op('a2', 'submit', { item: '#2', headline: 'Landed' }); } catch (e) { return e; } })();
    assert.match(stuck.message, /main doesn't contain nuworq\/2-second yet/);
    assert.match(stuck.hint, /rejected as non-fast-forward, main moved: go back to step 1/);
    // Step 1 again: the rebase rewrites the branch, so updating it on origin needs the lease.
    rebase(mac2, two.branch);
    push(mac2, `${two.branch}:main`);
    assert.throws(() => push(mac2, two.branch), /rejected/, 'a plain push of the rewritten branch is refused');
    push(mac2, two.branch, '--force-with-lease');
    op('a2', 'submit', { item: '#2', headline: 'Landed' });
    assert.equal(item(2).stage, 'done');
    assert.equal(git(origin, 'log', '--format=%s', 'main'), 'add second\nadd first\ninit');
  });

  test('when something lands on GitHub, agents still building are told to rebase onto origin/main', () => {
    const { hub, clone, op, build, push, rebase, tick } = remote();
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x' });
    op('a2', 'checkin');
    const one = op('a1', 'next'), two = op('a2', 'next');
    const mac1 = clone('mac1'), mac2 = clone('mac2');
    build(mac1, one.branch, 'first');
    build(mac2, two.branch, 'second');
    push(mac1, '-u', one.branch);
    push(mac2, '-u', two.branch);
    tick(60_000);
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    op('a1', 'next');
    rebase(mac1, one.branch);
    push(mac1, `${one.branch}:main`);
    op('a1', 'submit', { item: '#1', headline: 'Landed' });

    const nudge = op('a2', 'progress', { item: '#2', headline: 'Still going' }).heads_up;
    assert.match(nudge, /main moved since you started: #1 landed\. Rebase now \(git fetch origin, then git rebase origin\/main, then git push origin nuworq\/2-second --force-with-lease\)/);
  });

  test('submit before pushing says to push the branch, and the reviewer sees it too', () => {
    const { hub, clone, op, build, push, item } = remote();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const job = op('a1', 'next');
    const mac = clone('mac');
    build(mac, job.branch, 'thing');
    const r = op('a1', 'submit', { item: '#1', headline: 'Done' });
    assert.match(r.hint, /^nuworq\/1-thing isn't on origin yet; push it \(git push origin nuworq\/1-thing\) so reviewers anywhere can see it/);
    const review = hub.q(`SELECT data FROM events WHERE type = 'submitted'`).get();
    assert.equal(JSON.parse(review.data).git.unpushed, 'nuworq/1-thing');

    push(mac, '-u', job.branch);
    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'landing', 'accept fetches first, so it sees the branch pushed since');
  });

  test('accepted work never pushed to GitHub goes to landing; the land job pushes it, lands it, and it is done', () => {
    const { hub, origin, git, clone, op, build, push, rebase, item } = remote();
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const job = op('a1', 'next');
    const mac = clone('mac');
    build(mac, job.branch, 'thing');
    op('a1', 'submit', { item: '#1', headline: 'Done' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'landing', "the mirror lacks the branch: that isn't done, it isn't on main");
    assert.equal(item(1).branch, 'nuworq/1-thing');
    assert.match(hub.q(`SELECT summary FROM events WHERE type = 'accepted'`).get().summary, /can't see it on origin yet, so the lander pushes it first/);
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'landed'`).get().n, 0);

    const land = op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /^Push it first: git push origin nuworq\/1-thing \(/);
    assert.doesNotMatch(land.hint, /&&|push -u|push origin -u/, 'one git command at a time; plain git push origin');
    push(mac, job.branch);
    const notYet = (() => { try { op('a1', 'submit', { item: '#1', headline: 'Landed' }); } catch (e) { return e; } })();
    assert.match(notYet.message, /main doesn't contain nuworq\/1-thing yet/);
    assert.match(notYet.hint, /^Land #1: put nuworq\/1-thing on main on origin/, 'the hub sees it now: no push first');
    rebase(mac, job.branch);
    push(mac, `${job.branch}:main`);
    push(mac, job.branch, '--force-with-lease');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
    assert.equal(git(origin, 'rev-parse', 'main'), git(mac, 'rev-parse', job.branch));
  });

  test("with the remote unreachable, accepted work with a branch waits in landing; the hub says why once", () => {
    const { hub, clone, op, build, item } = remote({ reachable: false });
    const errors = mock.method(console, 'error', () => {});
    try {
      hub.humanOp('demo', 'create', { title: 'One', acceptance: 'x' });
      hub.humanOp('demo', 'create', { title: 'Two', acceptance: 'x' });
      const job = op('a1', 'next');
      assert.match(job.hint, /git switch -c nuworq\/1-one origin\/main/, 'agents still work through origin');
      build(clone('mac'), job.branch, 'one');
      const r = op('a1', 'submit', { item: '#1', headline: 'Done' });
      assert.doesNotMatch(r.hint, /isn't on origin/, "no warning when the hub can't look");
      hub.humanOp('demo', 'accept', { item: '#1' });
      assert.equal(item(1).stage, 'landing', "git can't say main has it, so it isn't done");

      const land = op('a1', 'next');
      assert.equal(land.mode, 'land');
      assert.match(land.hint, /^Push it first: git push origin nuworq\/1-one /);
      const refused = (() => { try { op('a1', 'submit', { item: '#1', headline: 'Landed' }); } catch (e) { return e; } })();
      assert.match(refused.message, /The hub can't see nuworq\/1-one in .*gone/);
      assert.match(refused.hint, /Push it \(git push origin nuworq\/1-one --force-with-lease\) and submit again/);
      assert.equal(item(1).stage, 'landing');

      // No branch at all: nothing for git to check, so accepted is done, as before.
      op('a2', 'checkin');
      op('a2', 'next');
      hub.q(`UPDATE items SET branch = '' WHERE seq = 2`).run();
      op('a2', 'submit', { item: '#2', headline: 'Done' });
      hub.humanOp('demo', 'accept', { item: '#2' });
      assert.equal(item(2).stage, 'done');

      const said = errors.mock.calls.map((c) => String(c.arguments[0]));
      assert.equal(said.length, 1, 'logged once per project');
      assert.match(said[0], /can't read .*gone for demo .* accepted work there waits in landing/);
    } finally {
      errors.mock.restore();
    }
  });

  test('where the mirror comes from: GitHub over SSH, a path as it is, nothing outside the folder', () => {
    assert.equal(mirrorSource('github.com/acme/api'), 'git@github.com:acme/api.git');
    assert.equal(mirrorSource('/srv/git/Api'), '/srv/git/Api');
    assert.equal(mirrorSource('github.com/../etc'), null);
    assert.equal(mirrorSource('-oProxyCommand=x/a/b'), null);
    assert.equal(mirrorPath('/data/repos', 'github.com/acme/api'), '/data/repos/github.com/acme/api.git');
    assert.equal(mirrorPath('/data/repos', '/srv/../etc'), null);
  });

  test('a deploy key per repository: <keys>/<host>/<owner>/<repo>, used only when that file is there', () => {
    const keys = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-keys-')));
    assert.equal(sshCommandFor(keys, 'github.com/acme/api'), null, 'no key file: the default key, as before');
    mkdirSync(join(keys, 'github.com', 'acme', 'folder'), { recursive: true });
    writeFileSync(join(keys, 'github.com', 'acme', 'api'), 'a private key\n', { mode: 0o600 });
    assert.equal(sshCommandFor(keys, 'github.com/acme/api'),
      `ssh -i '${keys}/github.com/acme/api' -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10`);
    assert.equal(sshCommandFor(keys, 'github.com/acme/web'), null, "one repository's key never fetches another");
    assert.equal(sshCommandFor(keys, 'github.com/acme/folder'), null, 'a folder is not a key');
    assert.equal(sshCommandFor(keys, 'github.com/acme/../acme/api'), null, 'no ".." in a segment');
    assert.equal(sshCommandFor(keys, '../keys/github.com/acme/api'), null);
    assert.equal(sshCommandFor(keys, 'github.com/acme/..'), null);
    assert.equal(sshCommandFor(keys, '/srv/git/api'), null, 'a path is read as it is, with no key');
    assert.equal(sshCommandFor(null, 'github.com/acme/api'), null, 'a hub without a keys folder');
    const odd = join(keys, "it's");
    mkdirSync(join(odd, 'github.com', 'acme'), { recursive: true });
    writeFileSync(join(odd, 'github.com', 'acme', 'api'), 'k\n');
    assert.match(sshCommandFor(odd, 'github.com/acme/api'), /^ssh -i '.*it'\\''s\/github\.com\/acme\/api' /, 'quoted for the shell git runs it in');
  });

  test("the mirror is cloned with the repository's key; a GIT_SSH_COMMAND set for the hub still wins", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-sshkey-')));
    const keys = join(dir, 'keys'), log = join(dir, 'ssh.log');
    mkdirSync(join(dir, 'bin'));
    // A stand-in ssh: records how it was called and refuses, so nothing goes over the network.
    writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/sh\necho "$@" >> '${log}'\nexit 255\n`, { mode: 0o755 });
    mkdirSync(join(keys, 'github.com', 'acme'), { recursive: true });
    writeFileSync(join(keys, 'github.com', 'acme', 'api'), 'a private key\n', { mode: 0o600 });
    const saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
    process.env.PATH = `${join(dir, 'bin')}:${process.env.PATH}`;
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH;
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
    try {
      assert.ok((await fetchMirror(join(dir, 'repos'), 'github.com/acme/api', { keys })).error);
      assert.match(calls(), new RegExp(`-i ${keys}/github\\.com/acme/api -o IdentitiesOnly=yes -o BatchMode=yes .*git@github\\.com`));
      writeFileSync(log, '');
      process.env.GIT_SSH_COMMAND = 'ssh -o Explicit=yes';
      assert.ok((await fetchMirror(join(dir, 'repos'), 'github.com/acme/api', { keys })).error);
      assert.match(calls(), /-o Explicit=yes/);
      assert.doesNotMatch(calls(), /-i /, 'the explicit command is used as it is');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});
