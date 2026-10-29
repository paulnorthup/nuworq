import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

// #52, end to end over HTTP, as the browser and the CLI drive it: a newly signed-in person creates "acme",
// lands in it as owner, makes a project with two repositories, connects a machine with the command the hub
// shows, then creates "beta" and switches between the two from the header's list.
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

describe('a new person makes an organization, a project, connects a machine, and switches organizations', () => {
  let p, spaces, server, port, origin;
  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-orgflow-')) });
    server = createServer(spaces, { sweepMs: 3600_000, oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } } });
    port = await listen(server);
    origin = `http://127.0.0.1:${port}`;
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  // Follows a hub-relative or absolute link on this hub, keeping only its path.
  const at = (link) => { const u = new URL(link, origin); return u.pathname + u.search; };
  // One click on an organization in the switcher: its enter link, then the one-time ticket.
  const enter = async (hubSession, link) => {
    const r = await request(port, 'GET', at(link), { headers: { cookie: hubSession } });
    assert.equal(r.status, 302, r.text);
    return cookie(await request(port, 'GET', at(r.headers.location)));
  };

  test('end to end, with nothing set up but sign-in', async () => {
    const started = Date.now();
    // Sign in to the hub: start → GitHub → callback → finish.
    const s = await request(port, 'GET', '/auth/github/start');
    const state = new URL(s.headers.location).searchParams.get('state');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${p.approve('cleo@example.com')}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookie(s) } });
    const hubSession = cookie(await request(port, 'GET', at(cb.headers.location)));
    assert.deepEqual((await request(port, 'GET', '/api/me', { headers: { cookie: hubSession } })).json.orgs, [], 'a new person, in no organization yet');

    // Step 1: the name, its address checked as typed, then create.
    assert.equal((await request(port, 'GET', '/api/orgs/check?slug=acme', { headers: { cookie: hubSession } })).json.ok, true);
    const made = await request(port, 'POST', '/api/orgs', { headers: { cookie: hubSession, origin }, body: { name: 'Acme' } });
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json.workspace, 'acme');
    const acme = await enter(hubSession, made.json.enter);
    const who = await request(port, 'GET', '/w/acme/api/people/me', { headers: { cookie: acme } });
    assert.deepEqual(who.json, { person: '@cleo', role: 'owner' }, 'lands in it as its owner');

    // Step 2: the first project, with two repositories.
    const proj = await request(port, 'POST', '/w/acme/api/projects', { headers: { cookie: acme, origin }, body: { name: 'api', mission: 'Never lose an order.', remotes: ['github.com/acme/api', 'github.com/acme/web'] } });
    assert.equal(proj.status, 200, proj.text);
    assert.deepEqual(proj.json.remotes, ['github.com/acme/api', 'github.com/acme/web']);
    const board = await request(port, 'GET', '/w/acme/api/p/api/view', { headers: { cookie: acme } });
    assert.equal(board.status, 200, board.text);
    assert.equal(board.json.project.mission, 'Never lose an order.', "the org's board, with the project");
    assert.deepEqual(board.json.project.remotes, ['github.com/acme/api', 'github.com/acme/web'], 'and its repositories');

    // Step 3: the connect command names the organization's address; on another machine, its device login
    // (approved in the browser by the owner) gives an agent token that checks in to the project.
    const info = (await request(port, 'GET', '/w/acme/api/info', { headers: { cookie: acme } })).json;
    assert.equal(info.url, `${origin}/w/acme`);
    const hubUrl = at(info.url);
    const d = (await request(port, 'POST', `${hubUrl}/api/device/start`, { body: { machine: 'laptop' } })).json;
    const ok = await request(port, 'POST', `${hubUrl}/api/device/approve`, { headers: { cookie: acme, origin }, body: { user_code: d.user_code, approve: true } });
    assert.equal(ok.status, 200, ok.text);
    const got = (await request(port, 'POST', `${hubUrl}/api/device/poll`, { body: { device_code: d.device_code } })).json;
    assert.equal(got.status, 'approved');
    const checkin = await request(port, 'POST', `${hubUrl}/api/p/api/agent/checkin`, { headers: { authorization: `Bearer ${got.token}` }, body: { agent: 'w1', has: ['macos'] } });
    assert.equal(checkin.status, 200, checkin.text);
    assert.equal(checkin.json.project, 'api');
    assert.equal(checkin.json.mission, 'Never lose an order.');

    // A second organization; the header's list (/api/me inside one) switches between them in one click each.
    assert.equal((await request(port, 'POST', '/api/orgs', { headers: { cookie: hubSession, origin }, body: { name: 'Beta' } })).status, 200);
    const list = (await request(port, 'GET', '/w/acme/api/me', { headers: { cookie: acme } })).json.orgs;
    assert.deepEqual(list.map((o) => [o.workspace, o.role, o.current]), [['acme', 'owner', true], ['beta', 'owner', false]]);
    const beta = await enter(hubSession, list.find((o) => o.workspace === 'beta').enter);
    const fromBeta = (await request(port, 'GET', '/w/beta/api/me', { headers: { cookie: beta } })).json.orgs;
    assert.deepEqual(fromBeta.map((o) => [o.workspace, o.current]), [['acme', false], ['beta', true]]);
    const back = await enter(hubSession, fromBeta.find((o) => o.workspace === 'acme').enter);
    assert.deepEqual((await request(port, 'GET', '/w/acme/api/people/me', { headers: { cookie: back } })).json, { person: '@cleo', role: 'owner' });
    assert.ok(Date.now() - started < 60_000, 'well under a minute of the hub\'s time');
  });
});
