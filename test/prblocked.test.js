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
  test('a conflict hands out a rebase land job; the resolved rebase is reviewed again, then the same PR merges and the item is done', async () => {
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
    // Operators, who can't force-push, may merge main instead (#784).
    assert.match(land.hint, /Can't force-push \(operators\)\? Merge instead: .*git merge origin\/main .*git push origin nuworq\/1-add-it\. A merge of main that changes nothing else is the same change and lands without a new review/);
    assert.throws(() => w.op('a1', 'submit', { item: '#1', headline: 'Rebased' }), /doesn't contain main yet/);

    w.git(w.job.dir, 'fetch', '-q', 'origin');
    try { w.git(w.job.dir, 'rebase', '-q', 'origin/main'); } catch {
      writeFileSync(join(w.job.dir, 'it.txt'), 'theirs\nit\n');
      w.git(w.job.dir, 'add', 'it.txt');
      w.git(w.job.dir, '-c', 'core.editor=true', 'rebase', '--continue');
    }
    w.git(w.job.dir, 'push', '-q', 'origin', w.job.branch, '--force-with-lease');
    // Resolving the conflict changed what lands (#605): it isn't the change the review accepted, so it's reviewed again.
    const back = w.op('a1', 'submit', { item: '#1', headline: 'Rebased' });
    assert.match(back.hint, /isn't the head #1's review accepted, nor that change rebased, so it is verifying again/);
    assert.equal(w.item().stage, 'verifying');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.item().stage, 'landing');
    assert.equal(w.item().reviewed_sha, w.git(w.job.dir, 'rev-parse', 'HEAD'), 'the rebased head is the reviewed one now');
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
    // GitHub's order: the PR kept its auto-merge, so the fix merges as soon as it's green, while a1 still holds it.
    w.deliver('check_run', run('success'));
    w.deliver('pull_request', { action: 'closed', pull_request: w.pr({ state: 'closed', merged: true }) });
    const done = w.item();
    assert.equal(done.stage, 'done');
    assert.equal(done.holder, null, 'released');
    assert.equal(w.opened.length, 1, 'the same PR, not a new one');
    const landed = w.events('landed');
    assert.equal(landed.length, 1);
    assert.match(landed[0].summary, /It was active with a1: its pull request merged once its checks passed/);
  });

  test('after a fix, submitting and accepting before the merge still uses the same PR', async () => {
    const w = world();
    const job = await w.accepted();
    w.deliver('check_run', { action: 'completed', check_run: { name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' } });
    w.op('a1', 'next');
    writeFileSync(join(job.dir, 'fix.txt'), 'fix\n');
    w.git(job.dir, 'add', '.');
    w.git(job.dir, 'commit', '-q', '-m', 'fix');
    w.git(job.dir, 'push', '-q', 'origin', job.branch);
    w.op('a1', 'submit', { item: '#1', headline: 'Fixed' });
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.opened.length, 1, 'the same PR, not a new one');
    w.deliver('pull_request', { action: 'closed', pull_request: w.pr({ state: 'closed', merged: true }) });
    assert.equal(w.item().stage, 'done');
    assert.equal(w.events('landed').length, 1);
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

// #726: work a person takes back out of landing never merges on its own. GitHub, here, says the PR has auto-merge on
// until the hub turns it off, and records that it did.
describe('sending back or dropping a landing item turns its auto-merge off', () => {
  async function landing({ refuse = false } = {}) {
    const w = world();
    const job = await w.accepted();
    const gh = { auto: true, off: [] };
    Object.assign(w.hub.github, {
      async pull() { return { state: 'open', mergeable_state: 'blocked', auto_merge: gh.auto, base: 'main', head_sha: SHA, node_id: 'PR_101' }; },
      async disableAutoMerge(args) {
        if (refuse) throw new Error('Resource not accessible by integration');
        gh.off.push(args);
        gh.auto = false;
      },
    });
    const merged = () => w.deliver('pull_request', { action: 'closed', pull_request: w.pr({ state: 'closed', merged: true, merge_commit_sha: 'fff' }) });
    return { ...w, job, gh, merged };
  }
  const off = (w) => [{ repo: w.hub.repoOf(w.hub.project('demo'), w.item()), id: 'PR_101' }];

  test('a person sending it back turns auto-merge off, and a merge afterwards leaves it ready', async () => {
    const w = await landing();
    w.hub.humanOp('demo', 'sendback', { item: '#1', note: 'Not this way' });
    await w.hub.prsSettled();
    assert.equal(w.item().stage, 'ready');
    assert.deepEqual(w.gh.off, off(w));
    w.merged();
    assert.equal(w.item().stage, 'ready', 'someone merging by hand on GitHub is not the sent-back work done');
    assert.equal(w.events('landed').length, 0);
  });

  test('dropping it, or moving it back to ready, turns auto-merge off too', async () => {
    for (const stage of ['dropped', 'ready']) {
      const w = await landing();
      w.hub.humanOp('demo', 'update', { item: '#1', stage });
      await w.hub.prsSettled();
      assert.deepEqual(w.gh.off, off(w), stage);
      w.merged();
      assert.equal(w.item().stage, stage, `${stage}: a merge afterwards changes nothing`);
    }
  });

  // #827: a drop a person decided in an answer, carried out by refine with drop or by the hub for a parked item.
  test('a drop a person answered turns auto-merge off too: refine with drop, and "drop" to the question it is parked on', async () => {
    {
      const w = await landing();
      const { question } = w.op('a1', 'ask', { item: '#1', question: 'Is #1 still wanted?', assumption: 'yes' });
      w.hub.humanOp('demo', 'answer', { question, answer: 'Drop it' });
      assert.equal(w.op('a1', 'refine', { item: '#1', drop: question }).stage, 'dropped');
      await w.hub.prsSettled();
      assert.deepEqual(w.gh.off, off(w), 'refine with drop');
      w.merged();
      assert.equal(w.item().stage, 'dropped', 'a merge afterwards changes nothing');
    }
    {
      // CI sends it back to its builder with auto-merge kept on; the builder parks it on a question; a person says drop.
      const w = await landing();
      w.hub.humanOp('demo', 'settings', { autonomy: 'full' });
      w.deliver('check_run', { action: 'completed', check_run: { name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' } });
      await w.hub.prsSettled();
      w.op('a1', 'next');
      const { question } = w.op('a1', 'ask', { item: '#1', question: 'CI fails on a test #2 removes. Still wanted?', blocking: true });
      assert.equal(w.item().stage, 'waiting');
      assert.deepEqual(w.gh.off, []);
      w.hub.humanOp('demo', 'answer', { question, answer: 'Drop it' });
      assert.equal(w.item().stage, 'dropped');
      await w.hub.prsSettled();
      assert.deepEqual(w.gh.off, off(w), 'answering drop to the parked question');
    }
  });

  test("a reviewer rejecting the builder's CI fix turns auto-merge off; only CI's own send-back keeps it", async () => {
    const w = await landing();
    w.hub.humanOp('demo', 'settings', { autonomy: 'full' });
    w.deliver('check_run', { action: 'completed', check_run: { name: 'test', head_sha: SHA, status: 'completed', conclusion: 'failure' } });
    await w.hub.prsSettled();
    assert.deepEqual(w.gh.off, [], "CI's send-back keeps auto-merge: the fix merges once green");
    w.op('a1', 'next');
    w.op('a1', 'submit', { item: '#1', headline: 'Fixed' });
    w.op('r1', 'checkin');
    assert.equal(w.op('r1', 'next').mode, 'review');
    w.op('r1', 'review', { item: '#1', verdict: 'reject', headline: 'The fix hides the failure' });
    await w.hub.prsSettled();
    assert.deepEqual(w.gh.off, off(w));
    w.merged();
    assert.equal(w.item().stage, 'ready');
  });

  test('GitHub refusing to turn it off goes on the record with the PR link', async () => {
    const w = await landing({ refuse: true });
    w.hub.humanOp('demo', 'update', { item: '#1', stage: 'dropped' });
    await w.hub.prsSettled();
    const [e] = w.events('pr_merge_failed');
    assert.match(e.headline, /couldn't turn off auto-merge on PR #101 for #1: Resource not accessible/);
    assert.equal(e.summary, 'Turn it off on GitHub (https://github.com/acme/api/pull/101): #1 was dropped.');
  });
});
