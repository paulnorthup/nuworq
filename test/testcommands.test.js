import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../src/core.js';
import { PROJECT_KINDS, allows, projectCommands, testsLine } from '../src/sandbox.js';

// Runner workers stalled on approval for `node --test` (#789): every hint and the worker's prompt name the test
// command the sandbox allows, from the same list its allowlist comes from, or say to ask the operator.
const checkout = (files) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-tests-')));
  for (const [f, body] of Object.entries(files)) writeFileSync(join(home, f), body);
  return home;
};
const has = (home) => (f) => existsSync(join(home, f));
// The commands a hint's tests line names, and that line.
const named = (hint) => {
  const line = /Run tests with (.*?): the runner's sandbox/.exec(hint)?.[1];
  assert.ok(line, hint);
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
};

describe('workers are told the test command the sandbox allows (#789)', () => {
  test('each kind of project: every command named is in its allowlist, and Node says npm test -- ', () => {
    const marks = { 'package.json': '{"scripts":{"test":"node --test"}}', 'pyproject.toml': '', 'Cargo.toml': '', 'go.mod': '' };
    for (const [f, body] of Object.entries(marks)) {
      const home = checkout({ [f]: body });
      const cmds = named(testsLine(has(home)));
      assert.ok(cmds.length >= 2, f);
      for (const c of cmds) assert.ok(allows(projectCommands(home), c), `${f}: ${c} isn't allowed`);
    }
    const node = testsLine(has(checkout({ 'package.json': '{}' })));
    assert.match(node, /`npm test -- test\/<file>\.test\.js`/);
    assert.match(node, /not `node --test`, which stalls on approval/);
    assert.equal(PROJECT_KINDS.length, 4);
  });

  test('a command a person added counts, and none at all says to ask the operator', () => {
    assert.deepEqual(named(testsLine(() => false, ['make test', 'npm run e2e'])), ['make test', 'npm run e2e']);
    const none = testsLine(() => false, []);
    assert.match(none, /no test command a worker may run without approval/);
    assert.match(none, /Ask to: "operator" to run the tests/);
    assert.doesNotMatch(none, /`/, 'names no command to stall on');
  });

  test('allows reads a rule as the sandbox does: a prefix with arguments, or an exact command', () => {
    const allow = ['Bash(npm test:*)', 'Bash(npm ci)'];
    assert.ok(allows(allow, 'npm test') && allows(allow, 'npm test -- test/a.test.js') && allows(allow, 'npm ci'));
    assert.ok(!allows(allow, 'npm testx') && !allows(allow, 'npm ci --foo') && !allows(allow, 'node --test'));
  });

  test("the hub's work, land and review hints name them, read from the project's checkout", () => {
    const hub = new Hub();
    const node = checkout({ 'package.json': '{"scripts":{"test":"node --test"}}' });
    const bare = checkout({ README: 'docs\n' });
    for (const [slug, home] of [['api', node], ['docs', bare]]) {
      const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', home, ...a], { stdio: 'ignore' });
      git('init', '-q', '-b', 'main');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      hub.tx(() => hub.project(slug, { create: true }));
      hub.humanOp(slug, 'settings', { path: home });
      hub.humanOp(slug, 'create', { title: 'Exports retry', acceptance: '- retries 3 times', stage: 'ready' });
      hub.agentOp(slug, 'checkin', 'w1', {});
    }
    const work = hub.agentOp('api', 'next', 'w1', {}).hint;
    assert.match(work, /npm test -- /);
    for (const c of named(work)) assert.ok(allows(projectCommands(node), c), c);
    const p = hub.project('api'), item = hub.item(p, '#1');
    assert.match(hub.landHint(p, item), /3\. Run the project's checks and fix anything the rebase broke\. Run tests with `npm test`/);
    assert.match(hub.reviewHint(p, item, 'Review #1.'), /^Review #1\. Run tests with `npm test`/);
    // No test command it may run: ask the operator.
    assert.match(hub.agentOp('docs', 'next', 'w1', {}).hint, /no test command a worker may run without approval/);
  });
});
