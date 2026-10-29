import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const SECRET = 'a-long-shared-secret';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const repository = { full_name: 'acme/api' };
const issue = (n) => ({ number: n, title: `Issue ${n}`, body: '', state: 'open', labels: [], html_url: `https://github.com/acme/api/issues/${n}` });

// GitHub, as far as this goes: a token, comments, and closing issues.
function github() {
  const state = { comments: [], closed: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    let m;
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_x', expires_at: '2026-10-29T13:00:00Z' });
    if (req.headers.authorization !== 'Bearer ghs_x') return json(401, {});
    if (req.method === 'POST' && (m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)\/comments$/))) {
      state.comments.push({ number: Number(m[1]), body: JSON.parse(raw).body });
      return json(201, { id: state.comments.length });
    }
    if (req.method === 'PATCH' && (m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)$/))) {
      state.closed.push({ number: Number(m[1]), ...JSON.parse(raw) });
      return json(200, { number: Number(m[1]), state: 'closed' });
    }
    json(404, {});
  });
  return { server, state };
}

describe('bulk shaping of an imported backlog', () => {
  let gh, hub, server, base;
  const deliver = async (event, payload) => {
    const raw = JSON.stringify(payload);
    await fetch(`${base}/api/hooks/github/app`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') }, body: raw });
  };
  const human = async (action, body) => (await fetch(`${base}/api/p/app/human/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const refine = (agent, args) => hub.agentOp('app', 'refine', agent, args);
  const staleQs = () => hub.q("SELECT * FROM questions WHERE asked_by = 'nuworq' AND question LIKE 'Close these %' ORDER BY id").all();
  const stage = (n) => hub.item(hub.project('app'), `#${n}`).stage;
  const staleComments = () => gh.state.comments.filter((c) => c.body.startsWith('Closed as stale'));

  beforeEach(async () => {
    gh = github();
    const api = `http://127.0.0.1:${await listen(gh.server)}`;
    hub = new Hub();
    hub.tx(() => hub.project('app', { create: true }));
    hub.addRemote(hub.project('app'), 'github.com/acme/api', 'you');
    hub.humanOp('app', 'settings', { github_secret: SECRET });
    server = createServer(hub, { githubApp: { id: 1, key: PEM, api } });
    base = `http://127.0.0.1:${await listen(server)}`;
    for (let n = 1; n <= 7; n++) await deliver('issues', { action: 'opened', issue: issue(n), repository });
    hub.humanOp('app', 'create', { title: 'Not from an issue', stage: 'proposed' }); // #8
  });
  const close = () => { server.close(); gh.server.close(); };

  test('five stale flags from different agents at different times are one question; "Close them all" closes all five', async () => {
    try {
      for (const [n, agent] of [[1, 'a1'], [2, 'a2'], [3, 'a3'], [4, 'a1'], [5, 'a4']]) refine(agent, { item: `#${n}`, stale: `no activity since 2023 (#${n})` });
      const qs = staleQs();
      assert.equal(qs.length, 1, 'one question, not five');
      assert.equal(qs[0].status, 'open');
      assert.equal(qs[0].question, 'Close these 5 stale issues?');
      for (let n = 1; n <= 5; n++) assert.match(qs[0].context, new RegExp(`acme/api#${n} \\(#${n}\\) Issue ${n}: no activity since 2023 \\(#${n}\\)`));
      assert.deepEqual(JSON.parse(qs[0].options), ['Close them all', 'Keep them all']);

      const r = await human('answer', { question: qs[0].id, answer: 'Close them all' });
      assert.deepEqual(r.github, { closed: 5 });
      assert.deepEqual(staleComments().map((c) => c.number), [1, 2, 3, 4, 5], 'one comment each');
      assert.match(staleComments()[0].body, /Closed as stale via nuworq: no activity since 2023 \(#1\)/);
      assert.deepEqual(gh.state.closed.map((c) => [c.number, c.state, c.state_reason]), [1, 2, 3, 4, 5].map((n) => [n, 'closed', 'not_planned']));
      for (let n = 1; n <= 5; n++) assert.equal(stage(n), 'dropped');
      assert.equal(stage(6), 'proposed');

      refine('a2', { item: '#6', stale: 'superseded' });
      assert.equal(staleQs().length, 2, 'a flag after the answer starts a new question');
      assert.equal(staleQs()[1].question, 'Close these 1 stale issues?');
    } finally { close(); }
  });

  test('"Keep them all" clears the flags and touches nothing on GitHub', async () => {
    try {
      refine('a1', { item: '#1', stale: 'old' });
      refine('a1', { item: '#2', stale: 'old' });
      const before = gh.state.comments.length;
      await human('answer', { question: staleQs()[0].id, answer: 'Keep them all' });
      assert.equal(gh.state.comments.length, before);
      assert.equal(gh.state.closed.length, 0);
      assert.equal(stage(1), 'proposed');
      assert.equal(hub.q("SELECT COUNT(*) AS n FROM issues WHERE stale != ''").get().n, 0);
    } finally { close(); }
  });

  test('duplicate_of moves the issue link to the target and drops the duplicate; no issue link → 400', async () => {
    try {
      const r = refine('a1', { item: '#3', duplicate_of: '#1' });
      assert.deepEqual(r.changed, ['duplicate of #1']);
      assert.equal(stage(3), 'dropped');
      assert.deepEqual(hub.q('SELECT number FROM issues WHERE item_id = ? ORDER BY number').all(hub.item(hub.project('app'), '#1').id).map((x) => x.number), [1, 3]);
      assert.equal(gh.state.closed.length, 0, 'nothing closes until the target lands');
      assert.throws(() => refine('a1', { item: '#8', stale: 'old' }), (e) => e.status === 400 && /didn't come from a GitHub issue/.test(e.message) && !!e.hint);
      assert.throws(() => refine('a1', { item: '#8', duplicate_of: '#1' }), /didn't come from a GitHub issue/);
    } finally { close(); }
  });
});
