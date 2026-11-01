import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { oauthFromEnv } from '../src/oauth.js';

function request(port, method, path, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const cookie = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

// GitHub and Google, played by one local server: it checks the client secret and the PKCE verifier.
function provider() {
  const codes = new Map(), tokens = new Map(), seen = [];
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      seen.push(f);
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (!c || f.client_secret !== 'shh') return json(400, { error: 'bad_verification_code' });
      if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant' });
      const t = randomBytes(8).toString('hex');
      tokens.set(t, c);
      return json(200, { access_token: t, token_type: 'bearer' });
    }
    const who = tokens.get(String(req.headers.authorization ?? '').replace('Bearer ', ''));
    if (!who) return json(401, { message: 'Bad credentials' });
    if (req.url === '/user/emails') return json(200, [{ email: 'other@example.com', primary: false, verified: true }, { email: who.email, primary: true, verified: who.verified }]);
    if (req.url === '/v1/userinfo') return json(200, { sub: '1', email: who.email, email_verified: who.verified });
    json(404, {});
  });
  return {
    server, seen,
    // The person approves at the provider: a code for the challenge the hub sent.
    approve(authorizeUrl, email, verified = true) {
      const u = new URL(authorizeUrl);
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge'), email, verified });
      return { code, state: u.searchParams.get('state'), callback: new URL(u.searchParams.get('redirect_uri')) };
    },
  };
}

const config = (stub) => ({
  github: { id: 'gh-id', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub },
  google: { id: 'go-id', secret: 'shh', authorize: `${stub}/o/oauth2/v2/auth`, token: `${stub}/token`, api: stub },
});

describe('sign in with GitHub or Google', () => {
  let p, stubUrl, hub, auth, server, port;
  before(async () => {
    p = provider();
    stubUrl = `http://127.0.0.1:${await listen(p.server)}`;
    hub = new Hub();
    auth = new Auth(hub.db);
    auth.addPerson('ann', 'owner', { email: 'ann@example.com', verified: true }); // as the host's person add does
    hub.tx(() => hub.project('p', { create: true }));
    server = createServer(hub, { auth: 'required', oauth: config(stubUrl) });
    port = await listen(server);
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } });

  // Start → provider → callback → finish, as a browser would. Returns each step's response.
  async function flow(name, email, { verified = true, headers = {}, start = `/auth/${name}/start`, tamper } = {}) {
    const s = await request(port, 'GET', start, { headers });
    assert.equal(s.status, 302, s.text);
    const a = p.approve(s.headers.location, email, verified);
    const state = tamper ? tamper(a.state) : a.state;
    const cb = await request(port, 'GET', `${a.callback.pathname}?code=${a.code}&state=${encodeURIComponent(state)}`, { headers: { ...headers, cookie: cookie(s) } });
    if (cb.status !== 302 || !cb.headers.location.includes('/api/oauth/finish')) return { start: s, cb, approval: a };
    const fin = new URL(cb.headers.location);
    const done = await request(port, 'GET', fin.pathname + fin.search, { headers: { ...headers, host: fin.host } });
    return { start: s, cb, done, session: cookie(done), approval: a };
  }

  test('the login page offers the configured providers; without config it offers none', async () => {
    const r = await request(port, 'GET', '/api/oauth');
    assert.deepEqual(r.json.providers.map((x) => x.name), ['github', 'google']);
    assert.match(r.json.providers[0].start, /\/auth\/github\/start$/);
    const plain = createServer(new Hub(), { auth: 'required' });
    const pp = await listen(plain);
    try {
      assert.deepEqual((await request(pp, 'GET', '/api/oauth')).json.providers, []);
      assert.equal((await request(pp, 'GET', '/auth/github/start')).status, 404);
      assert.match((await request(pp, 'GET', '/login.html')).text, /Paste your human token/);
    } finally { plain.close(); }
    assert.deepEqual(oauthFromEnv({ NUWORQ_GITHUB_CLIENT_ID: 'a', NUWORQ_GITHUB_CLIENT_SECRET: 'b', TRELLIS_GOOGLE_CLIENT_ID: 'c' }), { github: { id: 'a', secret: 'b' } });
  });

  test('the provider gets a signed state and a PKCE challenge; the hub sends the verifier', async () => {
    const r = await flow('github', 'ann@example.com');
    const u = new URL(r.start.headers.location);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('client_id'), 'gh-id');
    assert.match(u.searchParams.get('state'), /^[\w-]+\.\d+\.\.[\w-]+$/);
    assert.ok(p.seen.at(-1).code_verifier, 'the token request carries the verifier');
    assert.match(r.start.headers['set-cookie'][0], /HttpOnly; SameSite=Lax; Path=\/auth\//);
  });

  test('a verified email that matches a person signs them in as that person (GitHub and Google)', async () => {
    for (const name of ['github', 'google']) {
      const r = await flow(name, 'ANN@example.com');
      assert.equal(r.done.status, 302);
      assert.equal(r.done.headers.location, '/');
      const me = await request(port, 'GET', '/api/people/me', { headers: { cookie: r.session } });
      assert.deepEqual(me.json, { person: '@ann', role: 'owner' }, name);
    }
    // One hidden login token per person and provider, reused on the next sign-in.
    await flow('github', 'ann@example.com');
    assert.deepEqual(auth.listTokens().filter((t) => t.person === 'ann').map((t) => t.name), ['ann-github', 'ann-google']);
  });

  test('a missing, forged, reused or other-browser state is refused', async () => {
    const missing = await request(port, 'GET', '/auth/github/callback?code=x');
    assert.equal(missing.status, 400);
    assert.match(missing.text, /state is missing/);
    const forged = await flow('github', 'ann@example.com', { tamper: (s) => s.replace(/\.\d+\./, `.${Date.now() + 9e9}.`) });
    assert.equal(forged.cb.status, 400);
    assert.match(forged.cb.text, /doesn't match/);

    const s = await request(port, 'GET', '/auth/github/start');
    const a = p.approve(s.headers.location, 'ann@example.com');
    const elsewhere = await request(port, 'GET', `/auth/github/callback?code=${a.code}&state=${encodeURIComponent(a.state)}`, { headers: { cookie: 'nuworq_oauth=someone-else' } });
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.text, /another browser/);
    const again = await request(port, 'GET', `/auth/github/callback?code=${a.code}&state=${encodeURIComponent(a.state)}`, { headers: { cookie: cookie(s) } });
    assert.match(again.text, /already used/, 'a state works once');

    const r = await flow('github', 'ann@example.com');
    const fin = new URL(r.cb.headers.location);
    const reuse = await request(port, 'GET', fin.pathname + fin.search);
    assert.match(reuse.headers.location, /login\.html#error=/, 'a ticket works once');
  });

  test('an unverified or unknown email is refused, with a hint to ask for an invite', async () => {
    const unverified = await flow('google', 'ann@example.com', { verified: false });
    assert.match(decodeURIComponent(unverified.cb.headers.location), /login\.html#error=Google has no verified email/);
    const stranger = await flow('github', 'eve@example.com');
    assert.match(decodeURIComponent(stranger.cb.headers.location), /eve@example\.com isn't a member here\. Ask an owner for an invite/);
    assert.equal(auth.person('eve'), null);
  });

  test('a pending invite bound to the email makes them a person with its role', async () => {
    auth.createInvite('steward', { email: 'Bo@Example.com', by: '@ann' });
    const r = await flow('google', 'bo@example.com');
    const me = await request(port, 'GET', '/api/people/me', { headers: { cookie: r.session } });
    assert.deepEqual(me.json, { person: '@bo', role: 'steward' });
    assert.equal(auth.listInvites().find((i) => i.email === 'bo@example.com').state, 'used');
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'joined' AND actor = '@bo'`).get());
  });
});

describe('one provider app serves every workspace', () => {
  let p, stubUrl, spaces, server, port;
  const BASE = 'nuworq.test';
  before(async () => {
    p = provider();
    stubUrl = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-oauth-')) });
    for (const ws of ['acme', 'globex']) spaces.create(ws);
    new Auth(spaces.get('acme').db).addPerson('ann', 'owner', { email: 'ann@acme.com', verified: true });
    new Auth(spaces.get('globex').db).addPerson('gus', 'owner', { email: 'gus@globex.com', verified: true });
    server = createServer(spaces, { baseDomain: BASE, publicUrl: `http://auth.${BASE}`, oauth: config(stubUrl) });
    port = await listen(server);
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } });

  // device: the device code login.html adds to the start link when it was opened from device.html (#153).
  const begin = async (ws, email, device = null) => {
    const opts = (await request(port, 'GET', '/api/oauth', { headers: { host: `${ws}.${BASE}` } })).json.providers;
    const start = new URL(opts[0].start);
    if (device != null) start.searchParams.set('device', device);
    assert.equal(start.host, `auth.${BASE}`, 'the flow starts at the hub-wide address');
    const s = await request(port, 'GET', start.pathname + start.search, { headers: { host: start.host } });
    const a = p.approve(s.headers.location, email);
    assert.equal(a.callback.toString(), `http://auth.${BASE}/auth/github/callback`, 'one callback for every workspace');
    return request(port, 'GET', `${a.callback.pathname}?code=${a.code}&state=${encodeURIComponent(a.state)}`, { headers: { host: a.callback.host, cookie: cookie(s) } });
  };

  test("the workspace rides in the state, and the ticket works only in that workspace", async () => {
    const cb = await begin('acme', 'ann@acme.com');
    const fin = new URL(cb.headers.location);
    assert.equal(fin.host, `acme.${BASE}`);
    const wrong = await request(port, 'GET', fin.pathname + fin.search, { headers: { host: `globex.${BASE}` } });
    assert.match(wrong.headers.location, /login\.html#error=/, 'an acme ticket does not sign anyone in to globex');
    assert.equal(wrong.headers['set-cookie'], undefined);

    const cb2 = await begin('acme', 'ann@acme.com');
    const fin2 = new URL(cb2.headers.location);
    const done = await request(port, 'GET', fin2.pathname + fin2.search, { headers: { host: fin2.host } });
    const me = await request(port, 'GET', '/api/people/me', { headers: { host: `acme.${BASE}`, cookie: cookie(done) } });
    assert.deepEqual(me.json, { person: '@ann', role: 'owner' });
    const there = await request(port, 'GET', '/api/people/me', { headers: { host: `globex.${BASE}`, cookie: cookie(done) } });
    assert.equal(there.status, 401, "acme's session means nothing in globex");
  });

  test('signing in from a device approval page ends back on it with the same code; anything else is ignored (#153)', async () => {
    const finish = async (device) => {
      const fin = new URL((await begin('acme', 'ann@acme.com', device)).headers.location);
      return (await request(port, 'GET', fin.pathname + fin.search, { headers: { host: fin.host } })).headers.location;
    };
    assert.equal(await finish('abcd-efgh'), '/device.html?code=ABCD-EFGH');
    for (const bad of ['//evil.example', 'ABCD-EFGH&x=1', '../admin', 'ABCDEFGH1']) assert.equal(await finish(bad), '/', `${bad} is not a code`);
    assert.equal(await finish(), '/', 'no code: the board, as before');
    const fail = await begin('globex', 'ann@acme.com', 'ABCD-EFGH');
    assert.match(fail.headers.location, /^http:\/\/globex\.nuworq\.test\/login\.html\?device=ABCD-EFGH#error=/, 'a failed sign-in keeps the code too');
  });

  test("a person of acme can't sign in to globex", async () => {
    const cb = await begin('globex', 'ann@acme.com');
    assert.match(decodeURIComponent(cb.headers.location), /^http:\/\/globex\.nuworq\.test\/login\.html#error=ann@acme\.com isn't a member here/);
  });
});
