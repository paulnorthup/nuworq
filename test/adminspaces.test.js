import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { manifest } from '../src/ghapp.js';

const ADMIN = 'admin.example.test', APP = 'app.example.test';
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const PAUL = 'paul@example.com';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });

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
const cookies = (res) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

// GitHub, played by a local server: a code for whoever approves, traded for a token that says their email.
function provider() {
  const codes = new Map(), tokens = new Map();
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/token') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = Object.fromEntries(new URLSearchParams(raw));
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (!c || createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'bad_verification_code' });
      const t = randomBytes(8).toString('hex');
      tokens.set(t, c.email);
      return json(200, { access_token: t });
    }
    const email = tokens.get(String(req.headers.authorization ?? '').replace('Bearer ', ''));
    if (email && req.url === '/user/emails') return json(200, [{ email, primary: true, verified: true }]);
    // The hub's GitHub App, as GitHub describes it: subscribed to no events (#220).
    if (req.url === '/app') return json(200, { id: 1, slug: 'nuworq', owner: { login: 'nuworq', type: 'Organization' }, permissions: manifest('https://x.test', 'n').default_permissions, events: [] });
    json(401, {});
  });
  return {
    server,
    approve(authorizeUrl, email) {
      const u = new URL(authorizeUrl);
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge'), email });
      return { code, state: u.searchParams.get('state'), callback: new URL(u.searchParams.get('redirect_uri')) };
    },
  };
}

// The admin dashboard's Workspaces section (#169): every workspace with its plan, and the plan switch.
describe('the admin host lists workspaces and sets their plans', () => {
  let p, spaces, server, port, data, owner;
  const op = (ws, agent, name, args = {}) => spaces.get(ws).agentOp('app', name, agent, args);
  const cli = (...a) => promisify(execFile)(process.execPath, [BIN, ...a, '--data-dir', data, '--owners', PAUL], { env: { ...process.env, HOME: data, NO_COLOR: '1' } });
  const get = (cookie) => request(port, 'GET', '/api/workspaces', { host: ADMIN, headers: { cookie } });
  const setPlan = (cookie, workspace, plan) => request(port, 'POST', '/api/workspaces/plan', { host: ADMIN, headers: { cookie }, body: { workspace, plan } });

  before(async () => {
    p = provider();
    const stub = `http://127.0.0.1:${await listen(p.server)}`;
    data = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-adminspaces-')));
    spaces = new Workspaces({ dir: join(data, 'workspaces'), plans: true, owners: [PAUL] });
    // acme: Ann signed up for it (so Free), with a project, two items, two people.
    const dir = spaces.directory;
    dir.request({ email: 'ann@acme.test', github: 'ann-gh', building: 'things' });
    spaces.create('acme');
    dir.identify('ann@acme.test', 'github');
    dir.join('ann@acme.test', 'acme', { created: true });
    const acme = spaces.get('acme');
    acme.tx(() => acme.project('app', { create: true }));
    for (const t of ['One', 'Two']) acme.humanOp('app', 'create', { title: t, acceptance: 'x' });
    for (const [h, e] of [['ann', 'ann@acme.test'], ['bo', 'bo@acme.test']]) acme.db.prepare("INSERT INTO people (handle, email, role, created_at) VALUES (?, ?, 'owner', 0)").run(h, e);
    // quiet: made by the host on the command line, nothing in it.
    spaces.create('quiet');
    server = createServer(spaces, {
      publicUrl: `http://${APP}`, adminHost: ADMIN,
      oauth: { github: { id: 'gh', secret: 'shh', authorize: `${stub}/authorize`, token: `${stub}/token`, api: stub } },
      earlyAccess: { owners: [PAUL], verify: async () => true, gate: true },
      githubApp: { id: 1, key: PEM, webhook_secret: 's', api: stub },
    });
    port = await listen(server);
    owner = await signIn(PAUL);
  });

  test('what the hub\'s GitHub App is missing shows on the dashboard, and in Needs you only for the hub\'s owners (#220)', async () => {
    let r;
    for (const end = Date.now() + 3000; Date.now() < end; await new Promise((ok) => setTimeout(ok, 20))) {
      r = await request(port, 'GET', '/api/github/app/wiring', { host: ADMIN, headers: { cookie: owner } });
      if (r.json?.missing) break;
    }
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.missing.headline, /missing 7 events/);
    assert.equal(r.json.missing.how[0].where, 'https://github.com/organizations/nuworq/settings/apps/nuworq/permissions');
    assert.equal((await request(port, 'GET', '/api/github/app/wiring', { host: ADMIN, headers: { cookie: await signIn('zed@example.com') } })).status, 403);
    // In a workspace: Ann owns acme but not the hub, so it isn't hers to fix; Paul, a hub owner, sees it there.
    await request(port, 'GET', '/w/acme/api/health');
    const acme = spaces.get('acme');
    assert.equal(acme.appWiring('@ann'), null);
    acme.db.prepare("INSERT INTO people (handle, email, role, created_at) VALUES ('paul', ?, 'member', 0)").run(PAUL);
    assert.equal(acme.appWiring('@paul'), null, 'not by an email someone typed for him (#470)');
    acme.db.prepare("UPDATE people SET verified_at = 1 WHERE handle = 'paul'").run();
    assert.ok(acme.appWiring('@paul')?.gaps.events.length, 'by the email he signed in with');
    acme.db.prepare("DELETE FROM people WHERE handle = 'paul'").run();
  });
  after(() => { for (const s of [server, p.server]) { s.close(); s.closeAllConnections(); } spaces.close(); });

  async function signIn(email) {
    const s = await request(port, 'GET', '/auth/github/start', { host: ADMIN });
    const a = p.approve(s.headers.location, email);
    return cookies(await request(port, 'GET', `${a.callback.pathname}?code=${a.code}&state=${encodeURIComponent(a.state)}`, { host: ADMIN, headers: { cookie: cookies(s) } }));
  }

  test('an owner gets every workspace, most recently active first, with its plan and what is in it', async () => {
    op('acme', 'a1', 'checkin');
    op('acme', 'a1', 'next');
    const r = await get(owner);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.enforced, true);
    assert.deepEqual(r.json.workspaces.map((w) => w.name), ['acme', 'quiet'], 'sorted by last activity; quiet has none');
    const [acme, quiet] = r.json.workspaces;
    assert.deepEqual({ ...acme, last_active: typeof acme.last_active }, {
      name: 'acme', plan: 'free', source: 'default', set_by: null, set_at: null, billing: null,
      creator: { email: 'ann@acme.test', github: 'ann-gh' },
      people: 2, projects: 1, working: ['a1'], last_active: 'number',
    });
    assert.deepEqual(quiet, { name: 'quiet', plan: 'unlimited', source: 'default', set_by: null, set_at: null, billing: null, creator: null, people: 0, projects: 0, working: [], last_active: null });
  });

  test('a non-owner gets 403, and the app host refuses the API with a hint naming the admin host', async () => {
    const zed = await signIn('zed@example.com');
    for (const r of [await get(zed), await setPlan(zed, 'acme', 'unlimited')]) {
      assert.equal(r.status, 403);
      assert.match(r.json.hint, /NUWORQ_HUB_OWNERS/);
      assert.equal(r.json.workspaces, undefined);
    }
    assert.equal((await get('')).status, 401);
    const appOwner = `nuworq_id=${spaces.directory.createSession(spaces.directory.identify(PAUL, 'github').id)}`;
    for (const [method, path] of [['GET', '/api/workspaces'], ['POST', '/api/workspaces/plan']]) {
      const r = await request(port, method, path, { headers: { cookie: appOwner }, ...(method === 'POST' ? { body: { workspace: 'acme', plan: 'unlimited' } } : {}) });
      assert.equal(r.status, 403, path);
      assert.match(r.json.hint, /admin\.example\.test/, path);
    }
    assert.equal(spaces.directory.plan('acme'), null, 'nothing was set');
  });

  test('an owner sets unlimited and back to free; Free refuses a second agent at once, Unlimited does not', async () => {
    op('acme', 'a2', 'checkin');
    assert.throws(() => op('acme', 'a2', 'next'), (e) => e.status === 402 && /upgrade/i.test(e.hint), 'free by default: a1 is working');
    const up = await setPlan(owner, 'acme', 'unlimited');
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.workspace.plan, 'unlimited');
    assert.equal(up.json.workspace.source, 'set');
    assert.equal(up.json.workspace.set_by, PAUL);
    assert.equal(typeof up.json.workspace.set_at, 'number');
    assert.equal(op('acme', 'a2', 'next').mode, 'work', 'unlimited: a2 works beside a1');
    op('acme', 'a2', 'handoff', { item: '#2', headline: 'Out' });
    const down = await setPlan(owner, 'acme', 'free');
    assert.equal(down.json.workspace.plan, 'free');
    assert.equal(spaces.directory.planSet('acme').set_by, PAUL);
    assert.throws(() => op('acme', 'a2', 'next'), (e) => e.status === 402 && /upgrade/i.test(e.hint), 'free again: refused while a1 works');
  });

  test('an unknown plan is a 400 and an unknown workspace a 404, each with a hint', async () => {
    const bad = await setPlan(owner, 'acme', 'pro');
    assert.equal(bad.status, 400);
    assert.match(bad.json.hint, /free, unlimited/);
    const none = await setPlan(owner, 'nope', 'free');
    assert.equal(none.status, 404);
    assert.ok(none.json.hint);
    const cross = await request(port, 'POST', '/api/workspaces/plan', { host: ADMIN, headers: { cookie: owner, origin: `http://${APP}` }, body: { workspace: 'acme', plan: 'unlimited' } });
    assert.equal(cross.status, 403, 'a write from another origin is refused');
    assert.equal(spaces.directory.plan('acme'), 'free');
  });

  test('the CLI and the dashboard read and write the same plan', async () => {
    await cli('workspace', 'plan', 'quiet', 'free');
    const q = (await get(owner)).json.workspaces.find((w) => w.name === 'quiet');
    assert.deepEqual([q.plan, q.source, q.set_by], ['free', 'set', 'host'], 'set on the command line, seen on the dashboard');
    await setPlan(owner, 'quiet', 'unlimited');
    const list = (await cli('workspace', 'list')).stdout;
    assert.match(list, new RegExp(`^quiet  unlimited \\(set by ${PAUL.replace('.', '\\.')} \\d{4}-\\d\\d-\\d\\d\\)$`, 'm'), 'set on the dashboard, seen on the command line');
    assert.match(list, /^acme  free \(set by /m);
  });

  test('the dashboard has a Workspaces section whose plan switch asks first', async () => {
    const js = (await request(port, 'GET', '/admin.js', { host: ADMIN })).text;
    assert.match(js, /\/api\/workspaces/);
    assert.match(js, /confirm\(`Switch \$\{name\} to/);
    assert.match(js, /one agent works at a time/);
  });
});
