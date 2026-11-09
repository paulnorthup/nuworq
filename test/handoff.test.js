import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname as dir } from 'node:path';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { system, follower } from '../src/follow.js';

const ROOT = join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Close a server that never listened: listen, then drain, so its timers stop.
const finish = async (server) => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); await server.drain(); };
const freePort =() => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

describe('the background loops run in one hub at a time (#523)', () => {
  const hubWithSweeps = () => {
    const h = new Hub();
    const n = { sweeps: 0 };
    h.sweep = () => { n.sweeps++; };
    return { h, n };
  };

  test('a standby hub runs no loops until it leads, and none after it goes quiet', async () => {
    const { h, n } = hubWithSweeps();
    const server = createServer(h, { standby: true, sweepMs: 20 });
    await sleep(100);
    assert.equal(n.sweeps, 0, 'standby: no sweeps');
    assert.equal(server.leading(), false);
    server.lead();
    await sleep(100);
    assert.ok(n.sweeps >= 2, `leading: swept ${n.sweeps} times`);
    server.quiet();
    const at = n.sweeps;
    await sleep(100);
    assert.equal(n.sweeps, at, 'quiet: no more sweeps');
    assert.equal(server.leading(), false);
    server.lead(); // it can lead again
    assert.equal(server.leading(), true);
    await finish(server);
  });

  test('a hub that is not on standby leads from the start, as before', async () => {
    const { h, n } = hubWithSweeps();
    const server = createServer(h, { sweepMs: 20 });
    await sleep(100);
    assert.ok(n.sweeps >= 2);
    await finish(server);
  });

  test('a connection passed in from outside is served, and drain waits for it', async () => {
    const h = new Hub();
    h.tx(() => h.project('o', { create: true }));
    const server = createServer(h, { standby: true });
    // The supervisor's part, in-process: accept, then hand the socket to adopt().
    const front = net.createServer({ pauseOnConnect: true }, (sock) => server.adopt(sock));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    const { port } = front.address();
    const get = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject));
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).name, 'nuworq');
    await server.drain();
    front.close();
  });

  test('passed-in connections keep the connection cap (#261): past it, one is dropped', async (t) => {
    const h = new Hub();
    h.tx(() => h.project('o', { create: true }));
    const server = createServer(h, { standby: true, maxConnections: 1 });
    const front = net.createServer({ pauseOnConnect: true }, (sock) => server.adopt(sock));
    await new Promise((r) => front.listen(0, '127.0.0.1', r));
    t.after(async () => { front.close(); await finish(server); });
    const { port } = front.address();
    const connect = () => new Promise((resolve) => { const c = net.connect(port, '127.0.0.1', () => resolve(c)); });
    const closed = (c) => new Promise((resolve) => { c.on('error', () => {}); c.once('close', () => resolve(true)); });
    const first = await connect();
    await sleep(50);
    const second = await connect();
    assert.equal(await Promise.race([closed(second), sleep(1000).then(() => false)]), true, 'the second is dropped');
    // The first is still served.
    first.write('GET /api/health HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n');
    const reply = await new Promise((resolve) => { let b = ''; first.on('data', (d) => { b += d; }); first.on('end', () => resolve(b)); });
    assert.match(reply, /^HTTP\/1.1 200/);
  });
});

describe('the follower swaps beside the running hub (#523)', () => {
  // A pretend world where the hub can hand over: stop() and start() must never be called.
  function stub({ swap = { ok: true }, beside = true } = {}) {
    const calls = [];
    const w = {
      calls, main: 'aaaaaaa1',
      head: () => w.main,
      checkout: () => calls.push('checkout'),
      start: async () => calls.push('start'),
      stop: async () => calls.push('stop'),
      healthy: async () => true,
      backup: (sha) => calls.push(`backup ${sha}`),
      restore: () => null,
      test: async () => ({ ok: true }),
      canSwap: () => beside,
      swap: async (sha) => { calls.push(`swap ${sha}`); return swap; },
      redMain: async () => null,
      close: async () => {},
    };
    return w;
  }
  const boot = async (w, lines) => {
    const f = follower(w, { log: (l) => lines.push(l) });
    await f.boot();
    w.calls.length = 0;
    return f;
  };

  test('a passed commit is started beside the running hub: nothing is stopped first', async () => {
    const w = stub(), lines = [];
    const f = await boot(w, lines);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.deepEqual(w.calls, ['backup aaaaaaa1', 'swap bbbbbbb2']);
    assert.equal(f.state.running, 'bbbbbbb2');
    assert.ok(lines.some((l) => /beside aaaaaaa, which serves until it is ready/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /moved to bbbbbbb with no gap/.test(l)));
  });

  test('one that does not come up is skipped, the old hub serves on, and nothing is stopped or restored', async () => {
    const w = stub({ swap: { ok: false, failed: 'it exited with code 3' } }), lines = [];
    const f = await boot(w, lines);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(f.state.running, 'aaaaaaa1');
    assert.equal(f.state.skip, 'bbbbbbb2');
    assert.ok(!w.calls.includes('stop') && !w.calls.includes('start'));
    assert.ok(lines.some((l) => /didn't come up beside aaaaaaa \(it exited with code 3\); aaaaaaa keeps serving, nothing was dropped/.test(l)));
  });

  test('where the hub cannot hand over, it restarts as before', async () => {
    const w = stub({ beside: false }), lines = [];
    const f = await boot(w, lines);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.deepEqual(w.calls.filter((c) => c !== 'checkout'), ['stop', 'backup aaaaaaa1', 'start']);
    assert.equal(f.state.running, 'bbbbbbb2');
  });
});

describe('a deploy with no gap (#523)', () => {
  // A copy of this checkout as a git repo of two commits, so the supervisor really places worktrees and runs two hubs.
  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'nuworq-handoff-'));
    const r = join(root, 'repo');
    mkdirSync(r);
    process.env.NUWORQ_DATA_DIR = root; // the hubs build their package here, not in ~/.nuworq
    const files = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter((f) => f && f.split('/')[0] !== 'docs' && !f.startsWith('test/'));
    for (const f of files) { mkdirSync(join(r, dir(f)), { recursive: true }); cpSync(join(ROOT, f), join(r, f)); }
    const git = (...a) => execFileSync('git', ['-C', r, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const one = git('rev-parse', 'HEAD');
    writeFileSync(join(r, 'CHANGELOG.md'), 'two\n');
    git('commit', '-qam', 'two');
    return { root, repo: r, one, two: git('rev-parse', 'HEAD'), git };
  }

  // A request every 50 ms on a fresh connection, until stop(); every answer or error is kept.
  function probe(port) {
    const seen = { ok: 0, bad: [] };
    let on = true;
    const loop = (async () => {
      while (on) {
        await new Promise((resolve) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false, timeout: 5000 }, (res) => {
            res.resume();
            res.on('end', () => { if (res.statusCode === 200) seen.ok++; else seen.bad.push(res.statusCode); resolve(); });
          });
          req.on('error', (e) => { seen.bad.push(e.code ?? e.message); resolve(); });
          req.on('timeout', () => req.destroy(new Error('timeout')));
        });
        await sleep(50);
      }
    })();
    return { seen, stop: async () => { on = false; await loop; } };
  }

  test('the new hub starts beside the old one, takes over, and no request is refused meanwhile', async (t) => {
    const w = repo();
    t.after(() => rmSync(w.root, { recursive: true, force: true }));
    const port = await freePort();
    const lines = [];
    const sys = system({
      repo: w.repo, dir: join(w.root, 'hub-src'), args: ['--demo', '--host', '127.0.0.1', '--port', String(port)],
      url: `http://127.0.0.1:${port}`, listen: { host: '127.0.0.1', port }, log: (l) => lines.push(l),
    });
    t.after(() => sys.close());
    sys.checkout(w.one);
    await sys.start();
    assert.equal(await sys.healthy(30_000), true, 'the first hub comes up');
    const p = probe(port);
    await sleep(300);
    assert.equal(sys.canSwap(w.two), true);
    const r = await sys.swap(w.two);
    assert.deepEqual(r, { ok: true });
    await sleep(300);
    await p.stop();
    assert.deepEqual(p.seen.bad, [], 'nothing refused, reset or failed');
    assert.ok(p.seen.ok >= 10, `${p.seen.ok} requests answered`);
    assert.equal(sys.alive(), true);
  });

  test('a browser signed in before a deploy with no gap stays signed in (#920)', async (t) => {
    const w = repo();
    const home = process.env.HOME;
    process.env.HOME = w.root; // the person's key lives under the home; this hub's must not be the real one
    t.after(() => { process.env.HOME = home; rmSync(w.root, { recursive: true, force: true }); });
    const port = await freePort();
    const sys = system({
      repo: w.repo, dir: join(w.root, 'hub-src'), args: ['--db', join(w.root, 'hub.db'), '--host', '127.0.0.1', '--port', String(port)],
      url: `http://127.0.0.1:${port}`, listen: { host: '127.0.0.1', port },
    });
    t.after(() => sys.close());
    sys.checkout(w.one);
    await sys.start();
    assert.equal(await sys.healthy(30_000), true);
    const get = (path, headers = {}) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ headers: res.headers, body }));
    }).on('error', reject));
    const key = readFileSync(join(w.root, '.nuworq', 'tokens', 'person.token'), 'utf8').trim();
    const credential = (await get(`/?person=${key}`)).headers.location.match(/#person=(\w+)$/)[1];
    const role = async () => JSON.parse((await get('/api/me', { 'x-nuworq-person': credential })).body).role;
    assert.equal(await role(), 'human');
    assert.deepEqual(await sys.swap(w.two), { ok: true });
    assert.equal(await role(), 'human');
  });

  test('a hub that does not come up leaves the old one serving, and nothing is dropped', async (t) => {
    const w = repo();
    t.after(() => rmSync(w.root, { recursive: true, force: true }));
    const port = await freePort();
    const sys = system({
      repo: w.repo, dir: join(w.root, 'hub-src'), args: ['--demo', '--host', '127.0.0.1', '--port', String(port)],
      url: `http://127.0.0.1:${port}`, listen: { host: '127.0.0.1', port },
    });
    t.after(() => sys.close());
    sys.checkout(w.one);
    await sys.start();
    assert.equal(await sys.healthy(30_000), true);
    // A commit whose bin exits at once.
    writeFileSync(join(w.repo, 'bin', 'nuworq.js'), 'process.exit(3);\n');
    w.git('commit', '-qam', 'broken');
    const broken = w.git('rev-parse', 'HEAD');
    const p = probe(port);
    await sleep(200);
    const r = await sys.swap(broken);
    assert.equal(r.ok, false);
    assert.match(r.failed, /exited with code 3/);
    await sleep(200);
    await p.stop();
    assert.deepEqual(p.seen.bad, []);
    assert.ok(p.seen.ok >= 5);
    assert.equal(sys.alive(), true, 'the old hub still serves');
  });

  test('a commit from before #523 is not swapped to: it restarts as it always did', async (t) => {
    const w = repo();
    t.after(() => rmSync(w.root, { recursive: true, force: true }));
    const port = await freePort();
    const sys = system({
      repo: w.repo, dir: join(w.root, 'hub-src'), args: ['--demo', '--host', '127.0.0.1', '--port', String(port)],
      url: `http://127.0.0.1:${port}`, listen: { host: '127.0.0.1', port },
    });
    t.after(() => sys.close());
    sys.checkout(w.one);
    await sys.start();
    assert.equal(await sys.healthy(30_000), true);
    w.git('rm', '-q', 'src/handoff.js');
    w.git('commit', '-qm', 'old');
    assert.equal(sys.canSwap(w.git('rev-parse', 'HEAD')), false);
  });
});
