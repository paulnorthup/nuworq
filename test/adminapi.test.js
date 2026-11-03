import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Workspaces } from '../src/workspaces.js';
import { createServer, ADMIN_ROUTES } from '../src/server.js';

const ADMIN = 'admin.example.test', APP = 'app.example.test';
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

function request(port, method, path, { host = APP, headers = {}, body } = {}) {
  const data = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), origin: `http://${host}` } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data ?? undefined);
  });
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const OWNER = 'remy@example.com';

// One hub of workspaces with an admin host; adminConsole: the directory it serves there, if any.
async function hub(adminConsole) {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-adminapi-')) });
  spaces.create('acme');
  const server = createServer(spaces, { publicUrl: `http://${APP}`, adminHost: ADMIN, earlyAccess: { owners: [OWNER], gate: true }, ...(adminConsole ? { adminConsole } : {}) });
  const port = await listen(server);
  const session = (email) => `nuworq_admin=${spaces.directory.createSession(spaces.directory.identify(email, 'github').id, 'admin')}`;
  return { spaces, server, port, session, close: () => { server.close(); server.closeAllConnections(); spaces.close(); } };
}

describe('docs/ADMIN-API.md documents the admin host (#877)', () => {
  let h;
  before(async () => { h = await hub(); });
  after(() => h.close());

  test('every route the admin host answers is documented, and the doc names no other', () => {
    const doc = readFileSync(new URL('../docs/ADMIN-API.md', import.meta.url), 'utf8');
    const documented = [...doc.matchAll(/^### (GET|POST|PUT|PATCH|DELETE) (\/\S+)\s*$/gm)].map((m) => `${m[1]} ${m[2]}`);
    assert.ok(documented.length >= 10, 'it reads the headings');
    assert.deepEqual(ADMIN_ROUTES.filter((r) => !documented.includes(r)), [], 'routes missing from docs/ADMIN-API.md');
    assert.deepEqual(documented.filter((r) => !ADMIN_ROUTES.includes(r)), [], 'docs/ADMIN-API.md names routes the admin host doesn\'t answer');
    assert.equal(new Set(documented).size, documented.length, 'each route once');
    // The list is the one the admin host checks requests against.
    assert.match(readFileSync(new URL('../src/server.js', import.meta.url), 'utf8'), /if \(!ADMIN_ROUTES\.includes\(`\$\{req\.method\} \$\{path\}`\)\)/);
  });

  test('the admin host answers each listed route, and a route it doesn\'t list is a 404', async () => {
    for (const r of ADMIN_ROUTES) {
      const [method, path] = r.split(' ');
      const res = await request(h.port, method, path, { host: ADMIN, ...(method === 'POST' ? { body: {} } : {}) });
      assert.notEqual(res.status, 404, r);
    }
    assert.equal((await request(h.port, 'GET', '/api/orgs', { host: ADMIN })).status, 404);
    assert.equal((await request(h.port, 'GET', '/api/workspaces', { host: ADMIN, headers: { cookie: h.session(OWNER) } })).status, 200);
  });

  test('the errors it documents for who may call: 401 signed out, 403 for a non-owner and for another origin', async () => {
    assert.equal((await request(h.port, 'GET', '/api/workspaces', { host: ADMIN })).status, 401);
    const zed = await request(h.port, 'GET', '/api/workspaces', { host: ADMIN, headers: { cookie: h.session('zed@example.com') } });
    assert.equal(zed.status, 403);
    assert.match(zed.json.hint, /NUWORQ_HUB_OWNERS/);
    const cross = await request(h.port, 'POST', '/api/workspaces/plan', { host: ADMIN, headers: { cookie: h.session(OWNER), origin: `http://${APP}` }, body: { workspace: 'acme', plan: 'free' } });
    assert.deepEqual([cross.status, cross.json.error], [403, 'missing or mismatched Origin header']);
  });
});

describe('the admin host serves an owner\'s own console from a directory (#877)', () => {
  let h, dir, outside;
  before(async () => {
    const root = mkdtempSync(join(tmpdir(), 'nuworq-console-'));
    dir = join(root, 'console');
    outside = join(root, 'outside');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Owner console</title><script src="/assets/app.js"></script>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'fetch("/api/workspaces")');
    writeFileSync(join(outside, 'secret.txt'), 'not for the web');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    symlinkSync(outside, join(dir, 'out'));
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n  url = https://x:not for the web@example.com/console.git');
    writeFileSync(join(dir, '.env'), 'SECRET=not for the web');
    writeFileSync(join(dir, 'assets', '.hidden'), 'not for the web');
    h = await hub(dir);
  });
  after(() => h.close());

  test('its page and files are served on the admin host, with the hub\'s content types and security headers', async () => {
    const page = await request(h.port, 'GET', '/', { host: ADMIN });
    assert.equal(page.status, 200);
    assert.match(page.text, /Owner console/);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const js = await request(h.port, 'GET', '/assets/app.js', { host: ADMIN });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    // The open dashboard isn't served beside it.
    assert.equal((await request(h.port, 'GET', '/admin.js', { host: ADMIN })).status, 404);
  });

  test('the app host never serves it', async () => {
    for (const path of ['/', '/index.html', '/assets/app.js']) {
      assert.doesNotMatch((await request(h.port, 'GET', path)).text, /Owner console|api\/workspaces/, path);
    }
    for (const path of ['/requests.html', '/w/acme/admin.html']) assert.equal((await request(h.port, 'GET', path)).headers.location, `http://${ADMIN}/`, path);
  });

  test('a path that escapes the directory, or names a dot-file, is a 404, symlinks included', async () => {
    for (const path of ['/../outside/secret.txt', '/%2e%2e/outside/secret.txt', '/assets/..%2f..%2foutside%2fsecret.txt', '/assets%5c..%5c..%5coutside%5csecret.txt', '/leak.txt', '/out/secret.txt', '/assets', '/nope.html', '/%E0%A4%A',
      '/.git/config', '/%2egit/config', '/.git%2fconfig', '/assets%5c..%5c.git%5cconfig', '/.env', '/assets/.hidden', '/assets/%2ehidden']) {
      const r = await request(h.port, 'GET', path, { host: ADMIN });
      assert.equal(r.status, 404, path);
      assert.doesNotMatch(r.text, /not for the web/, path);
    }
  });

  test('the admin API answers as without it: an owner reads workspaces, a non-owner still gets 403', async () => {
    const owner = await request(h.port, 'GET', '/api/workspaces', { host: ADMIN, headers: { cookie: h.session(OWNER) } });
    assert.equal(owner.status, 200);
    assert.deepEqual(owner.json.workspaces.map((w) => w.name), ['acme']);
    const zed = await request(h.port, 'GET', '/api/workspaces', { host: ADMIN, headers: { cookie: h.session('zed@example.com') } });
    assert.equal(zed.status, 403);
    assert.equal(zed.json.workspaces, undefined);
    assert.equal((await request(h.port, 'GET', '/api/workspaces', { host: ADMIN })).status, 401);
    assert.equal((await request(h.port, 'GET', '/api/oauth', { host: ADMIN })).status, 200);
    assert.equal((await request(h.port, 'GET', '/api/nope', { host: ADMIN })).status, 404);
  });

  test('serve refuses to start with such a console, by flag or variable, saying why and how to fix it', { timeout: 30_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'nuworq-adminapi-cli-'));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: home, NO_COLOR: '1' };
    const serve = (args, extra = {}) => promisify(execFile)(process.execPath, [BIN, 'serve', '--workspaces', '--port', '0', '--data-dir', join(home, 'data'), '--public-url', `http://${APP}`, ...args], { env: { ...env, ...extra } })
      .then(() => assert.fail('it started'), (e) => e);
    const empty = mkdtempSync(join(tmpdir(), 'nuworq-console-'));
    const flag = await serve(['--admin-host', ADMIN, '--admin-console', empty]);
    assert.equal(flag.code, 1);
    assert.match(flag.stderr, /error: the admin console directory .* has no index\.html/);
    assert.match(flag.stderr, /hint: .*--admin-console \(NUWORQ_ADMIN_CONSOLE\)/);
    assert.doesNotMatch(flag.stderr, /\n\s+at /, 'no stack trace');
    const variable = await serve([], { NUWORQ_ADMIN_CONSOLE: dir });
    assert.match(variable.stderr, /error: an admin console needs an admin host/);
    assert.match(variable.stderr, /hint: .*--admin-host/);
  });

  test('the hub refuses a console without an index.html or without an admin host, with a hint', () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-adminapi-')) });
    try {
      const empty = mkdtempSync(join(tmpdir(), 'nuworq-console-'));
      const refused = (opts, re) => assert.throws(() => createServer(spaces, opts), (e) => re.test(e.message) && /--admin-console|--admin-host/.test(e.hint));
      refused({ publicUrl: `http://${APP}`, adminHost: ADMIN, adminConsole: empty }, /no index\.html/);
      refused({ publicUrl: `http://${APP}`, adminHost: ADMIN, adminConsole: join(empty, 'missing') }, /doesn't exist/);
      refused({ publicUrl: `http://${APP}`, adminConsole: dir }, /needs an admin host/);
    } finally { spaces.close(); }
  });
});
