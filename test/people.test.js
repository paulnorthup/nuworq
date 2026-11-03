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
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

function request(port, method, path, { headers = {}, body } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('people and roles', () => {
  let ctx;
  before(async () => {
    const hub = new Hub();
    const auth = new Auth(hub.db);
    const tok = {};
    for (const [handle, role] of [['olivia', 'owner'], ['sam', 'steward'], ['mo', 'member'], ['vic', 'viewer']]) {
      auth.addPerson(handle, role);
      tok[handle] = auth.createToken(`${handle}-laptop`, 'human', { person: handle });
    }
    tok.bot = auth.createToken('bot', 'agent');
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'Seed work', acceptance: 'x' });
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    ctx = { hub, auth, tok, server, port: server.address().port };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  const as = (who, action, body = {}) => request(ctx.port, 'POST', `/api/p/demo/human/${action}`, { headers: { authorization: `Bearer ${ctx.tok[who]}` }, body });

  test('a viewer reads but cannot comment or steer', async () => {
    assert.equal((await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { authorization: `Bearer ${ctx.tok.vic}` } })).status, 200);
    for (const a of ['comment', 'steer']) {
      const r = await as('vic', a, { body: 'hi' });
      assert.equal(r.status, 403, a);
      assert.match(r.json.error, /a viewer can't/);
    }
  });

  test('a member comments and proposes (created work lands in proposed), but cannot steer, accept or change settings', async () => {
    assert.equal((await as('mo', 'comment', { body: 'Looks good' })).status, 200);
    const c = await as('mo', 'create', { title: 'Idea from Mo', acceptance: 'x' });
    assert.equal(c.status, 200);
    assert.equal(ctx.hub.item(ctx.hub.project('demo'), c.json.item).stage, 'proposed');
    for (const [a, b] of [['steer', { body: 'x' }], ['accept', { item: '#1' }], ['settings', { mission: 'x' }]]) {
      assert.equal((await as('mo', a, b)).status, 403, a);
    }
  });

  test('a steward steers, decides, answers, accepts and sends back, but cannot change settings or people', async () => {
    const { hub } = ctx;
    assert.equal((await as('sam', 'steer', { body: 'Keep it small' })).status, 200);
    assert.equal((await as('sam', 'decide', { body: 'Tests before merge' })).status, 200);
    hub.agentOp('demo', 'claim', 'bot', { item: '#1' });
    const q = hub.agentOp('demo', 'ask', 'bot', { item: '#1', question: 'Which way?', assumption: 'Left' }).question;
    assert.equal((await as('sam', 'answer', { question: q, answer: 'Right' })).status, 200);
    hub.agentOp('demo', 'submit', 'bot', { item: '#1', headline: 'Done' });
    assert.equal((await as('sam', 'sendback', { item: '#1', note: 'Missing tests' })).status, 200);
    hub.agentOp('demo', 'claim', 'bot', { item: '#1' });
    hub.agentOp('demo', 'submit', 'bot', { item: '#1', headline: 'Done, with tests' });
    assert.equal((await as('sam', 'accept', { item: '#1' })).status, 200);
    assert.equal((await as('sam', 'settings', { mission: 'x' })).status, 403);
    const add = await request(ctx.port, 'POST', '/api/people', { headers: { authorization: `Bearer ${ctx.tok.sam}` }, body: { handle: 'eve', role: 'owner' } });
    assert.equal(add.status, 403);
  });

  test('an owner can do everything, including people', async () => {
    assert.equal((await as('olivia', 'settings', { mission: 'Ship it' })).status, 200);
    const h = { authorization: `Bearer ${ctx.tok.olivia}` };
    assert.equal((await request(ctx.port, 'POST', '/api/people', { headers: h, body: { handle: 'eve', role: 'viewer' } })).status, 200);
    assert.equal((await request(ctx.port, 'POST', '/api/people/role', { headers: h, body: { handle: 'eve', role: 'steward' } })).status, 200);
    assert.equal(ctx.auth.person('eve').role, 'steward');
    const me = await request(ctx.port, 'GET', '/api/people/me', { headers: h });
    assert.deepEqual(me.json, { person: '@olivia', role: 'owner' });
  });

  test('every human action names the person who took it', () => {
    const { hub } = ctx;
    const ev = (type) => hub.q('SELECT actor, headline FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type);
    assert.equal(hub.q(`SELECT actor FROM events WHERE headline = '@sam steered: Keep it small'`).get()?.actor, '@sam');
    assert.match(ev('steer').headline, /^@sam steered #1: Change of course/, 'an overridden assumption steers as the person too');
    assert.equal(ev('decision').actor, '@sam');
    assert.equal(ev('accepted').actor, '@sam');
    assert.equal(ev('sent_back').actor, '@sam');
    assert.equal(ev('comment').actor, '@mo');
    assert.equal(ev('mission').actor, '@olivia');
    assert.equal(hub.q(`SELECT author FROM notes WHERE kind = 'decision'`).get().author, '@sam');
    assert.equal(hub.q('SELECT answered_by FROM questions').get().answered_by, '@sam');
    // The agent's briefing shows who steered it.
    const brief = hub.agentOp('demo', 'checkin', 'bot2', {});
    assert.ok(brief.steers.some((s) => s.from === '@sam'));
  });

  test('agent names starting with "@" are refused', () => {
    assert.throws(() => ctx.hub.agentOp('demo', 'checkin', '@sam', {}), /can't start with "@"/);
  });

  test('the last owner cannot be demoted', () => {
    const auth = new Auth(new Hub().db);
    auth.addPerson('solo', 'owner');
    assert.throws(() => auth.setRole('solo', 'member'), /last owner/);
  });
});

describe('existing human tokens', () => {
  test('become owner people on upgrade, so nobody loses access', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE tokens (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, hash BLOB NOT NULL, prefix TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER)`);
    db.prepare(`INSERT INTO tokens (name, role, hash, prefix, created_at) VALUES ('Remy', 'human', x'00', 'trl_xxxx', 0), ('ci', 'agent', x'00', 'trl_yyyy', 0)`).run();
    const auth = new Auth(db);
    assert.deepEqual(auth.listPeople().map((p) => [p.handle, p.role]), [['remy', 'owner']]);
    assert.deepEqual(auth.listTokens().map((t) => [t.name, t.person]), [['Remy', 'remy'], ['ci', null]]);
  });
});

describe('the person CLI', () => {
  test('add, list, set-role, and tokens tied to a person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-people-'));
    const db = join(dir, 't.db');
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--db', db], { env: { ...process.env, HOME: dir, NO_COLOR: '1' } });
    await run('person', 'add', 'bea', '--role', 'steward', '--email', 'bea@example.com');
    await run('token', 'create', 'bea-laptop', '--role', 'human', '--person', 'bea');
    assert.match((await run('person', 'list')).stdout, /@bea\s+steward\s+bea@example.com/);
    await run('person', 'set-role', 'bea', 'member');
    assert.match((await run('person', 'list')).stdout, /@bea\s+member/);
    assert.match((await run('token', 'list')).stdout, /bea-laptop/);
    await assert.rejects(run('person', 'add', 'bad handle!'), /handle/);
  });
});
