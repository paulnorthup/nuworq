import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { receive } from '../src/github.js';
import { itemView } from '../src/insight.js';
import { Workspaces } from '../src/workspaces.js';
import { notifyWorkspaces, workspaceUrl } from '../src/notify.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const SECRET = 'loose-ends-secret';

// #54: loose ends from merging the overnight branches.
describe('loose ends', () => {
  test('1. /api/me in required mode says which projects a token is limited to', async () => {
    const server = createServer(new Hub(), { auth: 'required' });
    const url = `http://127.0.0.1:${await listen(server)}`;
    try {
      const me = async (t) => (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${t}` } })).json();
      assert.deepEqual((await me(server.auth.createToken('box', 'agent', { projects: ['alpha', 'beta'] }))).projects, ['alpha', 'beta']);
      assert.ok(!('projects' in await me(server.auth.createToken('all', 'agent'))), 'unlimited: no projects field, as in local mode');
    } finally { server.close(); }
  });

  test('2. with workspaces, each workspace gets its own push notifier, linking to its own address', () => {
    const spaces = new Workspaces({ dir: realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-ws-push-'))) });
    spaces.create('acme');
    spaces.create('beta');
    const pushes = notifyWorkspaces(spaces, (n) => workspaceUrl(n, { publicUrl: 'https://hub.example' }), { every: 60_000 });
    try {
      assert.deepEqual([...pushes.notifiers.keys()], ['acme', 'beta']);
      assert.equal(pushes.notifiers.get('acme').baseUrl, 'https://hub.example/w/acme');
      assert.equal(pushes.notifiers.get('acme').hub, spaces.get('acme'));
      spaces.create('gamma');
      pushes.sweep();
      assert.ok(pushes.notifiers.has('gamma'), 'a workspace made while serving is picked up');
    } finally { pushes.stop(); spaces.close(); }
    assert.equal(workspaceUrl('acme', { baseDomain: 'nuworq.com', publicUrl: 'https://nuworq.com' }), 'https://acme.nuworq.com');
  });

  test('2b. a removed workspace loses its notifier, and one made again under that name gets a fresh one', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-ws-gone-')));
    const spaces = new Workspaces({ dir });
    spaces.create('acme');
    spaces.create('beta');
    const pushes = notifyWorkspaces(spaces, (n) => workspaceUrl(n, { publicUrl: 'https://hub.example' }), { every: 60_000, interval: 5, debounce: 1 });
    const errors = [];
    const logged = console.error;
    console.error = (...a) => errors.push(a);
    try {
      const old = pushes.notifiers.get('acme');
      spaces.remove('acme'); // in this process: the hub closes at once
      assert.ok(!pushes.notifiers.has('acme'));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(errors, [], 'no scans on the closed hub');
      spaces.create('acme');
      pushes.sweep();
      assert.ok(pushes.notifiers.get('acme') && pushes.notifiers.get('acme') !== old, 'a fresh notifier');
      assert.equal(pushes.notifiers.get('acme').hub, spaces.get('acme'));

      // Removed by another process (nuworq workspace remove): the next sweep lets it go.
      new Workspaces({ dir }).remove('beta');
      pushes.sweep();
      assert.ok(!pushes.notifiers.has('beta'));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(errors, []);
    } finally { console.error = logged; pushes.stop(); spaces.close(); }
  });

  test("3. a pull request from an item's own branch links to that item, with no #N in its title", () => {
    const hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { github_secret: SECRET });
    hub.addRemote(hub.project('demo'), 'github.com/acme/api', 'you');
    hub.humanOp('demo', 'create', { title: 'Other', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Add things', acceptance: 'x' });
    hub.agentOp('demo', 'checkin', 'a1');
    hub.agentOp('demo', 'claim', 'a1', { item: '#2' });
    const branch = hub.item(hub.project('demo'), '#2').branch;
    assert.match(branch, /^nuworq\/2-/);
    const raw = Buffer.from(JSON.stringify({
      action: 'opened', repository: { full_name: 'acme/api' },
      pull_request: { number: 7, title: 'Add things', state: 'open', merged: false, html_url: 'https://github.com/acme/api/pull/7', head: { ref: branch, sha: 'abc1234' }, base: { ref: 'main' } },
    }));
    const r = receive(hub, 'demo', { event: 'pull_request', raw, signature: 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') });
    assert.equal(r.item, '#2');
  });

  test("4. an item's agents leave out the hub's own actors (github, nuworq)", () => {
    const hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    hub.agentOp('demo', 'checkin', 'a1');
    hub.agentOp('demo', 'claim', 'a1', { item: '#1' });
    const p = hub.project('demo');
    hub.tx(() => {
      hub.event(p, { item: hub.item(p, '#1'), actor: 'github', type: 'pr', headline: 'PR #3 opened' });
      hub.event(p, { item: hub.item(p, '#1'), actor: 'nuworq', type: 'lease_expired', headline: 'x' });
    });
    assert.deepEqual(itemView(hub, 'demo', '#1').agents.map((a) => a.name), ['a1']);
    assert.throws(() => hub.agentOp('demo', 'checkin', 'github'), /reserved/, 'nor can an agent pass itself off as one');
  });

  test("5. \"waiting on dependencies\" counts only work the caller's token could build", () => {
    const hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('demo', 'create', { title: 'Second', acceptance: 'x', depends_on: ['#1'] });
    hub.agentOp('demo', 'checkin', 'busy');
    hub.agentOp('demo', 'claim', 'busy', { item: '#1' });
    hub.agentOp('demo', 'checkin', 'builder');
    assert.match(hub.agentOp('demo', 'next', 'builder').hint, /1 ready item\(s\) are waiting on dependencies/);
    hub.agentOp('demo', 'checkin', 'reviewer', {}, { token: { name: 'r', powers: ['review'] } });
    const idle = hub.agentOp('demo', 'next', 'reviewer', {}, { token: { name: 'r', powers: ['review'] } });
    assert.equal(idle.mode, 'idle');
    assert.doesNotMatch(idle.hint, /waiting on dependencies/, 'a review-only token could never take it');
  });
});
