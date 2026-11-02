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

// The setup that works (#489), all three running: a runner, an operator and a shaper.
function theSetup(hub, slug = 'demo') {
  hub.agentOp(slug, 'checkin', 'a1', {});
  hub.reportRunner({ machine: 'mac' }, { scope: [slug] });
  hub.agentOp(slug, 'checkin', 'op', { has: ['operator'] });
  hub.agentOp(slug, 'checkin', 's1', { role: 'shaper' });
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
  test('a single hub has seven steps; a workspaces hub adds the organization first', () => {
    const { hub } = setup();
    assert.deepEqual(getStarted(facts(hub)).steps.map((s) => s.key), ['project', 'github', 'machine', 'workers', 'operator', 'shaper', 'landed']);
    assert.deepEqual(getStarted(facts(hub, { workspaces: true })).steps.map((s) => s.key), ['org', 'project', 'github', 'machine', 'workers', 'operator', 'shaper', 'landed']);
  });

  test('organization: done once the viewer is a person in the workspace', () => {
    const { hub, step } = setup();
    assert.equal(step('org', { workspaces: true, viewer: '@ana' }).done, false);
    new Auth(hub.db).addPerson('ana', 'owner');
    assert.equal(step('org', { workspaces: true, viewer: '@ana' }).done, true);
  });

  test('add a project: any live project ticks it, with or without a repository (#147)', () => {
    const { hub, step } = setup();
    assert.equal(step('project').done, false);
    assert.equal(step('repo'), undefined, 'no project yet: nothing to link');
    hub.tx(() => hub.project('demo', { create: true }));
    assert.equal(step('project').done, true);
  });

  test('no project has a repository: "Link a project to its repository" opens + repo on the newest project (#147)', () => {
    const { hub, step, tick } = setup();
    hub.tx(() => hub.project('llm-proxy', { create: true }));
    tick(1000);
    const p = hub.tx(() => hub.project('nuworq', { create: true }));
    assert.deepEqual(step('repo'), { key: 'repo', label: 'Link a project to its repository', done: false,
      action: { label: '+ repo', ui: 'link-repo', slug: 'nuworq' } });
    assert.match(getStartedCard({ show: true, steps: [step('project'), step('repo')] }),
      /<button class="btn primary small" data-action="link-repo" data-slug="nuworq">\+ repo<\/button>/);
    hub.addRemote(p, 'github.com/acme/nuworq', 'you');
    assert.equal(step('repo').done, true);
  });

  test('link a repository: a project with a path on disk counts too', () => {
    const { hub, step } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { path: tmpdir() });
    assert.equal(step('repo').done, true);
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

  // The setup that works (#489): Start an agent became its three sessions.
  test('start workers: a runner reported for one of these projects within the last week', () => {
    const { hub, step, tick } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.agentOp('demo', 'checkin', 'a1', {});
    assert.equal(step('workers').done, false, 'an agent checking in is not workers');
    hub.reportRunner({ machine: 'other' }, { scope: ['elsewhere'] });
    assert.equal(step('workers').done, false, 'a runner for a project this hub has not');
    hub.reportRunner({ machine: 'mac' }, { scope: ['demo'] });
    assert.equal(step('workers').done, true);
    tick(RECENT_MS + 1);
    assert.equal(step('workers').done, false, 'a week of silence: start them again');
    hub.reportRunner({ machine: 'mac' });
    assert.equal(step('workers').done, true, 'a runner whose token reaches every project');
  });

  test('start an operator: one checked in within the last week; a worker or session is not one', () => {
    const { hub, step, tick } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.agentOp('demo', 'checkin', 'a1', {});
    assert.equal(step('operator').done, false);
    hub.agentOp('demo', 'checkin', 'op', { has: ['operator'] });
    assert.equal(step('operator').done, true);
    tick(RECENT_MS + 1);
    assert.equal(step('operator').done, false, 'a week of silence: start one again');
  });

  test('shape work with a shaper: a shaper checked in, once is enough', () => {
    const { hub, step, tick } = setup();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.agentOp('demo', 'propose', 'a1', { title: 'A worker proposed this' });
    assert.equal(step('shaper').done, false, 'a worker proposing is not a shaper');
    hub.agentOp('demo', 'checkin', 's1', { role: 'shaper' });
    assert.equal(step('shaper').done, true);
    tick(RECENT_MS + 1);
    assert.equal(step('shaper').done, true, 'shaping is done once: no need to keep one open');
  });

  test('each setup step opens Connect an agent with its session\'s commands', () => {
    const { step } = setup();
    for (const [key, label] of [['workers', 'Start workers'], ['operator', 'Start an operator'], ['shaper', 'Shape work with a shaper']]) {
      assert.deepEqual(step(key), { key, label, done: false, action: { label, ui: 'connect', command: key } });
    }
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
    theSetup(hub);
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
      assert.deepEqual(gs.steps.filter((s) => !s.done).map((s) => s.key), ['repo', 'github', 'machine', 'workers', 'operator', 'shaper', 'landed']);
      assert.equal(gs.steps.find((s) => s.key === 'github').action.href, 'https://github.com/apps/nuworq-test/installations/new');

      hub.addRemote(p, 'github.com/acme/api', 'you');
      theSetup(hub);
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
      theSetup(hub);
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
    { key: 'operator', label: 'Start an operator', done: false, action: { label: 'Start an operator', ui: 'connect', command: 'operator' } },
    { key: 'landed', label: 'Watch your first item land', done: false, action: { label: 'Open the board', href: '#/p/demo' } },
  ];
  const commands = { operator: 'In the project\'s folder, run `claude`, then type `/nuworq:operator`' };

  test('done steps are ticked; the next undone step is a button, later ones links', () => {
    const html = getStartedCard({ show: true, steps });
    assert.match(html, /1 of 4 done/);
    assert.match(html, /<li class="done" data-step="github">\s*<span class="tick">✓/);
    assert.match(html, /class="btn primary small" data-action="new-project">\+ Project/);
    assert.match(html, /<a class="link" href="#\/p\/demo">Open the board/);
    assert.match(html, /data-action="get-started-hide"/);
  });

  test('a step\'s commands show under it once it is the next step, each with its Copy (#489)', () => {
    const later = getStartedCard({ show: true, steps }, { commands });
    assert.doesNotMatch(later, /nuworq:operator/);
    const now = getStartedCard({ show: true, steps: steps.map((s) => (s.key === 'project' ? { ...s, done: true, action: undefined } : s)) }, { commands });
    assert.match(now, /<pre>claude<\/pre>/);
    assert.match(now, /<p class="cmd-join">then type<\/p>/);
    assert.match(now, /<pre>\/nuworq:operator<\/pre>/);
  });

  test('complete or hidden: no card at all', () => {
    assert.equal(getStartedCard({ show: false, complete: true, steps: [] }), '');
    assert.equal(getStartedCard({ show: false, complete: true, steps: steps.map((s) => ({ ...s, done: true })) }), '');
    assert.equal(getStartedCard(null), '');
  });
});
