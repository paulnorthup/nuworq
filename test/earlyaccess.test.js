import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { turnstile } from '../src/directory.js';
import { Auth } from '../src/auth.js';
import { addChannel, composeRequest } from '../src/notify.js';
import http from 'node:http';

// A workspaces hub in early access: paul owns it, "good" is the only Turnstile token that passes.
async function hub({ gate = true } = {}) {
  const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) });
  const checked = [];
  const verify = async (token, ip) => { checked.push({ token, ip }); return token === 'good'; };
  const server = createServer(spaces, { earlyAccess: { owners: ['paul@example.com'], verify, gate, sitekey: '0xSITEKEY' } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = spaces.directory;
  const as = (email) => `nuworq_id=${dir.createSession(dir.identify(email, 'github').id)}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { spaces, dir, base, as, call, checked, close: () => server.close() };
}

describe('early access', () => {
  test('the form: a passing Turnstile token is stored; none or a bad one is refused; the same email is one request; 5 an hour per address', async () => {
    const h = await hub();
    try {
      assert.equal((await h.call('POST', '/api/early-access', { email: 'ann@example.com' })).status, 400, 'no token');
      assert.equal((await h.call('POST', '/api/early-access', { email: 'ann@example.com', turnstile: 'bad' })).status, 400);
      const ok = await h.call('POST', '/api/early-access', { email: 'Ann@Example.com', github: '@ann', building: 'a CLI', turnstile: 'good' });
      assert.deepEqual(ok.json, { ok: true, state: 'new', created: true });
      const again = await h.call('POST', '/api/early-access', { email: 'ann@example.com', building: 'a CLI and an API', turnstile: 'good' });
      assert.equal(again.status, 200);
      const rows = h.dir.requests();
      assert.equal(rows.length, 1, 'merged');
      assert.equal(rows[0].building, 'a CLI and an API');
      assert.equal(rows[0].github, 'ann', 'what they left out the second time is kept');
      assert.equal((await h.call('POST', '/api/early-access', { email: 'bob@example.com', turnstile: 'good' })).status, 200, 'the 5th attempt from this address');
      assert.equal((await h.call('POST', '/api/early-access', { email: 'cy@example.com', turnstile: 'good' })).status, 429, 'the 6th within the hour, passing or not, is refused');
      assert.ok(h.checked.every((c) => c.ip), 'Turnstile hears the address');
    } finally { h.close(); }
  });

  test('owners list and decide; approve gives a link; decline mints nothing; others get 403', async () => {
    const h = await hub();
    try {
      await h.call('POST', '/api/early-access', { email: 'ann@example.com', turnstile: 'good' });
      await h.call('POST', '/api/early-access', { email: 'cy@example.com', turnstile: 'good' });
      const paul = h.as('paul@example.com'), ann = h.as('ann@example.com');
      assert.equal((await h.call('GET', '/api/early-access', null, ann)).status, 403);
      const list = (await h.call('GET', '/api/early-access?state=new', null, paul)).json.requests;
      assert.deepEqual(list.map((r) => r.email).sort(), ['ann@example.com', 'cy@example.com']);
      const annId = list.find((r) => r.email === 'ann@example.com').id;
      const yes = await h.call('POST', '/api/early-access/decide', { id: annId, approve: true }, paul);
      assert.match(yes.json.link, /\/\?grant=[\w-]{20,}$/);
      const no = await h.call('POST', '/api/early-access/decide', { id: list.find((r) => r.email === 'cy@example.com').id, approve: false }, paul);
      assert.deepEqual(no.json, { ok: true, state: 'declined' });
      assert.equal(h.dir.db.prepare('SELECT COUNT(*) AS n FROM org_grants').get().n, 1, 'decline minted nothing');
      assert.equal((await h.call('POST', '/api/early-access/decide', { id: annId, approve: true }, ann)).status, 403);
    } finally { h.close(); }
  });

  test('with the gate on, an organization takes a grant, once; the owners need none; without the gate nothing changes', async () => {
    const h = await hub();
    try {
      await h.call('POST', '/api/early-access', { email: 'ann@example.com', turnstile: 'good' });
      const paul = h.as('paul@example.com'), ann = h.as('ann@example.com');
      const refused = await h.call('POST', '/api/orgs', { slug: 'annco' }, ann);
      assert.equal(refused.status, 403);
      assert.match(refused.json.hint, /Request access/);
      const id = h.dir.requests()[0].id;
      const grant = new URL((await h.call('POST', '/api/early-access/decide', { id, approve: true }, paul)).json.link).searchParams.get('grant');
      const made = await h.call('POST', '/api/orgs', { slug: 'annco', grant }, ann);
      assert.equal(made.status, 200, JSON.stringify(made.json));
      assert.equal(made.json.role, 'owner');
      assert.equal((await h.call('POST', '/api/orgs', { slug: 'annco2', grant }, ann)).status, 403, 'a grant works once');
      assert.equal((await h.call('POST', '/api/orgs', { slug: 'paulco' }, paul)).status, 200, "the hub's owners need no grant");
      const page = await fetch(`${h.base}/?grant=${grant}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Welcome to nuworq/, 'the link lands on the join page');
    } finally { h.close(); }

    const open = await hub({ gate: false });
    try {
      assert.equal((await open.call('POST', '/api/orgs', { slug: 'free' }, open.as('zed@example.com'))).status, 200);
    } finally { open.close(); }
  });

  test('the form: /early-access answers without sign-in, may load Turnstile, and is told only the site key', async () => {
    const h = await hub();
    try {
      const page = await fetch(`${h.base}/early-access`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type'), /text\/html/);
      const csp = page.headers.get('content-security-policy');
      assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
      assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
      const html = await page.text();
      assert.match(html, /<form id="ask"/);
      assert.match(html, /\/early-access\.js/);
      // What asking agrees to (#232): nuworq.com's terms and privacy pages, each in a new tab.
      assert.match(html, /By asking you agree to the <a [^>]*>terms<\/a> and <a [^>]*>privacy policy<\/a>/);
      for (const page of ['terms', 'privacy']) assert.match(html, new RegExp(`<a href="https://nuworq\\.com/${page}" target="_blank" rel="noopener">`), page);
      // It looks like the sign-in card (#121): both stylesheets come from the hub's own address.
      assert.match(html, /href="\/login\.css"/);
      for (const css of ['/style.css', '/login.css']) assert.match((await fetch(h.base + css)).headers.get('content-type'), /text\/css/, css);
      assert.equal((await fetch(`${h.base}/early-access.js`)).status, 200);
      assert.deepEqual(await (await fetch(`${h.base}/api/early-access/config`)).json(), { sitekey: '0xSITEKEY', open: true });
      // Only that page may load Turnstile.
      assert.doesNotMatch((await fetch(`${h.base}/requests.html`)).headers.get('content-security-policy'), /cloudflare/);
    } finally { h.close(); }
  });

  test("nuworq.com's form may call the form's APIs cross-origin (#245); no other origin or endpoint may", async () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) });
    // The site is the app's parent domain (#164): no flag names it.
    const server = createServer(spaces, {
      publicUrl: 'https://app.nuworq.com',
      earlyAccess: { owners: ['paul@example.com'], verify: async (t) => t === 'good', gate: true, sitekey: '0xSITEKEY' },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const site = 'https://nuworq.com';
    const ask = (origin, b) => fetch(`${base}/api/early-access`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: 'ann@example.com', ...b }) });
    const cors = (r) => [...r.headers.keys()].filter((k) => k.startsWith('access-control-'));
    try {
      const config = await fetch(`${base}/api/early-access/config`, { headers: { origin: site } });
      assert.equal(config.headers.get('access-control-allow-origin'), site);
      assert.match(config.headers.get('vary'), /Origin/);
      assert.deepEqual(await config.json(), { sitekey: '0xSITEKEY', open: true });

      const pre = await fetch(`${base}/api/early-access`, { method: 'OPTIONS', headers: { origin: site, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get('access-control-allow-origin'), site);
      assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
      assert.match(pre.headers.get('access-control-allow-headers'), /content-type/);

      // Turnstile still applies cross-origin; a passing one is stored.
      const bad = await ask(site, { turnstile: 'bad' });
      assert.equal(bad.status, 400);
      const ok = await ask(site, { turnstile: 'good' });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('access-control-allow-origin'), site);
      assert.equal(ok.headers.get('set-cookie'), null);
      assert.equal(spaces.directory.requests().length, 1);
      // ...and so does the per-address limit (5 an hour, this one is the 3rd–6th).
      for (let i = 0; i < 3; i++) await ask(site, { turnstile: 'good' });
      assert.equal((await ask(site, { turnstile: 'good' })).status, 429);

      // Never credentials; never another origin (http, a subdomain, a stranger); never another endpoint.
      for (const r of [config, pre, ok]) assert.equal(r.headers.get('access-control-allow-credentials'), null);
      for (const origin of ['http://nuworq.com', 'https://evil.nuworq.com', 'https://evil.example']) {
        assert.deepEqual(cors(await fetch(`${base}/api/early-access/config`, { headers: { origin } })), [], origin);
        const refused = await fetch(`${base}/api/early-access`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST' } });
        assert.notEqual(refused.status, 204, origin);
        assert.deepEqual(cors(refused), [], origin);
      }
      for (const [method, path] of [['GET', '/api/early-access'], ['GET', '/api/me'], ['OPTIONS', '/api/orgs'], ['GET', '/api/oauth']]) {
        const r = await fetch(base + path, { method, headers: { origin: site } });
        assert.deepEqual(cors(r), [], `${method} ${path}`);
      }
    } finally { server.close(); }
  });

  test('an app with no parent domain (nuworq.com itself, localhost, an IP) lets no site call cross-origin', async () => {
    for (const publicUrl of ['https://nuworq.com', 'http://localhost:4747', 'http://10.0.0.5:4747', '']) {
      const server = createServer(new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) }), { publicUrl, earlyAccess: { owners: [], verify: async () => true, sitekey: 'k' } });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        for (const origin of ['https://com', 'https://nuworq.com', 'https://0.0.5']) {
          const r = await fetch(`http://127.0.0.1:${server.address().port}/api/early-access/config`, { headers: { origin } });
          assert.equal(r.headers.get('access-control-allow-origin'), null, `${publicUrl} ${origin}`);
        }
      } finally { server.close(); }
    }
  });

  test('a request is decided once', async () => {
    const h = await hub();
    try {
      await h.call('POST', '/api/early-access', { email: 'ann@example.com', turnstile: 'good' });
      const paul = h.as('paul@example.com');
      const id = h.dir.requests()[0].id;
      assert.equal((await h.call('POST', '/api/early-access/decide', { id, approve: true }, paul)).status, 200);
      const again = await h.call('POST', '/api/early-access/decide', { id, approve: false }, paul);
      assert.equal(again.status, 409);
      assert.match(again.json.error, /already approved/);
      assert.equal(h.dir.requests()[0].state, 'approved');
      assert.equal(h.dir.db.prepare('SELECT COUNT(*) AS n FROM org_grants').get().n, 1);
    } finally { h.close(); }
  });

  test("a new request reaches each owner's own channels once, linking to it on the admin host; a repeat sends nothing", async () => {
    const got = [];
    const sink = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      got.push({ path: req.url, msg: JSON.parse(raw) });
      res.end('ok');
    });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const to = (path) => `http://127.0.0.1:${sink.address().port}${path}`;
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-') ) });
    const dir = spaces.directory;
    // paul and quinn own the hub, each a person in a workspace with a channel of their own. The workspace's
    // hub-wide channel, and a member's, hear nothing.
    for (const [ws, handle, email] of [['acme', 'paul', 'paul@example.com'], ['globex', 'quinn', 'quinn@example.com']]) {
      spaces.create(ws);
      const db = spaces.get(ws).db;
      new Auth(db).addPerson(handle, 'owner', { email });
      new Auth(db).addPerson(`${handle}-mate`, 'member', { email: `${handle}-mate@example.com` });
      dir.identify(email, 'github');
      dir.join(email, ws);
      addChannel(db, 'webhook', to(`/${handle}`), Date.now(), { person: `@${handle}` });
      addChannel(db, 'webhook', to(`/${ws}-everyone`), Date.now());
      addChannel(db, 'webhook', to(`/${handle}-mate`), Date.now(), { person: `@${handle}-mate` });
    }
    const server = createServer(spaces, {
      publicUrl: 'http://app.example.test', adminHost: 'admin.example.test',
      earlyAccess: { owners: ['paul@example.com', 'quinn@example.com'], verify: async (t) => t === 'good', gate: true },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const post = (b) => fetch(`http://127.0.0.1:${server.address().port}/api/early-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ turnstile: 'good', ...b }) });
    const settle = async (n) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 100)); };
    try {
      const building = `an agent fleet for our monorepo ${'x'.repeat(300)}`;
      assert.equal((await post({ email: 'Ann@Example.com', github: '@ann', building })).status, 200);
      await settle(2);
      assert.deepEqual(got.map((g) => g.path).sort(), ['/paul', '/quinn'], 'each owner once; no hub-wide or member channel');
      const id = dir.requests()[0].id;
      for (const { msg } of got) {
        assert.equal(msg.url, `http://admin.example.test/?request=${id}`);
        assert.match(msg.text, /ann@example\.com \(@ann\) asked to come in: an agent fleet/);
        assert.ok(msg.text.includes(building.slice(0, 139)));
        assert.ok(!msg.text.includes(building.slice(0, 141)), 'at most 140 characters of the note');
        assert.deepEqual(msg.entries, []);
        assert.doesNotMatch(JSON.stringify(msg), /127\.0\.0\.1|ip_hash/,'nothing else about them');
      }
      got.length = 0;
      assert.equal((await post({ email: 'ann@example.com', building: 'more' })).status, 200);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(got.length, 0, 'a repeat (merged) sends nothing');
    } finally { server.close(); sink.close(); spaces.close(); }
  });

  test("an owner alone in their workspace hears requests on its hub-wide channels (#251); a second person stops that; a URL hears it once", async () => {
    const got = [];
    const sink = http.createServer(async (req, res) => { for await (const _ of req); got.push(req.url); res.end('ok'); });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const to = (path) => `http://127.0.0.1:${sink.address().port}${path}`;
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) });
    const dir = spaces.directory;
    // paul is the only person in each workspace. northup's only channel is hub-wide; acme's hub-wide channel has
    // the same URL as his personal one in globex.
    for (const ws of ['northup', 'acme', 'globex']) {
      spaces.create(ws);
      new Auth(spaces.get(ws).db).addPerson('paul', 'owner', { email: 'paul@example.com' });
    }
    dir.identify('paul@example.com', 'github');
    for (const ws of ['northup', 'acme', 'globex']) dir.join('paul@example.com', ws);
    addChannel(spaces.get('northup').db, 'webhook', to('/northup-everyone'), Date.now());
    addChannel(spaces.get('acme').db, 'webhook', to('/shared'), Date.now());
    addChannel(spaces.get('globex').db, 'webhook', to('/shared'), Date.now(), { person: '@paul' });
    const auth = new Auth(spaces.get('northup').db);
    const token = auth.createToken('paul-web', 'human', { person: 'paul' });
    const server = createServer(spaces, { earlyAccess: { owners: ['paul@example.com'], verify: async () => true } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (email) => fetch(`${base}/api/early-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, turnstile: 't' }) });
    const settle = async (n) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 100)); };
    const notify = async () => (await fetch(`${base}/w/northup/api/notify`, { headers: { authorization: `Bearer ${token}` } })).json();
    try {
      assert.equal((await post('ann@example.com')).status, 200);
      await settle(2);
      assert.deepEqual(got.sort(), ['/northup-everyone', '/shared'], 'the lone workspace\'s hub-wide channel; the shared URL once');
      const n = await notify();
      assert.deepEqual(n.requests, n.channels.map((c) => c.id), 'the modal is told this channel hears requests');

      // A second person in northup reads its hub-wide channel too: the push stops going there.
      auth.addPerson('mate', 'member', { email: 'mate@example.com' });
      got.length = 0;
      assert.equal((await post('bob@example.com')).status, 200);
      await settle(1);
      assert.deepEqual(got, ['/shared']);
      assert.deepEqual((await notify()).requests, [], 'the modal is told nothing here hears requests');
    } finally { server.close(); sink.close(); spaces.close(); }
  });

  test('with no owners, or owners without a channel, a request is still stored and answered', async () => {
    for (const owners of [[], ['paul@example.com']]) {
      const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) });
      const server = createServer(spaces, { earlyAccess: { owners, verify: async () => true } });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      try {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/early-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ann@example.com', turnstile: 't' }) });
        assert.equal(r.status, 200);
        assert.equal(spaces.directory.requests().length, 1);
      } finally { server.close(); spaces.close(); }
    }
  });

  test('without an admin host, the push links to /requests.html', async () => {
    const got = [];
    const sink = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; got.push(JSON.parse(raw)); res.end('ok'); });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ea-')) });
    spaces.create('acme');
    new Auth(spaces.get('acme').db).addPerson('paul', 'owner', { email: 'paul@example.com' });
    spaces.directory.identify('paul@example.com', 'github');
    spaces.directory.join('paul@example.com', 'acme');
    addChannel(spaces.get('acme').db, 'webhook', `http://127.0.0.1:${sink.address().port}/`, Date.now(), { person: '@paul' });
    const server = createServer(spaces, { publicUrl: 'https://app.example.test', earlyAccess: { owners: ['paul@example.com'], verify: async () => true } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      await fetch(`http://127.0.0.1:${server.address().port}/api/early-access`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ann@example.com', building: 'line one\nline two', turnstile: 't' }) });
      for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(got.length, 1);
      assert.equal(got[0].text, 'nuworq: early-access request\nann@example.com asked to come in: line one\n→ https://app.example.test/requests.html');
      assert.deepEqual(composeRequest({ email: 'a@b.co' }).text, 'nuworq: early-access request\na@b.co asked to come in');
    } finally { server.close(); sink.close(); spaces.close(); }
  });

  test('turnstile() checks the token with the secret on the hub, and says no on any failure', async () => {
    const seen = [];
    const fake = async (url, init) => { seen.push({ url, body: String(init.body) }); return { json: async () => ({ success: init.body.get('response') === 'tok' }) }; };
    const verify = turnstile('s3cret', { fetch: fake });
    assert.equal(await verify('tok', '1.2.3.4'), true);
    assert.equal(await verify('nope'), false);
    assert.equal(await verify(''), false, 'no token: not even asked');
    assert.equal(seen.length, 2);
    assert.match(seen[0].url, /challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
    assert.match(seen[0].body, /secret=s3cret&response=tok&remoteip=1\.2\.3\.4/);
    assert.equal(await turnstile('s', { fetch: async () => { throw new Error('down'); } })('tok'), false);
  });
});
