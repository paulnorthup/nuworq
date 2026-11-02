import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { LEASE_MS, MIN } from '../src/core.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const BASE = 'nuworq.test';

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
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

// Read an SSE stream until `until` matches or `ms` passes; resolve with everything
// received. `open` resolves on the first chunk (the server's hello), so a test can
// wait for the stream to be live instead of guessing with a timer.
function listen(port, path, headers, { until, ms = 5000 } = {}) {
  let opened;
  const open = new Promise((r) => (opened = r));
  const done = new Promise((resolve, reject) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      const finish = () => { clearTimeout(timer); req.destroy(); resolve({ status: res.statusCode, text }); };
      const timer = setTimeout(finish, ms);
      res.on('data', (c) => {
        text += c;
        opened();
        if (until && until.test(text)) finish();
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? resolve({ text }) : reject(e)));
    req.end();
  });
  return { open, done };
}

const bearer = (t) => ({ authorization: `Bearer ${t}` });
const at = (slug) => ({ host: `${slug}.${BASE}` });

describe('the workspace registry', () => {
  test('create makes one file, list shows it, remove deletes it (and its WAL files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-ws-'));
    const spaces = new Workspaces({ dir });
    spaces.create('acme');
    assert.deepEqual(readdirSync(dir), ['acme.db']);
    assert.deepEqual(spaces.list(), ['acme']);
    spaces.get('acme').tx(() => spaces.get('acme').project('p', { create: true }));
    assert.ok(readdirSync(dir).length > 1, 'an open hub has WAL files');
    spaces.remove('acme');
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(spaces.get('acme'), null);
    assert.throws(() => spaces.create('Bad Name!'), /can't be a workspace's address/);
    assert.throws(() => spaces.create('www'), /reserved/);
    spaces.create('acme');
    assert.throws(() => spaces.create('acme'), /already exists/);
  });

  // #728: remove left acme's directory rows, so whoever made acme next could mint tokens through the old tenant's
  // GitHub installation, got its webhooks, its plan and grant, and the old creator still counted it as theirs.
  test('a name freed by remove starts clean: no old installation, plan, grant, members or creator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-ws-'));
    const spaces = new Workspaces({ dir });
    const d = spaces.directory;
    const old = d.identify('old@acme.test', 'github'), next = d.identify('new@other.test', 'github');
    const { code } = d.decide(d.request({ email: 'old@acme.test', building: 'rockets' }).id, true, 'owner');
    spaces.create('acme');
    assert.equal(d.useGrant(code, old, 'acme'), true);
    d.join('old@acme.test', 'acme', { created: true });
    assert.equal(d.bindInstallation(4242, 'acme'), true);
    spaces.setPlan('acme', 'unlimited', 'owner');
    d.setting('adopted:acme', join(dir, 'gone.db'));
    assert.equal(d.installation(4242), 'acme');

    spaces.remove('acme');
    spaces.create('acme');
    d.join('new@other.test', 'acme', { created: true });
    assert.equal(d.installation(4242), null, "the old installation routes nowhere: no tokens, no webhooks");
    assert.equal(d.plan('acme'), null, 'the default plan');
    assert.equal(d.madeByGrant('acme'), false, 'no early-access grant');
    assert.deepEqual(d.created(old), [], "not the old creator's any more");
    assert.deepEqual(d.created(next), ['acme']);
    assert.equal(d.creator('acme').email, 'new@other.test', 'only its new creator');
    assert.equal(d.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE workspace = 'acme'").get().n, 1);
    assert.equal(d.setting('adopted:acme'), null);
    assert.equal(d.useGrant(code, next, 'acme'), false, 'the old grant stays used');
  });
});

describe('one server, two workspaces', () => {
  let ctx;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-ws-'));
    const clock = { t: Date.UTC(2026, 9, 1, 9) };
    const spaces = new Workspaces({ dir, clock: () => clock.t });
    const tokens = {};
    for (const s of ['acme', 'globex']) {
      spaces.create(s);
      const auth = new Auth(spaces.get(s).db);
      tokens[s] = { human: auth.createToken('boss', 'human'), agent: auth.createToken('bot', 'agent') };
    }
    const server = createServer(spaces, { baseDomain: BASE, sweepMs: 40 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { spaces, server, port: server.address().port, tokens, clock, dir };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); ctx.spaces.close(); });

  const call = (method, path, opts) => request(ctx.port, method, path, opts);

  test('a subdomain and a /w/<name>/ prefix both reach the workspace; unknown names get a 404 with a hint', async () => {
    const a = ctx.tokens.acme;
    const sub = await call('POST', '/api/p/rockets/agent/checkin', { headers: { ...at('acme'), ...bearer(a.agent), 'x-nuworq-agent': 'bot' }, body: {} });
    assert.equal(sub.status, 200, sub.text);
    const viaPath = await call('GET', '/w/acme/api/projects', { headers: bearer(a.human) });
    assert.deepEqual(viaPath.json.map((p) => p.slug), ['rockets']);
    const none = await call('GET', '/api/projects', { headers: at('initech') });
    assert.equal(none.status, 404);
    assert.match(none.json.hint, /nuworq workspace create/);
    const bare = await call('GET', '/api/projects');
    assert.equal(bare.status, 404);
    assert.match(bare.json.hint, /\/w\/<workspace>/);
    assert.equal((await call('GET', '/api/health')).status, 200);
    const redirect = await call('GET', '/w/acme');
    assert.deepEqual([redirect.status, redirect.headers.location], [308, '/w/acme/']);
    const page = await call('GET', '/w/acme/');
    assert.match(page.text, /src="app.js"/, 'the UI loads its assets relative to the workspace');
    const info = await call('GET', '/w/acme/api/info', { headers: bearer(a.human) });
    assert.match(info.json.url, /\/w\/acme$/);
  });

  test("one workspace never sees another's projects, items, events or route", async () => {
    const a = ctx.tokens.acme, g = ctx.tokens.globex;
    await call('POST', '/api/p/rockets/human/create', { headers: { ...at('acme'), ...bearer(a.human) }, body: { title: 'Secret acme plan', acceptance: 'x' } });
    const gp = await call('GET', '/api/projects', { headers: { ...at('globex'), ...bearer(g.human) } });
    assert.deepEqual(gp.json, []);
    const gv = await call('GET', '/api/p/rockets/view', { headers: { ...at('globex'), ...bearer(g.human) } });
    assert.equal(gv.status, 404);
    const route = await call('GET', '/api/route', { headers: { ...at('globex'), ...bearer(g.agent) } });
    assert.deepEqual(route.json, []);
    const aroute = await call('GET', '/api/route', { headers: { ...at('acme'), ...bearer(a.agent) } });
    assert.equal(aroute.json[0].title, 'Secret acme plan');
    assert.equal(ctx.spaces.get('globex').q('SELECT COUNT(*) AS n FROM events').get().n, 0);
  });

  test('tokens and sessions from one workspace get 401 on the other, by subdomain and by path', async () => {
    const a = ctx.tokens.acme;
    for (const t of [a.human, a.agent]) {
      assert.equal((await call('GET', '/api/route', { headers: { ...at('globex'), ...bearer(t) } })).status, 401);
      assert.equal((await call('GET', '/w/globex/api/route', { headers: bearer(t) })).status, 401);
    }
    const login = await call('POST', '/w/acme/api/login', { body: { token: a.human } });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /Path=\/w\/acme\//, 'the session cookie is scoped to its workspace path');
    const sid = cookie.split(';')[0];
    assert.equal((await call('GET', '/w/acme/api/projects', { headers: { cookie: sid } })).status, 200);
    assert.equal((await call('GET', '/w/globex/api/projects', { headers: { cookie: sid } })).status, 401);
    assert.equal((await call('GET', '/api/projects', { headers: { ...at('globex'), cookie: sid } })).status, 401);
  });

  test("a workspace's live stream carries only its own changes", async () => {
    const a = ctx.tokens.acme, g = ctx.tokens.globex;
    const gStream = listen(ctx.port, '/api/stream', { ...at('globex'), ...bearer(g.human) }, { ms: 500 });
    const aStream = listen(ctx.port, '/api/stream', { ...at('acme'), ...bearer(a.human) }, { until: /"project":"rockets"/ });
    await Promise.all([gStream.open, aStream.open]);
    await call('POST', '/api/p/rockets/human/comment', { headers: { ...at('acme'), ...bearer(a.human) }, body: { body: 'hello' } });
    const [gs, as] = await Promise.all([gStream.done, aStream.done]);
    assert.match(as.text, /"project":"rockets"/);
    assert.doesNotMatch(gs.text, /data:/);
  });

  test('expired leases are swept in every open workspace', async () => {
    const g = ctx.tokens.globex;
    const h = { ...at('globex'), ...bearer(g.agent), 'x-nuworq-agent': 'bot' };
    await call('POST', '/api/p/mines/agent/checkin', { headers: h, body: {} });
    ctx.spaces.get('globex').humanOp('mines', 'create', { title: 'Dig', acceptance: 'x' });
    const next = await call('POST', '/api/p/mines/agent/next', { headers: h, body: {} });
    assert.equal(next.json.item, '#1');
    ctx.clock.t += LEASE_MS + MIN;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ctx.spaces.get('globex').q('SELECT stage FROM items WHERE seq = 1').get().stage, 'ready');
  });

  test('a removed workspace stops being served at once', async () => {
    ctx.spaces.create('tempco');
    const t = new Auth(ctx.spaces.get('tempco').db).createToken('boss', 'human');
    assert.equal((await call('GET', '/w/tempco/api/projects', { headers: bearer(t) })).status, 200);
    ctx.spaces.remove('tempco');
    assert.equal((await call('GET', '/w/tempco/api/projects', { headers: bearer(t) })).status, 404);
    assert.ok(!existsSync(join(ctx.dir, 'tempco.db')));
  });
});

describe('the CLI manages workspaces on the host', () => {
  test('workspace create, list, token --workspace, remove', async () => {
    const data = mkdtempSync(join(tmpdir(), 'nuworq-ws-cli-'));
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--data-dir', data], { env: { ...process.env, HOME: data, NO_COLOR: '1' } });
    assert.match((await run('workspace', 'create', 'acme')).stdout, /Created workspace/);
    assert.ok(existsSync(join(data, 'workspaces', 'acme.db')));
    assert.equal((await run('workspace', 'list')).stdout.trim(), 'acme  unlimited (default)', 'made by the host, so unlimited');
    assert.match((await run('token', 'create', 'boss', '--role', 'human', '--workspace', 'acme')).stdout, /nwq_/);
    await run('workspace', 'remove', 'acme');
    assert.deepEqual(readdirSync(join(data, 'workspaces')).filter((f) => f.startsWith('acme')), [], 'its database and WAL files are gone');
    await assert.rejects(run('token', 'list', '--workspace', 'acme'), /no workspace "acme"/);
  });
});
