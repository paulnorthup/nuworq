import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { workerGitDenies, WORKER_GIT } from '../src/sandbox.js';

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
