import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { getStarted, facts, RECENT_MS } from '../src/getstarted.js';
import { getStartedCard } from '../web/getstarted.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

function setup() {
  let now = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => now });
  const step = (key, opts = {}) => getStarted(facts(hub, opts)).steps.find((s) => s.key === key);
  return { hub, step, tick: (ms) => { now += ms; } };
}

// GitHub as far as Get started asks: whether the app has any installation.
function github(installations) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url.startsWith('/app/installations?') ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/app/installations?') ? installations.list : { message: 'Not Found' }));
  });
  return server;
}

describe('get started: each step checks itself off from hub state', () => {
  test('a single hub has five steps; a workspaces hub adds the organization first', () => {
    const { hub } = setup();
    assert.deepEqual(getStarted(facts(hub)).steps.map((s) => s.key), ['project', 'github', 'machine', 'agent', 'landed']);
    assert.deepEqual(getStarted(facts(hub, { workspaces: true })).steps.map((s) => s.key), ['org', 'project', 'github', 'machine', 'agent', 'landed']);
  });

  test('organization: done once the viewer is a person in the workspace', () => {
    const { hub, step } = setup();
    assert.equal(step('org', { workspaces: true, viewer: '@ana' }).done, false);
    new Auth(hub.db).addPerson('ana', 'owner');
    assert.equal(step('org', { workspaces: true, viewer: '@ana' }).done, true);
  });

  test('add a project: a project alone is not enough; one with a repository is', () => {
    const { hub, step } = setup();
    const p = hub.tx(() => hub.project('demo', { create: true }));
    assert.equal(step('project').done, false);
    hub.addRemote(p, 'github.com/acme/api', 'you');
    assert.equal(step('project').done, true);
  });

  test('add a project: a project with a path on disk counts too', () => {
    const { hub, step } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { path: tmpdir() });
    assert.equal(step('project').done, true);
  });

  test('connect your machine (no logins): any agent has checked in', () => {
    const { hub, step } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    assert.equal(step('machine').done, false);
    hub.agentOp('demo', 'checkin', 'a1', {});
    assert.equal(step('machine').done, true);
  });

  test('connect your machine (signed in): an agent token issued to this person, not to someone else', () => {
    const { hub, step } = setup();
    const auth = new Auth(hub.db);
    auth.addPerson('ana', 'owner');
    auth.addPerson('bo', 'member');
    assert.equal(step('machine', { viewer: '@ana' }).done, false);
    auth.createToken('ana-laptop', 'agent', { mintedBy: 'ana' });
    assert.equal(step('machine', { viewer: '@ana' }).done, true);
    assert.equal(step('machine', { viewer: '@bo' }).done, false);
  });

  test('start an agent: one checked in within the last week', () => {
    const { hub, step, tick } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    assert.equal(step('agent').done, false);
    hub.agentOp('demo', 'checkin', 'a1', {});
    assert.equal(step('agent').done, true);
    tick(RECENT_MS + 1);
    assert.equal(step('agent').done, false, 'a week of silence: start one again');
  });

  test('first item landed: an item built, accepted and landed on main', () => {
    const { hub, step } = setup();
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-gs-')));
    const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'] });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README'), 'hi\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { path: repo });
    hub.humanOp('demo', 'create', { title: 'Greeting', acceptance: 'greeting exists' });
    const op = (name, args = {}) => hub.agentOp('demo', name, 'a1', args);
    op('checkin');
    const job = op('next');
    git('switch', '-q', '-c', job.branch);
    writeFileSync(join(repo, 'greeting'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'greeting');
    git('switch', '-q', 'main');
    op('submit', { item: '#1', headline: 'Greeting added' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(op('next').mode, 'land');
    assert.equal(step('landed').done, false);
    git('merge', '-q', '--ff-only', job.branch);
    op('submit', { item: '#1', headline: 'Landed' });
    assert.equal(step('landed').done, true);
  });

  test('a project that is not on GitHub finishes without the GitHub step; one on github.com still needs it (#129)', () => {
    const { hub, step } = setup();
    assert.ok(step('github'), 'before any project, GitHub is on the list');
    const p = hub.tx(() => hub.project('demo', { create: true }));
    hub.addRemote(p, '/srv/git/demo.git', 'you');
    hub.agentOp('demo', 'checkin', 'a1', {});
    hub.event(p, { actor: 'a1', type: 'landed', headline: 'a1 landed #1 on main' });
    const gs = getStarted(facts(hub, { app: 'none' }));
    assert.equal(gs.steps.find((s) => s.key === 'github'), undefined);
    assert.equal(gs.complete, true);

    const q = hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(q, 'github.com/acme/api', 'you');
    const again = getStarted(facts(hub, { app: 'none' }));
    assert.equal(again.steps.find((s) => s.key === 'github').done, false);
    assert.equal(again.complete, false);
  });

  test("with no app, someone who can't create it is told whom to ask, not sent to the create flow (#129)", () => {
    const { hub, step } = setup();
    const auth = new Auth(hub.db);
    auth.addPerson('paul', 'owner');
    auth.addPerson('sam', 'steward');
    const ask = step('github', { app: 'none', viewer: '@sam' }).action;
    assert.deepEqual(ask, { label: 'Ask an owner (@paul) to set up GitHub', note: true });
    assert.deepEqual(step('github', { app: 'none', workspaces: true }).action, { label: 'Ask whoever runs this hub to set up its GitHub App', note: true });
    assert.equal(step('github', { app: 'none', canCreateApp: true }).action.href, 'api/github/app/new', 'an owner still creates it');
    assert.match(getStartedCard({ show: true, steps: [{ key: 'github', label: 'Connect GitHub', done: false, action: ask }] }),
      /<span class="faint">Ask an owner \(@paul\) to set up GitHub<\/span>/);
  });

  test('connect GitHub: no app, an app installed nowhere, an app installed', () => {
    const { hub, step } = setup();
    assert.equal(step('github', { app: 'none' }).done, false);
    assert.equal(step('github', { app: 'uninstalled' }).done, false);
    assert.equal(step('github', { app: 'installed' }).done, true);
  });

  test('every step that is not done carries an action that leads somewhere', () => {
    const variants = [
      { workspaces: true, app: 'none' }, { app: 'none', canCreateApp: true },
      { app: 'uninstalled', installUrl: 'https://github.com/apps/x/installations/new' }, { app: 'uninstalled' },
      { app: 'none', board: 'demo' },
    ];
    for (const s of variants) {
      for (const st of getStarted(s).steps) {
        assert.ok(!st.done, st.key);
        assert.ok(st.action?.label, `${st.key} has a label`);
        assert.ok(st.action.href || st.action.ui || st.action.note, `${st.key} has an href, a ui action, or says whom to ask`);
      }
    }
    assert.equal(getStarted({ app: 'none', canCreateApp: true }).steps.find((s) => s.key === 'github').action.href, 'api/github/app/new');
    assert.equal(getStarted({ app: 'uninstalled', installUrl: 'https://github.com/apps/x/installations/new' }).steps.find((s) => s.key === 'github').action.href, 'https://github.com/apps/x/installations/new');
    assert.equal(getStarted({ board: 'demo' }).steps.at(-1).action.href, '#/p/demo');
    assert.equal(getStarted({}).steps.find((s) => s.key === 'project').action.ui, 'new-project');
  });
});

describe('get started over HTTP: complete once, then gone for good', () => {
  async function hubWithEverything(installations) {
    const gh = github(installations);
    const ghPort = await listen(gh);
    const hub = new Hub();
    const p = hub.tx(() => hub.project('demo', { create: true }));
    const server = createServer(hub, { sweepMs: 60_000, githubApp: { id: '1', key: PEM, slug: 'nuworq-test' }, github: { api: `http://127.0.0.1:${ghPort}` } });
    const port = await listen(server);
    const call = async (path, method = 'GET') => (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { origin: `http://127.0.0.1:${port}` } })).json();
    return { hub, p, call, close: () => { server.close(); gh.close(); } };
  }

  test('undone steps show with their actions; GitHub stays undone while the app is installed nowhere', async () => {
    const installations = { list: [] };
    const { hub, p, call, close } = await hubWithEverything(installations);
    try {
      let gs = await call('/api/get-started');
      assert.equal(gs.show, true);
      assert.equal(gs.complete, false);
      assert.deepEqual(gs.steps.filter((s) => !s.done).map((s) => s.key), ['project', 'github', 'machine', 'agent', 'landed']);
      assert.equal(gs.steps.find((s) => s.key === 'github').action.href, 'https://github.com/apps/nuworq-test/installations/new');

      hub.addRemote(p, 'github.com/acme/api', 'you');
      hub.agentOp('demo', 'checkin', 'a1', {});
      hub.event(p, { actor: 'a1', type: 'landed', headline: 'a1 landed #1 on main' });
      gs = await call('/api/get-started');
      assert.deepEqual(gs.steps.filter((s) => !s.done).map((s) => s.key), ['github'], 'GitHub still has no installation');
      assert.equal(gs.show, true);
      assert.equal(gs.complete, false);
    } finally { close(); }
  });

  test('all done from the first ask: complete, recorded, and still gone after the app is removed', async () => {
    const installations = { list: [{ id: 7 }] };
    const { hub, p, call, close } = await hubWithEverything(installations);
    try {
      hub.addRemote(p, 'github.com/acme/api', 'you');
      hub.agentOp('demo', 'checkin', 'a1', {});
      hub.event(p, { actor: 'a1', type: 'landed', headline: 'a1 landed #1 on main' });
      let gs = await call('/api/get-started');
      assert.equal(gs.complete, true);
      assert.equal(gs.show, false);
      assert.ok(gs.steps.every((s) => s.done));

      // Regression: the app's installations are gone and the project loses its repository.
      installations.list = [];
      hub.humanOp('demo', 'remote', { remove: 'github.com/acme/api' });
      gs = await call('/api/get-started');
      assert.equal(gs.show, false);
      assert.equal(gs.complete, true);
      assert.equal(gs.how, 'complete');
    } finally { close(); }
  });

  test('Hide records it: the card is gone from then on', async () => {
    const { call, close } = await hubWithEverything({ list: [] });
    try {
      assert.equal((await call('/api/get-started')).show, true);
      const hidden = await call('/api/get-started/hide', 'POST');
      assert.equal(hidden.show, false);
      assert.equal(hidden.how, 'hidden');
      const gs = await call('/api/get-started');
      assert.equal(gs.show, false);
      assert.equal(gs.complete, false);
    } finally { close(); }
  });
});

describe('get started card', () => {
  const steps = [
    { key: 'github', label: 'Connect GitHub', done: true },
    { key: 'project', label: 'Add a project', done: false, action: { label: '+ Project', ui: 'new-project' } },
    { key: 'agent', label: 'Start an agent', done: false, action: { label: 'Start an agent', ui: 'connect', command: 'worker' } },
    { key: 'landed', label: 'Watch your first item land', done: false, action: { label: 'Open the board', href: '#/p/demo' } },
  ];

  test('done steps are ticked; the next undone step is a button, later ones links', () => {
    const html = getStartedCard({ show: true, steps });
    assert.match(html, /1 of 4 done/);
    assert.match(html, /<li class="done" data-step="github">\s*<span class="tick">✓/);
    assert.match(html, /class="btn primary small" data-action="new-project">\+ Project/);
    assert.match(html, /<a class="link" href="#\/p\/demo">Open the board/);
    assert.match(html, /data-action="get-started-hide"/);
  });

  test('the worker command shows under "Start an agent" once it is the next step', () => {
    const later = getStartedCard({ show: true, steps }, { worker: 'node nuworq.js worker --run' });
    assert.doesNotMatch(later, /worker --run/);
    const now = getStartedCard({ show: true, steps: steps.map((s) => (s.key === 'project' ? { ...s, done: true, action: undefined } : s)) }, { worker: 'node nuworq.js worker --run' });
    assert.match(now, /<pre>node nuworq.js worker --run<\/pre>/);
  });

  test('complete or hidden: no card at all', () => {
    assert.equal(getStartedCard({ show: false, complete: true, steps: [] }), '');
    assert.equal(getStartedCard({ show: false, complete: true, steps: steps.map((s) => ({ ...s, done: true })) }), '');
    assert.equal(getStartedCard(null), '');
  });
});
