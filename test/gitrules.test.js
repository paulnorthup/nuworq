import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { workerGitDenies, WORKER_GIT } from '../src/sandbox.js';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// A rule as Claude Code reads it: Bash(<text>), `*` any text (spaces included), a trailing `:*` "and anything".
const matches = (rule, cmd) => {
  const m = rule.match(/^Bash\((.*)\)$/);
  if (!m) return false;
  let text = m[1];
  const prefix = text.endsWith(':*');
  if (prefix) text = text.slice(0, -2);
  return new RegExp(`^${text.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${prefix ? '' : '$'}`).test(cmd);
};
// The worker's git allowlist (bin/nuworq.js), with landing in the checkout too.
const HOME = '/work/api';
const ALLOW = [...WORKER_GIT.map((c) => `Bash(${c}:*)`), `Bash(git -C ${HOME} merge --ff-only:*)`];
const DENY = workerGitDenies({ home: HOME });
const runs = (cmd) => ALLOW.some((r) => matches(r, cmd)) && !DENY.some((r) => matches(r, cmd));

describe('worker allowlist refuses git options that run a program (#625)', () => {
  test('its everyday git still runs', () => {
    for (const cmd of ['git status', 'git diff origin/main --stat', 'git log --oneline -5', 'git add src/a.js', 'git commit -m "Fix it"',
      'git switch -c nuworq/12-x origin/main', 'git switch --no-track -c nuworq/12-x origin/main', 'git rebase origin/main', 'git rebase --continue', 'git fetch origin', 'git fetch -q origin main',
      'git rm src/a.js', 'git rm -r old', 'git rm --cached src/a.js', 'git rm -f -- test/a.test.js', 'git rm src/a.js test/a.test.js',
      'git push origin nuworq/12-x', 'git push origin nuworq/12-x --force-with-lease', `git -C ${HOME} merge --ff-only nuworq/12-x`]) {
      assert.ok(runs(cmd), cmd);
    }
  });

  test('an option that runs a program or writes a file is refused, wherever it sits', () => {
    for (const cmd of [
      'git fetch --upload-pack="sh -c id" origin', 'git fetch origin --upload-pack=touch',
      'git push origin x --receive-pack=evil', 'git push origin --exec=evil x',
      'git rebase --exec "curl x" origin/main', 'git rebase origin/main -x make', 'git rebase -i origin/main', 'git rebase origin/main --interactive',
      'git rebase --edit-todo', 'git rebase -s ours origin/main', 'git rebase --strategy=evil origin/main', 'git rebase -kx sh origin/main',
      'git diff --ext-diff', 'git log --textconv -p', 'git diff --output=/tmp/x', 'git log -p --output=../hooks/x',
      'git rm ../x', 'git rm /etc/hosts', 'git rm src/a.js /etc/hosts', 'git rm -r ../..', 'git rm ~/x', 'git rm src/../../x', 'git rm $HOME/x',
      'git rm --cached ../x', 'git rm -r /', 'git rm "/etc/hosts"', "git rm '/etc/hosts'", "git rm a.js '~/x'", 'git rm -r "~"','git rm --pathspec-from-file=/etc/passwd', 'git rm --pathspec-from-file /etc/passwd',
      `git -C ${HOME} merge --ff-only -s evil x`, `git -C ${HOME} merge --ff-only --strategy=evil x`,
    ]) assert.ok(!runs(cmd), cmd);
  });

  test('the worker gets them in its settings, whatever its allowlist', async () => {
    const { readFileSync } = await import('node:fs');
    const bin = readFileSync(new URL('../bin/nuworq.js', import.meta.url), 'utf8');
    assert.match(bin, /const deny = sandbox && \[\.\.\.files\.deny, \.\.\.workerGitDenies\(\{ home: sandbox\.landsHere \? sandbox\.home : null \}\)\];/);
    assert.match(bin, /permissions: own \? \{ deny \} : \{ \.\.\.files, deny \}/, 'with --allow too');
  });
});

describe('a worker may git rm a tracked file in its own worktree (#796)', () => {
  test('under the settings nuworq worker gives it, git rm stages the deletion; paths outside are refused', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-rm-')));
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'old'));
    for (const f of ['a.js', 'b.js', 'old/c.js']) writeFileSync(join(repo, f), 'x');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'init');
    const hub = new Hub();
    hub.tx(() => hub.project('rm', { create: true }));
    hub.humanOp('rm', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let stdout;
    try {
      ({ stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'rm', '--agent', 'claude', '--as', 'c-rm'],
        { env: { ...process.env, NUWORQ_TOKEN: '' } }));
    } finally {
      server.close();
    }
    // Its allow and deny rules, as Claude Code gets them.
    const allow = stdout.match(/--allowedTools '([^']*)'/)[1].split(',');
    // Shell-quoted: the rules for '/ and '~ carry a ', written '\''.
    const { permissions } = JSON.parse(stdout.match(/--settings '((?:[^']|'\\'')*)'/)[1].replaceAll("'\\''", "'"));
    const may = (cmd) => allow.some((r) => matches(r, cmd)) && !permissions.deny.some((r) => matches(r, cmd));
    const wt = join(`${repo}.worktrees`, 'c-rm');
    g(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');

    for (const [cmd, gone] of [['git rm a.js', 'a.js'], ['git rm -r old', 'old/c.js'], ['git rm --cached b.js', 'b.js']]) {
      assert.ok(may(cmd), cmd);
      g(wt, ...cmd.split(' ').slice(1));
      assert.match(g(wt, 'diff', '--cached', '--name-status'), new RegExp(`^D\\t${gone}$`, 'm'), cmd);
    }
    // Outside the worktree, quoted or not: refused by the rules, whatever git would make of it.
    for (const cmd of ['git rm ../x', 'git rm /etc/hosts', 'git rm "/etc/hosts"', "git rm '/etc/hosts'", 'git rm -r "~/x"', "git rm a.js '/etc/hosts'", 'git rm -- "../x"']) {
      assert.ok(!may(cmd), cmd);
    }
    // And git itself keeps to the repository: it deletes nothing outside it.
    assert.throws(() => g(wt, 'rm', '-q', join(repo, '..', 'elsewhere')), /outside repository/);
  });
});
