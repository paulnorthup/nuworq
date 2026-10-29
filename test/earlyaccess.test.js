import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { turnstile } from '../src/directory.js';

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
      // It looks like the sign-in card (#121): both stylesheets come from the hub's own address.
      assert.match(html, /href="\/login\.css"/);
      for (const css of ['/style.css', '/login.css']) assert.match((await fetch(h.base + css)).headers.get('content-type'), /text\/css/, css);
      assert.equal((await fetch(`${h.base}/early-access.js`)).status, 200);
      assert.deepEqual(await (await fetch(`${h.base}/api/early-access/config`)).json(), { sitekey: '0xSITEKEY', open: true });
      // Only that page may load Turnstile.
      assert.doesNotMatch((await fetch(`${h.base}/requests.html`)).headers.get('content-security-policy'), /cloudflare/);
    } finally { h.close(); }
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
