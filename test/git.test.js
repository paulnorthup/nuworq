import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { claimedHashes } from '../src/git.js';

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-git-')));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f'), '0');
  g('add', '.');
  g('commit', '-qm', 'init');
  g('branch', 'nuworq/idle'); // a worker that never committed
  g('checkout', '-q', '-b', 'nuworq/w1');
  for (const n of [1, 2]) {
    writeFileSync(join(dir, 'f'), String(n));
    g('commit', '-qam', `change ${n}`);
  }
  const head = g('rev-parse', '--short', 'HEAD');
  g('checkout', '-q', 'main');
  return { dir, head };
}

function world(path) {
  const hub = new Hub();
  hub.tx(() => hub.project('p', { create: true }));
  if (path) hub.humanOp('p', 'settings', { path });
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const submit = (agent, args) => {
    const { item } = hub.humanOp('p', 'create', { title: `work for ${agent}`, acceptance: 'x' });
    op(agent, 'claim', { item });
    return { item, r: op(agent, 'submit', { item, headline: 'done', ...args }) };
  };
  const git = () => JSON.parse(hub.q("SELECT data FROM events WHERE type = 'submitted' ORDER BY id DESC LIMIT 1").get().data).git;
  const card = (item) => view(hub, 'p').attention.find((a) => a.kind === 'review' && a.item === item);
  return { hub, submit, git, card };
}

describe('git facts on submit', () => {
  test("records the worker's branch and commits; real hashes raise nothing", () => {
    const { dir, head } = repo();
    const { submit, git, card } = world(dir);
    const { item, r } = submit('w1', { evidence: [{ label: `commit ${head} on nuworq/w1` }] });
    const g = git();
    assert.equal(g.branch, 'nuworq/w1');
    assert.equal(g.base, 'main');
    assert.deepEqual(g.commits.map((c) => c.subject), ['change 2', 'change 1']);
    assert.deepEqual(g.missing, []);
    assert.doesNotMatch(r.hint, /isn't in the repo|No commits/);
    assert.equal(card(item).warn, null);
    assert.equal(card(item).git.commits.length, 2);
  });

  test('evidence naming a commit that does not exist is flagged to agent and human', () => {
    const { dir } = repo();
    const { submit, card } = world(dir);
    const { item, r } = submit('w1', { headline: 'done, committed as 9f3c2ab', evidence: [{ label: 'npm test: 5 passed' }] });
    assert.match(r.hint, /Evidence names commit 9f3c2ab, which isn't in the repo/);
    assert.match(card(item).warn, /9f3c2ab/);
  });

  test('a worker branch with nothing ahead of main says so', () => {
    const { dir } = repo();
    const { submit, card } = world(dir);
    const { item, r } = submit('idle', { evidence: [{ label: 'looked at it' }] });
    assert.match(r.hint, /No commits on nuworq\/idle ahead of main/);
    assert.match(card(item).warn, /No commits on nuworq\/idle/);
  });

  test('no repo where the project lives: submit is exactly as before', () => {
    const { submit, git } = world(realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-norepo-'))));
    const { r } = submit('w1', { headline: 'committed as 9f3c2ab', evidence: [{ label: 'x' }] });
    assert.equal(git(), undefined);
    assert.doesNotMatch(r.hint, /repo|commits/);
    const none = world('');
    assert.equal(none.submit('w1', { evidence: [{ label: 'x' }] }).r.ok, true);
  });

  test('only plausible commit claims are checked', () => {
    assert.deepEqual(claimedHashes({ evidence: [{ label: 'npm test: 1234567 assertions' }, { label: 'commit d58e260' }] }), ['d58e260']);
    assert.deepEqual(claimedHashes({ headline: 'acceded to the request', summary: 'committed as 5fc2e1c; deadbeef elsewhere' }), ['5fc2e1c']);
  });
});
