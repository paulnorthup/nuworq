import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

const ADMIN = 'admin.example.test', APP = 'app.example.test';

function request(port, method, path, { host = APP, headers = {}, body } = {}) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://${host}` } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const cookies = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

// GitHub, played by a local server: a code for whoever approves, traded for a token that says their email.
function provider() {
  const codes = new Map(), tokens = new Map();
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (!c || createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'bad_verification_code' });
      const t = randomBytes(8).toString('hex');
      tokens.set(t, c.email);
      return json(200, { access_token: t });
    }
    const email = tokens.get(String(req.headers.authorization ?? '').replace('Bearer ', ''));
    if (email && req.url === '/user/emails') return json(200, [{ email, primary: true, verified: true }]);
    json(401, {});
  });
  return {
    server,
    approve(authorizeUrl, email) {
      const u = new URL(authorizeUrl);
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge'), email });
      return { code, state: u.searchParams.get('state'), callback: new URL(u.searchParams.get('redirect_uri')) };
    },
  };
}

describe('the admin host', () => {
  let p, spaces, server, port;
  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-admin-')) });
    spaces.create('acme');
    server = createServer(spaces, {
      publicUrl: `http://${APP}`, adminHost: ADMIN,
      oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } },
      earlyAccess: { owners: ['remy@example.com'], verify: async (t) => t === 'good', gate: true },
    });
    port = await listen(server);
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  // Sign in on the admin host as a browser would: start → GitHub → callback. Returns the callback's response.
  async function signIn(email) {
    const s = await request(port, 'GET', '/auth/github/start', { host: ADMIN });
    assert.equal(s.status, 302, s.text);
    const a = p.approve(s.headers.location, email);
    assert.equal(a.callback.host, ADMIN, 'the callback is on the admin host itself');
    return request(port, 'GET', `${a.callback.pathname}?code=${a.code}&state=${encodeURIComponent(a.state)}`, { host: ADMIN, headers: { cookie: cookies(s) } });
  }
  const ask = (email) => request(port, 'POST', '/api/early-access', { body: { email, turnstile: 'good' } });

  test('an owner signs in on the admin host, lists requests and approves one; a grant link to the app comes back', async () => {
    await ask('ann@example.com');
    const cb = await signIn('remy@example.com');
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.location, '/');
    const set = cb.headers['set-cookie'].find((c) => c.startsWith('nuworq_admin='));
    assert.ok(set, 'an admin session cookie');
    assert.doesNotMatch(set, /domain=/i, 'host-only: no Domain attribute');
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const jar = cookies(cb);
    const me = await request(port, 'GET', '/api/me', { host: ADMIN, headers: { cookie: jar } });
    assert.deepEqual(me.json, { email: 'remy@example.com', owner: true });
    const list = await request(port, 'GET', '/api/early-access?state=new', { host: ADMIN, headers: { cookie: jar } });
    assert.equal(list.status, 200);
    const ann = list.json.requests.find((r) => r.email === 'ann@example.com');
    assert.ok(ann);
    const yes = await request(port, 'POST', '/api/early-access/decide', { host: ADMIN, headers: { cookie: jar }, body: { id: ann.id, approve: true } });
    assert.equal(yes.status, 200, yes.text);
    assert.match(yes.json.link, new RegExp(`^http://${APP}/\\?grant=[\\w-]{20,}$`), 'the link goes to the app, not the admin host');
    // A write without the admin host's own Origin is refused.
    const cross = await request(port, 'POST', '/api/early-access/decide', { host: ADMIN, headers: { cookie: jar, origin: `http://${APP}` }, body: { id: ann.id, approve: false } });
    assert.equal(cross.status, 403);
    // Signing out ends the session.
    assert.equal((await request(port, 'POST', '/api/logout', { host: ADMIN, headers: { cookie: jar }, body: {} })).status, 200);
    assert.equal((await request(port, 'GET', '/api/me', { host: ADMIN, headers: { cookie: jar } })).status, 401);
  });

  test('a signed-in non-owner gets 403 with a hint and no request data', async () => {
    await ask('cy@example.com');
    const jar = cookies(await signIn('zed@example.com'));
    assert.ok(jar.includes('nuworq_admin='));
    assert.deepEqual((await request(port, 'GET', '/api/me', { host: ADMIN, headers: { cookie: jar } })).json, { email: 'zed@example.com', owner: false });
    const list = await request(port, 'GET', '/api/early-access', { host: ADMIN, headers: { cookie: jar } });
    assert.equal(list.status, 403);
    assert.match(list.json.hint, /NUWORQ_HUB_OWNERS/);
    assert.equal(list.json.requests, undefined);
    assert.doesNotMatch(list.text, /cy@example\.com/);
    const id = spaces.directory.requests().find((r) => r.email === 'cy@example.com').id;
    assert.equal((await request(port, 'POST', '/api/early-access/decide', { host: ADMIN, headers: { cookie: jar }, body: { id, approve: true } })).status, 403);
    assert.equal(spaces.directory.requests().find((r) => r.id === id).state, 'new');
  });

  test('signed out, the admin host offers sign-in and nothing else', async () => {
    const page = await request(port, 'GET', '/', { host: ADMIN });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /\/admin\.js/);
    assert.equal((await request(port, 'GET', '/admin.js', { host: ADMIN })).status, 200);
    assert.deepEqual((await request(port, 'GET', '/api/oauth', { host: ADMIN })).json.providers, [{ name: 'github', label: 'GitHub', start: '/auth/github/start' }]);
    const list = await request(port, 'GET', '/api/early-access', { host: ADMIN });
    assert.equal(list.status, 401);
    assert.equal(list.json.requests, undefined);
    assert.equal((await request(port, 'GET', '/api/me', { host: ADMIN })).status, 401);
    // Nothing of the app answers here: not its pages, its APIs, a workspace, or the form.
    for (const path of ['/join.html', '/requests.html', '/early-access', '/api/orgs', '/w/acme/', '/w/acme/api/info', '/nuworq.tgz', '/agents.md']) {
      assert.equal((await request(port, 'GET', path, { host: ADMIN })).status, 404, path);
    }
    assert.equal((await request(port, 'POST', '/api/early-access', { host: ADMIN, body: { email: 'x@example.com', turnstile: 'good' } })).status, 404);
  });

  test("an app session doesn't open the admin host, and an admin session doesn't open the app", async () => {
    const dir = spaces.directory;
    const id = dir.identify('remy@example.com', 'github').id;
    const appSid = dir.createSession(id);
    assert.equal((await request(port, 'GET', '/api/me', { headers: { cookie: `nuworq_id=${appSid}` } })).status, 200, 'it works on the app');
    for (const cookie of [`nuworq_admin=${appSid}`, `nuworq_id=${appSid}`]) {
      assert.equal((await request(port, 'GET', '/api/early-access', { host: ADMIN, headers: { cookie } })).status, 401, cookie);
    }
    const adminSid = dir.createSession(id, 'admin');
    assert.equal((await request(port, 'GET', '/api/me', { host: ADMIN, headers: { cookie: `nuworq_admin=${adminSid}` } })).status, 200, 'it works on the admin host');
    for (const cookie of [`nuworq_id=${adminSid}`, `nuworq_admin=${adminSid}`]) {
      assert.equal((await request(port, 'GET', '/api/me', { headers: { cookie } })).status, 401, cookie);
    }
    // A sign-in started on the app can't finish on the admin host's callback.
    const s = await request(port, 'GET', '/auth/github/start');
    const a = p.approve(s.headers.location, 'remy@example.com');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${a.code}&state=${encodeURIComponent(a.state)}`, { host: ADMIN, headers: { cookie: cookies(s) } });
    assert.equal(cb.status, 400);
    assert.equal(cb.headers['set-cookie']?.some((c) => c.startsWith('nuworq_admin=') && !c.startsWith('nuworq_admin=;')) ?? false, false);
  });

  test('the app host sends the request list to the admin host and refuses its APIs; the public form still works', async () => {
    for (const path of ['/requests.html', '/requests.js', '/w/acme/requests.html', '/w/acme/admin.html']) {
      const r = await request(port, 'GET', path);
      assert.equal(r.status, 308, path);
      assert.equal(r.headers.location, `http://${ADMIN}/`, path);
    }
    const owner = `nuworq_id=${spaces.directory.createSession(spaces.directory.identify('remy@example.com', 'github').id)}`;
    for (const cookie of [owner, '']) {
      const list = await request(port, 'GET', '/api/early-access', { headers: cookie ? { cookie } : {} });
      assert.equal(list.status, 403);
      assert.match(list.json.hint, /admin\.example\.test/);
      assert.equal(list.json.requests, undefined);
      const decide = await request(port, 'POST', '/api/early-access/decide', { headers: cookie ? { cookie } : {}, body: { id: 1, approve: true } });
      assert.equal(decide.status, 403);
      assert.match(decide.json.hint, /admin\.example\.test/);
    }
    const form = await ask('dee@example.com');
    assert.equal(form.status, 200);
    assert.equal(form.json.ok, true);
  });

  test('an admin host needs a hub of workspaces, the app\'s public URL, and a host of its own', () => {
    assert.throws(() => createServer(new Hub(), { auth: 'required', publicUrl: `http://${APP}`, adminHost: ADMIN }), /workspaces/);
    assert.throws(() => createServer(spaces, { adminHost: ADMIN }), /public URL/);
    assert.throws(() => createServer(spaces, { publicUrl: `http://${APP}`, adminHost: APP }), /host of its own/);
  });

  test('new requests come first in the list', () => {
    const rows = spaces.directory.requests();
    const firstDecided = rows.findIndex((r) => r.state !== 'new');
    assert.ok(firstDecided > 0);
    assert.ok(rows.slice(firstDecided).every((r) => r.state !== 'new'));
  });
});
