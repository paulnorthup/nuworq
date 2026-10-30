import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
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

  test('an old link to #/p/<slug>/<n> at the root reaches the item in the workspace', async () => {
    const root = await (await call('GET', '/api/root')).json();
    assert.deepEqual(root, { workspace: 'main', address: `${base}/w/main` });
    const join = readFileSync(new URL('../web/join.js', import.meta.url), 'utf8');
    assert.match(join, /location\.hash\.startsWith\('#\/p\/'\)/);
    assert.match(join, /location\.replace\(`\$\{address\}\/\$\{location\.hash\}`\)/);
  });
});
