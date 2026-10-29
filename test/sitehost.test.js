import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Hub, prBody } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemLink } from '../src/issues.js';
import { compose, workspaceUrl } from '../src/notify.js';

// #119: the app lives at its public URL (app.nuworq.com); the site host (nuworq.com) serves the landing page
// and sends app paths, and old #/ links, on to the app.
const APP = 'https://app.test', SITE = 'site.test';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
// fetch can't set Host, so a raw request does.
const get = (port, host, path, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

describe('the site host and the app host', () => {
  let hub, server, port;
  before(async () => {
    hub = new Hub();
    hub.tx(() => hub.project('nuworq', { create: true }));
    server = createServer(hub, { publicUrl: APP, siteHost: SITE, sweepMs: 3600_000, githubApp: { id: 1, key: PEM, slug: 'nuworq-test', api: 'http://127.0.0.1:9' } });
    port = await listen(server);
  });
  after(() => { server.close(); server.closeAllConnections(); });

  test('app paths on the site host go to the same path and query on the public URL (308)', async () => {
    for (const [path, to] of [['/api/info', `${APP}/api/info`], ['/login.html?x=1', `${APP}/login.html?x=1`], ['/device.html', `${APP}/device.html`],
      ['/auth/github/start?ws=a', `${APP}/auth/github/start?ws=a`], ['/w/acme/', `${APP}/w/acme/`], ['/agents.md', `${APP}/agents.md`], ['/early-access', `${APP}/early-access`]]) {
      const r = await get(port, SITE, path);
      assert.equal(r.status, 308, path);
      assert.equal(r.headers.location, to);
    }
    assert.equal((await get(port, `${SITE}:443`, '/api/info', 'POST')).status, 308, 'any method, with a port too');
  });

  test('"/" on the site host is the landing page, its links on the public URL, its one script allowed by hash', async () => {
    const r = await get(port, SITE, '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /<section id="pricing"/);
    assert.match(r.body, new RegExp(`<html lang="en" data-app="${APP}">`));
    assert.match(r.body, new RegExp(`href="${APP}/early-access"`));
    assert.doesNotMatch(r.body, /app\.nuworq\.com/);
    const hash = createHash('sha256').update(script).digest('base64');
    const csp = r.headers['content-security-policy'];
    assert.match(csp, new RegExp(`script-src 'sha256-${hash.replace(/[+/]/g, '\\$&')}';`));
    assert.doesNotMatch(csp.match(/script-src [^;]*/)[0], /unsafe-inline|'self'/);
    const css = await get(port, SITE, '/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });

  test('the app host still serves the app', async () => {
    const r = await get(port, '127.0.0.1', '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('app.js'), 'the app shell');
    assert.doesNotMatch(r.body, /<section id="pricing"/);
    assert.equal((await get(port, '127.0.0.1', '/api/health')).status, 200);
  });

  test('links the hub builds use the public URL, never the site host', async () => {
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
    for (const l of links) {
      assert.ok(l.includes(APP), l);
      assert.ok(!l.includes(SITE), l);
    }
    assert.match(links[0], new RegExp(`${APP}/#/p/nuworq/1`));
  });

  test("the App manifest's callback, setup and hook URLs are on the public URL", async () => {
    const plain = createServer(new Hub(), { publicUrl: APP, siteHost: SITE, sweepMs: 3600_000 });
    const pp = await listen(plain);
    try {
      const r = await get(pp, '127.0.0.1', '/api/github/app/new');
      assert.equal(r.status, 200);
      const m = JSON.parse(r.body.match(/name="manifest" value="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      const urls = [m.url, m.redirect_url, m.setup_url, m.hook_attributes.url, ...(m.callback_urls ?? [])].filter(Boolean);
      assert.ok(urls.length >= 3, urls.join(' '));
      for (const u of urls) assert.ok(u.startsWith(APP) && !u.includes(SITE), u);
    } finally { plain.close(); plain.closeAllConnections(); }
  });

  test('without a site host nothing changes, and a site host needs a public URL', async () => {
    const plain = createServer(new Hub(), { sweepMs: 3600_000 });
    const pp = await listen(plain);
    try {
      const r = await get(pp, 'localhost', '/');
      assert.equal(r.status, 200);
      assert.doesNotMatch(r.body, /<section id="pricing"/);
    } finally { plain.close(); plain.closeAllConnections(); }
    assert.throws(() => createServer(new Hub(), { siteHost: SITE }), /--public-url/);
  });
});

describe("the landing page's redirect script (old nuworq.com/#/… links)", () => {
  const run = (hash, app = APP) => {
    let went = null;
    const location = { hash, replace: (u) => { went = u; } };
    const document = { documentElement: { getAttribute: (n) => (n === 'data-app' ? app : null) } };
    new Function('document', 'location', script)(document, location);
    return went;
  };
  test('an app route goes to the same route on the app; anything else stays', () => {
    assert.equal(run('#/p/nuworq/12'), `${APP}/#/p/nuworq/12`);
    assert.equal(run('#/'), `${APP}/#/`);
    assert.equal(run(''), null);
    assert.equal(run('#pricing'), null);
  });
});
