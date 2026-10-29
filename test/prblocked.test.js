import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { Hub, normRemote } from '../src/core.js';
import { receive } from '../src/github.js';
import { view } from '../src/insight.js';

const SECRET = 'webhook-secret';
const SHA = 'abc1234def';

// A landing PR that gets stuck (#64), on top of #63's world: a bare repo plays GitHub's repository, a
// fake client opens PRs, and signed webhooks say what GitHub sees.
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-prblocked-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'github', 'acme', 'api.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const clone = (name) => { const dir = join(root, name); git(root, 'clone', '-q', origin, dir); return dir; };
  const seed = clone('seed');
  writeFileSync(join(seed, 'README'), 'api\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');

  const opened = [];
  const hub = new Hub({ repos: join(root, 'hub', 'repos') });
  hub.github = {
    covers: () => true,
    async openPr(args) { opened.push(args); return { number: 101, url: 'https://github.com/acme/api/pull/101', node_id: 'PR_101', head_ref: args.head, head_sha: SHA }; },
    async autoMerge() {},
  };
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'remote', { add: origin });
  hub.humanOp('demo', 'settings', { github_secret: SECRET });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const item = () => hub.item(hub.project('demo'), '#1');
  const events = (type) => hub.q('SELECT * FROM events WHERE item_id = ? AND type = ? ORDER BY id').all(item().id, type);
  const deliver = (event, body) => {
    const raw = Buffer.from(JSON.stringify({ repository: { full_name: normRemote(origin) }, ...body }));
    return receive(hub, 'demo', { event, raw, signature: 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') });
  };
  const pr = (over = {}) => ({ number: 101, title: 'x', state: 'open', merged: false, html_url: 'https://github.com/acme/api/pull/101', head: { ref: 'nuworq/1-add-it', sha: SHA }, base: { ref: 'main' }, ...over });

  // a1 builds #1, pushes it, submits; the human accepts; the hub opens its PR.
  const accepted = async () => {
    hub.humanOp('demo', 'create', { title: 'Add it', acceptance: 'x' });
    const j = op('a1', 'next');
    const dir = clone('mac');
    git(dir, 'switch', '-q', '-c', j.branch, 'origin/main');
    writeFileSync(join(dir, 'it.txt'), 'it\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'add it');
    git(dir, 'push', '-q', 'origin', j.branch);
    op('a1', 'submit', { item: '#1', headline: 'Added' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    await hub.prsSettled();
    assert.equal(opened.length, 1);
    return { ...j, dir };
  };
  // Someone else lands on main meanwhile, touching the same file: the PR now conflicts.
  const mainMoves = () => {
    writeFileSync(join(seed, 'it.txt'), 'theirs\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'theirs');
    git(seed, 'push', '-q', 'origin', 'main');
  };
  return { hub, git, op, item, events, deliver, pr, accepted, mainMoves, opened };
}

describe('a landing PR that cannot merge routes itself', () => {
  test('a conflict hands out a rebase land job; after the rebase the same PR merges and the item is done', async () => {
    const w = await (async () => { const x = world(); return { ...x, job: await x.accepted() }; })();
    assert.notEqual(w.op('a1', 'next').mode, 'land', 'an open, mergeable PR is no land job');
    w.mainMoves();
    w.deliver('pull_request', { action: 'synchronize', pull_request: w.pr({ mergeable_state: 'dirty' }) });
    w.deliver('pull_request', { action: 'edited', pull_request: w.pr({ mergeable_state: 'dirty' }) });
    assert.equal(w.events('pr_blocked').length, 1, 'the same state twice is one event');

    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /PR #101 for #1 conflicts with main/);
    assert.match(land.hint, /git rebase origin\/main/);
    assert.match(land.hint, /git push origin nuworq\/1-add-it --force-with-lease/);
    assert.throws(() => w.op('a1', 'submit', { item: '#1', headline: 'Rebased' }), /doesn't contain main yet/);

    w.git(w.job.dir, 'fetch', '-q', 'origin');
    try { w.git(w.job.dir, 'rebase', '-q', 'origin/main'); } catch {
      writeFileSync(join(w.job.dir, 'it.txt'), 'theirs\nit\n');
      w.git(w.job.dir, 'add', 'it.txt');
      w.git(w.job.dir, '-c', 'core.editor=true', 'rebase', '--continue');
    }
    w.git(w.job.dir, 'push', '-q', 'origin', w.job.branch, '--force-with-lease');
    const done = w.op('a1', 'submit', { item: '#1', headline: 'Rebased' });
    assert.match(done.hint, /PR #101 has the rebased branch/);
    assert.equal(w.opened.length, 1, 'no second PR');
    assert.notEqual(w.op('a2', 'next').mode, 'land', 'no land job once rebased');

    w.deliver('pull_request', { action: 'closed', pull_request: w.pr({ state: 'closed', merged: true, merge_commit_sha: 'fff' }) });
    assert.equal(w.item().stage, 'done');
  });

  test('a failing check sends it back to its builder with the check named; the fix merges through the same PR', async () => {
    const w = world();
    const job = await w.accepted();
    const run = (conclusion) => ({ action: 'completed', check_run: { name: 'test', head_sha: SHA, status: 'completed', conclusion, html_url: 'https://github.com/acme/api/runs/7' } });
    w.deliver('check_run', run('failure'));
    w.deliver('check_run', run('failure'));
    const it = w.item();
    assert.equal(it.stage, 'ready');
    assert.equal(it.last_worker, 'a1');
    const note = JSON.parse(it.handoff);
    assert.match(note.headline, /test failed on PR #101/);
    assert.match(note.summary, /test: failure \(https:\/\/github\.com\/acme\/api\/runs\/7\)/);
    assert.equal(w.events('sent_back').length, 1, 'a repeated failure is one send-back');

    const again = w.op('a1', 'next');
    assert.equal(again.item, '#1', 'its builder gets it back');
    writeFileSync(join(job.dir, 'fix.txt'), 'fix\n');
    w.git(job.dir, 'add', '.');
    w.git(job.dir, 'commit', '-q', '-m', 'fix');
    w.git(job.dir, 'push', '-q', 'origin', job.branch);
    w.op('a1', 'submit', { item: '#1', headline: 'Fixed' });
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.opened.length, 1, 'the same PR, not a new one');
    w.deliver('check_run', run('success'));
    w.deliver('pull_request', { action: 'closed', pull_request: w.pr({ state: 'closed', merged: true }) });
    assert.equal(w.item().stage, 'done');
  });

  test("a required approval is one \"needs you\" card with the PR link; the approval clears it", async () => {
    const w = world();
    await w.accepted();
    const cards = () => view(w.hub, 'demo').attention.filter((a) => a.kind === 'pr-review');
    w.deliver('pull_request', { action: 'synchronize', pull_request: w.pr({ mergeable_state: 'blocked' }) });
    w.deliver('pull_request', { action: 'edited', pull_request: w.pr({ mergeable_state: 'blocked' }) });
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].pr.url, 'https://github.com/acme/api/pull/101');
    assert.equal(cards()[0].level, 'act');
    assert.equal(w.events('pr_blocked').length, 1);
    assert.notEqual(w.op('a2', 'next').mode, 'land', 'waiting for a person is no agent job');

    w.deliver('pull_request_review', { action: 'submitted', review: { state: 'approved' }, pull_request: w.pr() });
    assert.equal(cards().length, 0);
    w.deliver('pull_request_review', { action: 'submitted', review: { state: 'approved' }, pull_request: w.pr() });
    assert.equal(w.events('pr_blocked').length, 2, 'blocked, then clear: nothing more');

    // review_decision says so too (GraphQL's field, when a delivery carries it).
    w.deliver('pull_request', { action: 'edited', pull_request: w.pr({ review_decision: 'REVIEW_REQUIRED' }) });
    assert.equal(cards().length, 1);
  });
});
