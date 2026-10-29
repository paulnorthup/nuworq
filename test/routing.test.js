import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { repoRoot } from '../src/client.js';

function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 1, 9) });
  const make = (slug, path = '') => {
    hub.tx(() => hub.project(slug, { create: true }));
    if (path) hub.humanOp(slug, 'settings', { path });
  };
  const op = (slug, op, agent, args = {}, root = '') => hub.agentOp(slug, op, agent, args, { root });
  return { hub, make, op };
}

describe('the hub routes agents to work', () => {
  test('naming a project from a folder teaches the hub where it lives', () => {
    const { hub, op } = setup();
    op('lantern', 'checkin', 'a', {}, '/code/lantern/');
    assert.equal(hub.project('lantern').path, '/code/lantern');
    assert.equal(hub.projectByPath('/code/lantern/src/deep').slug, 'lantern');
    assert.equal(hub.projectByPath('/code/lantern-other'), null, 'a sibling folder with a shared prefix is not a match');
  });

  test('an agent in a known folder needs no project name', () => {
    const { hub, make, op } = setup();
    make('lantern', '/code/lantern');
    hub.humanOp('lantern', 'create', { title: 'Do a thing', acceptance: 'x' });
    const brief = op('', 'checkin', 'a', {}, '/code/lantern');
    assert.equal(brief.project, 'lantern');
    assert.equal(brief.routed, undefined);
    assert.equal(brief.workspace, '/code/lantern');
    assert.equal(op('', 'next', 'a', {}, '/code/lantern').item, '#1');
    op('', 'progress', 'a', { item: '#1', headline: 'going' }, '/code/lantern/src');
  });

  test('an agent anywhere else is routed to the most valuable work, and told where it lives', () => {
    const { hub, make, op } = setup();
    make('quiet', '/code/quiet');
    hub.humanOp('quiet', 'create', { title: 'Later thing', acceptance: 'x', priority: 'later' });
    make('urgent', '/code/urgent');
    hub.humanOp('urgent', 'create', { title: 'Idea', stage: 'proposed' });
    hub.humanOp('urgent', 'pick', { item: '#1' });
    const brief = op('', 'checkin', 'a', {}, '/somewhere/else');
    assert.equal(brief.project, 'urgent');
    assert.match(brief.routed, /#1 Idea/);
    assert.match(brief.workspace, /lives in \/code\/urgent, but you are in \/somewhere\/else/);
    assert.deepEqual(hub.route().map((r) => r.project), ['urgent', 'quiet']);
  });

  test('routing skips parked projects, and says so when nothing is waiting anywhere', () => {
    const { hub, make, op } = setup();
    make('lantern', '/code/lantern');
    hub.humanOp('lantern', 'create', { title: 'Do a thing', acceptance: 'x' });
    hub.humanOp('lantern', 'settings', { parked: true });
    assert.deepEqual(hub.route(), []);
    const r = op('', 'checkin', 'a', {}, '/nowhere');
    assert.equal(r.project, null);
    assert.match(r.next, /No work is waiting in any project/);
  });

  test('other operations without a resolvable project ask the agent to check in first', () => {
    const { op } = setup();
    assert.throws(() => op('', 'progress', 'a', { item: '#1', headline: 'x' }, '/nowhere'), /Which project/);
  });
});

describe('handing off', () => {
  function world() {
    const clock = { t: Date.UTC(2026, 9, 1, 9) };
    const hub = new Hub({ clock: () => clock.t });
    hub.tx(() => hub.project('p', { create: true }));
    const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
    return { hub, clock, op };
  }

  test("what you hand off isn't handed straight back to you, but others get it at once", () => {
    const { hub, clock, op } = world();
    hub.humanOp('p', 'create', { title: 'Needs Docker', acceptance: 'x', priority: 'now' });
    hub.humanOp('p', 'create', { title: 'Plain work', acceptance: 'x' });
    assert.equal(op('a', 'next').item, '#1');
    op('a', 'handoff', { item: '#1', headline: 'no Docker here' });
    assert.equal(op('a', 'next').item, '#2', 'other work instead');
    op('a', 'handoff', { item: '#2', headline: 'also stuck' });
    const idle = op('a', 'next');
    assert.equal(idle.mode, 'idle');
    assert.match(idle.hint, /You handed off #1, #2/);
    assert.equal(op('b', 'next').item, '#1', 'another agent gets it immediately');
    op('b', 'handoff', { item: '#1', headline: 'me neither' });
    clock.t += 31 * 60_000;
    assert.equal(op('a', 'next').item, '#1', 'after the cooldown it comes back');
  });

  test('affinity still brings sent-back work to its implementer', () => {
    const { hub, op } = world();
    hub.humanOp('p', 'create', { title: 'First', acceptance: 'x' });
    hub.humanOp('p', 'create', { title: 'Mine', acceptance: 'x' });
    op('a', 'claim', { item: '#2' });
    op('a', 'submit', { item: '#2', headline: 'done' });
    hub.humanOp('p', 'sendback', { item: '#2', note: 'missing a test' });
    assert.equal(op('a', 'next').item, '#2');
  });
});

describe('transport', () => {
  test('HTTP: project-less agent calls resolve by folder; /api/where and /api/route answer', async () => {
    const { hub, make } = setup();
    make('lantern', '/code/my lantern');
    hub.humanOp('lantern', 'create', { title: 'Do a thing', acceptance: 'x' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/agent/checkin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nuworq-agent': 'a', 'x-nuworq-root': encodeURIComponent('/code/my lantern') },
        body: '{}',
      });
      assert.equal((await res.json()).project, 'lantern');
      const where = await (await fetch(`${base}/api/where?root=${encodeURIComponent('/code/my lantern/sub')}`)).json();
      assert.equal(where.project, 'lantern');
      const route = await (await fetch(`${base}/api/route`)).json();
      assert.equal(route[0].item, '#1');
    } finally {
      server.close();
    }
  });

  test('a git worktree maps back to its main checkout', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-wt-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    g('worktree', 'add', '-q', '-b', 'nuworq/w1', `${dir}.worktrees/w1`);
    assert.equal(repoRoot(`${dir}.worktrees/w1`), dir);
    assert.equal(repoRoot(dir), dir);
  });
});

describe('projects are found by name too', () => {
  test('checking in with a project\'s display name reaches it instead of creating an empty one', () => {
    const { hub, make, op } = setup();
    make('trellis');
    hub.humanOp('trellis', 'settings', { name: 'nuworq' });
    hub.humanOp('trellis', 'create', { title: 'Real work', acceptance: 'x' });
    const brief = op('nuworq', 'checkin', 'a');
    assert.equal(brief.project, 'trellis');
    assert.equal(hub.projects().length, 1, 'no second, empty project');
    assert.equal(op('Nuworq', 'next', 'a').item, '#1');
  });
});

describe('learning where a project lives', () => {
  test('a checkin from a clone of another repository does not teach the project its folder', () => {
    const { hub, make, op } = setup();
    make('proxy');
    hub.humanOp('proxy', 'remote', { add: 'git@github.com:acme/proxy.git' });
    hub.agentOp('proxy', 'checkin', 'a', {}, { root: '/code/other-repo', remote: 'github.com/acme/other' });
    assert.equal(hub.project('proxy').path, '', 'the wrong folder is not learned');
    hub.agentOp('proxy', 'checkin', 'b', {}, { root: '/code/proxy', remote: 'github.com/acme/proxy' });
    assert.equal(hub.project('proxy').path, '/code/proxy', 'its own clone is');
  });
});
