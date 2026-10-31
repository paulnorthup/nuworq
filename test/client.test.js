import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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
});

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
      assert.deepEqual(await c.get('/api/health'), { ok: true });
      assert.deepEqual(seen, [undefined], 'the other host never saw the token');
      assert.equal(c.settings.url, url);
      assert.equal(JSON.parse(readFileSync(connectFile, 'utf8')).url, url);
      assert.equal(JSON.parse(readFileSync(join(dir, '.nuworq.json'), 'utf8')).url, url);
    } finally {
      hub.close();
      other.close();
    }
  });
});
