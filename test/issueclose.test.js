import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { GitHubApp } from '../src/ghapp.js';
import { takeIssue, closeLanded, PR_GRACE } from '../src/issues.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const issue = (number) => ({ number, title: `Issue ${number}`, body: '', state: 'open', labels: [], author_association: 'OWNER', html_url: `https://github.com/acme/api/issues/${number}` });

// GitHub's issues API for acme/api: each issue's state, and every call the hub makes. down: answer 500.
function github() {
  const state = { issues: new Map(), calls: [], down: false };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_issues', expires_at: '2026-10-29T13:00:00Z' });
    const m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)(\/comments)?$/);
    if (!m || req.headers.authorization !== 'Bearer ghs_issues') return json(404, { message: 'Not Found' });
    const n = Number(m[1]);
    state.calls.push({ method: req.method, number: n, ...(m[2] ? { comment: JSON.parse(raw).body } : {}), ...(req.method === 'PATCH' ? { body: JSON.parse(raw) } : {}) });
    if (state.down) return json(500, { message: 'Server Error' });
    if (req.method === 'GET') return json(200, { number: n, state: state.issues.get(n) ?? 'open' });
    if (req.method === 'POST' && m[2]) return json(201, { id: 5000 + state.calls.length });
    if (req.method === 'PATCH') { state.issues.set(n, JSON.parse(raw).state); return json(200, { number: n, state: JSON.parse(raw).state }); }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('an issue-linked item closes its GitHub issue when it lands', () => {
  let gh, app, hub, repo, now, git, p;
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const item = (n) => hub.item(p, `#${n}`);
  const row = (n) => ({ ...hub.q('SELECT state, close_error, landed_comment FROM issues WHERE number = ?').get(n) });
  const changes = () => gh.state.calls.filter((c) => c.method !== 'GET');

  beforeEach(async () => {
    gh = github();
    app = new GitHubApp({ id: 1, key: PEM, api: `http://127.0.0.1:${await listen(gh.server)}` });
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-issueclose-')));
    git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    now = Date.UTC(2026, 9, 29, 9);
    hub = new Hub({ clock: () => now });
    hub.publicUrl = 'https://hub.test';
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { path: repo });
    p = hub.project('demo');
    hub.addRemote(p, 'github.com/acme/api', 'you');
  });
  afterEach(() => { gh.server.close(); gh.server.closeAllConnections(); });

  // Issue #7 comes in as #1; an agent builds it, a human accepts it, and the agent fast-forwards main.
  const landLocally = () => {
    hub.tx(() => takeIssue(hub, p, 'github.com/acme/api', issue(7)));
    hub.humanOp('demo', 'update', { item: '#1', acceptance: 'works', stage: 'ready' });
    op('a1', 'checkin');
    const job = op('a1', 'next');
    const wt = `${repo}.worktrees/a1`;
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    git(wt, 'switch', '-q', '-c', job.branch, 'main');
    writeFileSync(join(wt, 'fix'), 'fix\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'fix');
    op('a1', 'submit', { item: '#1', headline: 'Fixed' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    git(repo, 'merge', '-q', '--ff-only', job.branch);
    op('a1', 'next');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
    return git(repo, 'rev-parse', '--short', 'main');
  };

  test('local landing: the hub closes the issue with one comment naming the item and the commit on main', async () => {
    const head = landLocally();
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 1 });
    assert.deepEqual(changes().map((c) => c.method), ['POST', 'PATCH']);
    assert.equal(changes()[0].number, 7);
    assert.match(changes()[0].comment, /\[#1\]\(https:\/\/hub\.test\/#\/p\/demo\/1\)/);
    assert.ok(changes()[0].comment.includes(head), `${changes()[0].comment} names ${head}`);
    assert.deepEqual(changes()[1].body, { state: 'closed', state_reason: 'completed' });
    assert.equal(row(7).state, 'closed');
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'issue' AND headline LIKE 'Closed %#1 landed'`).get());

    gh.state.calls = [];
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, [], 'closed once: nothing more to do');
  });

  test('pull request landing: the body says "Fixes #7", and an issue GitHub already closed gets no second close or comment', async () => {
    hub.tx(() => takeIssue(hub, p, 'github.com/acme/api', issue(7)));
    let body = '';
    hub.github = { covers: () => true, async openPr(a) { body = a.body; return { number: 9, url: 'https://github.com/acme/api/pull/9', node_id: 'PR_9', head_ref: a.head }; }, async autoMerge() {} };
    hub.patch(item(1), { stage: 'landing', branch: 'nuworq/1-issue-7' });
    hub.openPr(p, item(1));
    await hub.prsSettled();
    assert.match(body, /^Fixes #7$/m);

    // GitHub merges it and closes #7 itself; the merge marks the item done.
    hub.q(`UPDATE prs SET state = 'merged' WHERE number = 9`).run();
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    gh.state.issues.set(7, 'closed');
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, [], 'GitHub gets its moment to close it after the merge');
    now += PR_GRACE;
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls.map((c) => c.method), ['GET'], 'it looked, and left it');
    assert.equal(row(7).state, 'closed');
  });

  test('an item linked to two issues (a merged duplicate) closes both', async () => {
    hub.tx(() => { takeIssue(hub, p, 'github.com/acme/api', issue(7)); takeIssue(hub, p, 'github.com/acme/api', issue(8)); });
    // Shaping found #8 the same as #7: its link moved to #7's item.
    hub.q('UPDATE issues SET item_id = ? WHERE number = 8').run(item(1).id);
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 2 });
    assert.deepEqual(changes().filter((c) => c.method === 'PATCH').map((c) => c.number), [7, 8]);
    assert.equal(changes().filter((c) => c.method === 'POST').length, 2, 'one comment each');
  });

  test('while GitHub fails the item stays done, the failure is on the record once, and a later sweep closes it once', async () => {
    gh.state.down = true;
    landLocally();
    await closeLanded(hub, p, app);
    await closeLanded(hub, p, app);
    assert.equal(item(1).stage, 'done');
    assert.equal(row(7).state, 'open');
    assert.match(row(7).close_error, /500/);
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'issue_close_failed'`).get().n, 1, 'said once, not every sweep');

    gh.state.down = false;
    gh.state.calls = [];
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 1 });
    assert.deepEqual(changes().map((c) => c.method), ['POST', 'PATCH']);
    assert.deepEqual(row(7), { state: 'closed', close_error: '', landed_comment: row(7).landed_comment });
    gh.state.calls = [];
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, []);
  });

  test('a comment that went through is not posted again when the close fails', async () => {
    landLocally();
    const orig = gh.server.listeners('request')[0];
    gh.server.removeAllListeners('request');
    gh.server.on('request', (req, res) => (req.method === 'PATCH' ? (res.writeHead(502), res.end('{}')) : orig(req, res)));
    await closeLanded(hub, p, app);
    assert.equal(row(7).state, 'open');
    assert.ok(row(7).landed_comment);
    gh.server.removeAllListeners('request');
    gh.server.on('request', orig);
    gh.state.calls = [];
    await closeLanded(hub, p, app);
    assert.deepEqual(changes().map((c) => c.method), ['PATCH']);
  });

  test('items with no issue make no GitHub calls', async () => {
    hub.humanOp('demo', 'create', { title: 'Plain work', acceptance: 'x' });
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 0 });
    assert.deepEqual(gh.state.calls, []);
  });
});
