import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { Hub, prBody } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemLink } from '../src/issues.js';
import { compose, workspaceUrl } from '../src/notify.js';

// #119: the app lives at its public URL (app.nuworq.com), and everything it hands out points there.
const APP = 'https://app.test';
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
// fetch can't set Host, so a raw request does.
const get = (port, host, path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

describe('a hub at its public URL', () => {
  let hub, server, port;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('nuworq', { create: true }));
    server = createServer(hub, { publicUrl: APP, sweepMs: 3600_000, githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api: 'http://127.0.0.1:9' } });
    port = await listen(server);
  });
  after(() => { server.close(); server.closeAllConnections(); });

  test('it serves the app and announces its public URL', async () => {
    const r = await get(port, '127.0.0.1', '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('app.js'), 'the app shell');
    const health = await get(port, '127.0.0.1', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).url, APP, 'a client sent here by a redirect can trust it (#222)');
  });

  test('links the hub builds use the public URL', async () => {
    await get(port, '127.0.0.1', '/api/info'); // the hub learns its address on a request
    assert.equal(hub.publicUrl, APP);
    const p = hub.project('nuworq');
    const item = hub.humanOp('nuworq', 'create', { title: 'Some work', acceptance: 'x' }) && hub.item(p, '#1');
    const links = [
      prBody.call(hub, p, item), // pull request bodies
      itemLink(hub, p)(item), // issue comments
      compose([{ project: 'nuworq', name: 'nuworq', entry: { key: 'k', kind: 'question', item: '#1', headline: 'h' } }], hub.publicUrl).text, // pushes
      workspaceUrl('acme', { publicUrl: APP }),
    ];
    for (const l of links) assert.ok(l.includes(APP), l);
    assert.match(links[0], new RegExp(`${APP}/#/p/nuworq/1`));
  });

  test("the App manifest's callback, setup and hook URLs are on the public URL", async () => {
    const plain = createServer(new Hub(), { publicUrl: APP, sweepMs: 3600_000 });
    const pp = await listen(plain);
    try {
      const r = await get(pp, '127.0.0.1', '/api/github/app/new', 'GET', { authorization: `Bearer ${plain.personKey}` });
      assert.equal(r.status, 200);
      const m = JSON.parse(r.body.match(/name="manifest" value="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const urls = [m.url, m.redirect_url, m.setup_url, m.hook_attributes.url, ...(m.callback_urls ?? [])].filter(Boolean);
      assert.ok(urls.length >= 3, urls.join(' '));
      for (const u of urls) assert.ok(u.startsWith(APP), u);
    } finally { plain.close(); plain.closeAllConnections(); }
  });
});

// #164: nuworq.com is served from nuworq-site, so a unit that still passes --site-host starts as if it didn't.
test('serve with the old --site-host (or NUWORQ_SITE_HOST) starts normally and says once that it is ignored', { timeout: 20_000 }, async () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))),
    HOME: mkdtempSync(join(tmpdir(), 'nuworq-sitehost-')), NO_COLOR: '1', NUWORQ_SITE_HOST: 'nuworq.com',
  };
  const child = spawn(process.execPath, [BIN, 'serve', '--demo', '--port', '0', '--public-url', 'https://app.example', '--site-host', 'nuworq.com'], { env });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  try {
    for (let i = 0; i < 150 && !/Tool schemas/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /nuworq is running at/, out);
    assert.equal(out.match(/--site-host is ignored: nuworq\.com is served from nuworq-site/g)?.length, 1, out);
  } finally {
    child.kill('SIGTERM');
  }
});
