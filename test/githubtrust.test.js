// GitHub events count only from those entitled to send them (#478): a stranger's fork PR changes nothing, CI
// counts only on the item's own branch, and a delivery is acted on once.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const SECRET = 'another-long-shared-secret';
const repository = { id: 1, full_name: 'paul/nuworq' };
const BRANCH = 'nuworq/1-ship-it';

let hub, server, base;
const deliver = async (event, payload, delivery) => {
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') };
  if (delivery) headers['x-github-delivery'] = delivery;
  return (await fetch(`${base}/api/hooks/github/app`, { method: 'POST', headers, body: raw })).json();
};
const pr = (number, { title = `Ship it #1`, ref = BRANCH, sha = String(number).repeat(40).slice(0, 40), state = 'open', fork = null } = {}) => ({
  action: state === 'open' ? 'opened' : 'closed', number, repository,
  pull_request: {
    number, title, state, merged: false, html_url: `https://github.com/paul/nuworq/pull/${number}`, body: '',
    head: { ref, sha, repo: { full_name: fork ?? 'paul/nuworq' } }, base: { ref: 'main', repo: { full_name: 'paul/nuworq' } },
  },
});
const failed = (sha) => ({ action: 'completed', repository, check_run: { name: 'test', head_sha: sha, status: 'completed', conclusion: 'failure' } });
const item = () => hub.q('SELECT * FROM items WHERE seq = 1').get();
const toLanding = () => hub.tx(() => hub.move(item(), 'landing', 'claude-1', { branch: BRANCH, holder: null }));

before(async () => {
  hub = new Hub();
  hub.agentOp('app', 'checkin', 'claude-1');
  hub.humanOp('app', 'create', { title: 'Ship it', acceptance: 'it ships' });
  hub.humanOp('app', 'settings', { github_secret: SECRET });
  toLanding();
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('GitHub events count only from those entitled to send them (#478)', () => {
  test("a stranger's fork PR titled \"#1\" never links or moves the item, opened, closed or failing", async () => {
    for (const fork of ['stranger/nuworq', null]) {
      const opened = await deliver('pull_request', pr(9, { fork: fork ?? 'x', ref: BRANCH }));
      assert.equal(opened.ignored, "a fork's pull request");
      const closed = pr(9, { state: 'closed', fork: fork ?? 'x' });
      if (!fork) closed.pull_request.head.repo = null; // a fork deleted since
      assert.equal((await deliver('pull_request', closed)).ignored, "a fork's pull request");
    }
    assert.equal((await deliver('check_run', failed('9'.repeat(40)))).ignored, 'no pull request for this commit');
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM prs').get().n, 0, 'never on record');
    assert.equal(item().stage, 'landing');
    assert.equal(item().rejections, 0);
  });

  test("CI and closing count only on the item's own branch", async () => {
    // A collaborator's PR on another branch that names #1: on record, but its failure and closing send nothing back.
    assert.equal((await deliver('pull_request', pr(10, { ref: 'fix/typo' }))).item, '#1');
    assert.equal((await deliver('check_run', failed(pr(10).pull_request.head.sha))).ci, 'fail');
    assert.equal(item().stage, 'landing');
    await deliver('pull_request', pr(10, { ref: 'fix/typo', state: 'closed' }));
    assert.equal(item().stage, 'landing');
    assert.equal(item().rejections, 0);
    // Its own branch's PR failing a check sends it back, as before.
    await deliver('pull_request', pr(11));
    await deliver('check_run', failed(pr(11).pull_request.head.sha));
    assert.equal(item().stage, 'ready');
    assert.equal(item().rejections, 1);
  });

  test('each delivery id is acted on once', async () => {
    toLanding();
    const before = item().rejections;
    const closing = pr(11, { state: 'closed' });
    hub.q(`UPDATE prs SET state = 'open' WHERE number = 11`).run();
    const first = await deliver('pull_request', closing, 'd-1');
    assert.equal(first.state, 'closed');
    assert.equal(item().stage, 'ready');
    toLanding();
    hub.q(`UPDATE prs SET state = 'open' WHERE number = 11`).run();
    assert.equal((await deliver('pull_request', closing, 'd-1')).ignored, 'a delivery already acted on');
    assert.equal(item().stage, 'landing', 'the replay changed nothing');
    assert.equal(item().rejections, before);
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM deliveries WHERE id = 'd-1'`).get().n, 1);
  });

  // #727: merging counted from any branch: a merged "Fix #1 typo" from fix/typo marked #1 done and deleted its branch.
  const merged = (number, opts) => { const e = pr(number, { ...opts, state: 'closed' }); e.pull_request.merged = true; return e; };
  test("only the item's own branch merging lands it", async () => {
    toLanding();
    assert.equal((await deliver('pull_request', merged(20, { ref: 'fix/typo', title: 'Fix #1 typo' }))).state, 'merged');
    assert.equal(item().stage, 'landing', 'another branch naming #1 merged: #1 still landing');
    assert.equal(item().branch, BRANCH, 'and its own branch kept');
    await deliver('pull_request', merged(21));
    assert.equal(item().stage, 'done', 'its own branch merged: done, as before');
  });

  test("a CI-failed item's pull request lands it while it's being fixed only from its own branch", async () => {
    const prMode = hub.prMode;
    hub.prMode = () => true; // the hub opened its PR with auto-merge on
    try {
      hub.tx(() => hub.move(item(), 'active', 'claude-1', { branch: BRANCH, holder: 'claude-1' }));
      await deliver('pull_request', pr(22, { ref: 'fix/other', title: 'Other #1' }));
      await deliver('pull_request', merged(22, { ref: 'fix/other', title: 'Other #1' }));
      assert.equal(item().stage, 'active', 'another branch merged: still with its builder');
      await deliver('pull_request', pr(23));
      await deliver('pull_request', merged(23));
      assert.equal(item().stage, 'done', 'its own branch merged once green: done');
    } finally { hub.prMode = prMode; }
  });
});
