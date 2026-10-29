import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/trellis.js', import.meta.url));

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

describe('invite links', () => {
  let ctx;
  before(async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    const auth = server.auth;
    auth.addPerson('paul', 'owner');
    auth.addPerson('sam', 'steward');
    const tok = { paul: auth.createToken('paul-l', 'human', { person: 'paul' }), sam: auth.createToken('sam-l', 'human', { person: 'sam' }) };
    hub.tx(() => hub.project('demo', { create: true }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { hub, auth, tok, server, port: server.address().port };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  const call = (method, path, opts) => request(ctx.port, method, path, opts);
  const as = (who) => ({ authorization: `Bearer ${ctx.tok[who]}` });
  const tokenOf = (link) => link.split('#')[1];

  test('an owner creates an invite and gets the link once; non-owners get 403', async () => {
    const r = await call('POST', '/api/invites', { headers: as('paul'), body: { role: 'steward', email: 'bea@example.com' } });
    assert.equal(r.status, 200);
    assert.match(r.json.link, /^http:\/\/127\.0\.0\.1:\d+\/invite\.html#tri_[\w-]{30,}$/);
    assert.equal((await call('POST', '/api/invites', { headers: as('sam'), body: { role: 'member' } })).status, 403);
    assert.equal((await call('GET', '/api/invites', { headers: as('sam') })).status, 403);
    const list = await call('GET', '/api/invites', { headers: as('paul') });
    assert.ok(!list.text.includes(tokenOf(r.json.link)), 'the link is never shown again');
    assert.equal(list.json.at(-1).state, 'open');
    // Only a hash is stored.
    assert.ok(!JSON.stringify(ctx.hub.db.prepare('SELECT * FROM invites').all()).includes(tokenOf(r.json.link)));
    assert.equal((await call('GET', '/invite.html')).status, 200, 'the invite page is public');
  });

  test('opening the link and picking a handle creates the person, signs them in, and is on the record', async () => {
    const link = (await call('POST', '/api/invites', { headers: as('paul'), body: { role: 'steward' } })).json.link;
    const token = tokenOf(link);
    const peek = await call('POST', '/api/invite/peek', { body: { token } });
    assert.deepEqual(peek.json, { ok: true, role: 'steward', invited_by: '@paul' });
    const acc = await call('POST', '/api/invite/accept', { body: { token, handle: 'bea' } });
    assert.equal(acc.status, 200);
    assert.deepEqual([acc.json.person, acc.json.role], ['@bea', 'steward']);
    const cookie = acc.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\//);
    const me = await call('GET', '/api/people/me', { headers: { cookie: cookie.split(';')[0] } });
    assert.deepEqual(me.json, { person: '@bea', role: 'steward' });
    assert.equal(ctx.auth.person('bea').role, 'steward');
    const ev = ctx.hub.q(`SELECT actor, headline FROM events WHERE type = 'joined'`).get();
    assert.deepEqual({ ...ev }, { actor: '@bea', headline: '@bea joined as steward, invited by @paul' });
  });

  test('a used, expired or revoked invite gets a clear error and creates nothing', async () => {
    const people = () => ctx.auth.listPeople().length;
    const used = tokenOf((await call('POST', '/api/invites', { headers: as('paul'), body: { role: 'member' } })).json.link);
    await call('POST', '/api/invite/accept', { body: { token: used, handle: 'cal' } });
    const n = people();
    const again = await call('POST', '/api/invite/accept', { body: { token: used, handle: 'dee' } });
    assert.deepEqual([again.status, again.json.error], [410, 'this invite was already used']);
    const expired = ctx.auth.createInvite('member', { ttl: -1 }).token;
    assert.equal((await call('POST', '/api/invite/accept', { body: { token: expired, handle: 'dee' } })).json.error, 'this invite has expired');
    const rev = await call('POST', '/api/invites', { headers: as('paul'), body: { role: 'member' } });
    await call('POST', '/api/invites/revoke', { headers: as('paul'), body: { id: rev.json.id } });
    assert.equal((await call('POST', '/api/invite/accept', { body: { token: tokenOf(rev.json.link), handle: 'dee' } })).json.error, 'this invite was revoked');
    assert.equal((await call('POST', '/api/invite/accept', { body: { token: 'tri_nonsense', handle: 'dee' } })).json.error, 'this invite link is not valid');
    assert.equal(people(), n, 'nobody was created');
    // A taken handle leaves the invite usable.
    const fresh = tokenOf((await call('POST', '/api/invites', { headers: as('paul'), body: { role: 'viewer' } })).json.link);
    assert.equal((await call('POST', '/api/invite/accept', { body: { token: fresh, handle: 'bea' } })).status, 400);
    assert.equal((await call('POST', '/api/invite/accept', { body: { token: fresh, handle: 'eli' } })).status, 200);
  });

  test('bad invite tokens are rate-limited like logins', async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      let last;
      for (let i = 0; i < 11; i++) last = await request(server.address().port, 'POST', '/api/invite/accept', { body: { token: `tri_bad${i}`, handle: 'x' } });
      assert.equal(last.status, 429);
    } finally {
      server.close();
    }
  });

  test('local mode has no invites', async () => {
    const server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      assert.equal((await request(server.address().port, 'POST', '/api/invite/peek', { body: { token: 'x' } })).status, 400);
    } finally {
      server.close();
    }
  });
});

describe('the invite CLI', () => {
  test('create prints the link once; list shows state; revoke', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trellis-inv-'));
    const db = join(dir, 't.db');
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--db', db], { env: { ...process.env, HOME: dir, NO_COLOR: '1' } });
    const out = (await run('invite', 'create', '--role', 'steward', '--email', 'bea@example.com', '--public-url', 'https://trellis.example.com')).stdout;
    assert.match(out, /https:\/\/trellis\.example\.com\/invite\.html#tri_/);
    assert.match((await run('invite', 'list')).stdout, /1\s+steward\s+bea@example.com\s+open/);
    await run('invite', 'revoke', '1');
    assert.match((await run('invite', 'list')).stdout, /revoked/);
    await assert.rejects(run('invite', 'create', '--role', 'boss'), /role must be one of/);
  });
});
