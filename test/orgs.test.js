import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

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

describe('organizations: who belongs where, and making one', () => {
  let p, spaces, server, port, origin;
  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-orgs-')) });
    server = createServer(spaces, { orgCap: 2, oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } } });
    port = await listen(server);
    origin = `http://127.0.0.1:${port}`;
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  // Sign in to the hub itself (no workspace), as a browser would: start → GitHub → callback → finish.
  async function signIn(email) {
    const s = await request(port, 'GET', '/auth/github/start');
    assert.equal(s.status, 302, s.text);
    const state = new URL(s.headers.location).searchParams.get('state');
    const cb = await request(port, 'GET', `/auth/github/callback?code=${p.approve(email)}&state=${encodeURIComponent(state)}`, { headers: { cookie: cookie(s) } });
    const fin = new URL(cb.headers.location);
    assert.equal(fin.pathname, '/api/oauth/finish', cb.headers.location);
    const done = await request(port, 'GET', fin.pathname + fin.search);
    assert.equal(done.headers.location, '/');
    return cookie(done);
  }
  const me = (c) => request(port, 'GET', '/api/me', { headers: { cookie: c } });
  const create = (c, b) => request(port, 'POST', '/api/orgs', { headers: { cookie: c, origin }, body: b });
  // One click into an organization: a workspace session there, via a one-time ticket.
  async function enter(c, ws) {
    const r = await request(port, 'GET', `/api/orgs/${ws}/enter`, { headers: { cookie: c } });
    if (r.status !== 302) return { status: r.status, json: r.json };
    const fin = new URL(r.headers.location);
    assert.equal(fin.pathname, `/w/${ws}/api/oauth/finish`);
    return { status: 302, session: cookie(await request(port, 'GET', fin.pathname + fin.search)) };
  }

  let ann, bob;
  test('not signed in: 401, and nothing is created', async () => {
    assert.equal((await request(port, 'GET', '/api/me')).status, 401);
    const r = await request(port, 'POST', '/api/orgs', { headers: { origin }, body: { name: 'Acme' } });
    assert.equal(r.status, 401);
    assert.ok(r.json.hint);
    assert.deepEqual(spaces.list(), []);
  });

  test('a signed-in person creates an organization and owns it', async () => {
    ann = await signIn('Ann@Example.com');
    assert.deepEqual((await me(ann)).json, { auth: 'required', email: 'ann@example.com', orgs: [] });
    const r = await create(ann, { name: 'Acme' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.workspace, 'acme');
    assert.ok(existsSync(spaces.file('acme')));
    const owner = new Auth(spaces.get('acme').db).person('ann');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.email, 'ann@example.com');
    assert.deepEqual((await me(ann)).json.orgs, [{ workspace: 'acme', handle: 'ann', role: 'owner', created: true, address: `${origin}/w/acme`, enter: '/api/orgs/acme/enter' }]);

    const inside = await enter(ann, 'acme');
    const who = await request(port, 'GET', '/w/acme/api/people/me', { headers: { cookie: inside.session } });
    assert.deepEqual(who.json, { person: '@ann', role: 'owner' });
  });

  test('invalid, reserved and taken names are refused with a hint; nothing is created', async () => {
    bob = await signIn('bob@example.org');
    for (const [b, status] of [[{ slug: 'A!' }, 400], [{ name: '' }, 400], [{ slug: 'admin' }, 400], [{ name: 'acme' }, 409]]) {
      const r = await create(bob, b);
      assert.equal(r.status, status, JSON.stringify(b));
      assert.ok(r.json.hint, `${JSON.stringify(b)} has a hint`);
    }
    assert.deepEqual(spaces.list(), ['acme']);
    assert.equal(new Auth(spaces.get('acme').db).person('bob'), null);
    const cross = await request(port, 'POST', '/api/orgs', { headers: { cookie: bob, origin: 'http://evil.test' }, body: { name: 'x' } });
    assert.equal(cross.status, 403, 'another site cannot create organizations with your cookie');
  });

  test('a person may create only so many organizations', async () => {
    assert.equal((await create(ann, { name: 'Acme Labs', slug: 'acme-labs' })).status, 200);
    const r = await create(ann, { name: 'Third' });
    assert.equal(r.status, 429);
    assert.match(r.json.hint, /--org-cap/);
    assert.ok(!spaces.has('third'));
  });

  test("two people's organizations are sealed from each other", async () => {
    assert.equal((await create(bob, { name: 'Beta' })).status, 200);
    const b = await enter(bob, 'beta');
    assert.equal((await request(port, 'POST', '/w/beta/api/projects', { headers: { cookie: b.session, origin }, body: { name: 'secret' } })).status, 200);
    const a = await enter(ann, 'acme');

    assert.equal((await enter(ann, 'beta')).status, 404, "ann can't enter beta");
    for (const c of [a.session, ann, `${a.session}; ${ann}`]) {
      for (const [method, path, body] of [['GET', '/w/beta/api/projects'], ['GET', '/w/beta/api/people'], ['POST', '/w/beta/api/projects', { name: 'mine' }]]) {
        const r = await request(port, method, path, { headers: { cookie: c, origin }, body });
        assert.equal(r.status, 401, `${method} ${path} with ${c.split('=')[0]}`);
      }
    }
    assert.equal((await request(port, 'GET', '/w/acme/api/projects', { headers: { cookie: b.session } })).status, 401);
    assert.deepEqual((await me(ann)).json.orgs.map((o) => o.workspace), ['acme', 'acme-labs']);
    assert.deepEqual((await me(bob)).json.orgs.map((o) => o.workspace), ['beta']);
  });

  test('accepting an invite adds the organization; a role change shows; removal takes it off', async () => {
    const b = await enter(bob, 'beta');
    const inv = await request(port, 'POST', '/w/beta/api/invites', { headers: { cookie: b.session, origin }, body: { role: 'member', email: 'ann@example.com' } });
    assert.equal(inv.status, 200, inv.text);
    const a = await enter(ann, 'beta');
    assert.equal(a.status, 302, 'the invite to her email lets her in');
    assert.deepEqual((await request(port, 'GET', '/w/beta/api/people/me', { headers: { cookie: a.session } })).json, { person: '@ann', role: 'member' });
    const beta = () => me(ann).then((r) => r.json.orgs.find((o) => o.workspace === 'beta'));
    assert.deepEqual(await beta(), { workspace: 'beta', handle: 'ann', role: 'member', created: false, address: `${origin}/w/beta`, enter: '/api/orgs/beta/enter' });

    await request(port, 'POST', '/w/beta/api/people/role', { headers: { cookie: b.session, origin }, body: { handle: 'ann', role: 'steward' } });
    assert.equal((await beta()).role, 'steward');

    new Auth(spaces.get('beta').db).removePerson('ann');
    assert.equal(await beta(), undefined);
    assert.equal((await enter(ann, 'beta')).status, 404);
  });

  test('with subdomains, the base domain and the public URL are the hub itself, not a workspace', async () => {
    const sub = createServer(spaces, { baseDomain: 'nuworq.test', publicUrl: 'https://auth.nuworq.test' });
    const sp = await listen(sub);
    try {
      for (const host of ['nuworq.test', 'auth.nuworq.test']) {
        const r = await request(sp, 'GET', '/api/me', { headers: { host } });
        assert.equal(r.status, 401, host);
        assert.equal(r.json.error, 'sign in required');
      }
      assert.equal((await request(sp, 'GET', '/api/me', { headers: { host: 'acme.nuworq.test' } })).json.auth, 'required', 'acme is still a workspace');
    } finally { sub.close(); }
  });

  test('signing out of the hub ends the hub session only', async () => {
    const a = await enter(ann, 'acme');
    assert.equal((await request(port, 'POST', '/api/logout', { headers: { cookie: ann, origin } })).status, 200);
    assert.equal((await me(ann)).status, 401);
    assert.equal((await request(port, 'GET', '/w/acme/api/people/me', { headers: { cookie: a.session } })).status, 200);
  });
});
