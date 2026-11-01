// The getting-started guide (#383): served at /guide to anyone, in Get started's order and words, and every
// Get started step links to its section.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer, buildInfo } from '../src/server.js';
import { getStarted } from '../src/getstarted.js';
import { STEPS, ESSENTIALS, guidePage, mentions } from '../src/userguide.js';
import { getStartedCard } from '../web/getstarted.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const stop = (s) => { s.close(); s.closeAllConnections(); };

// Every step Get started can show: a hub with workspaces, a project and GitHub.
const all = getStarted({ workspaces: true, project: true, github: true, app: 'none', canCreateApp: true }).steps.map((s) => s.done
  ? { ...s, done: false, action: { label: s.label, ui: 'connect' } } : s);

describe('the guide follows Get started', () => {
  test('every Get started step has a section with the same title, in the same order', () => {
    const keys = STEPS.map((s) => s.key);
    for (const g of all) {
      const s = STEPS.find((x) => x.key === g.key);
      assert.ok(s, `the guide has a section for Get started's ${g.key}`);
      assert.equal(s.title, g.label, `${g.key} is called the same in both`);
    }
    const order = all.map((g) => keys.indexOf(g.key));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in the order Get started lists them');
    assert.equal(STEPS[0].key, 'signin', 'it starts from signing in');
    assert.equal(STEPS.at(-1).key, 'landed', 'and ends at a landed item');
  });

  test('each step says what to do by hand, whether nuworq can do it, and how to see it worked', () => {
    for (const s of STEPS) {
      assert.ok(s.glance && s.hand.length && s.check, `${s.key} has a glance, the manual way and a check`);
      assert.ok(!!s.auto !== !!s.none, `${s.key} says either what nuworq does for you or that it can't`);
    }
    for (const e of ESSENTIALS) assert.ok(e.glance && e.body.length, `${e.key} has a glance and a body`);
    assert.deepEqual(ESSENTIALS.map((e) => e.key), ['autonomy', 'depth', 'notifications', 'operator']);
  });

  test('the Get started card links the guide, and each undone step to its section', () => {
    const html = getStartedCard({ show: true, steps: all });
    assert.match(html, /href="guide"/);
    for (const g of all) assert.match(html, new RegExp(`href="guide#${g.key}"`), `${g.key} links to its section`);
    const done = getStartedCard({ show: true, steps: [{ ...all[0], done: true, action: undefined }, ...all.slice(1)] });
    assert.doesNotMatch(done, new RegExp(`href="guide#${all[0].key}"`), 'a done step needs no How?');
  });
});

describe('the page', () => {
  test('one screen lists the steps; each opens for the details; commands get a Copy button', () => {
    const html = guidePage({ version: 'v1.2.3 · abc1234', base: '/w/acme' });
    assert.match(html, /This guide describes nuworq v1\.2\.3 · abc1234/);
    for (const s of [...STEPS, ...ESSENTIALS]) assert.match(html, new RegExp(`<details id="${s.key}">`));
    assert.match(html, /href="\/w\/acme\/guide\.css"/, 'its assets come from the workspace it is served in');
    assert.match(html, /<button type="button" data-copy="nuworq run --workers 3 --agent claude">Copy<\/button>/);
    assert.match(html, /<b>Accept<\/b>/, 'labels are bold');
    assert.doesNotMatch(html, /\*\*|`/, 'no raw marks are left');
  });

  test('mentions() lists the commands and labels it names', () => {
    const m = mentions();
    assert.ok(m.commands.includes('nuworq run --install'));
    assert.ok(m.labels.includes('Connect an agent'));
  });
});

describe('GET /guide', () => {
  test('a hub without logins serves it, with the running version', async () => {
    const server = createServer(new Hub(), { sweepMs: 60_000 });
    const url = await listen(server);
    try {
      const r = await fetch(`${url}/guide`);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      const body = await r.text();
      assert.match(body, /<h1>Getting started<\/h1>/);
      assert.ok(body.includes(`nuworq v${buildInfo().version}`), 'it says which version it describes');
      for (const f of ['guide.js', 'guide.css', 'copy.js']) assert.equal((await fetch(`${url}/${f}`)).status, 200, f);
    } finally { stop(server); }
  });

  test('a hub with login serves it to someone not signed in', async () => {
    const hub = new Hub();
    new Auth(hub.db);
    const server = createServer(hub, { auth: 'required', sweepMs: 60_000 });
    const url = await listen(server);
    try {
      const r = await fetch(`${url}/guide`);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /Getting started/);
      assert.equal((await fetch(`${url}/api/projects`)).status, 401, 'while the rest still needs a sign-in');
    } finally { stop(server); }
  });

  let spaces, server, url;
  before(async () => {
    spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-guide-')) });
    spaces.create('acme');
    server = createServer(spaces, { sweepMs: 60_000 });
    url = await listen(server);
  });
  after(() => stop(server));

  test('a hub with workspaces serves it at its own address and in each workspace, signed out', async () => {
    const root = await fetch(`${url}/guide`);
    assert.equal(root.status, 200);
    const body = await root.text();
    assert.match(body, /href="\/guide\.css"/);
    for (const f of ['guide.js', 'guide.css', 'copy.js', 'style.css']) assert.equal((await fetch(`${url}/${f}`)).status, 200, f);
    const ws = await fetch(`${url}/w/acme/guide`);
    assert.equal(ws.status, 200);
    assert.match(await ws.text(), /href="\/w\/acme\/guide\.css"/);
  });
});

describe('the change rule (#385)', () => {
  test('the rule is nuworq\'s own, so /agents.md leaves it to that project\'s decisions (#527)', async () => {
    const server = createServer(new Hub(), { sweepMs: 60_000 });
    const url = await listen(server);
    try {
      const md = await (await fetch(`${url}/agents.md`)).text();
      assert.doesNotMatch(md, /src\/userguide\.js/);
      assert.ok(existsSync(new URL('../src/userguide.js', import.meta.url)), 'the file the decision names exists');
    } finally { stop(server); }
  });
});
