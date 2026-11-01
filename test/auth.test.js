import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

function start(opts) {
  const hub = new Hub();
  const server = createServer(hub, opts);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ hub, server, port: server.address().port })));
}

// Raw http so we control every header (Origin, Cookie, Host).
function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('local mode', () => {
  let ctx;
  before(async () => { ctx = await start(); });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test('is open on loopback', async () => {
    const r = await request(ctx.port, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    const me = await request(ctx.port, 'GET', '/api/me');
    assert.deepEqual(me.json, { auth: 'local', role: 'human', name: 'you' });
  });

  test('refuses non-loopback Host headers (DNS rebinding) and cross-origin writes', async () => {
    const r = await request(ctx.port, 'GET', '/api/projects', { headers: { host: 'evil.example:4747' } });
    assert.equal(r.status, 403);
    const w = await request(ctx.port, 'POST', '/api/projects', { body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    assert.equal(w.status, 403);
  });

  test('security headers on every response', async () => {
    for (const path of ['/', '/api/projects', '/nope.js']) {
      const r = await request(ctx.port, 'GET', path);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
      assert.match(r.headers['content-security-policy'], /script-src 'self';/);
    }
  });

  test('bodies over 1MB are refused', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 10) });
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: big, headers: { 'x-nuworq-agent': 'a1' } });
    assert.equal(r.status, 413);
  });
});

describe('required mode', () => {
  let ctx, human, agent;
  const H = () => ({ authorization: `Bearer ${human}` });
  before(async () => {
    ctx = await start({ auth: 'required' });
    human = ctx.server.auth.createToken('paul', 'human');
    agent = ctx.server.auth.createToken('claude-box', 'agent');
    assert.match(human, /^nwq_[\w-]{40,}$/);
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test('static assets and health are public; the API is not', async () => {
    assert.equal((await request(ctx.port, 'GET', '/')).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/login.html')).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/health')).status, 200);
    const r = await request(ctx.port, 'GET', '/api/projects');
    assert.equal(r.status, 401);
    assert.ok(r.json.hint);
    // The guide is public: it's how an agent learns nuworq before it has a token.
    const g = await request(ctx.port, 'GET', '/agents.md');
    assert.equal(g.status, 200);
    assert.match(g.text, /checkin/);
    assert.equal((await request(ctx.port, 'GET', '/api/stream')).status, 401);
    const me = await request(ctx.port, 'GET', '/api/me');
    assert.deepEqual(me.json, { auth: 'required', role: null, name: null });
  });

  test('a non-loopback Host is fine once login is required', async () => {
    const r = await request(ctx.port, 'GET', '/api/health', { headers: { host: 'nuworq.example.com' } });
    assert.equal(r.status, 200);
  });

  test('agent tokens: agent operations yes, human views no', async () => {
    const ok = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: { model: 'gpt-5' }, headers: { authorization: `Bearer ${agent}`, 'x-nuworq-agent': 'codex-1' } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.project, 'demo');
    assert.equal((await request(ctx.port, 'GET', '/api/tools', { headers: { authorization: `Bearer ${agent}` } })).status, 200);
    // Workers find their checkout from the project list: agents get a lean one, without the human view. sandbox_hosts:
    // what a person let the project's workers reach (#472).
    const list = await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer ${agent}` } });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(Object.keys(list.json.find((p) => p.slug === 'demo')).sort(), ['name', 'parked', 'path', 'remotes', 'runner', 'sandbox_hosts', 'slug']);
    const no = await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { authorization: `Bearer ${agent}` } });
    assert.equal(no.status, 403);
    assert.match(no.json.error, /agent tokens can only use agent operations/);
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'hi' }, headers: { authorization: `Bearer ${agent}` } });
    assert.equal(steer.status, 403);
  });

  test('human bearer tokens see everything', async () => {
    const r = await request(ctx.port, 'GET', '/api/p/demo/view', { headers: H() });
    assert.equal(r.status, 200);
    assert.equal(r.json.project.slug, 'demo');
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'Bearer requests skip the Origin check' }, headers: H() });
    assert.equal(steer.status, 200);
  });

  test('login sets an HttpOnly session cookie that works for the UI', async () => {
    const r = await request(ctx.port, 'POST', '/api/login', { body: { token: human } });
    assert.equal(r.status, 200);
    const set = r.headers['set-cookie'][0];
    assert.match(set, /^nuworq_session=[\w-]+; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    const cookie = set.split(';')[0];
    const v = await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie } });
    assert.equal(v.status, 200);
    const me = await request(ctx.port, 'GET', '/api/me', { headers: { cookie } });
    assert.deepEqual(me.json, { auth: 'required', role: 'human', name: 'paul' });

    // CSRF: cookie-authenticated writes must prove they came from this site
    const noOrigin = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'x' }, headers: { cookie } });
    assert.equal(noOrigin.status, 403);
    const evil = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'x' }, headers: { cookie, origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const good = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'from the UI' }, headers: { cookie, origin: `http://127.0.0.1:${ctx.port}` } });
    assert.equal(good.status, 200, good.text);

    const out = await request(ctx.port, 'POST', '/api/logout', { headers: { cookie, origin: `http://127.0.0.1:${ctx.port}` } });
    assert.equal(out.status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { cookie } })).status, 401);
  });

  test('Secure cookie behind an HTTPS proxy only when the proxy is trusted', async () => {
    const plain = await request(ctx.port, 'POST', '/api/login', { body: { token: human }, headers: { 'x-forwarded-proto': 'https' } });
    assert.doesNotMatch(plain.headers['set-cookie'][0], /Secure/);
    const proxied = await start({ auth: 'required', trustProxy: true });
    try {
      const t = proxied.server.auth.createToken('me', 'human');
      const r = await request(proxied.port, 'POST', '/api/login', { body: { token: t }, headers: { 'x-forwarded-proto': 'https' } });
      assert.match(r.headers['set-cookie'][0], /; Secure$/);
    } finally {
      proxied.server.close(); proxied.server.closeAllConnections();
    }
  });

  test('agent tokens cannot log in to the UI', async () => {
    const r = await request(ctx.port, 'POST', '/api/login', { body: { token: agent } });
    assert.equal(r.status, 403);
  });

  test('revoked tokens stop working, sessions included', async () => {
    const t = ctx.server.auth.createToken('temp', 'human');
    const login = await request(ctx.port, 'POST', '/api/login', { body: { token: t } });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer ${t}` } })).status, 200);
    ctx.server.auth.revoke('temp');
    assert.equal((await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer ${t}` } })).status, 401);
    assert.equal((await request(ctx.port, 'GET', '/api/projects', { headers: { cookie } })).status, 401);
    const list = ctx.server.auth.listTokens();
    assert.ok(list.find((x) => x.name === 'temp').revoked_at);
    assert.ok(list.every((x) => !('hash' in x)), 'listTokens never exposes hashes');
  });

  test('repeated bad logins are rate-limited', async () => {
    const limited = await start({ auth: 'required' });
    try {
      const t = limited.server.auth.createToken('me', 'human');
      for (let i = 0; i < 10; i++) {
        const r = await request(limited.port, 'POST', '/api/login', { body: { token: 'nwq_wrongwrongwrongwrongwrong' } });
        assert.equal(r.status, 401);
      }
      const eleventh = await request(limited.port, 'POST', '/api/login', { body: { token: 'nwq_wrongwrongwrongwrongwrong' } });
      assert.equal(eleventh.status, 429);
      const evenRight = await request(limited.port, 'POST', '/api/login', { body: { token: t } });
      assert.equal(evenRight.status, 429);
    } finally {
      limited.server.close(); limited.server.closeAllConnections();
    }
  });

  test('body limit applies in required mode too', async () => {
    const big = JSON.stringify({ title: 'x'.repeat(1024 * 1024 + 10) });
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/propose', { body: big, headers: { authorization: `Bearer ${agent}`, 'x-nuworq-agent': 'codex-1' } });
    assert.equal(r.status, 413);
  });
});

describe('agent tokens limited to projects', () => {
  let ctx, scoped, other;
  const as = (token, agent = 'w1') => ({ authorization: `Bearer ${token}`, 'x-nuworq-agent': agent });
  before(async () => {
    ctx = await start({ auth: 'required' });
    for (const slug of ['alpha', 'beta']) {
      ctx.hub.tx(() => ctx.hub.project(slug, { create: true }));
      ctx.hub.humanOp(slug, 'settings', { path: `/code/${slug}` });
      ctx.hub.humanOp(slug, 'create', { title: `${slug} work`, acceptance: 'x', priority: slug === 'beta' ? 'now' : 'soon' });
    }
    scoped = ctx.server.auth.createToken('alpha-box', 'agent', { projects: ['alpha'] });
    other = ctx.server.auth.createToken('spare-box', 'agent');
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test('the scope is stored and listed; human tokens cannot have one', () => {
    const rows = ctx.server.auth.listTokens();
    assert.equal(rows.find((r) => r.name === 'alpha-box').projects, 'alpha');
    assert.equal(rows.find((r) => r.name === 'spare-box').projects, '');
    assert.throws(() => ctx.server.auth.createToken('h', 'human', { projects: ['alpha'] }), /only agent tokens/);
  });

  test('out-of-scope projects are refused, and never created', async () => {
    const r = await request(ctx.port, 'POST', '/api/p/beta/agent/checkin', { body: {}, headers: as(scoped) });
    assert.equal(r.status, 403);
    assert.match(r.json.hint, /limited to: alpha/);
    const c = await request(ctx.port, 'POST', '/api/p/gamma/agent/checkin', { body: {}, headers: as(scoped) });
    assert.equal(c.status, 403);
    assert.ok(!ctx.hub.projects().some((p) => p.slug === 'gamma'));
    const ok = await request(ctx.port, 'POST', '/api/p/alpha/agent/checkin', { body: {}, headers: as(scoped) });
    assert.equal(ok.status, 200);
  });

  test('routing, /api/route and /api/where only reveal projects in scope', async () => {
    // beta has the more urgent work, but this token only sees alpha
    const route = await request(ctx.port, 'GET', '/api/route', { headers: as(scoped) });
    assert.deepEqual(route.json.map((r) => r.project), ['alpha']);
    const where = await request(ctx.port, 'GET', `/api/where?root=${encodeURIComponent('/code/beta')}`, { headers: as(scoped) });
    assert.equal(where.json.project, null);
    const next = await request(ctx.port, 'POST', '/api/agent/next', { body: {}, headers: { ...as(scoped, 'w2'), 'x-nuworq-root': encodeURIComponent('/code/beta') } });
    assert.equal(next.status, 200);
    assert.equal(next.json.project, 'alpha');
    assert.equal(next.json.item, '#1');
    // an unscoped token still sees everything (alpha's only item is now held by w2)
    const all = await request(ctx.port, 'GET', '/api/route', { headers: as(other) });
    assert.deepEqual(all.json.map((r) => r.project), ['beta']);
  });

  test("agent tokens read finished branches for the sweep, only their projects' (#448)", async () => {
    for (const slug of ['alpha', 'beta']) {
      const it = ctx.hub.humanOp(slug, 'create', { title: `${slug} done`, acceptance: 'x' }).item;
      ctx.hub.patch(ctx.hub.item(ctx.hub.project(slug), it), { stage: 'done', branch: `nuworq/9-${slug}` });
    }
    const mine = await request(ctx.port, 'GET', '/api/finished?project=alpha', { headers: as(scoped) });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.json.branches, ['nuworq/9-alpha']);
    const theirs = await request(ctx.port, 'GET', '/api/finished?project=beta', { headers: as(scoped) });
    assert.deepEqual(theirs.json.branches, []);
    const all = await request(ctx.port, 'GET', '/api/finished?project=beta', { headers: as(other) });
    assert.deepEqual(all.json.branches, ['nuworq/9-beta']);
  });

  test('an agent name belongs to the token that first used it: another token is refused (#469)', async () => {
    const r = await request(ctx.port, 'POST', '/api/p/alpha/agent/checkin', { body: {}, headers: as(other, 'w1') });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /"w1" is another agent's name here/);
    assert.match(r.json.hint, /Pick a name of your own/);
    assert.equal(ctx.hub.q("SELECT tokens FROM agents WHERE name = 'w1'").get().tokens, 'alpha-box');
    const { view } = await import('../src/insight.js');
    assert.deepEqual(view(ctx.hub, 'alpha').agents.find((x) => x.name === 'w1').tokens, ['alpha-box']);
  });
});
