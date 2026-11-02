import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';

// #611: a field note a person pinned (always) stays until a person unpins or retires it. A review retires only the
// notes it lists (a merge may take a duplicate from elsewhere), and learn's replaces follows retire's rules.
function world({ autonomy = 'full' } = {}) {
  let now = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true }));
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, name, args = {}) => hub.agentOp('p', op, name, args);
  human('settings', { autonomy });
  human('create', { title: 'Exports retry', acceptance: 'x' });
  agent('checkin', 'a1');
  const learn = (note, item) => { now += 1000; return agent('learn', 'a1', { note, ...(item ? { item } : {}) }).note; };
  const pinned = learn('Never run the migration against the live database from a worker.', '#1');
  const plain = learn('Export tests need the fixture in test/data.', '#1');
  const elsewhere = learn('Dashboards cache for a minute.');
  human('always', { note: pinned, on: true });
  // #1 lands: its notes come up in a review, which a2 holds.
  human('update', { item: '#1', stage: 'done' });
  hub.tidyAll();
  const review = agent('next', 'a2');
  const active = (id) => hub.q('SELECT active FROM notes WHERE id = ?').get(id).active === 1;
  return { hub, human, agent, review, pinned, plain, elsewhere, active, learn };
}

describe('a field note a person pinned stays until a person unpins or retires it (#611)', () => {
  test("agents can't retire or replace a pinned field note", () => {
    const { agent, review, pinned, active } = world();
    assert.equal(review.mode, 'tidy');
    assert.match(review.summary, new RegExp(`note ${pinned}\\b`), 'the review lists it');
    assert.throws(() => agent('retire', 'a2', { notes: [pinned], reason: 'Now in the guide' }),
      (e) => e.status === 403 && /A person pinned field note/.test(e.message) && /ask the person/.test(e.hint));
    assert.throws(() => agent('learn', 'a3', { note: 'Workers may run migrations now.', replaces: pinned }), (e) => e.status === 403 && /pinned/.test(e.message));
    assert.ok(active(pinned), 'still on, for every agent');
    const merged = agent('learn', 'a2', { note: 'Combined.' }).note;
    assert.throws(() => agent('retire', 'a2', { notes: [pinned], into: merged, reason: 'duplicate' }), /pinned/, 'nor by merging it away');
  });

  test('once a person unpins it, a review may retire it', () => {
    const { human, agent, pinned, active } = world();
    human('always', { note: pinned, on: false });
    agent('retire', 'a2', { notes: [pinned], reason: 'Now enforced by the worker sandbox (src/sandbox.js)' });
    assert.ok(!active(pinned));
  });

  test('a review retires only the notes it lists; a merge may take a duplicate from elsewhere', () => {
    const { agent, review, plain, elsewhere, active } = world();
    assert.doesNotMatch(review.summary, new RegExp(`note ${elsewhere}\\b`), 'not about the landed item');
    assert.throws(() => agent('retire', 'a2', { notes: [elsewhere], reason: 'stale' }),
      (e) => e.status === 403 && new RegExp(`doesn't list field note ${elsewhere}`).test(e.message));
    assert.ok(active(elsewhere));
    agent('retire', 'a2', { notes: [plain], reason: 'Now in test/export.test.js setup' });
    assert.ok(!active(plain), 'a listed note goes');
    const merged = agent('learn', 'a2', { note: 'Dashboards and exports both cache for a minute.' }).note;
    agent('retire', 'a2', { notes: [elsewhere], into: merged, reason: 'Merged into the combined note' });
    assert.ok(!active(elsewhere), 'merged: its lesson lives on');
  });

  test('replaces follows the same autonomy rule as retire', () => {
    const { agent, plain, active } = world({ autonomy: 'balanced' });
    assert.throws(() => agent('learn', 'a3', { note: 'Export tests build their own fixture.', replaces: plain }),
      (e) => e.status === 403 && /a person retires field notes/.test(e.message));
    assert.ok(active(plain), 'the old note stays');
    const full = world();
    full.agent('learn', 'a3', { note: 'Export tests build their own fixture.', replaces: full.plain });
    assert.ok(!full.active(full.plain), 'under Run with it, replacing still works');
  });
});
