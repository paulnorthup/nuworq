import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Hub } from '../src/core.js';
import { createServer, recentIn, MAX_HELD, MAX_CONNECTIONS } from '../src/server.js';
import { Workspaces } from '../src/workspaces.js';
import { Directory } from '../src/directory.js';
import { Auth } from '../src/auth.js';
import { forgetWorkspace } from '../src/follow.js';
import { appSource } from './appsource.js';

// #479: the hub's web edge, hardened.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP = { id: 1, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), slug: 'nuworq-test', api: 'http://127.0.0.1:9' };
const tmp = (p) => mkdtempSync(join(tmpdir(), `nuworq-edge-${p}-`));
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const stop = (server) => { server.close(); server.closeAllConnections(); };
// A raw request, so Host and the forwarding headers are what the test says.
const call = (port, method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
    let text = '';
    res.on('data', (c) => (text += c));
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json, text }); });
  });
  req.on('error', reject);
  req.end(body && JSON.stringify(body));
});
const single = () => { const hub = new Hub(); hub.tx(() => hub.project('demo', { create: true })); return hub; };

describe('who is asking: the client address behind a proxy', () => {
  const start = async (opts) => {
    const spaces = new Workspaces({ dir: tmp('ip') });
    const seen = [];
    const server = createServer(spaces, { sweepMs: 3600_000, earlyAccess: { owners: ['o@example.com'], verify: async (_t, ip) => { seen.push(ip); return true; } }, ...opts });
    return { spaces, server, seen, port: await listen(server) };
  };
  const ask = (port, headers, n) => call(port, 'POST', '/api/early-access', { headers: { origin: `http://127.0.0.1:${port}`, ...headers }, body: { email: `p${n}@example.com`, turnstile: 'ok' } });

  test('behind a proxy: CF-Connecting-IP, else the rightmost hop that is not the proxies\' own; the leftmost is never believed', async () => {
    const h = await start({ trustProxy: true });
    try {
      await ask(h.port, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, 1);
      await ask(h.port, { 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2, 127.0.0.1' }, 2);
      await ask(h.port, { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '198.51.100.7' }, 3);
      assert.deepEqual(h.seen, ['203.0.113.9', '203.0.113.9', '198.51.100.7']);
    } finally { stop(h.server); }
  });

  test('a client changing the left of X-Forwarded-For stays one address to the limit', async () => {
    const h = await start({ trustProxy: true });
    try {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await ask(h.port, { 'x-forwarded-for': `6.6.6.${i}, 203.0.113.9` }, i)).status);
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429], 'the 6th within the hour is refused, whatever it wrote');
    } finally { stop(h.server); }
  });

  test('without --trust-proxy the headers are ignored', async () => {
    const h = await start({});
    try {
      await ask(h.port, { 'x-forwarded-for': '6.6.6.6', 'cf-connecting-ip': '198.51.100.7' }, 1);
      assert.deepEqual(h.seen, ['127.0.0.1']);
    } finally { stop(h.server); }
  });

  test('the limiter evicts its oldest addresses at the cap, never clearing the one being limited', () => {
    const map = new Map();
    const now = 1_000_000;
    recentIn(map, 'busy', 60_000, now, 3).push(now, now, now);
    for (const ip of ['a', 'b', 'c', 'd']) recentIn(map, ip, 60_000, now, 3).push(now);
    assert.equal(map.size, 3);
    assert.deepEqual([...map.keys()], ['b', 'c', 'd'], 'oldest first out');
    recentIn(map, 'busy', 60_000, now, 3).push(now, now, now);
    recentIn(map, 'b', 60_000, now, 3);
    recentIn(map, 'e', 60_000, now, 3);
    assert.equal(recentIn(map, 'busy', 60_000, now, 3).length, 3, 'seen recently, so kept while new addresses arrive');
  });
});

describe("early-access addresses can't be undone", () => {
  test('an HMAC under a key only the database holds; plain hashes from before it are cleared', () => {
    const dir = new Directory(join(tmp('hmac'), 'directory.sqlite'));
    const plain = createHash('sha256').update('203.0.113.9').digest('hex');
    dir.db.prepare("INSERT INTO access_requests (email, ip_hash, created_at, updated_at) VALUES ('old@example.com', ?, 1, 1)").run(plain);
    dir.request({ email: 'ann@example.com', ip: '203.0.113.9' });
    const rows = Object.fromEntries(dir.db.prepare('SELECT email, ip_hash FROM access_requests').all().map((r) => [r.email, r.ip_hash]));
    assert.equal(rows['old@example.com'], '', 'the old reversible hash is gone');
    assert.notEqual(rows['ann@example.com'], plain);
    assert.match(rows['ann@example.com'], /^[0-9a-f]{64}$/);
    assert.equal(dir.ipHash('203.0.113.9'), rows['ann@example.com'], 'stable, so the same address still matches');
    const other = new Directory(join(tmp('hmac2'), 'directory.sqlite'));
    assert.notEqual(other.ipHash('203.0.113.9'), rows['ann@example.com'], 'each hub its own key');
  });
});

describe('links leave from the configured address only', () => {
  const start = async (opts) => {
    const spaces = new Workspaces({ dir: tmp('links') });
    spaces.create('acme');
    const hub = spaces.get('acme');
    const token = new Auth(hub.db).createToken('boss', 'human');
    const server = createServer(spaces, { sweepMs: 3600_000, trustProxy: true, githubApp: APP, ...opts });
    return { hub, server, token, port: await listen(server) };
  };
  const forged = (h) => call(h.port, 'GET', '/w/acme/api/info', { headers: { authorization: `Bearer ${h.token}`, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } });

  test('on a shared hub, a forged X-Forwarded-Host never becomes the links in pull requests and issues', async () => {
    const h = await start({ publicUrl: 'https://app.test' });
    try {
      assert.equal((await forged(h)).status, 200);
      assert.equal(h.hub.publicUrl, 'https://app.test/w/acme');
    } finally { stop(h.server); }
  });

  test('a shared hub with no public URL builds no absolute links at all', async () => {
    const h = await start({});
    try {
      await forged(h);
      assert.equal(h.hub.publicUrl, '');
    } finally { stop(h.server); }
  });
});

describe('headers and errors', () => {
  test('HSTS whenever the public URL is https, and only then', async () => {
    for (const [publicUrl, want] of [['https://app.test', 'max-age=31536000; includeSubDomains'], ['http://127.0.0.1:1', undefined], ['', undefined]]) {
      const server = createServer(single(), { sweepMs: 3600_000, publicUrl });
      const port = await listen(server);
      try {
        assert.equal((await call(port, 'GET', '/api/health')).headers['strict-transport-security'], want, publicUrl || 'no public URL');
        assert.equal((await call(port, 'GET', '/')).headers['strict-transport-security'], want);
      } finally { stop(server); }
    }
  });

  test('a 500 says "something went wrong" with an id; the log has the error under that id', async () => {
    const hub = single();
    const server = createServer(hub, { sweepMs: 3600_000 });
    const port = await listen(server);
    const logged = [];
    const was = console.error;
    const projects = hub.projects;
    hub.projects = () => { throw new Error('ENOENT /srv/secret/path/nuworq.db'); };
    console.error = (...a) => logged.push(a);
    try {
      const r = await call(port, 'GET', '/api/projects');
      assert.equal(r.status, 500);
      assert.equal(r.json.error, 'something went wrong');
      assert.match(r.json.id, /^[0-9a-f]{12}$/);
      assert.doesNotMatch(r.text, /secret|ENOENT/);
      assert.ok(logged.some((a) => String(a[0]).includes(r.json.id) && /secret\/path/.test(String(a[1]?.message))), 'the log keeps it');
    } finally {
      console.error = was;
      hub.projects = projects;
      stop(server);
    }
  });

  test("/api/info names the CLI's path on a single hub, never on a shared one", async () => {
    const server = createServer(single(), { sweepMs: 3600_000 });
    let port = await listen(server);
    try { assert.match((await call(port, 'GET', '/api/info')).json.bin, /bin\/nuworq\.js$/); } finally { stop(server); }
    const spaces = new Workspaces({ dir: tmp('info') });
    spaces.create('acme');
    const token = new Auth(spaces.get('acme').db).createToken('boss', 'human');
    const shared = createServer(spaces, { sweepMs: 3600_000 });
    port = await listen(shared);
    try {
      const r = await call(port, 'GET', '/w/acme/api/info', { headers: { authorization: `Bearer ${token}` } });
      assert.equal(r.status, 200);
      assert.equal('bin' in r.json, false);
    } finally { stop(shared); }
  });
});

describe('held connections are capped', () => {
  test(`a sign-in holds at most ${MAX_HELD.stream} streams; closing one frees its place; the server caps its sockets`, async () => {
    const server = createServer(single(), { sweepMs: 3600_000 });
    const port = await listen(server);
    assert.equal(server.maxConnections, MAX_CONNECTIONS);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 100 });
    const open = () => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/stream', agent }, (res) => resolve({ res, req }));
      req.on('error', reject);
    });
    const streams = [];
    try {
      for (let i = 0; i < MAX_HELD.stream; i++) streams.push(await open());
      assert.ok(streams.every((s) => s.res.statusCode === 200));
      const over = await open();
      assert.equal(over.res.statusCode, 429);
      over.res.resume();
      streams.shift().req.destroy();
      await new Promise((r) => setTimeout(r, 50));
      const again = await open();
      assert.equal(again.res.statusCode, 200, 'a closed stream gives its place back');
      streams.push(again);
    } finally {
      for (const s of streams) s.req.destroy();
      agent.destroy();
      stop(server);
    }
  });
});

describe('the board takes only what it knows', () => {
  test("inherited keys aren't priorities", () => {
    const hub = single();
    hub.humanOp('demo', 'create', { title: 'One', acceptance: 'x', priority: 'constructor' });
    hub.agentOp('demo', 'checkin', 'w1', {});
    const p = hub.project('demo');
    assert.equal(hub.item(p, '#1').priority, 'soon', 'falls back to the default');
    assert.equal(hub.item(p, '#1').priority_by, '', 'and no person chose it');
    hub.agentOp('demo', 'refine', 'w1', { item: '#1', priority: 'toString' });
    assert.equal(hub.item(p, '#1').priority, 'soon');
    hub.agentOp('demo', 'refine', 'w1', { item: '#1', priority: 'now' });
    assert.equal(hub.item(p, '#1').priority, 'now');
  });

  test('patch() and move() take only columns the items table has', () => {
    const hub = single();
    hub.humanOp('demo', 'create', { title: 'One', acceptance: 'x' });
    const item = hub.item(hub.project('demo'), '#1');
    assert.throws(() => hub.patch(item, { 'title = 1, stage': 'x' }), /no column/);
    assert.throws(() => hub.move(item, 'done', 'you', { 'holder = NULL --': 1 }), /no column/);
    assert.throws(() => hub.patch(item, { id: 9 }), /no column/);
    hub.patch(item, { summary: 'fine' });
    assert.equal(hub.item(hub.project('demo'), '#1').summary, 'fine');
    assert.equal(hub.item(hub.project('demo'), '#1').stage, 'ready', 'the refused move changed nothing');
  });
});

describe('the page', () => {
  const app = appSource();
  // md() and stepsBy() as the page has them, run on their own.
  const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
  const src = [slice('const esc =', '\n'), slice('const FLAG', 'function providerOf'), slice('const stepsBy', '\n\n')].join('\n').replace(/^export /gm, '');
  const { md, inline, stepsBy } = new Function(`${src}; return { md, inline, stepsBy };`)();

  test('md() links in one pass: a URL inside a link never breaks out of its href', () => {
    const out = md('[x](https://a.test/(https://b.test/" onmouseover="alert(1))');
    assert.equal((out.match(/<a /g) ?? []).length, 1);
    assert.doesNotMatch(out, /href="[^"]*<a/);
    assert.doesNotMatch(out, /onmouseover="/);
    const label = md('[see https://b.test](https://a.test)');
    assert.equal((label.match(/<a /g) ?? []).length, 1, "a link's label isn't linked again");
    assert.equal(md('go to https://a.test/x now'), '<p>go to <a href="https://a.test/x" target="_blank" rel="noopener">https://a.test/x</a> now</p>');
    assert.equal(md('**bold `code`** and `https://not.a.link`'), '<p><strong>bold <code>code</code></strong> and <code>https://not.a.link</code></p>');
  });

  test('a flag stays whole on a phone (#716): in a sentence and in inline code, never in a URL or a word', () => {
    const f = (x) => `<span class="flag">${x}</span>`;
    assert.equal(inline('Run `nuworq run --workers 1` (add --here), not a-b or x--y'),
      `Run <code>nuworq run ${f('--workers')} 1</code> (add ${f('--here')}), not a-b or x--y`);
    assert.equal(inline('`--here` and a lone ` tick'), `<code>${f('--here')}</code> and a lone \` tick`);
    assert.equal(md('takes --can-read-keys, `--browser` or https://a.test/--x'),
      `<p>takes ${f('--can-read-keys')}, <code>${f('--browser')}</code> or <a href="https://a.test/--x" target="_blank" rel="noopener">https://a.test/--x</a></p>`);
    assert.equal(md('**`--b` --c**'), `<p><strong><code>${f('--b')}</code> ${f('--c')}</strong></p>`);
    assert.equal(inline('`--staff nuworq-app docs/a-b.md`'), `<code>${f('--staff')} nuworq-app docs/a-b.md</code>`, 'a word or path still wraps');
    const slug = 'nuworq-716-commands-on-a-phone-wrap-only-at-spaces-and-more';
    assert.equal(md(`The branch \`${slug}\` is pushed.`), `<p>The branch <code>${slug}</code> is pushed.</p>`, 'a long kebab word wraps at its hyphens');
  });

  test("an agent's steps say who wrote them and that the hub didn't; a person's and the hub's say nothing", () => {
    assert.match(stepsBy('claude-1234'), /Written by claude-1234, an agent, not by nuworq/);
    assert.match(stepsBy('<b>x</b>'), /&lt;b&gt;/);
    for (const by of ['you', '@paul', 'nuworq', '', undefined]) assert.equal(stepsBy(by), '', String(by));
    assert.match(app, /\$\{stepsBy\(a\.question\.asked_by\)\}/, 'the Needs you checklist shows it');
  });
});

describe('backups go with a removed workspace', () => {
  test("follow's copies of it, and the dated copy it was adopted from, are deleted; other workspaces' stay", () => {
    const data = tmp('bk');
    const backups = join(data, 'backups');
    const spaces = new Workspaces({ dir: join(data, 'workspaces'), backups });
    const single = join(data, 'nuworq.db');
    new Hub({ file: single }).db.close();
    const { backup } = spaces.adopt('acme', single);
    spaces.create('globex');
    for (const sha of ['aaa', 'bbb']) {
      mkdirSync(join(backups, sha), { recursive: true });
      for (const ws of ['acme', 'globex']) writeFileSync(join(backups, sha, `${ws}.db`), 'x');
    }
    assert.ok(existsSync(backup));
    spaces.remove('acme');
    assert.ok(!existsSync(backup), 'the dated copy');
    for (const sha of ['aaa', 'bbb']) {
      assert.ok(!existsSync(join(backups, sha, 'acme.db')), `backups/${sha}/acme.db`);
      assert.ok(existsSync(join(backups, sha, 'globex.db')), 'another workspace keeps its copies');
    }
    assert.ok(existsSync(single), "the single hub's own database is the host's, untouched");
    assert.equal(forgetWorkspace(join(data, 'nowhere'), 'acme'), 0);
  });

  test('DEPLOY.md says how long copies are kept and that removing a workspace deletes them', () => {
    const deploy = readFileSync(new URL('../docs/DEPLOY.md', import.meta.url), 'utf8');
    assert.match(deploy, /\*\*How long copies are kept\.\*\*/);
    assert.match(deploy, /`nuworq workspace remove <name>` deletes the workspace's database, its copy in every `backups\/<sha>\/` folder/);
  });
});
