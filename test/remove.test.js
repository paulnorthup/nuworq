import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { mirrorPath } from '../src/git.js';
import { createServer } from '../src/server.js';

// Two projects with work and history in each: "gone" is removed, "kept" must not change.
function twoProjects() {
  const repos = mkdtempSync(join(tmpdir(), 'nuworq-rm-'));
  const hub = new Hub({ repos });
  for (const [slug, remote] of [['gone', 'github.com/acme/gone'], ['kept', 'github.com/acme/kept']]) {
    hub.tx(() => hub.project(slug, { create: true }));
    hub.addRemote(hub.project(slug), remote, 'you');
    hub.humanOp(slug, 'create', { title: `${slug} one`, acceptance: 'x' });
    hub.humanOp(slug, 'create', { title: `${slug} two`, acceptance: 'x', depends_on: ['#1'] });
    hub.agentOp(slug, 'checkin', 'a1');
    hub.agentOp(slug, 'next', 'a1');
    hub.agentOp(slug, 'ask', 'a1', { item: '#1', question: 'Which?', assumption: 'This one' });
    hub.humanOp(slug, 'steer', { body: 'Keep it small' });
    mkdirSync(mirrorPath(repos, remote), { recursive: true });
  }
  // Every table that holds a project's rows, counted per project.
  const count = (slug) => {
    const id = hub.q('SELECT id FROM projects WHERE slug = ?').get(slug)?.id ?? -1;
    const items = hub.q('SELECT id FROM items WHERE project_id = ?').all(id).map((i) => i.id);
    const inItems = (t, col = 'item_id') => items.length ? hub.q(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} IN (${items.join(',')})`).get().n : 0;
    return {
      ...Object.fromEntries(['items', 'events', 'agents', 'questions', 'notes', 'project_remotes'].map((t) => [t, hub.q(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`).get(id).n])),
      transitions: inItems('transitions'), deps: inItems('deps'),
    };
  };
  return { hub, repos, count };
}

describe('an owner removes a project', () => {
  test('archive: out of lists, routing and lookups, history kept; restore brings it back as it was', () => {
    const { hub, count } = twoProjects();
    const before = { gone: count('gone'), kept: count('kept') };
    hub.humanOp('gone', 'archive');
    assert.deepEqual(hub.projects().map((p) => p.slug), ['kept']);
    assert.deepEqual(hub.projects({ archived: true }).map((p) => p.slug), ['gone']);
    assert.ok(hub.route('x').every((r) => r.project !== 'gone'), 'nobody is routed there');
    assert.equal(hub.projectByRemote('github.com/acme/gone'), null);
    assert.throws(() => hub.agentOp('gone', 'next', 'a2'), /gone is archived/);
    assert.throws(() => hub.addRemote(hub.project('kept'), 'github.com/acme/gone', 'you'), /already belongs to gone \(archived\)/);
    const archived = count('gone');
    assert.equal(archived.items, before.gone.items);
    assert.equal(archived.events, before.gone.events + 1, 'the archive itself is on the record');
    assert.deepEqual(count('kept'), before.kept);

    hub.humanOp('gone', 'restore');
    assert.deepEqual(hub.projects().map((p) => p.slug), ['gone', 'kept']);
    assert.equal(hub.projectByRemote('github.com/acme/gone').slug, 'gone');
    assert.doesNotThrow(() => hub.agentOp('gone', 'next', 'a2'), 'agents reach it again');
    assert.equal(hub.item(hub.project('gone'), '#1').holder, 'a1', 'work in flight is as it was');
  });

  test('delete: only after typing its name; every row, the mirror and its place in tokens go; nothing else changes', () => {
    const { hub, repos, count } = twoProjects();
    const auth = new Auth(hub.db);
    const both = auth.createToken('both', 'agent', { projects: ['gone', 'kept'] });
    const only = auth.createToken('only', 'agent', { projects: ['gone'] });
    const all = auth.createToken('all', 'agent');
    const kept = count('kept');

    assert.throws(() => hub.humanOp('gone', 'delete', { confirm: 'nope' }), /Type the project's name \(gone\)/);
    assert.ok(hub.project('gone'));
    const r = hub.humanOp('gone', 'delete', { confirm: 'gone' });
    assert.equal(r.deleted, 'gone');
    assert.equal(r.revoked_tokens, 1);

    assert.throws(() => hub.project('gone'), /No project "gone"/);
    assert.deepEqual(Object.values(count('gone')), Object.values(count('gone')).map(() => 0), 'no row left anywhere');
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM acks WHERE note_id NOT IN (SELECT id FROM notes)").get().n, 0);
    assert.ok(!existsSync(mirrorPath(repos, 'github.com/acme/gone')), 'its mirror is gone');
    assert.ok(existsSync(mirrorPath(repos, 'github.com/acme/kept')), "the other project's mirror stays");
    assert.deepEqual(count('kept'), kept, 'the other project is untouched');

    assert.deepEqual(auth.verifyToken(both).projects, ['kept'], 'a token for both keeps the other');
    assert.equal(auth.verifyToken(only), null, 'a token for only this one is revoked, not widened to all');
    assert.equal(auth.verifyToken(all).projects, null, 'an unscoped token is untouched');

    // The repository is free again.
    hub.tx(() => hub.project('again', { create: true }));
    assert.equal(hub.addRemote(hub.project('again'), 'github.com/acme/gone', 'you'), 'github.com/acme/gone');
  });

  test('only an owner may archive or delete', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('demo', { create: true }));
    const server = createServer(hub, { auth: 'required' });
    server.auth.addPerson('ste', 'steward');
    const tok = server.auth.createToken('ste-l', 'human', { person: 'ste' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      for (const action of ['archive', 'delete']) {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/p/demo/human/${action}`, {
          method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ confirm: 'demo' }),
        });
        assert.equal(r.status, 403, action);
      }
      assert.ok(hub.project('demo'));
    } finally { server.close(); }
  });
});
