import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { claimedHashes, sameChange, mergesBase } from '../src/git.js';

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

  test('a peer reviewer sees the git facts in next and look, and the warning in the hint', () => {
    const { dir } = repo();
    const { hub, submit } = world(dir);
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    const { item } = submit('w1', { headline: 'done, committed as 9f3c2ab', evidence: [{ label: 'npm test: 5 passed' }] });
    const n = hub.agentOp('p', 'next', 'rev', {});
    assert.equal(n.mode, 'review');
    assert.equal(n.git.branch, 'nuworq/w1');
    assert.equal(n.git.base, 'main');
    assert.deepEqual(n.git.commits.map((c) => c.subject), ['change 2', 'change 1']);
    assert.deepEqual(n.git.missing, ['9f3c2ab']);
    assert.match(n.git_warning, /Evidence names commit 9f3c2ab, which isn't in the repo/);
    assert.match(n.hint, /Evidence names commit 9f3c2ab.*check it before you accept\. Review #/);
    const l = hub.agentOp('p', 'look', 'other', { item });
    assert.deepEqual(l.git, n.git);
    assert.equal(l.git_warning, n.git_warning);
  });

  test('without git facts, the review context is as before', () => {
    const { hub, submit } = world('');
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    const { item } = submit('w1', { evidence: [{ label: 'x' }] });
    const n = hub.agentOp('p', 'next', 'rev', {});
    assert.equal(n.mode, 'review');
    assert.equal(n.git, undefined);
    assert.equal(n.git_warning, undefined);
    assert.doesNotMatch(n.hint, /check it before you accept/);
    assert.equal(hub.agentOp('p', 'look', 'other', { item }).git, undefined);
  });

  test('only plausible commit claims are checked', () => {
    assert.deepEqual(claimedHashes({ evidence: [{ label: 'npm test: 1234567 assertions' }, { label: 'commit d58e260' }] }), ['d58e260']);
    assert.deepEqual(claimedHashes({ headline: 'acceded to the request', summary: 'committed as 5fc2e1c; deadbeef elsewhere' }), ['5fc2e1c']);
  });
});

// Whether a moved head is the reviewed change (#605, #784): the lines it removes and adds per file, not their context.
describe('sameChange', () => {
  function history() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-same-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (files) => { for (const [f, s] of Object.entries(files)) writeFileSync(join(dir, f), s); g('add', '-A'); };
    const keys = (...k) => `export const NEW = {\n${['old', ...k].map((x) => `  ${x}: '2026-11-01',\n`).join('')}};\n`;
    const doc = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
    const bin = (b) => Buffer.from([0, 1, 2, 3, 0, b]);
    g('init', '-q', '-b', 'main');
    write({ 'new.js': keys(), 'doc.txt': doc, 'img.bin': bin(255) });
    g('commit', '-qm', 'init');
    // The reviewed change: a key after old's, a rename with an edit, a binary change.
    const work = (more = {}) => {
      g('mv', 'doc.txt', 'docs.txt');
      write({ 'new.js': keys('mine'), 'docs.txt': `${doc}line 20\n`, 'img.bin': bin(254), ...more });
      g('commit', '-qm', 'work');
      return g('rev-parse', 'HEAD');
    };
    g('switch', '-qc', 'work');
    const reviewed = work();
    // Main adds its own key right beside it.
    g('switch', '-q', 'main');
    write({ 'new.js': keys('theirs') });
    g('commit', '-qm', 'theirs');
    // The change made again on top of parent, with new.js as given and anything more.
    const on = (parent, resolved, more = {}) => { g('switch', '-q', '--detach', parent); return work({ 'new.js': resolved, ...more }); };
    // from merged into into; a conflict resolved with new.js as given.
    const merged = (resolved, into = reviewed, from = 'main') => {
      g('switch', '-q', '--detach', into);
      try { g('merge', '-q', '--no-edit', from); } catch {
        write({ 'new.js': resolved });
        g('commit', '-q', '--no-edit');
      }
      return g('rev-parse', 'HEAD');
    };
    return { dir, g, keys, write, bin, reviewed, on, merged };
  }

  test('a rebase across main editing beside the change is the same change', () => {
    const h = history();
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'))), true);
  });

  test('a merge of main, resolved by keeping both sides, is the same change, and merges main', () => {
    const h = history();
    const m = h.merged(h.keys('theirs', 'mine'));
    assert.equal(sameChange(h.dir, 'main', h.reviewed, m), true);
    assert.equal(mergesBase(h.dir, 'main', m), true);
    assert.equal(mergesBase(h.dir, 'main', h.reviewed), false, 'not a merge');
  });

  test('a clean merge of main is the same change', () => {
    const h = history();
    const rebased = h.on('main', h.keys('theirs', 'mine'));
    h.g('switch', '-q', 'main');
    h.write({ 'other.txt': 'x\n' });
    h.g('commit', '-qm', 'other');
    const m = h.merged('', rebased);
    assert.equal(mergesBase(h.dir, 'main', m), true);
    assert.equal(sameChange(h.dir, 'main', rebased, m), true);
  });

  test('a resolution that alters or drops one of its lines, or adds one, is not', () => {
    const h = history();
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.merged(h.keys('theirs', 'mine2'))), false, 'altered');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.merged(h.keys('theirs'))), false, 'dropped');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine', 'extra'))), false, 'added');
  });

  test('the same lines in another file, an extra file, another binary or another rename are not', () => {
    const h = history();
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs'), { 'new2.js': `  mine: '2026-11-01',\n` })), false, 'another file');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'), { 'extra.js': 'x\n' })), false, 'extra file');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'), { 'img.bin': h.bin(253) })), false, 'binary');
    h.on('main', h.keys('theirs', 'mine'));
    h.g('mv', 'docs.txt', 'doc2.txt');
    h.g('commit', '-qm', 'renamed elsewhere');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.g('rev-parse', 'HEAD')), false, 'rename');
  });

  test('a reviewed change whose hunks moved within a file goes back to review (#806)', () => {
    const h = history();
    const doc = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join('');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'), { 'docs.txt': `line 20\n${doc}` })), false, 'added line moved to the top');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('mine', 'theirs'))), true, "either side of main's key at the same spot");
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', `export const NEW = {\n  mine: '2026-11-01',\n  old: '2026-11-01',\n  theirs: '2026-11-01',\n};\n`)), false, 'key moved above old');
    // Main adds a line above the change in the same file: the change's line moves down with it, and nowhere else.
    h.g('switch', '-q', 'main');
    h.write({ 'doc.txt': `top\n${doc}` });
    h.g('commit', '-qm', 'top');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'), { 'docs.txt': `top\n${doc}line 20\n` })), true, 'shifted by main');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, h.on('main', h.keys('theirs', 'mine'), { 'docs.txt': `top\nline 20\n${doc}` })), false, 'moved under main');
  });

  test('a removed line taken from another place with the same text is not the same change (#806)', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-same-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const commit = (s, m) => { writeFileSync(join(dir, 'a.js'), s); g('add', '-A'); g('commit', '-qm', m); return g('rev-parse', 'HEAD'); };
    const fn = (name, guard = true) => `function ${name}() {\n${guard ? '  check();\n' : ''}  run();\n}\n`;
    g('init', '-q', '-b', 'main');
    commit(fn('a') + fn('b'), 'init');
    g('switch', '-qc', 'work');
    const reviewed = commit(fn('a', false) + fn('b'), 'drop a guard');
    g('switch', '-q', 'main');
    commit(`// top\n${fn('a')}${fn('b')}`, 'main');
    g('switch', '-q', '--detach', 'main');
    const same = commit(`// top\n${fn('a', false)}${fn('b')}`, 'rebased');
    g('switch', '-q', '--detach', 'main');
    const other = commit(`// top\n${fn('a')}${fn('b', false)}`, 'the other guard');
    assert.equal(sameChange(dir, 'main', reviewed, same), true);
    assert.equal(sameChange(dir, 'main', reviewed, other), false);
  });

  test("a merge of a main the hub's copy doesn't have yet is not", () => {
    const h = history();
    // Upstream main moved on past the copy's main.
    h.g('switch', '-qc', 'upstream', 'main');
    h.write({ 'later.txt': 'later\n' });
    h.g('commit', '-qm', 'later');
    const m = h.merged(h.keys('theirs', 'mine'), h.reviewed, 'upstream');
    assert.equal(sameChange(h.dir, 'main', h.reviewed, m), false);
    assert.equal(sameChange(h.dir, 'upstream', h.reviewed, m), true, 'once the copy has it');
  });
});
