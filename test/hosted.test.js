import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

// #31's own bar, over HTTP: on a fresh hosted hub a new organization goes from sign-in to an agent's item
// done well inside 10 minutes; and the same build, run locally, needs no login and no config at all.
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const cookie = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

// GitHub's sign-in, played by a local server that signs in whoever the test says.
function provider() {
  const codes = new Map(), tokens = new Map();
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method === 'POST' && req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const email = codes.get(new URLSearchParams(raw).get('code'));
      if (!email) return json(400, { error: 'bad_verification_code' });
      const t = randomBytes(8).toString('hex');
      tokens.set(t, email);
      return json(200, { access_token: t });
    }
    const email = tokens.get(String(req.headers.authorization ?? '').replace('Bearer ', ''));
    if (req.url === '/user/emails' && email) return json(200, [{ email, primary: true, verified: true }]);
    json(401, {});
  });
  return { server, approve: (email) => { const code = randomBytes(8).toString('hex'); codes.set(code, email); return code; } };
}

describe('hosted: a new organization, from sign-in to an agent finishing an item', () => {
  let p, spaces, server, port, origin;
  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-hosted-')) });
    server = createServer(spaces, { sweepMs: 3600_000, oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } } });
    port = await listen(server);
    origin = `http://127.0.0.1:${port}`;
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  const at = (link) => { const u = new URL(link, origin); return u.pathname + u.search; };

  test('sign in, create the organization and a project, connect a machine, and the agent gets an item done', async () => {
    const started = Date.now();
    const s = await request(port, 'GET', '/auth/github/start');
    const state = new URL(s.headers.location).searchParams.get('state');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${p.approve('dana@example.com')}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookie(s) } });
    const hubSession = cookie(await request(port, 'GET', at(cb.headers.location)));

    const made = await request(port, 'POST', '/api/orgs', { headers: { cookie: hubSession, origin }, body: { name: 'Acme' } });
    assert.equal(made.status, 200, made.text);
    const go = await request(port, 'GET', at(made.json.enter), { headers: { cookie: hubSession } });
    const acme = cookie(await request(port, 'GET', at(go.headers.location)));
    const owner = { cookie: acme, origin };

    const proj = await request(port, 'POST', '/w/acme/api/projects', { headers: owner, body: { name: 'api', mission: 'Never lose an order.', remotes: ['github.com/acme/api'] } });
    assert.equal(proj.status, 200, proj.text);

    // `nuworq connect acme`: the device login the owner approves in the browser.
    const d = (await request(port, 'POST', '/w/acme/api/device/start', { body: { machine: 'laptop' } })).json;
    assert.equal((await request(port, 'POST', '/w/acme/api/device/approve', { headers: owner, body: { user_code: d.user_code, approve: true } })).status, 200);
    const { token } = (await request(port, 'POST', '/w/acme/api/device/poll', { body: { device_code: d.device_code } })).json;
    const agent = (op, body) => request(port, 'POST', `/w/acme/api/p/api/agent/${op}`, { headers: { authorization: `Bearer ${token}` }, body: { agent: 'w1', ...body } });

    // The agent's loop: checkin, propose work it noticed, claim it with next, submit with evidence.
    assert.equal((await agent('checkin', { has: ['macos'] })).json.mission, 'Never lose an order.');
    const proposed = await agent('propose', { title: 'Orders survive a restart', acceptance: 'An order saved before a restart is there after it.' });
    assert.equal(proposed.status, 200, proposed.text);
    const job = (await agent('next')).json;
    assert.equal(job.mode, 'work', JSON.stringify(job));
    assert.equal(job.title, 'Orders survive a restart');
    const sub = await agent('submit', { item: job.item, headline: 'Orders are written before the reply', evidence: [{ label: 'npm test: 12 passed' }] });
    assert.equal(sub.status, 200, sub.text);

    // The owner verifies it; the item is finished.
    const ok = await request(port, 'POST', '/w/acme/api/p/api/human/accept', { headers: owner, body: { item: job.item } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await agent('look', { item: job.item })).json.stage, 'done');
    assert.ok(Date.now() - started < 10 * 60_000, 'inside 10 minutes');
  });
});

describe('local: the same build, with no login and no config', () => {
  let hub, server, port;
  before(async () => {
    hub = new Hub();
    server = createServer(hub, { sweepMs: 3600_000 });
    port = await listen(server);
  });
  after(() => { server.close(); server.closeAllConnections(); hub.close?.(); });

  test('a person on this machine makes a project and an agent finishes an item, with no token or cookie anywhere', async () => {
    const proj = await request(port, 'POST', '/api/projects', { headers: { origin: `http://127.0.0.1:${port}` }, body: { name: 'shop', mission: 'Sell things.' } });
    assert.equal(proj.status, 200, proj.text);
    const agent = (op, body) => request(port, 'POST', `/api/p/shop/agent/${op}`, { body: { agent: 'w1', ...body } });
    assert.equal((await agent('checkin')).json.project, 'shop');
    assert.equal((await agent('propose', { title: 'Checkout works', acceptance: 'A cart can be paid for.' })).status, 200);
    const job = (await agent('next')).json;
    assert.equal(job.mode, 'work', JSON.stringify(job));
    assert.equal((await agent('submit', { item: job.item, headline: 'Checkout pays', evidence: [{ label: 'tests pass' }] })).status, 200);
    const ok = await request(port, 'POST', '/api/p/shop/human/accept', { headers: { origin: `http://127.0.0.1:${port}` }, body: { item: job.item } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await agent('look', { item: job.item })).json.stage, 'done');
  });
});
