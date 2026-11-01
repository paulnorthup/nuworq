import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { view } from '../src/insight.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// A single hub as it runs today: two projects with history, a decision and a field note; an owner with an
// email, and a human, an agent (limited to "site") and a runner token.
function singleHub(file) {
  const hub = new Hub({ file });
  const auth = new Auth(hub.db);
  auth.addPerson('paul', 'owner', { email: 'paul@example.com' });
  const tokens = {
    human: auth.createToken('paul-laptop', 'human', { person: 'paul' }),
    agent: auth.createToken('site-agent', 'agent', { projects: ['site'] }),
    runner: auth.createToken('mini-runner', 'agent', { runner: 'mini' }),
  };
  for (const slug of ['nuworq', 'site']) hub.tx(() => hub.project(slug, { create: true }));
  hub.humanOp('site', 'create', { title: 'Signup page', acceptance: 'people sign up' });
  hub.humanOp('site', 'decide', { body: 'Light theme only' });
  hub.agentOp('site', 'checkin', 'w1');
  hub.agentOp('site', 'learn', 'w1', { note: 'Run npm test before pushing' });
  hub.agentOp('site', 'claim', 'w1', { item: '#1' });
  hub.agentOp('site', 'progress', 'w1', { item: '#1', headline: 'Form drafted' });
  hub.db.close();
  return tokens;
}

describe('a single hub moves into workspaces mode (#204)', () => {
  const home = mkdtempSync(join(tmpdir(), 'nuworq-adopt-'));
  const dataDir = join(home, 'data'), db = join(home, 'hub.db');
  let tokens, server, base;
  const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'workspace', ...a, '--db', db, '--data-dir', dataDir], { env: { HOME: home, PATH: process.env.PATH, NO_COLOR: '1', NUWORQ_NO_UPDATE: '1' } });
  const call = (method, path, token, body, headers = {}) => fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body && JSON.stringify(body),
  });

  before(async () => {
    tokens = singleHub(db);
    const out = await cli('adopt', 'main');
    assert.match(out.stdout, /Adopted .* as workspace main/);
    assert.match(out.stdout, /No GitHub App on this hub\. .*nuworq workspace bind-installation <id> main/, 'without an app it says how to bind one later');
    server = createServer(new Workspaces({ dir: join(dataDir, 'workspaces') }), {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => { server?.close(); server?.closeAllConnections(); });

  test('adopt copies the database into workspaces/<name>.db and keeps a copy of the original; a taken or reserved name is refused', async () => {
    assert.ok(existsSync(join(dataDir, 'workspaces', 'main.db')));
    assert.ok(existsSync(db), 'the original stays where it was');
    assert.equal(readdirSync(home).filter((f) => f.startsWith('hub.db.before-workspaces-')).length, 1, 'and a dated copy sits beside it');
    await assert.rejects(cli('adopt', 'main'), /already exists/);
    await assert.rejects(cli('adopt', 'admin'), /reserved/);
  });

  test('the workspace has the same projects, items, history, decisions and field notes', () => {
    const hub = new Workspaces({ dir: join(dataDir, 'workspaces') }).get('main');
    assert.deepEqual(hub.projects().map((p) => p.slug).sort(), ['nuworq', 'site']);
    const v = view(hub, 'site');
    assert.equal(v.all[0].title, 'Signup page');
    assert.equal(v.all[0].stage, 'active');
    assert.ok(v.activity.some((e) => e.headline.includes('Form drafted')));
    assert.deepEqual(v.decisions.map((d) => d.body), ['Light theme only']);
    assert.deepEqual(v.notes.map((n) => n.body), ['Run npm test before pushing']);
    hub.db.close();
  });

  test("every token works at the hub's root address, served in place, and under /w/main", async () => {
    for (const prefix of ['', '/w/main']) {
      const projects = await call('GET', `${prefix}/api/projects`, tokens.human);
      assert.equal(projects.status, 200, prefix);
      assert.deepEqual((await projects.json()).map((p) => p.slug).sort(), ['nuworq', 'site']);
      const look = await call('POST', `${prefix}/api/p/site/agent/look`, tokens.agent, {}, { 'x-nuworq-agent': 'w1' });
      assert.equal(look.status, 200, `agent ${prefix}`);
      assert.equal((await call('POST', `${prefix}/api/p/nuworq/agent/look`, tokens.agent, {}, { 'x-nuworq-agent': 'w1' })).status, 403, 'its scope still holds');
      const runner = await call('POST', `${prefix}/api/runner`, tokens.runner, { machine: 'mini.local', workers: 1 });
      assert.equal(runner.status, 200, `runner ${prefix}`);
    }
    // Never a redirect: the token is answered by this host and goes nowhere else.
    assert.equal((await call('GET', '/api/me', tokens.agent)).status, 200);
    assert.equal((await call('GET', '/api/projects', 'nuworq_not_a_token_at_all_xxxxxxxx')).status, 401, 'a wrong token is refused there, not passed on');
  });

  test('without a token the root is still the hub itself; the owner signs in and finds the workspace', async () => {
    assert.equal((await call('GET', '/api/projects')).status, 404, 'no workspace named, no token: the hub\'s own address');
    const spaces = new Workspaces({ dir: join(dataDir, 'workspaces') });
    const dir = spaces.directory;
    const me = dir.identity('paul@example.com');
    assert.deepEqual(dir.orgsOf(me, spaces).map((o) => [o.workspace, o.handle, o.role]), [['main', 'paul', 'owner']]);
    const sid = dir.createSession(me.id);
    const enter = await call('GET', '/api/orgs/main/enter', null, null, { cookie: `nuworq_id=${sid}` });
    assert.equal(enter.status, 302);
    assert.match(enter.headers.get('location'), /\/w\/main\/api\/oauth\/finish\?ticket=/);
  });

  test('bind-installation binds one installation by hand; a bad id or a missing workspace is refused', async () => {
    const out = await cli('bind-installation', '99', 'main');
    assert.match(out.stdout, /Bound GitHub App installation 99 to main/);
    assert.equal(new Workspaces({ dir: join(dataDir, 'workspaces') }).directory.installation(99), 'main');
    await assert.rejects(cli('bind-installation', 'abc', 'main'), /not an installation id/);
    await assert.rejects(cli('bind-installation', '99', 'nope'), /No workspace "nope"/);
  });

  test('an old link to #/p/<slug>/<n> at the root reaches the item in the workspace', async () => {
    const root = await (await call('GET', '/api/root')).json();
    assert.deepEqual(root, { workspace: 'main', address: `${base}/w/main` });
    const join = readFileSync(new URL('../web/join.js', import.meta.url), 'utf8');
    assert.match(join, /location\.hash\.startsWith\('#\/p\/'\)/);
    assert.match(join, /location\.replace\(`\$\{address\}\/\$\{location\.hash\}`\)/);
  });
});

describe("adopting a hub with a GitHub App keeps the app's webhooks reaching it (#226)", () => {
  const WHS = 'app-webhook-secret';
  const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const home = mkdtempSync(join(tmpdir(), 'nuworq-adopt-app-'));
  const dataDir = join(home, 'data'), db = join(home, 'hub.db');
  const cli = (a, file = db) => promisify(execFile)(process.execPath, [BIN, 'workspace', ...a, '--db', file, '--data-dir', dataDir], { env: { HOME: home, PATH: process.env.PATH, NO_COLOR: '1', NUWORQ_NO_UPDATE: '1' } });
  // GitHub as the app sees it: two installations, listed only to the app's own JWT.
  const asked = [];
  const github = createHttpServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.startsWith('/app/installations?') && /^Bearer ey/.test(req.headers.authorization ?? '')) return json(200, [{ id: 41, account: { login: 'paul' } }, { id: 42, account: { login: 'acme' } }]);
    json(404, { message: 'Not Found' });
  });
  let api, spaces, server;

  before(async () => {
    await new Promise((r) => github.listen(0, '127.0.0.1', r));
    api = `http://127.0.0.1:${github.address().port}`;
    const hub = new Hub({ file: db });
    hub.tx(() => hub.project('nuworq', { create: true }));
    hub.addRemote(hub.project('nuworq'), 'github.com/paul/nuworq', 'you');
    hub.db.close();
    // Installation 42 was already installed for another workspace on this hub: it stays there.
    const before = new Workspaces({ dir: join(dataDir, 'workspaces') });
    before.create('other');
    before.directory.bindInstallation(42, 'other');
    before.close();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'github-app.json'), JSON.stringify({ id: '7', key: PEM, webhook_secret: WHS, api }));
  });
  after(() => { server?.close(); server?.closeAllConnections(); spaces?.close(); github.close(); github.closeAllConnections(); });

  test('adopt binds every installation of the app to the workspace, and names one bound elsewhere', async () => {
    const out = await cli(['adopt', 'main']);
    assert.match(out.stdout, /Bound GitHub App installation 41 to main/);
    assert.match(out.stdout, /Installation 42 is bound to workspace other, so it stays there/);
    assert.ok(asked.some((a) => a.startsWith('GET /app/installations?')));
    spaces = new Workspaces({ dir: join(dataDir, 'workspaces') });
    assert.equal(spaces.directory.installation(41), 'main');
    assert.equal(spaces.directory.installation(42), 'other');
  });

  test("a delivery for the adopted hub's installation reaches the workspace as a proposal", async () => {
    server = createServer(spaces, { githubApp: { id: '7', key: PEM, webhook_secret: WHS, api }, sweepMs: 3600_000 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const raw = JSON.stringify({ action: 'opened', installation: { id: 41 }, issue: { number: 121, title: 'Webhook check', state: 'open', author_association: 'OWNER', html_url: 'https://github.com/paul/nuworq/issues/121' }, repository: { full_name: 'paul/nuworq' } });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/hooks/github-app`, {
      method: 'POST', body: raw,
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', WHS).update(raw).digest('hex') },
    });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).projects.map((p) => [p.project, p.created]), [['nuworq', true]]);
    const v = view(spaces.get('main'), 'nuworq');
    assert.deepEqual(v.all.map((i) => [i.title, i.stage]), [['Webhook check', 'proposed']]);
  });

  test("without GitHub, adopt still works and says how to bind an installation later", async () => {
    github.close(); github.closeAllConnections();
    const other = join(home, 'other.db');
    new Hub({ file: other }).db.close();
    const out = await cli(['adopt', 'again'], other);
    assert.match(out.stdout, /Adopted .* as workspace again/);
    assert.match(out.stdout, /Couldn't list the GitHub App's installations .*nuworq workspace bind-installation <id> again/);
  });
});
