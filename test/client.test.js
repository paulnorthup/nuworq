import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '../src/client.js';
import { createServer as hubServer } from '../src/server.js';
import { Workspaces } from '../src/workspaces.js';

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

  // Cloudflare's 502 page is about 6 KB; none of it may reach an agent's context.
  const page = `<!DOCTYPE html><html><head><title>Bad gateway</title></head><body>${'<div>cloudflare</div>'.repeat(300)}</body></html>`;
  const answering = (status, type, body) => createServer((req, res) => { res.statusCode = status; res.setHeader('content-type', type); res.end(body); });

  for (const status of [502, 530]) {
    test(`a ${status} page from the proxy is one short line with a retry hint, naming the status and the host`, async () => {
      const server = answering(status, 'text/html; charset=UTF-8', page);
      const port = await listen(server);
      try {
        await assert.rejects(client(port, { retryMs: 0 }).call('look', {}, { agent: 'a' }), (e) => {
          assert.equal(e.message, `nuworq hub at http://127.0.0.1:${port} is restarting or unreachable (HTTP ${status} from 127.0.0.1:${port})`);
          assert.match(e.hint, /Try again in a minute/);
          return true;
        });
      } finally {
        server.close();
      }
    });
  }

  test('a proxy page is waited out for reads (checkin, look, next without claiming), never for writes', async () => {
    const hits = {};
    const server = createServer((req, res) => {
      const op = req.url.split('/').pop();
      hits[op] = (hits[op] ?? 0) + 1;
      res.statusCode = 502; res.setHeader('content-type', 'text/html'); res.end(page);
    });
    const port = await listen(server);
    const c = client(port, { retryMs: 400 });
    try {
      for (const [op, args] of [['comment', { headline: 'hi' }], ['submit', { item: '#1', headline: 'done' }], ['next', {}]]) {
        await assert.rejects(c.call(op, args, { agent: 'a' }), (e) => e.status === 502 && /restarting or unreachable/.test(e.message) && /look before sending it again/.test(e.hint));
      }
      assert.deepEqual(hits, { comment: 1, submit: 1, next: 1 });
      for (const [op, args] of [['checkin', {}], ['look', {}], ['next', { claim: false }]]) {
        hits[op] = 0;
        await assert.rejects(c.call(op, args, { agent: 'a' }), (e) => e.status === 502 && /Try again in a minute/.test(e.hint));
        assert.ok(hits[op] > 1, `${op} was sent ${hits[op]} time(s)`);
      }
    } finally {
      server.close();
    }
  });

  test('a web page at any other status, 200 included, is reported briefly, never echoed', async () => {
    for (const status of [200, 403, 404]) {
      const server = answering(status, 'text/html', page);
      const port = await listen(server);
      try {
        await assert.rejects(client(port).get('/api/projects'), (e) => e.status === status && /answered with a web page/.test(e.message) && e.message.length < 200 && !/</.test(e.message + e.hint) && /Try again/.test(e.hint));
      } finally {
        server.close();
      }
    }
  });

  test("a long plain-text error is cut to about 200 characters; the hub's JSON errors pass through as before", async () => {
    let server = answering(500, 'text/plain', 'x'.repeat(5000));
    let port = await listen(server);
    try {
      await assert.rejects(client(port).get('/api/projects'), (e) => e.status === 500 && e.message.length <= 201 && /Try again/.test(e.hint));
    } finally {
      server.close();
    }
    server = answering(400, 'application/json', JSON.stringify({ error: 'title is required', hint: 'Give a title.' }));
    port = await listen(server);
    try {
      await assert.rejects(client(port).get('/api/projects'), (e) => e.status === 400 && e.message === 'title is required' && e.hint === 'Give a title.');
    } finally {
      server.close();
    }
  });

  test("the hub's plain-text answers (the guide) still come back as text", async () => {
    const server = answering(200, 'text/markdown; charset=utf-8', '# nuworq\n');
    const port = await listen(server);
    try {
      assert.equal(await client(port).get('/api/guide'), '# nuworq\n');
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

  test('a 308 from https down to http on the same site is refused, and the http host is never asked', async () => {
    const calls = [];
    const real = globalThis.fetch;
    // TLS is beside the point here: a stand-in fetch plays the https hub and an http host that would vouch for itself.
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), auth: init.headers?.authorization });
      if (String(url).startsWith('https://')) return new Response(null, { status: 308, headers: { location: 'http://app.nuworq.test/api/projects' } });
      return new Response(JSON.stringify({ ok: true, name: 'nuworq', url: 'http://app.nuworq.test' }), { headers: { 'content-type': 'application/json' } });
    };
    try {
      const c = createClient({ url: 'https://nuworq.test', token: 'tok', cwd: tmpdir(), connectFile: join(tmpdir(), 'nuworq-none.json') });
      await assert.rejects(c.get('/api/projects'), (e) => e.status === 308 && /token was not sent/.test(e.message));
      assert.equal(c.settings.url, 'https://nuworq.test', 'it did not move');
    } finally {
      globalThis.fetch = real;
    }
    assert.deepEqual(calls.map((x) => x.url), ['https://nuworq.test/api/projects'], 'nothing went to the http host, not even its health check');
  });

  test('a workspace on a hub behind a tunnel: nuworq.com/w/acme → the public URL is followed with the token', async () => {
    // The real hub, in workspaces mode, with no --trust-proxy: it sees plain http, as behind Cloudflare. nuworq.com
    // isn't the hub's (nuworq-site serves it); it sends app paths on to the app with a 308.
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ws-')) });
    spaces.create('acme');
    const server = hubServer(spaces, { publicUrl: 'https://app.nuworq.test', sweepMs: 3600_000 });
    const port = await listen(server);
    const calls = [];
    const real = globalThis.fetch;
    // A stand-in fetch plays the TLS tunnel: https://<host>/<path> reaches the hub as http with that Host.
    globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
      const u = new URL(url);
      calls.push({ url: u.href, auth: init.headers?.authorization });
      if (u.host === 'nuworq.test') return resolve(new Response(null, { status: 308, headers: { location: `https://app.nuworq.test${u.pathname}${u.search}` } }));
      const req = request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: init.method ?? 'GET', headers: { ...init.headers, host: u.host } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(new Response([101, 204, 304].includes(res.statusCode) || chunks.length === 0 ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      });
      req.on('error', reject);
      req.end(init.body);
    });
    try {
      const c = createClient({ url: 'https://nuworq.test/w/acme', token: 'tok', cwd: tmpdir(), connectFile: join(tmpdir(), 'nuworq-none.json') });
      // 'tok' is no real token, so the workspace refuses it. That refusal comes back once: the address given
      // outright still names nuworq.com, and it must not send the call round the redirect again.
      await assert.rejects(c.get('/api/projects'), (e) => e.status === 401);
      assert.equal(c.settings.url, 'https://app.nuworq.test/w/acme', 'it moved to the workspace on the public URL');
      assert.deepEqual(calls.map((x) => [x.url, x.auth]), [
        ['https://nuworq.test/w/acme/api/projects', 'Bearer tok'],
        ['https://app.nuworq.test/w/acme/api/health', undefined],
        ['https://app.nuworq.test/w/acme/api/projects', 'Bearer tok'],
      ]);
    } finally {
      globalThis.fetch = real;
      server.close();
      server.closeAllConnections();
      spaces.close();
    }
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
