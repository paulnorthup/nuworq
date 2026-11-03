import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';

// A submit naming another live item's branch is told its item keeps its own (#759), and steering waiting for
// the agent doesn't replace that (#800): the steering line leads, the notice follows. Neither waits on a
// repository the hub can read.
function world(opts = {}) {
  const hub = new Hub({ clock: () => Date.UTC(2026, 10, 2, 9), ...opts });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  for (const title of ['One', 'Two']) hub.humanOp('p', 'create', { title, acceptance: 'x' });
  const agent = (name, op, args = {}) => hub.agentOp('p', op, name, args);
  for (const a of ['a1', 'a2']) for (const s of agent(a, 'checkin').steers ?? []) agent(a, 'ack', { steer: s.steer });
  const two = agent('a2', 'claim', { item: '#2' });
  const one = agent('a1', 'claim', { item: '#1' });
  return { hub, agent, one, two };
}

describe("a submit's branch notice", () => {
  for (const [where, opts] of [['with no repository', {}], ['with a mirror the hub can\'t read', 'mirror']]) {
    test(`survives waiting steering, ${where}`, () => {
      const { hub, agent, one, two } = world();
      if (opts === 'mirror') {
        hub.repos = mkdtempSync(join(tmpdir(), 'nuworq-800-'));
        hub.addRemote(hub.project('p'), join(hub.repos, 'nowhere'), 'you');
      }
      hub.humanOp('p', 'steer', { body: 'Keep the diff small.' });
      const sub = agent('a1', 'submit', { item: '#1', headline: `Done on ${two.branch}`, evidence: [{ label: `branch ${two.branch}` }] });
      assert.equal(sub.steers.length, 1, 'the steer is waiting');
      assert.match(sub.hint, /^The human has steered you; read it, adjust, then ack\. /, 'steering leads');
      assert.ok(sub.hint.includes(`${two.branch} is #2's branch, so #1 keeps ${one.branch}`), sub.hint);
      assert.equal(hub.item(hub.project('p'), '#1').branch, one.branch, 'the item keeps its own branch');
    });
  }

  test('comes first when no steering waits', () => {
    const { agent, one, two } = world();
    const sub = agent('a1', 'submit', { item: '#1', headline: `Done on ${two.branch}` });
    assert.equal(sub.steers, undefined);
    assert.ok(sub.hint.startsWith(`${two.branch} is #2's branch, so #1 keeps ${one.branch}`), sub.hint);
  });
});
