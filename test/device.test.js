import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Devices, DEVICE_MS } from '../src/device.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('device login', () => {
  let ctx;
  before(async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    const auth = server.auth;
    auth.addPerson('bea', 'member');
    auth.addPerson('vic', 'viewer');
    const tok = {
      bea: auth.createToken('bea-l', 'human', { person: 'bea' }),
      vic: auth.createToken('vic-l', 'human', { person: 'vic' }),
      bot: auth.createToken('bot', 'agent'),
    };
    hub.tx(() => hub.project('demo', { create: true }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { hub, auth, tok, server, port: server.address().port };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  const call = (method, path, opts) => request(ctx.port, method, path, opts);
  const as = (who) => ({ authorization: `Bearer ${ctx.tok[who]}` });
  const start = (machine = 'laptop') => call('POST', '/api/device/start', { body: { machine } }).then((r) => r.json);
  const poll = (d) => call('POST', '/api/device/poll', { body: { device_code: d.device_code } });

  test('start, pending, approve in the browser, then the token exactly once', async () => {
    const d = await start('laptop');
    assert.match(d.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    assert.match(d.device_code, /^nwd_[\w-]{40,}$/);
    assert.deepEqual([d.interval, d.expires_in], [5, 600]);
    assert.match(d.verify_url_complete, new RegExp(`/device\\.html\\?code=${d.user_code}$`));
    assert.equal((await poll(d)).json.status, 'pending');

    const peek = await call('POST', '/api/device/peek', { headers: as('bea'), body: { user_code: d.user_code.toLowerCase().replace('-', ' ') } });
    assert.equal(peek.status, 200);
    assert.equal(peek.json.machine, 'laptop');
    const ok = await call('POST', '/api/device/approve', { headers: as('bea'), body: { user_code: d.user_code, approve: true } });
    assert.deepEqual([ok.status, ok.json.token_name], [200, 'bea@laptop']);

    const got = await poll(d);
    assert.equal(got.json.status, 'approved');
    assert.equal(got.json.name, 'bea@laptop');
    const me = await call('GET', '/api/me', { headers: { authorization: `Bearer ${got.json.token}` } });
    assert.deepEqual([me.json.role, me.json.name], ['agent', 'bea@laptop']);
    assert.equal(ctx.auth.listTokens().find((t) => t.name === 'bea@laptop').minted_by, 'bea');
    const again = await poll(d);
    assert.equal(again.status, 410);
    assert.match(again.json.hint, /start a new device login/);

    // Only hashes of the codes are kept, and never the token.
    const rows = JSON.stringify(ctx.hub.db.prepare('SELECT * FROM device_requests').all());
    for (const s of [d.device_code, d.user_code, d.user_code.replace('-', ''), got.json.token]) assert.ok(!rows.includes(s));
    assert.ok(ctx.hub.q(`SELECT 1 FROM events WHERE type = 'connected' AND headline = '@bea connected laptop (agent token bea@laptop)'`).get());
  });

  test('removing the person revokes the machine token; a second connect gets its own name', async () => {
    const d = await start('laptop');
    await call('POST', '/api/device/approve', { headers: as('bea'), body: { user_code: d.user_code } });
    const got = (await poll(d)).json;
    assert.equal(got.name, 'bea@laptop-2');
    assert.ok(ctx.auth.verifyToken(got.token));
    ctx.auth.removePerson('bea');
    assert.equal(ctx.auth.verifyToken(got.token), null);
    assert.equal((await call('GET', '/api/me', { headers: { authorization: `Bearer ${got.token}` } })).json.role, null);
  });

  test('wrong and denied codes fail with a hint; fast polling gets slow_down; viewers and agents cannot approve', async () => {
    ctx.auth.addPerson('bea', 'member');
    ctx.tok.bea = ctx.auth.createToken('bea-2', 'human', { person: 'bea' });
    const wrong = await call('POST', '/api/device/peek', { headers: as('bea'), body: { user_code: 'BBBB-BBBB' } });
    assert.equal(wrong.status, 410);
    assert.ok(wrong.json.hint);
    const unknown = await call('POST', '/api/device/poll', { body: { device_code: 'nwd_nope' } });
    assert.equal(unknown.status, 404);
    assert.ok(unknown.json.hint);

    const d = await start('desk');
    assert.equal((await poll(d)).json.status, 'pending');
    const fast = await poll(d);
    assert.deepEqual([fast.json.status, fast.json.interval], ['slow_down', 5]);
    assert.equal((await call('POST', '/api/device/approve', { headers: as('vic'), body: { user_code: d.user_code } })).status, 403);
    assert.equal((await call('POST', '/api/device/approve', { headers: as('bot'), body: { user_code: d.user_code } })).status, 403);
    const no = await call('POST', '/api/device/approve', { headers: as('bea'), body: { user_code: d.user_code, approve: false } });
    assert.deepEqual([no.status, no.json.approved], [200, false]);
    const denied = await poll(d);
    assert.equal(denied.status, 410);
    assert.match(denied.json.error, /denied/);
    assert.equal(ctx.auth.listTokens().filter((t) => t.name.startsWith('bea@desk')).length, 0);
    // A decided code can't be decided again.
    assert.equal((await call('POST', '/api/device/approve', { headers: as('bea'), body: { user_code: d.user_code } })).status, 410);
  });

  test('the approval page is public; its API needs a login', async () => {
    assert.equal((await call('GET', '/device.html?code=ABCD-EFGH')).status, 200);
    assert.equal((await call('POST', '/api/device/peek', { body: { user_code: 'ABCD-EFGH' } })).status, 401);
  });

  test('starting device logins is rate-limited per IP', async () => {
    let last;
    for (let n = 0; n < 12; n++) last = await call('POST', '/api/device/start', { body: { machine: 'spam' } });
    assert.equal(last.status, 429);
    assert.ok(last.json.hint);
  });
});

test('a code expires after 10 minutes', () => {
  const clock = { t: Date.UTC(2026, 9, 1, 9) };
  const auth = new Auth(new Hub().db, { now: () => clock.t });
  const devices = new Devices(auth);
  auth.addPerson('bea', 'member');
  const d = devices.start('laptop');
  clock.t += DEVICE_MS + 1;
  assert.deepEqual(devices.peek(d.user_code), { ok: false, error: 'this code has expired' });
  assert.throws(() => devices.decide(d.user_code, 'bea', true), /expired/);
  assert.throws(() => devices.poll(d.device_code), (e) => e.code === 'expired');
});

test('a code started in one workspace cannot be approved in another', async () => {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-dev-')) });
  const tok = {};
  for (const s of ['acme', 'globex']) {
    spaces.create(s);
    tok[s] = new Auth(spaces.get(s).db).createToken('boss', 'human');
  }
  const server = createServer(spaces, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    const d = (await request(port, 'POST', '/w/acme/api/device/start', { body: { machine: 'laptop' } })).json;
    assert.match(d.verify_url, /\/w\/acme\/device\.html$/);
    const there = await request(port, 'POST', '/w/globex/api/device/approve', { headers: { authorization: `Bearer ${tok.globex}` }, body: { user_code: d.user_code } });
    assert.equal(there.status, 410);
    const here = await request(port, 'POST', '/w/acme/api/device/approve', { headers: { authorization: `Bearer ${tok.acme}` }, body: { user_code: d.user_code } });
    assert.equal(here.status, 200);
    assert.equal((await request(port, 'POST', '/w/globex/api/device/poll', { body: { device_code: d.device_code } })).status, 404);
    assert.equal((await request(port, 'POST', '/w/acme/api/device/poll', { body: { device_code: d.device_code } })).json.name, 'boss@laptop');
  } finally {
    server.close(); server.closeAllConnections(); spaces.close();
  }
});
