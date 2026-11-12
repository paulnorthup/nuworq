import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

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

  test('reads are open on loopback; who am I says anonymous until the key', async () => {
    const r = await request(ctx.port, 'GET', '/api/projects');
    assert.equal(r.status, 200);
    const me = await request(ctx.port, 'GET', '/api/me');
    assert.deepEqual(me.json, { auth: 'local', role: 'anon', name: 'anonymous' });
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
    const r = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: big, headers: { 'x-nuworq-agent': 'a1', authorization: `Bearer ${ctx.server.personKey}` } });
    assert.equal(r.status, 413);
  });

  test('a token that identifies a worker is that agent, not the person (#892)', async () => {
    const { hostname } = await import('node:os');
    const runner = ctx.server.auth.localRunnerToken(hostname().split('.')[0]);
    const H = { authorization: `Bearer ${runner.token}`, 'x-nuworq-agent': 'w1' };
    const me = await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${runner.token}` } });
    assert.equal(me.json.auth, 'local');
    assert.equal(me.json.role, 'agent');
    assert.equal(me.json.runner, runner.runner);
    // Agent operations work; the person's human operations don't.
    const ok = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: H });
    assert.equal(ok.status, 200, ok.text);
    const view = await request(ctx.port, 'GET', '/api/p/demo/view', { headers: H });
    assert.equal(view.status, 403);
    assert.match(view.json.error, /agent tokens can only use agent operations/);
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'hi' }, headers: H });
    assert.equal(steer.status, 403);
    // Settings stay out of reach: what #892 is about.
    const settings = await request(ctx.port, 'POST', '/api/p/demo/human/settings', { body: { sandbox_hosts: 'evil.example' }, headers: H });
    assert.equal(settings.status, 403);
    // A runner token never operates (#609), on a hub without logins either.
    const op = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: { has: 'operator' }, headers: H });
    assert.equal(op.status, 403);
    assert.match(op.json.error, /can't be an operator|can't act as an operator/);
  });

  test("a tokenless caller reads no one's email, and nothing says it is an owner (#915)", async () => {
    ctx.server.auth.addPerson('remy', 'owner', { email: 'remy@example.com' });
    const key = { authorization: `Bearer ${ctx.server.personKey}` };
    const people = await request(ctx.port, 'GET', '/api/people');
    assert.equal(people.status, 200);
    assert.ok(people.json.some((p) => p.handle === 'remy'));
    assert.doesNotMatch(people.text, /remy@example\.com/);
    assert.match((await request(ctx.port, 'GET', '/api/people', { headers: key })).text, /remy@example\.com/, "the person's key still sees them");

    assert.deepEqual((await request(ctx.port, 'GET', '/api/people/me')).json, { person: null, role: null });
    assert.equal((await request(ctx.port, 'GET', '/api/people/me', { headers: key })).json.role, 'owner');
    assert.equal((await request(ctx.port, 'GET', '/api/info')).json.github_app, null);
    assert.equal((await request(ctx.port, 'GET', '/api/info', { headers: key })).json.github_app, 'create');
    assert.equal((await request(ctx.port, 'GET', '/api/github/app')).json.can_create, false);
    assert.equal((await request(ctx.port, 'GET', '/api/github/app', { headers: key })).json.can_create, true);

    const invites = await request(ctx.port, 'GET', '/api/invites');
    assert.equal(invites.status, 403);
    assert.match(invites.json.hint, /nuworq serve printed/);
    assert.equal((await request(ctx.port, 'GET', '/api/invites', { headers: key })).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/github/repos')).status, 403);
    assert.deepEqual((await request(ctx.port, 'GET', '/api/launcher')).json.can, []);
  });

  test("a tokenless caller sees none of the hub's push channels (#915)", async () => {
    const key = { authorization: `Bearer ${ctx.server.personKey}` };
    const added = await request(ctx.port, 'POST', '/api/notify', { headers: key, body: { kind: 'webhook', url: 'https://hooks.example.com/secret-path' } });
    assert.equal(added.status, 200, added.text);
    assert.deepEqual((await request(ctx.port, 'GET', '/api/notify')).json.channels, []);
    assert.equal((await request(ctx.port, 'GET', '/api/notify', { headers: key })).json.channels.length, 1);
  });

  test('a tokenless caller reads but cannot act (#900), and a bad token is refused', async () => {
    // What code a worker runs can send: no token at all, just the NUWORQ_URL it was given.
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'as you' } });
    assert.equal(steer.status, 403);
    assert.match(steer.json.error, /acts only for its person/);
    assert.ok(steer.json.hint);
    const accept = await request(ctx.port, 'POST', '/api/p/demo/human/accept', { body: {} });
    assert.equal(accept.status, 403);
    const staff = await request(ctx.port, 'POST', '/api/staff', { body: { project: 'demo', budget: 5 } });
    assert.equal(staff.status, 403);
    // Agent routes are agent operations: without a token there is no agent.
    const checkin = await request(ctx.port, 'POST', '/api/p/demo/agent/checkin', { body: {}, headers: { 'x-nuworq-agent': 'w1' } });
    assert.equal(checkin.status, 403);
    const bad = await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: 'Bearer nwq_wrongwrongwrongwrongwrongwrong' } });
    assert.equal(bad.status, 401);
    assert.match(bad.json.error, /invalid or revoked token/);
    const revoked = ctx.server.auth.createToken('gone', 'agent');
    ctx.server.auth.revoke('gone');
    const r = await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer ${revoked}` } });
    assert.equal(r.status, 401);
  });

  test('the person\'s key acts as the person; a wrong one claims an identity and is refused', async () => {
    const me = await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${ctx.server.personKey}` } });
    assert.deepEqual(me.json, { auth: 'local', role: 'human', name: 'you' });
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'mine' }, headers: { authorization: `Bearer ${ctx.server.personKey}` } });
    assert.equal(steer.status, 200);
    const bad = await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer not-the-key-${ctx.server.personKey.slice(0, 3)}` } });
    assert.equal(bad.status, 401);
    assert.match(bad.json.error, /invalid or revoked token/);
  });

  const credentialOf = (location) => location.match(/#person=([0-9a-f]{64})$/)?.[1];
  const signIn = async () => credentialOf((await request(ctx.port, 'GET', `/?person=${ctx.server.personKey}`)).headers.location);

  test('one open of the address with ?person= hands the page its credential, and the browser keeps acting', async () => {
    const open = await request(ctx.port, 'GET', '/?person=notit');
    assert.equal(open.status, 200); // a wrong key is just the plain page
    assert.equal(open.headers['set-cookie'], undefined);
    const first = await request(ctx.port, 'GET', `/?person=${ctx.server.personKey}`);
    assert.equal(first.status, 303);
    assert.doesNotMatch(first.headers.location, new RegExp(ctx.server.personKey));
    const credential = credentialOf(first.headers.location);
    assert.ok(credential, first.headers.location);
    const headers = { 'x-nuworq-person': credential };
    assert.equal((await request(ctx.port, 'GET', '/api/me', { headers })).json.role, 'human');
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'from the browser' }, headers });
    assert.equal(steer.status, 200);
    const wrong = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'guess' }, headers: { 'x-nuworq-person': 'a'.repeat(64) } });
    assert.equal(wrong.status, 403);
  });

  test('a browser credential taken while the hub was down can\'t act when it returns', async () => {
    const personKey = 'the-persons-key';
    const credentialFrom = async (port) => credentialOf((await request(port, 'GET', `/?person=${personKey}`)).headers.location);
    const stop = (s) => { s.server.close(); s.server.closeAllConnections(); };
    const before = await start({ personKey });
    const taken = await credentialFrom(before.port);
    assert.equal((await request(before.port, 'GET', '/api/me', { headers: { 'x-nuworq-person': taken } })).json.role, 'human');
    stop(before);

    const back = await start({ personKey });
    try {
      back.hub.tx(() => back.hub.project('demo', { create: true }));
      const headers = { 'x-nuworq-person': taken };
      assert.equal((await request(back.port, 'GET', '/api/me', { headers })).json.role, 'anon');
      assert.equal((await request(back.port, 'GET', '/api/projects', { headers })).status, 200, 'it can still look');
      const refused = await request(back.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'taken' }, headers });
      assert.equal(refused.status, 403);
      assert.match(refused.json.hint, /address nuworq serve printed/);
      // Opening the address again is all it takes.
      const fresh = await credentialFrom(back.port);
      assert.notEqual(fresh, taken);
      assert.equal((await request(back.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'mine' }, headers: { 'x-nuworq-person': fresh } })).status, 200);
    } finally { stop(back); }
  });

  test('hubs handed the port without a gap take each other\'s browser credentials', async () => {
    const personKey = 'the-persons-key';
    const old = await start({ personKey, hubRun: 'held-port' });
    const beside = await start({ personKey, hubRun: 'held-port' });
    try {
      const credential = credentialOf((await request(old.port, 'GET', `/?person=${personKey}`)).headers.location);
      assert.equal((await request(beside.port, 'GET', '/api/me', { headers: { 'x-nuworq-person': credential } })).json.role, 'human');
    } finally { for (const s of [old, beside]) { s.server.close(); s.server.closeAllConnections(); } }
  });

  test('a person\'s browser credential sent to another loopback port can\'t act on the hub', async () => {
    // What a browser hands any listener on 127.0.0.1, whatever its port: the cookies of that host. Replayed here.
    const credential = await signIn();
    const replayed = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'replayed' }, headers: { cookie: `nuworq_person=${credential}`, origin: `http://127.0.0.1:${ctx.port}` } });
    assert.equal(replayed.status, 403);
    assert.match(replayed.json.error, /acts only for its person/);
    const me = await request(ctx.port, 'GET', '/api/me', { headers: { cookie: `nuworq_person=${credential}` } });
    assert.equal(me.json.role, 'anon');
    // And signing in leaves nothing for a browser to send on: the only cookie is the old one being retired.
    const first = await request(ctx.port, 'GET', `/?person=${ctx.server.personKey}`);
    assert.deepEqual(first.headers['set-cookie'].map((c) => c.match(/^[^;]*/)[0]), ['nuworq_person=']);
    assert.match(first.headers['set-cookie'][0], /Max-Age=0/);
  });

  test('another local hub\'s cookie doesn\'t block signing in', async () => {
    const r = await request(ctx.port, 'GET', `/?person=${ctx.server.personKey}`, { headers: { cookie: `nuworq_person=${'b'.repeat(64)}` } });
    assert.equal(r.status, 303);
    assert.doesNotMatch(r.headers.location, /\?/); // the key has left the address bar
    assert.equal((await request(ctx.port, 'GET', '/api/me', { headers: { 'x-nuworq-person': credentialOf(r.headers.location) } })).json.role, 'human');
  });

  test('the person rotates the key: the old key and browser credential stop at once, and only the person can', async () => {
    const before = ctx.server.personKey;
    const browser = { 'x-nuworq-person': await signIn() };
    const anon = await request(ctx.port, 'POST', '/api/me/person-key', { body: {} });
    assert.equal(anon.status, 403);
    const agent = ctx.server.auth.createToken('rotator', 'agent');
    const refused = await request(ctx.port, 'POST', '/api/me/person-key', { body: {}, headers: { authorization: `Bearer ${agent}` } });
    assert.equal(refused.status, 403);
    assert.equal(ctx.server.personKey, before);
    const r = await request(ctx.port, 'POST', '/api/me/person-key', { body: {}, headers: { authorization: `Bearer ${before}` } });
    assert.equal(r.status, 200);
    assert.notEqual(r.json.key, before);
    assert.equal(ctx.server.personKey, r.json.key);
    assert.equal((await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${before}` } })).status, 200);
    assert.equal((await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${before}` } })).json.role, null);
    assert.equal((await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'old key' }, headers: { authorization: `Bearer ${before}` } })).status, 401);
    // The old browser falls back to looking; it isn't locked out of the page.
    assert.equal((await request(ctx.port, 'GET', '/api/me', { headers: browser })).json.role, 'anon');
    assert.equal((await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'old browser' }, headers: browser })).status, 403);
    assert.equal((await request(ctx.port, 'GET', `/?person=${before}`)).status, 200); // the old address no longer signs in
    assert.equal((await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'new key' }, headers: { authorization: `Bearer ${r.json.key}` } })).status, 200);
  });

  test('nuworq token rotate-person replaces the running hub\'s key, or the file with no hub up', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nuworq-rotate-'));
    const file = join(home, '.nuworq', 'tokens', 'person.token');
    mkdirSync(dirname(file), { recursive: true });
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: home, NUWORQ_NO_UPDATE: '1' };
    const rotate = () => run(process.execPath, [BIN, 'token', 'rotate-person'], { env });
    try {
      const running = await start({ savePersonKey: (k) => writeFileSync(file, `${k}\n`) });
      try {
        const before = running.server.personKey;
        const url = `http://127.0.0.1:${running.port}`;
        writeFileSync(file, `${before}\n`);
        writeFileSync(join(home, '.nuworq', 'hub.json'), JSON.stringify({ url, auth: 'local' }));
        const { stdout } = await rotate();
        assert.notEqual(running.server.personKey, before);
        assert.equal(readFileSync(file, 'utf8').trim(), running.server.personKey);
        assert.ok(stdout.includes(`${url}/?person=${running.server.personKey}`), stdout);
        assert.equal((await request(running.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${before}` } })).json.role, null);
      } finally { running.server.close(); running.server.closeAllConnections(); }
      // The hub in hub.json is gone now: the file changes, and no key is printed.
      const kept = readFileSync(file, 'utf8').trim();
      const { stdout } = await rotate();
      const next = readFileSync(file, 'utf8').trim();
      assert.notEqual(next, kept);
      assert.ok(!stdout.includes(next), stdout);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a new key that can\'t be kept never takes over', async () => {
    const stuck = await start({ savePersonKey: () => { throw new Error('read-only'); } });
    try {
      const before = stuck.server.personKey;
      const r = await request(stuck.port, 'POST', '/api/me/person-key', { body: {}, headers: { authorization: `Bearer ${before}` } });
      assert.equal(r.status, 500);
      assert.match(r.json.hint, /old key still works/);
      assert.equal(stuck.server.personKey, before);
      assert.equal((await request(stuck.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${before}` } })).json.role, 'human');
    } finally { stuck.server.close(); stuck.server.closeAllConnections(); }
  });

  test('a tokenless mint leaves the machine\'s workers\' runner token live', async () => {
    const { hostname } = await import('node:os');
    const name = hostname().split('.')[0];
    const one = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} });
    assert.equal(one.status, 200);
    assert.equal(one.json.runner, name);
    assert.match(one.json.name, new RegExp(`^${name}\\.runner`));
    const again = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} });
    assert.notEqual(again.json.token, one.json.token);
    for (const t of [one, again]) {
      const me = await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${t.json.token}` } });
      assert.equal(me.json.role, 'agent');
    }
    const role = async (t) => (await request(ctx.port, 'GET', '/api/me', { headers: { authorization: `Bearer ${t}` } })).json.role;
    // A worker holds the runner token, so showing it replaces nothing and revokes nothing, however often.
    for (let i = 0; i < 12; i++) {
      const refused = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {}, headers: { authorization: `Bearer ${again.json.token}` } });
      assert.equal(refused.status, 400);
      assert.match(refused.json.error, /runner token already/);
    }
    const selfRevoke = await request(ctx.port, 'POST', '/api/me/revoke', { body: {}, headers: { authorization: `Bearer ${again.json.token}` } });
    assert.equal(selfRevoke.status, 400);
    for (const t of [one, again]) assert.equal(await role(t.json.token), 'agent');
    // Only the person's key replaces it.
    const next = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {}, headers: { authorization: `Bearer ${ctx.server.personKey}` } });
    assert.equal(next.status, 200);
    for (const t of [one, again]) assert.equal(await role(t.json.token), null);
    assert.equal(await role(next.json.token), 'agent');
  });

  test('tokenless runner-token mints are limited', async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} });
    assert.equal(last.status, 429);
  });

  test('a person\'s own bearer token keeps its powers on a hub without logins', async () => {
    const human = ctx.server.auth.createToken('ada', 'human');
    const r = await request(ctx.port, 'GET', '/api/p/demo/view', { headers: { authorization: `Bearer ${human}` } });
    assert.equal(r.status, 200);
    const steer = await request(ctx.port, 'POST', '/api/p/demo/human/steer', { body: { body: 'mine' }, headers: { authorization: `Bearer ${human}` } });
    assert.equal(steer.status, 200);
    ctx.server.auth.revoke('ada');
  });
});

describe('agent names on a hub without logins (#922)', () => {
  let ctx, runner, own;
  const stateOf = () => ctx.hub.q('SELECT seq, stage, holder FROM items ORDER BY seq').all().map((i) => ({ ...i }));
  const as = (agent, token, op, body = {}) => request(ctx.port, 'POST', `/api/p/api/agent/${op}`, { body, headers: { authorization: `Bearer ${token}`, 'x-nuworq-agent': agent } });
  before(async () => {
    ctx = await start();
    ctx.hub.agentOp('api', 'checkin', 'a1', {});
    ctx.hub.humanOp('api', 'create', { title: 'first', acceptance: 'done' });
    ctx.hub.humanOp('api', 'create', { title: 'second', acceptance: 'done' });
    runner = ctx.server.auth.localRunnerToken('box');
    const parent = ctx.server.auth.verifyToken(runner.token).id;
    own = { a1: ctx.server.auth.workerToken(parent, 'a1').token, a2: ctx.server.auth.workerToken(parent, 'a2').token };
    ctx.hub.agentOp('api', 'claim', 'a1', { item: '#1' });
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test("a worker's token can't act under another agent's name on the agent API", async () => {
    const minted = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} }); // any code on this machine can get one
    const asked = { "another worker's own token": own.a2, "the machine's runner token": runner.token, 'a fresh tokenless mint': minted.json.token };
    const before_ = stateOf();
    const events = ctx.hub.q('SELECT COUNT(*) AS n FROM events').get().n;
    const calls = { claim: { item: '#2' }, handoff: { item: '#1', headline: 'taken' }, submit: { item: '#1', headline: 'mine' }, progress: { item: '#1', headline: 'mine' }, signoff: {} };
    for (const [what, token] of Object.entries(asked)) {
      for (const [op, body] of Object.entries(calls)) {
        const r = await as('a1', token, op, body);
        assert.equal(r.status, 403, `${what}: ${op}`);
        assert.match(r.json.error, /"a1" is another agent's name here/, `${what}: ${op}`);
      }
    }
    assert.deepEqual(stateOf(), before_, 'nothing moved');
    assert.equal(ctx.hub.q('SELECT COUNT(*) AS n FROM events').get().n, events, 'and nothing is on the record');
  });

  test('each worker on a machine still acts under its own name, and the runner signs one off once its token is gone', async () => {
    assert.equal((await as('a1', own.a1, 'progress', { item: '#1', headline: 'going' })).status, 200);
    assert.equal((await as('a2', own.a2, 'claim', { item: '#2' })).status, 200);
    assert.equal((await as('a2', own.a2, 'progress', { item: '#2', headline: 'going too' })).status, 200);
    assert.equal((await as('a1', own.a1, 'handoff', { item: '#1', headline: 'stopping' })).status, 200);
    assert.equal(stateOf().find((i) => i.seq === 1).holder, null, 'its own hand-off works');
    // The order nuworq run uses: drop the worker's token, then sign it off with the runner token.
    ctx.server.auth.dropWorkerToken('a2');
    assert.equal((await as('a2', runner.token, 'signoff', { headline: 'exited' })).status, 200);
    assert.equal(stateOf().find((i) => i.seq === 2).holder, null, 'what it held went back');
  });

  test("the person's key, and a runner's workers with no token of their own, are unaffected", async () => {
    ctx.server.auth.dropWorkerToken('a1');
    assert.equal((await as('a1', ctx.server.personKey, 'checkin')).status, 200, "the person's key");
    assert.equal((await as('a3', runner.token, 'checkin')).status, 200, 'a shared runner token, with no worker token for that name');
  });
});

describe("a runner token and a name with no worker token, on a hub without logins (#923)", () => {
  let ctx, runner, made;
  const stateOf = () => ctx.hub.q('SELECT seq, stage, holder FROM items ORDER BY seq').all().map((i) => ({ ...i }));
  const as = (agent, token, op, body = {}) => request(ctx.port, 'POST', `/api/p/api/agent/${op}`, { body, headers: { authorization: `Bearer ${token}`, 'x-nuworq-agent': agent } });
  before(async () => {
    ctx = await start();
    ctx.hub.agentOp('api', 'checkin', 'starter', {});
    for (const title of ['first', 'second', 'third']) ctx.hub.humanOp('api', 'create', { title, acceptance: 'done' });
    runner = ctx.server.auth.localRunnerToken('box');
    made = ctx.server.auth.createToken('laptop', 'agent');
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test("a runner token can't act under the name of an agent last active with the person's key or a person-made token", async () => {
    assert.equal((await as('session-key', ctx.server.personKey, 'claim', { item: '#1' })).status, 200);
    assert.equal((await as('session-made', made, 'claim', { item: '#2' })).status, 200);
    const minted = await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} }); // any code on this machine can get one
    const before_ = stateOf();
    const events = ctx.hub.q('SELECT COUNT(*) AS n FROM events').get().n;
    const calls = (item) => ({ checkin: {}, claim: { item: '#3' }, handoff: { item, headline: 'taken' }, submit: { item, headline: 'mine' }, progress: { item, headline: 'mine' }, signoff: {} });
    for (const [name, item] of [['session-key', '#1'], ['session-made', '#2']]) {
      for (const [what, token] of Object.entries({ "the machine's runner token": runner.token, 'a fresh tokenless mint': minted.json.token })) {
        for (const [op, body] of Object.entries(calls(item))) {
          const r = await as(name, token, op, body);
          assert.equal(r.status, 403, `${name}, ${what}: ${op}`);
          assert.match(r.json.error, new RegExp(`"${name}" is another agent's name here`), `${name}, ${what}: ${op}`);
        }
      }
    }
    assert.deepEqual(stateOf(), before_, 'nothing moved');
    assert.equal(ctx.hub.q('SELECT COUNT(*) AS n FROM events').get().n, events, 'and nothing is on the record');
    // The two-step #923 closes: nothing was handed back, so the runner's own name can't take it.
    assert.equal((await as('thief', runner.token, 'claim', { item: '#1' })).status, 409);
    assert.equal(stateOf().find((i) => i.seq === 1).holder, 'session-key');
    // The session itself goes on.
    assert.equal((await as('session-key', ctx.server.personKey, 'progress', { item: '#1', headline: 'going' })).status, 200);
    assert.equal((await as('session-made', made, 'progress', { item: '#2', headline: 'going' })).status, 200);
  });

  test('workers sharing a runner token, with none of their own, still work under their own names', async () => {
    assert.equal((await as('shared-1', runner.token, 'checkin')).status, 200);
    assert.equal((await as('shared-2', runner.token, 'checkin')).status, 200);
    assert.equal((await as('shared-1', runner.token, 'claim', { item: '#3' })).status, 200);
    assert.equal((await as('shared-1', runner.token, 'progress', { item: '#3', headline: 'going' })).status, 200);
    assert.equal((await as('shared-1', runner.token, 'handoff', { item: '#3', headline: 'stopping' })).status, 200);
    assert.equal((await as('shared-2', runner.token, 'signoff', { headline: 'exited' })).status, 200);
    assert.equal(ctx.hub.q('SELECT COUNT(*) AS n FROM agents WHERE by_person = 1 AND name LIKE ?').get('shared-%').n, 0);
  });

  test("a worker's own token frees a name the person's key used, so its runner can still sign it off", async () => {
    assert.equal((await as('reused', ctx.server.personKey, 'checkin')).status, 200);
    assert.equal((await as('reused', runner.token, 'checkin')).status, 403);
    const parent = ctx.server.auth.verifyToken(runner.token).id;
    const own = ctx.server.auth.workerToken(parent, 'reused').token;
    assert.equal((await as('reused', own, 'checkin')).status, 200);
    ctx.server.auth.dropWorkerToken('reused');
    assert.equal((await as('reused', runner.token, 'signoff', { headline: 'exited' })).status, 200);
  });
});

describe('review and the runner a build was submitted under (#937)', () => {
  const as = (port, agent, token, op, body = {}) => request(port, 'POST', `/api/p/api/agent/${op}`, { body, headers: { authorization: `Bearer ${token}`, 'x-nuworq-agent': agent } });
  const review = (port, agent, token, item) => as(port, agent, token, 'review', { item, verdict: 'accept', headline: 'looks right' });
  const build = async (port, agent, token, item) => {
    assert.equal((await as(port, agent, token, 'claim', { item })).status, 200, `${agent} claims ${item}`);
    assert.equal((await as(port, agent, token, 'submit', { item, headline: 'done', evidence: [{ label: 'tests pass' }] })).status, 200);
  };

  describe('on a hub without logins', () => {
    let ctx;
    const mint = async () => (await request(ctx.port, 'POST', '/api/me/runner-token', { body: {} })).json.token; // any code on this machine can
    const stageOf = (item) => ctx.hub.item(ctx.hub.project('api'), item).stage;
    const offered = async (agent, token) => (await as(ctx.port, agent, token, 'next', { claim: false })).json;
    before(async () => {
      ctx = await start();
      ctx.hub.agentOp('api', 'checkin', 'starter', {});
      ctx.hub.humanOp('api', 'settings', { autonomy: 'full' }); // agents peer-review
      for (const title of ['first', 'second', 'third']) ctx.hub.humanOp('api', 'create', { title, acceptance: 'done' });
    });
    after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

    test('a runner token can\'t review work built under the same runner token by another name', async () => {
      const runner = await mint();
      await build(ctx.port, 'w-builder', runner, '#1');
      const parent = ctx.server.auth.verifyToken(runner).id;
      const asked = [
        ['the same runner token', 'w-fresh', runner],
        ['a fresh tokenless mint', 'w-minted', await mint()],
        ['a worker token of its own, when the builder had none', 'w-own', ctx.server.auth.workerToken(parent, 'w-own').token],
      ];
      for (const [what, name, token] of asked) {
        const r = await review(ctx.port, name, token, '#1');
        assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.json)}`);
        assert.match(r.json.error, /can't review your own work/, what);
        const next = await offered(name, token);
        assert.ok(!(next.mode === 'review' && next.item === '#1'), `${what}: next doesn't offer the review it would refuse`);
      }
      assert.equal(stageOf('#1'), 'verifying', 'still waiting for someone else');
      // The person's key reviews it.
      assert.equal((await review(ctx.port, 'session', ctx.server.personKey, '#1')).status, 200);
    });

    test('workers on one runner with worker tokens of their own still review each other (#658)', async () => {
      const runner = await mint();
      const parent = ctx.server.auth.verifyToken(runner).id;
      const own = { a: ctx.server.auth.workerToken(parent, 'own-a').token, b: ctx.server.auth.workerToken(parent, 'own-b').token };
      await build(ctx.port, 'own-a', own.a, '#2');
      // Its runner's token, which code worker A runs may reach, still can't review it under a fresh name.
      assert.match((await review(ctx.port, 'own-a-alias', runner, '#2')).json.error, /can't review your own work/);
      assert.deepEqual(await offered('own-b', own.b).then((r) => [r.mode, r.item]), ['review', '#2']);
      assert.equal((await review(ctx.port, 'own-b', own.b, '#2')).status, 200);
      assert.equal(stageOf('#2'), 'done');
    });
  });

  // The runner's device login mints its workers' tokens here (#941), so the check holds on this hub type too.
  describe('on a hub with logins (#941)', () => {
    let ctx;
    const stageOf = (item) => ctx.hub.item(ctx.hub.project('api'), item).stage;
    const offered = async (agent, token) => (await as(ctx.port, agent, token, 'next', { claim: false })).json;
    // What nuworq connect saves on a machine, and the runner token nuworq run mints from it for its workers.
    const machine = async (name, person) => {
      ctx.server.auth.addPerson(person, 'steward');
      const device = ctx.server.auth.createToken(name, 'agent', { mintedBy: person });
      const runner = (await request(ctx.port, 'POST', '/api/me/runner-token', { body: {}, headers: { authorization: `Bearer ${device}` } })).json.token;
      const own = async (worker) => (await request(ctx.port, 'POST', '/api/me/worker-token', { body: { name: worker, from: runner }, headers: { authorization: `Bearer ${device}` } })).json.token;
      return { runner, own };
    };
    before(async () => {
      ctx = await start({ auth: 'required' });
      ctx.hub.agentOp('api', 'checkin', 'starter', {});
      ctx.hub.humanOp('api', 'settings', { autonomy: 'full' });
      for (const title of ['first', 'second']) ctx.hub.humanOp('api', 'create', { title, acceptance: 'done' });
    });
    after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

    test("a runner token can't review work built under the same runner by another name", async () => {
      const laptop = await machine('rita@laptop', 'rita');
      await build(ctx.port, 'ci-a', laptop.runner, '#1');
      const asked = [
        ['the same runner token', 'ci-b', laptop.runner],
        ['a worker token of its own, when the builder had none', 'ci-own', await laptop.own('ci-own')],
      ];
      for (const [what, name, token] of asked) {
        const r = await review(ctx.port, name, token, '#1');
        assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.json)}`);
        assert.match(r.json.error, /can't review your own work/, what);
        const next = await offered(name, token);
        assert.ok(!(next.mode === 'review' && next.item === '#1'), `${what}: next doesn't offer the review it would refuse`);
      }
      assert.equal(stageOf('#1'), 'verifying', 'still waiting for someone else');
      // Another machine's worker reviews it.
      const desk = await machine('sam@desk', 'sam');
      assert.equal((await review(ctx.port, 'desk-w', await desk.own('desk-w'), '#1')).status, 200);
    });

    test('workers on one runner with worker tokens of their own still review each other (#656)', async () => {
      const laptop = await machine('olu@laptop', 'olu');
      const own = { a: await laptop.own('own-a'), b: await laptop.own('own-b') };
      await build(ctx.port, 'own-a', own.a, '#2');
      // Its runner's token, which code worker A runs may reach, still can't review it under a fresh name.
      assert.match((await review(ctx.port, 'own-a-alias', laptop.runner, '#2')).json.error, /can't review your own work/);
      assert.deepEqual(await offered('own-b', own.b).then((r) => [r.mode, r.item]), ['review', '#2']);
      assert.equal((await review(ctx.port, 'own-b', own.b, '#2')).status, 200);
      assert.equal(stageOf('#2'), 'done');
    });
  });
});

describe('required mode', () => {
  let ctx, human, agent;
  const H = () => ({ authorization: `Bearer ${human}` });
  before(async () => {
    ctx = await start({ auth: 'required' });
    human = ctx.server.auth.createToken('remy', 'human');
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
    // what a person let the project's workers reach (#472); worker_commands: what they may run beyond its checks (#768);
    // operators: for nuworq up (#559), which runs on connect's agent token; run_budget: so connect can tell whether
    // the hub's daily budget matches how this machine pays (#776).
    const list = await request(ctx.port, 'GET', '/api/projects', { headers: { authorization: `Bearer ${agent}` } });
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(Object.keys(list.json.find((p) => p.slug === 'demo')).sort(), ['name', 'operators', 'parked', 'path', 'remotes', 'run_budget', 'runner', 'sandbox_hosts', 'slug', 'worker_commands']);
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
    assert.deepEqual(me.json, { auth: 'required', role: 'human', name: 'remy' });

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

describe("a machine's workers on a hub with logins (#941)", () => {
  let ctx, device, runner, other;
  const post = (path, token, body = {}, agent) => request(ctx.port, 'POST', path, { body, headers: { authorization: `Bearer ${token}`, ...(agent ? { 'x-nuworq-agent': agent } : {}) } });
  const op = (name, token, agent, body = {}) => post(`/api/p/api/agent/${name}`, token, body, agent);
  before(async () => {
    ctx = await start({ auth: 'required' });
    ctx.hub.tx(() => ctx.hub.project('api', { create: true }));
    ctx.hub.humanOp('api', 'settings', { path: '/code/api', autonomy: 'full' });
    ctx.server.auth.addPerson('rita', 'steward');
    ctx.server.auth.addPerson('sam', 'steward');
    device = ctx.server.auth.createToken('rita@laptop', 'agent', { mintedBy: 'rita' }); // what nuworq connect saved
    runner = (await post('/api/me/runner-token', device)).json.token;
    const otherDevice = ctx.server.auth.createToken('sam@desk', 'agent', { mintedBy: 'sam' });
    other = { device: otherDevice, runner: (await post('/api/me/runner-token', otherDevice)).json.token };
  });
  after(() => { ctx.server.close(); ctx.server.closeAllConnections(); });

  test("only the machine's device login makes its workers' tokens, from the runner token it minted", async () => {
    const mint = (token, from = runner, name = 'w1') => post('/api/me/worker-token', token, { name, from });
    for (const [what, token] of Object.entries({ 'the runner token its workers carry': runner, "another machine's runner token": other.runner })) {
      const r = await mint(token);
      assert.equal(r.status, 403, what);
      assert.match(r.json.error, /only the machine's device login/, what);
    }
    const human = ctx.server.auth.createToken('rita-browser', 'human', { person: 'rita' });
    assert.equal((await mint(human)).status, 403, "a person's token isn't the machine's device login");
    assert.equal((await mint(device, other.runner)).status, 400, "another machine's runner token isn't this login's to hand out");
    const made = await mint(device);
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const own = ctx.server.auth.verifyToken(made.json.token);
    assert.deepEqual([own.worker, own.runner, own.operator], ['w1', 'rita@laptop', false]);
    assert.equal((await mint(made.json.token, made.json.token, 'w2')).status, 403, "a worker's token can't make another");
    // Another machine's login can't drop this machine's worker's token, even under the same name.
    assert.equal((await post('/api/me/worker-token', other.device, { name: 'w1', drop: true })).json.dropped, 0);
    assert.ok(ctx.server.auth.verifyToken(made.json.token), 'still live');
    assert.equal((await post('/api/me/worker-token', device, { name: 'w1', drop: true })).json.dropped, 1);
    assert.equal(ctx.server.auth.verifyToken(made.json.token), null, 'gone once its runner drops it');
  });

  test("one machine's workers review each other's work with their own tokens, and the runner still renews their leases (#656)", async () => {
    const own = async (name) => (await post('/api/me/worker-token', device, { name, from: runner })).json.token;
    const [a, b] = [await own('worker-a'), await own('worker-b')];
    const { item } = ctx.hub.humanOp('api', 'create', { title: 'Built by worker A', acceptance: 'x', priority: 'now' });
    assert.equal((await op('claim', a, 'worker-a', { item })).status, 200);
    // The runner token its workers came from vouches for them (#540).
    const report = await post('/api/runner', runner, { live: ['worker-a'] });
    assert.equal(report.json.renewed, 1, JSON.stringify(report.json));
    assert.equal((await post('/api/runner', other.runner, { live: ['worker-a'] })).json.renewed, 0, "another machine's runner doesn't");
    assert.equal((await op('submit', a, 'worker-a', { item, headline: 'done', evidence: [{ label: 'tests pass' }] })).status, 200);
    assert.equal((await op('checkin', b, 'worker-a')).status, 403, "worker B's token can't act as worker A");
    const r = await op('review', b, 'worker-b', { item, verdict: 'accept', headline: 'looks right' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // A worker's name is freed once its token goes, so the runner can still post its usage and sign it off.
    for (const name of ['worker-a', 'worker-b']) await post('/api/me/worker-token', device, { name, drop: true });
    assert.equal((await op('signoff', runner, 'worker-a')).status, 200);
  });
});
