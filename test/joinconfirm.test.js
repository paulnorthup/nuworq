import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

// Joining a workspace takes the person's own yes (#630, found by security review #590): an invite bound to their
// email is offered, never taken, by a link another site can send or by a sign-in link alone.
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

// GitHub, played by a local server that signs in whoever the test says.
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

describe('a cross-site link never joins anyone to a workspace (#630)', () => {
  let p, spaces, server, port, origin, auth, vic;
  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-join-')) });
    server = createServer(spaces, { oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } } });
    port = await listen(server);
    origin = `http://127.0.0.1:${port}`;
    spaces.create('other');
    auth = new Auth(spaces.get('other').db);
    auth.addPerson('own', 'owner', { email: 'own@other.test', verified: true });
    auth.createInvite('steward', { email: 'vic@example.com', by: '@own' });
    // Vic, signed in to the hub itself.
    const s = await request(port, 'GET', '/auth/github/start');
    const state = new URL(s.headers.location).searchParams.get('state');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${p.approve('vic@example.com')}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookie(s) } });
    const fin = new URL(cb.headers.location);
    vic = cookie(await request(port, 'GET', fin.pathname + fin.search));
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });
  const people = () => auth.listPeople().map((x) => x.handle);
  const open = () => auth.listInvites().filter((i) => i.state === 'open').length;

  test('a GET, or a POST from another site, creates no person and uses no invite', async () => {
    const get = await request(port, 'GET', '/api/orgs/other/enter', { headers: { cookie: vic } });
    assert.equal(get.status, 405);
    const cross = await request(port, 'POST', '/api/orgs/other/enter', { headers: { cookie: vic, origin: 'https://evil.example' }, body: { confirm: true } });
    assert.equal(cross.status, 403);
    assert.deepEqual([people(), open()], [['own'], 1]);
  });

  test('from the hub itself: first the offer, and only a yes adds them', async () => {
    const offer = await request(port, 'POST', '/api/orgs/other/enter', { headers: { cookie: vic, origin }, body: {} });
    assert.deepEqual(offer.json, { pending: { workspace: 'other', role: 'steward', invited_by: '@own' } });
    assert.deepEqual([people(), open()], [['own'], 1], 'asking changes nothing');
    const yes = await request(port, 'POST', '/api/orgs/other/enter', { headers: { cookie: vic, origin }, body: { confirm: true } });
    assert.match(yes.json.go, /\/w\/other\/api\/oauth\/finish\?ticket=/);
    assert.deepEqual([people(), open()], [['own', 'vic'], 0]);
    const again = await request(port, 'POST', '/api/orgs/other/enter', { headers: { cookie: vic, origin }, body: {} });
    assert.ok(again.json.go, 'a member goes straight in');
  });

  test('a sign-in link to the workspace asks on the hub first, instead of joining', async () => {
    auth.createInvite('member', { email: 'wes@example.com', by: '@own' });
    const s = await request(port, 'GET', '/auth/github/start?ws=other');
    const state = new URL(s.headers.location).searchParams.get('state');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${p.approve('wes@example.com')}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookie(s) } });
    const to = new URL(cb.headers.location);
    assert.equal(to.pathname, '/api/oauth/finish', 'the hub\'s own finish, not the workspace\'s');
    assert.equal(to.searchParams.get('enter'), 'other');
    const fin = await request(port, 'GET', to.pathname + to.search);
    assert.equal(fin.headers.location, '/?enter=other', 'back to the page that asks');
    assert.ok(!people().includes('wes'), 'not a member yet');
    const offer = await request(port, 'POST', '/api/orgs/other/enter', { headers: { cookie: cookie(fin), origin }, body: {} });
    assert.equal(offer.json.pending.role, 'member');
  });

  test("the hub's page shows the offer and joins on the button; the switcher links to it", () => {
    const js = readFileSync(new URL('../web/join.js', import.meta.url), 'utf8');
    assert.match(js, /Join <b>\$\{esc\(p\.workspace\)\}<\/b> as \$\{esc\(p\.role\)\}/);
    assert.match(js, /\$\('#join'\)\.addEventListener\('click', \(\) => \{ \$\('#join'\)\.disabled = true; enter\(ws, true\); \}\)/);
  });
});
