import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { createServer } from '../src/server.js';

const SECRET = 'a-long-shared-secret';
const sign = (raw, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

// Payloads shaped like GitHub's deliveries (trimmed to the fields nuworq reads, plus some it ignores).
const repository = { id: 1, full_name: 'paul/nuworq', html_url: 'https://github.com/paul/nuworq' };
const pr = (over = {}) => ({
  action: 'opened', number: 42, repository, sender: { login: 'paul' },
  pull_request: {
    number: 42, html_url: 'https://github.com/paul/nuworq/pull/42', state: 'open', merged: false, draft: false,
    title: 'Push notifications', body: 'Adds ntfy/Slack/webhook channels.', user: { login: 'paul' },
    head: { ref: 'nuworq/claude-1', sha: 'aaaaaaa1111111111111111111111111111111aa' }, base: { ref: 'main' },
    ...over,
  },
});
const checkRun = (name, conclusion, sha = 'aaaaaaa1111111111111111111111111111111aa') => ({
  action: 'completed', repository,
  check_run: { name, head_sha: sha, status: 'completed', conclusion, html_url: `https://github.com/paul/nuworq/runs/${name}`, app: { name: 'GitHub Actions' } },
});

let hub, server, base;
const deliver = async (event, payload, { secret = SECRET, signature, project = 'app' } = {}) => {
  const raw = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', 'x-github-event': event, 'user-agent': 'GitHub-Hookshot/abc' };
  if (signature !== null) headers['x-hub-signature-256'] = signature ?? sign(raw, secret);
  const r = await fetch(`${base}/api/hooks/github/${project}`, { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json() };
};
const events = (type) => itemView(hub, 'app', '#1').events.filter((e) => e.type === type);

before(async () => {
  hub = new Hub();
  const op = (o, agent, args = {}) => hub.agentOp('app', o, agent, args);
  op('checkin', 'claude-1');
  hub.humanOp('app', 'create', { title: 'Push notifications', acceptance: 'it pushes' });
  hub.humanOp('app', 'create', { title: 'Something else', acceptance: 'x' });
  op('next', 'claude-1');
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

describe('GitHub webhooks', () => {
  test('without a secret set, or with a missing or wrong signature, deliveries get 401 and nothing is recorded', async () => {
    assert.equal((await deliver('pull_request', pr())).status, 401, 'no secret set yet');
    hub.humanOp('app', 'settings', { github_secret: SECRET });
    assert.equal(view(hub, 'app').project.github, true);
    assert.ok(!JSON.stringify(view(hub, 'app')).includes(SECRET), 'the secret is never shown back');
    const bad = await deliver('pull_request', pr(), { secret: 'wrong' });
    assert.equal(bad.status, 401);
    assert.ok(bad.body.hint);
    assert.equal((await deliver('pull_request', pr(), { signature: null })).status, 401);
    assert.equal((await deliver('pull_request', pr(), { project: 'nope' })).status, 401, 'unknown projects look the same');
    assert.equal(events('pr').length, 0);
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM prs').get().n, 0);
    assert.deepEqual((await deliver('ping', { zen: 'Keep it logically awesome.', hook_id: 1 })).body, { ok: true, pong: true });
  });

  test('a PR from nuworq/<agent> links to the item that agent holds, with its link and state on the record', async () => {
    const r = await deliver('pull_request', pr());
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, item: '#1', pr: 42, state: 'open' });
    const it = itemView(hub, 'app', '#1');
    assert.deepEqual(it.prs.map((x) => [x.number, x.state, x.url]), [[42, 'open', 'https://github.com/paul/nuworq/pull/42']]);
    assert.match(events('pr')[0].headline, /PR #42 opened: Push notifications/);
    // a push to the branch moves the head without adding to the record
    await deliver('pull_request', pr({ head: { ref: 'nuworq/claude-1', sha: 'bbbbbbb2222222222222222222222222222222bb' } }));
    await deliver('pull_request', pr());
    assert.equal(events('pr').length, 1);
  });

  test('"#N" in the title links a PR from any branch', async () => {
    const r = await deliver('pull_request', { ...pr(), number: 7, pull_request: { ...pr().pull_request, number: 7, html_url: 'https://github.com/paul/nuworq/pull/7', title: 'Fix the other thing (#2)', head: { ref: 'fix/other', sha: 'c'.repeat(40) } } });
    assert.equal(r.body.item, '#2');
    const none = await deliver('pull_request', { ...pr(), number: 8, pull_request: { ...pr().pull_request, number: 8, title: 'Unrelated', body: '', head: { ref: 'random', sha: 'd'.repeat(40) } } });
    assert.equal(none.body.untracked, true, 'no item tracks it: on record for a tidy job (#202)');
  });

  test('CI results show on the item; a failure on work in Verifying needs you', async () => {
    hub.agentOp('app', 'submit', 'claude-1', { item: '#1', headline: 'Pushes work' });
    assert.equal((await deliver('check_run', checkRun('test', 'success'))).body.ci, 'pass');
    assert.equal(itemView(hub, 'app', '#1').prs[0].ci, 'pass');
    assert.equal(view(hub, 'app').attention.find((a) => a.kind === 'ci-failing'), undefined);
    assert.equal((await deliver('check_run', checkRun('lint', 'failure'))).body.ci, 'fail');
    const card = view(hub, 'app').attention.find((a) => a.kind === 'ci-failing');
    assert.equal(card.level, 'act');
    assert.equal(card.item, '#1');
    assert.match(card.sub, /PR #42 · lint/);
    assert.equal(card.pr.checks[0].url, 'https://github.com/paul/nuworq/runs/lint');
    assert.deepEqual(events('ci').map((e) => e.headline), ['CI passed on PR #42', 'CI failed on PR #42: lint']);
    // fixed: the card goes away, and the record says so once
    await deliver('check_run', checkRun('lint', 'success'));
    assert.equal(view(hub, 'app').attention.find((a) => a.kind === 'ci-failing'), undefined);
    assert.equal(events('ci').length, 3);
  });

  test('check suites and commit statuses count too; pending and unknown commits are ignored', async () => {
    const sha = 'aaaaaaa1111111111111111111111111111111aa';
    const suite = { action: 'completed', repository, check_suite: { head_sha: sha, status: 'completed', conclusion: 'timed_out', app: { name: 'CircleCI' }, pull_requests: [{ number: 42 }] } };
    assert.equal((await deliver('check_suite', suite)).body.ci, 'fail');
    assert.equal((await deliver('status', { sha, state: 'pending', context: 'ci/jenkins', repository })).body.ignored, 'pending');
    await deliver('check_suite', { ...suite, check_suite: { ...suite.check_suite, conclusion: 'success' } });
    assert.equal((await deliver('status', { sha, state: 'error', context: 'ci/jenkins', target_url: 'https://ci.test/1', repository })).body.ci, 'fail');
    assert.deepEqual(itemView(hub, 'app', '#1').prs[0].checks.map((c) => `${c.name}:${c.conclusion}`), ['CircleCI:success', 'ci/jenkins:error', 'lint:success', 'test:success']);
    assert.equal((await deliver('check_run', checkRun('test', 'failure', 'e'.repeat(40)))).body.ignored, 'no pull request for this commit');
    assert.equal((await deliver('issues', { action: 'opened', repository })).body.ignored, 'no issue');
  });

  test('deliveries get through a tunnel to a loopback hub, and to a hub that requires login, with no token', async () => {
    const raw = JSON.stringify({ zen: 'hi' });
    const post = (port, host) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/hooks/github/app', method: 'POST',
        headers: { host, 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sign(raw) } }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end(raw);
    });
    assert.equal(await post(server.address().port, 'abc123.ngrok.app'), 200);
    const locked = createServer(hub, { auth: 'required' });
    await new Promise((r) => locked.listen(0, '127.0.0.1', r));
    try {
      assert.equal(await post(locked.address().port, 'nuworq.example.com'), 200);
    } finally {
      locked.close();
    }
  });

  test('merging or closing is recorded, and a closed PR no longer raises CI alarms', async () => {
    await deliver('pull_request', pr({ state: 'closed', merged: true }));
    const it = itemView(hub, 'app', '#1');
    assert.equal(it.prs[0].state, 'merged');
    assert.match(events('pr').at(-1).headline, /PR #42 merged/);
    await deliver('pull_request', pr({ state: 'closed', merged: false }));
    assert.equal(view(hub, 'app').attention.find((a) => a.kind === 'ci-failing'), undefined);
  });
});
