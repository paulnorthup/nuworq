import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '../src/client.js';

// A port nothing listens on (for now).
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
const client = (port, extra = {}) => createClient({ url: `http://127.0.0.1:${port}`, token: '', cwd: tmpdir(), ...extra });

describe('the client rides out a hub restart', () => {
  test('a call made while the hub is down waits for it to come back', async () => {
    const port = await freePort();
    const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"name":"nuworq"}'); });
    const late = setTimeout(() => server.listen(port, '127.0.0.1'), 1000);
    const t0 = Date.now();
    try {
      assert.deepEqual(await client(port).get('/api/health'), { ok: true, name: 'nuworq' });
      assert.ok(Date.now() - t0 >= 900, 'it waited for the hub to listen');
    } finally {
      clearTimeout(late);
      server.close();
    }
  });

  test('an HTTP error is an answer: thrown at once, not retried', async () => {
    let hits = 0;
    const server = createServer((req, res) => { hits++; res.statusCode = 503; res.setHeader('content-type', 'application/json'); res.end('{"error":"busy"}'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await assert.rejects(client(server.address().port).get('/api/projects'), (e) => e.status === 503 && e.message === 'busy');
      assert.equal(hits, 1);
    } finally {
      server.close();
    }
  });

  test('a hub that stays down is reported as not reachable once the retries run out', async () => {
    const port = await freePort();
    const t0 = Date.now();
    await assert.rejects(client(port, { retryMs: 400 }).get('/api/health'), /hub not reachable/);
    const took = Date.now() - t0;
    assert.ok(took >= 250 && took < 3000, `retried for a while, then gave up (${took}ms)`);
  });

  test("a proxy's 502 page while the hub restarts is waited out", async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      if (++hits <= 2) { res.statusCode = 502; res.setHeader('content-type', 'text/html'); return res.end('<html><body>Bad gateway</body></html>'); }
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const port = await listen(server);
    try {
      assert.deepEqual(await client(port).get('/api/health'), { ok: true });
      assert.equal(hits, 3);
    } finally {
      server.close();
    }
  });

  test('a proxy that keeps answering 502 is reported as restarting, without its page', async () => {
    const server = createServer((req, res) => { res.statusCode = 502; res.setHeader('content-type', 'text/html'); res.end('<html><body>Bad gateway</body></html>'); });
    const port = await listen(server);
    try {
      await assert.rejects(client(port, { retryMs: 400 }).get('/api/health'), (e) => e.status === 502 && /restarting or unreachable/.test(e.message) && !/</.test(e.message + e.hint));
    } finally {
      server.close();
    }
  });
});

const listen = async (server, host = '127.0.0.1') => { await new Promise((r) => server.listen(0, host, r)); return server.address().port; };
const json = (res, body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
// The old address: answers every /api call with a 308 to the same path at `to()`.
const mover = (to, seen = []) => createServer((req, res) => { seen.push(req.url); res.writeHead(308, { location: `${to()}${req.url}` }); res.end(); });

describe('a hub that moved to a subdomain', () => {
  // nuworq.com answers app paths with a 308 to app.nuworq.com. Names like app.hub.test don't resolve, so fetch is faked.
  const saved = () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-move-'));
    const connectFile = join(dir, 'connect.json');
    writeFileSync(connectFile, JSON.stringify({ url: 'https://hub.test', token: 'tok', added: ['claude'] }), { mode: 0o600 });
    writeFileSync(join(dir, '.nuworq.json'), JSON.stringify({ project: 'p', url: 'https://hub.test' }));
    return { dir, connectFile };
  };
  const fake = (calls) => async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization, redirect: init.redirect });
    const u = new URL(url);
    if (u.host === 'hub.test') return new Response(null, { status: 308, headers: { location: `https://app.hub.test${u.pathname}${u.search}` } });
    // The new address says it is the hub (#222), asked without the token.
    if (u.host === 'app.hub.test' && u.pathname.endsWith('/api/health')) return Response.json({ ok: true, name: 'nuworq', url: `https://app.hub.test${u.pathname.slice(0, -'/api/health'.length)}` });
    if (u.host === 'app.hub.test' && init.headers?.authorization === 'Bearer tok') return Response.json({ ok: true, at: u.pathname });
    return Response.json({ error: 'login required' }, { status: 401 });
  };

  test('the client moves there with its token, and saves the new address where the old one was', async (t) => {
    const { dir, connectFile } = saved();
    const calls = [];
    t.mock.method(globalThis, 'fetch', fake(calls));
    const c = createClient({ cwd: dir, connectFile, retryMs: 0 });
    assert.equal(c.settings.url, 'https://hub.test');
    assert.deepEqual(await c.get('/api/me?x=1'), { ok: true, at: '/api/me' });
    assert.equal(c.settings.url, 'https://app.hub.test');
    assert.deepEqual(JSON.parse(readFileSync(connectFile, 'utf8')), { url: 'https://app.hub.test', token: 'tok', added: ['claude'] });
    assert.equal(statSync(connectFile).mode & 0o777, 0o600, 'the token stays readable only by its owner');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.nuworq.json'), 'utf8')), { project: 'p', url: 'https://app.hub.test' });
    // From then on it asks the new address directly.
    calls.length = 0;
    await c.call('checkin', {}, { project: 'p' });
    assert.deepEqual(calls.map((x) => x.url), ['https://app.hub.test/api/p/p/agent/checkin']);
    // A new process reads the saved address and token.
    calls.length = 0;
    await createClient({ cwd: tmpdir(), connectFile, retryMs: 0 }).get('/api/me');
    assert.deepEqual(calls.map((x) => x.url), ['https://app.hub.test/api/me']);
  });

  test('a workspace address keeps its path', async (t) => {
    t.mock.method(globalThis, 'fetch', fake([]));
    const c = createClient({ url: 'https://hub.test/w/acme', token: 'tok', cwd: tmpdir(), connectFile: join(tmpdir(), 'nuworq-none.json'), retryMs: 0 });
    await c.get('/api/me');
    assert.equal(c.settings.url, 'https://app.hub.test/w/acme');
  });

  // Since #222 a redirect anywhere else fails with a hint rather than being followed without the token.
  test('a redirect anywhere else never carries the token and moves nothing', async () => {
    const { dir, connectFile } = saved();
    const seen = [];
    const other = createServer((req, res) => { seen.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
    await new Promise((r) => other.listen(0, '127.0.0.1', r));
    // 127.0.0.1 → localhost: another host, not a subdomain of it.
    const hub = createServer((req, res) => { res.writeHead(308, { location: `http://localhost:${other.address().port}${req.url}` }); res.end(); });
    await new Promise((r) => hub.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${hub.address().port}`;
    writeFileSync(connectFile, JSON.stringify({ url, token: 'tok' }), { mode: 0o600 });
    writeFileSync(join(dir, '.nuworq.json'), JSON.stringify({ project: 'p', url }));
    try {
      const c = createClient({ cwd: dir, connectFile, retryMs: 0 });
      assert.equal(c.settings.token, 'tok');
      await assert.rejects(c.get('/api/health'), (e) => e.status === 308 && /token was not sent/.test(e.message) && e.hint.includes('nuworq connect http://localhost:'));
      assert.deepEqual(seen, [], 'the other host was never asked, so never saw the token');
      assert.equal(c.settings.url, url);
      assert.equal(JSON.parse(readFileSync(connectFile, 'utf8')).url, url);
      assert.equal(JSON.parse(readFileSync(join(dir, '.nuworq.json'), 'utf8')).url, url);
    } finally {
      hub.close();
      other.close();
    }
  });
});

describe('the client follows a moved hub, and only a moved hub (#222)', () => {
  test('a 308 to the address the hub announces is followed with the token, and later calls go there directly', async () => {
    const auth = [], old = [];
    let newUrl;
    const hub = createServer((req, res) => {
      if (req.url === '/api/health') return json(res, { ok: true, name: 'nuworq', url: newUrl });
      auth.push(req.headers.authorization);
      json(res, { ok: true, at: 'new' });
    });
    newUrl = `http://127.0.0.1:${await listen(hub)}`;
    const from = mover(() => newUrl, old);
    const c = createClient({ url: `http://127.0.0.1:${await listen(from)}`, token: 'tok', cwd: tmpdir(), connectFile: join(tmpdir(), 'nuworq-none.json') });
    try {
      assert.deepEqual(await c.get('/api/projects'), { ok: true, at: 'new' });
      assert.deepEqual(await c.get('/api/projects'), { ok: true, at: 'new' });
      assert.deepEqual(auth, ['Bearer tok', 'Bearer tok']);
      assert.deepEqual(old, ['/api/projects'], 'the second call went straight to the new address');
      assert.equal(c.settings.url, newUrl);
    } finally {
      hub.close();
      from.close();
    }
  });

  test('a 308 to another host never gets the token: neither one that says nothing nor one on another site', async () => {
    const auth = [];
    let foreignUrl;
    const foreign = (announce) => createServer((req, res) => {
      auth.push(req.headers.authorization);
      if (req.url === '/api/health') return json(res, { ok: true, name: 'nuworq', ...(announce ? { url: foreignUrl } : {}) });
      json(res, { ok: true, at: 'foreign' });
    });
    for (const [host, announce] of [['127.0.0.1', false], ['localhost', true]]) {
      const there = foreign(announce);
      foreignUrl = `http://${host}:${await listen(there)}`;
      const from = mover(() => foreignUrl);
      try {
        await assert.rejects(client(await listen(from), { token: 'tok', connectFile: join(tmpdir(), 'nuworq-none.json') }).get('/api/projects'), (e) => e.status === 308 && /token was not sent/.test(e.message) && e.hint.includes(`nuworq connect ${foreignUrl}`));
      } finally {
        there.close();
        from.close();
      }
    }
    assert.ok(auth.every((a) => a === undefined), 'no request to a foreign host carried the token');
  });

  test('a session started before `nuworq connect` moved this machine reaches the new hub without a restart', { timeout: 20_000 }, async () => {
    const seen = [];
    const hub = createServer((req, res) => { seen.push(req.headers.authorization); json(res, { ok: true, at: 'new' }); });
    const port = await listen(hub);
    const home = mkdtempSync(join(tmpdir(), 'nuworq-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'nuworq-cwd-'));
    mkdirSync(join(home, '.nuworq'));
    const file = join(home, '.nuworq', 'connect.json');
    const dead = `http://127.0.0.1:${await freePort()}`;
    writeFileSync(file, JSON.stringify({ url: dead, token: 'old' }));
    // In a process of its own, so the client's connect.json is the one in this test's HOME.
    const script = `
      import { writeFileSync } from 'node:fs';
      const { createClient } = await import(${JSON.stringify(new URL('../src/client.js', import.meta.url).href)});
      const c = createClient({ cwd: ${JSON.stringify(cwd)}, retryMs: 200 });
      if (c.settings.url !== ${JSON.stringify(dead)}) throw new Error('started on ' + c.settings.url);
      writeFileSync(${JSON.stringify(file)}, JSON.stringify({ url: 'http://127.0.0.1:${port}', token: 'new' }));
      console.log(JSON.stringify(await c.get('/api/projects')));`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k)));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, HOME: home }, cwd });
      assert.deepEqual(JSON.parse(stdout), { ok: true, at: 'new' });
      assert.deepEqual(seen, ['Bearer new']);
    } finally {
      hub.close();
    }
  });
});
