import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const SECRET = 'a-long-shared-secret';
const sign = (raw) => 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

const repository = { full_name: 'acme/api', html_url: 'https://github.com/acme/api' };
const issue = (number, over = {}) => ({
  number, title: `Issue ${number}`, body: `Body of ${number}`, state: 'open', labels: [],
  html_url: `https://github.com/acme/api/issues/${number}`, ...over,
});

// GitHub's REST API, as far as intake uses it: the installation, a token, the open issues (with a PR
// among them, as GitHub lists them), and comments. Only an installation token may list and comment.
function github() {
  const state = { open: [issue(1), issue(2), issue(3), issue(4, { pull_request: { url: 'x' } })], comments: [], perms: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    const auth = String(req.headers.authorization ?? '');
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
      state.perms.push(JSON.parse(raw).permissions);
      return json(201, { token: 'ghs_intake', expires_at: '2026-10-29T13:00:00Z' });
    }
    if (auth !== 'Bearer ghs_intake') return json(401, { message: 'Bad credentials' });
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/repos\/acme\/api\/issues\?state=open&per_page=100&page=(\d+)$/))) {
      return json(200, m[1] === '1' ? state.open : []);
    }
    if (req.method === 'POST' && (m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)\/comments$/))) {
      state.comments.push({ number: Number(m[1]), body: JSON.parse(raw).body });
      return json(201, { id: 1000 + state.comments.length });
    }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('GitHub issues come in as proposals', () => {
  let gh, hub, server, base;
  const deliver = async (event, payload, { signed = true } = {}) => {
    const raw = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'x-github-event': event, ...(signed ? { 'x-hub-signature-256': sign(raw) } : {}) };
    const r = await fetch(`${base}/api/hooks/github/app`, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json() };
  };
  const items = () => hub.q("SELECT seq, title, stage, repo, created_by FROM items ORDER BY seq").all().map((i) => ({ ...i }));
  const linked = () => hub.q('SELECT number, item_id, state FROM issues ORDER BY number').all().map((i) => ({ ...i }));
  const install = () => deliver('installation', { action: 'created', installation: { id: 42 }, repositories: [{ full_name: 'acme/api' }, { full_name: 'acme/elsewhere' }] });

  beforeEach(async () => {
    gh = github();
    const api = `http://127.0.0.1:${await listen(gh.server)}`;
    hub = new Hub();
    hub.tx(() => hub.project('app', { create: true }));
    hub.addRemote(hub.project('app'), 'git@github.com:acme/api.git', 'you');
    hub.humanOp('app', 'settings', { github_secret: SECRET });
    server = createServer(hub, { githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api } });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  const close = () => { server.close(); gh.server.close(); };

  test('install: each open issue becomes one linked proposal and gets exactly one comment; syncing again adds nothing', async () => {
    try {
      const r = await install();
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.github, { issues: 3, commented: 3 });
      assert.deepEqual(items(), [1, 2, 3].map((n) => ({ seq: n, title: `Issue ${n}`, stage: 'proposed', repo: 'github.com/acme/api', created_by: 'github' })), 'the PR is not an issue');
      const look = hub.agentOp('app', 'look', 'a1', { item: '#2' });
      assert.equal(look.issue, 'https://github.com/acme/api/issues/2');
      assert.match(look.summary, /Body of 2[\s\S]*From https:\/\/github\.com\/acme\/api\/issues\/2/);
      assert.deepEqual(gh.state.comments.map((c) => c.number), [1, 2, 3]);
      assert.match(gh.state.comments[0].body, new RegExp(`\\[#1\\]\\(${base}/#/p/app/1\\)`));
      assert.deepEqual(gh.state.perms[0], { issues: 'write', metadata: 'read' }, 'a token that can only read issues and comment');

      await install();
      const re = await fetch(`${base}/api/p/app/github/resync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const { alerts, ...issues } = await re.json();
      assert.deepEqual(issues, { ok: true, issues: 3, commented: 0 });
      assert.equal(alerts.alerts, 0, 'this fake GitHub has no alerts to give');
      assert.equal(items().length, 3, 'no new items');
      assert.equal(gh.state.comments.length, 3, 'no new comments');
    } finally { close(); }
  });

  test('issues.opened comes in within the request; closed drops it, reopened brings the same item back', async () => {
    try {
      const opened = await deliver('issues', { action: 'opened', issue: issue(7), repository });
      assert.equal(opened.body.item, '#1');
      assert.equal(opened.body.created, true);
      assert.equal(items()[0].stage, 'proposed', 'there before the answer');
      assert.deepEqual(opened.body.github, { commented: 1 });

      const closed = await deliver('issues', { action: 'closed', issue: issue(7, { state: 'closed' }), repository });
      assert.equal(closed.body.dropped, true);
      assert.equal(items()[0].stage, 'dropped');
      assert.ok(hub.q("SELECT 1 FROM events WHERE type = 'issue' AND headline LIKE '%dropped: its issue was closed on GitHub'").get());

      await deliver('issues', { action: 'reopened', issue: issue(7), repository });
      assert.equal(items().length, 1, 'one item, not two');
      assert.equal(items()[0].stage, 'proposed');
      assert.equal(gh.state.comments.length, 1, 'still one comment');

      await deliver('issues', { action: 'edited', issue: issue(7, { title: 'Better title' }), repository });
      assert.equal(items()[0].title, 'Better title', 'a proposal follows its issue\'s title');
    } finally { close(); }
  });

  test('a label filter lets in only labelled issues; adding the label later brings one in', async () => {
    try {
      hub.humanOp('app', 'settings', { issue_label: 'nuworq' });
      gh.state.open = [issue(1, { labels: [{ name: 'nuworq' }] }), issue(2)];
      const r = await install();
      assert.equal(r.body.github.commented, 1);
      assert.deepEqual(linked().map((l) => l.number), [1]);
      const plain = await deliver('issues', { action: 'opened', issue: issue(5), repository });
      assert.equal(plain.body.ignored, 'no "nuworq" label');
      await deliver('issues', { action: 'labeled', issue: issue(5, { labels: [{ name: 'nuworq' }] }), label: { name: 'nuworq' }, repository });
      assert.deepEqual(linked().map((l) => l.number), [1, 5]);
    } finally { close(); }
  });

  test('closing the issue of work already under way only leaves a note', async () => {
    try {
      await deliver('issues', { action: 'opened', issue: issue(9), repository });
      hub.humanOp('app', 'update', { item: '#1', acceptance: 'works' });
      hub.agentOp('app', 'claim', 'a1', { item: '#1' });
      const r = await deliver('issues', { action: 'closed', issue: issue(9, { state: 'closed' }), repository });
      assert.equal(r.body.noted, true);
      assert.equal(items()[0].stage, 'active');
      assert.ok(hub.q("SELECT 1 FROM events WHERE type = 'issue' AND headline LIKE '%the work here goes on'").get());
    } finally { close(); }
  });

  test('an unsigned delivery records nothing', async () => {
    try {
      const r = await deliver('issues', { action: 'opened', issue: issue(3), repository }, { signed: false });
      assert.equal(r.status, 401);
      assert.equal(items().length, 0);
      assert.equal(linked().length, 0);
      assert.equal(gh.state.comments.length, 0);
    } finally { close(); }
  });
});
