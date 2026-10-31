import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { OPERATOR_TAGS } from '../src/protocol.js';

// #325: one generic operator tag for live infrastructure. nuworq-infra and homelab-vm are its old names.
function setup(file) {
  const hub = new Hub({ file });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  const p = hub.project('p');
  return {
    hub, p,
    a: (agent, op, args = {}, opts) => hub.agentOp('p', op, agent, args, opts),
    needs: (n) => JSON.parse(hub.item(p, `#${n}`).needs),
    has: (agent) => JSON.parse(hub.q('SELECT has FROM agents WHERE project_id = ? AND name = ?').get(p.id, agent).has),
  };
}
const RUNNER = { token: { name: 'mac-runner', runner: 'mac' } };

describe('infra is the one operator tag for live infrastructure', () => {
  test('OPERATOR_TAGS is operator, claude-cli, infra and github-admin', () => {
    assert.deepEqual(OPERATOR_TAGS, ['operator', 'claude-cli', 'infra', 'github-admin']);
  });

  test('checkin accepts both old names in has, stores infra and says the tag was renamed', () => {
    const { a, has } = setup();
    for (const [agent, old] of [['op1', 'nuworq-infra'], ['op2', 'homelab-vm']]) {
      const r = a(agent, 'checkin', { has: ['operator', old] });
      assert.deepEqual(has(agent), ['operator', 'infra']);
      assert.match(r.hint, new RegExp(`Tag renamed: ${old} is now infra`));
    }
    assert.doesNotMatch(a('op3', 'checkin', { has: ['operator', 'infra'] }).hint ?? '', /renamed/, 'the new name: no note');
  });

  test('propose and refine accept the old names in needs, store infra and say so', () => {
    const { a, needs } = setup();
    a('s', 'checkin', {});
    const r = a('s', 'propose', { title: 'Point the DNS at the hub', needs: ['nuworq-infra', 'homelab-vm'] });
    assert.deepEqual(needs(1), ['infra']);
    assert.match(r.hint, /Tag renamed: nuworq-infra is now infra, homelab-vm is now infra/);
    const r2 = a('s', 'refine', { item: '#1', needs: 'homelab-vm, docker' });
    assert.deepEqual(needs(1), ['infra', 'docker']);
    assert.match(r2.hint, /homelab-vm is now infra/);
  });

  test('an operator that declares nuworq-infra gets infra work; a worker never does, even declaring it', () => {
    const { hub, a } = setup();
    hub.humanOp('p', 'create', { title: 'Restart the VM', acceptance: 'x', needs: ['infra'] });
    a('w', 'checkin', { has: ['macos', 'infra'] }, RUNNER);
    assert.notEqual(a('w', 'next', { claim: false }, RUNNER).item, '#1');
    assert.throws(() => a('w', 'claim', { item: '#1' }, RUNNER), /operator-only/);
    a('op', 'checkin', { has: ['operator', 'nuworq-infra'] });
    assert.equal(a('op', 'next').item, '#1');
  });

  test('on start, stored needs and has move from the old names to infra once, with no history', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-infra-')), 'hub.db');
    const { hub, p, a } = setup(file);
    hub.humanOp('p', 'create', { title: 'Check the VM', acceptance: 'x' });
    hub.humanOp('p', 'create', { title: 'Plain', acceptance: 'x', needs: ['docker'] });
    a('op', 'checkin', { has: ['operator'] });
    // As a hub from before #325 stored them.
    hub.q('UPDATE items SET needs = ? WHERE project_id = ? AND seq = 1').run('["homelab-vm","nuworq-infra","docker"]', p.id);
    hub.q('UPDATE agents SET has = ? WHERE project_id = ? AND name = ?').run('["operator","nuworq-infra"]', p.id, 'op');
    const events = hub.q('SELECT COUNT(*) AS n FROM events').get().n;
    hub.db.close();

    const again = new Hub({ file });
    const needs = (seq) => JSON.parse(again.q('SELECT needs FROM items WHERE project_id = ? AND seq = ?').get(p.id, seq).needs);
    assert.deepEqual(needs(1), ['infra', 'docker']);
    assert.deepEqual(needs(2), ['docker'], 'other tags untouched');
    assert.deepEqual(JSON.parse(again.q('SELECT has FROM agents WHERE name = ?').get('op').has), ['operator', 'infra']);
    assert.equal(again.q('SELECT COUNT(*) AS n FROM events').get().n, events, 'no events added');
    again.q('UPDATE items SET needs = ? WHERE project_id = ? AND seq = 1').run('["infra"]', p.id);
    assert.equal(again.agentOp('p', 'next', 'op', {}).item, '#1', 'the operator that declared nuworq-infra still gets infra work');
    again.db.close();
  });
});
