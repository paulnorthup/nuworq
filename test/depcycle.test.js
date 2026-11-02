import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN, UserError } from '../src/core.js';

// A dependency that would make a cycle is refused, naming the loop (#730): everything in a loop waits forever.
function world() {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const create = (args) => { const r = hub.humanOp('p', 'create', { acceptance: 'x', ...args }).item; t += MIN; return r; };
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const deps = (ref) => hub.deps(hub.item(hub.project('p'), ref)).map((d) => `#${d.seq}`);
  op('a1', 'checkin', { has: [] });
  return { hub, create, op, deps };
}

describe('dependency cycles (#730)', () => {
  test('#1 depending on #2 when #2 depends on #1 is refused, naming the loop, and #1 keeps its dependencies', () => {
    const { create, op, deps } = world();
    create({ title: 'One' }); // #1
    create({ title: 'Two', depends_on: ['#1'] }); // #2
    create({ title: 'Three' }); // #3
    op('a1', 'refine', { item: '#1', depends_on: ['#3'] });
    assert.throws(() => op('a1', 'refine', { item: '#1', depends_on: ['#2'] }), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /#1 → #2 → #1/);
      assert.match(e.hint, /#2/);
      return true;
    });
    assert.deepEqual(deps('#1'), ['#3']);
    assert.deepEqual(deps('#2'), ['#1']);
  });

  test('a longer loop is named in full', () => {
    const { create, op } = world();
    create({ title: 'One' }); // #1
    create({ title: 'Two', depends_on: ['#1'] }); // #2
    create({ title: 'Three', depends_on: ['#2'] }); // #3
    assert.throws(() => op('a1', 'refine', { item: '#1', depends_on: ['#3'] }), /#1 → #3 → #2 → #1/);
  });

  test('a new part depending on its own parent is refused, and nothing is created', () => {
    const { hub, create, op } = world();
    create({ title: 'One' }); // #1
    create({ title: 'Two' }); // #2
    create({ title: 'Group' }); // #3
    assert.throws(() => op('a1', 'propose', { title: 'A part', parent: '#3', depends_on: ['#3'] }), (e) => {
      assert.ok(e instanceof UserError);
      assert.match(e.message, /The new item can't depend on #3: that makes a loop, the new item → #3 → the new item/);
      assert.match(e.hint, /#3 waits for its parts/);
      return true;
    });
    assert.throws(() => hub.item(hub.project('p'), '#4'));
  });

  test('a part depending on an ancestor, directly or through another item, is refused', () => {
    const { create, op, deps } = world();
    create({ title: 'Milestone' }); // #1
    create({ title: 'Group', parent: '#1' }); // #2
    create({ title: 'Part', parent: '#2' }); // #3
    create({ title: 'Elsewhere', depends_on: ['#1'] }); // #4
    assert.throws(() => op('a1', 'refine', { item: '#3', depends_on: ['#1'] }), /#3 → #1 → #2 → #3/);
    assert.throws(() => op('a1', 'refine', { item: '#3', depends_on: ['#4'] }), /#3 → #4 → #1 → #2 → #3/);
    assert.deepEqual(deps('#3'), []);
  });

  test('moving an item under a group that waits on it is refused', () => {
    const { create, op, hub } = world();
    create({ title: 'One' }); // #1
    create({ title: 'Group', depends_on: ['#1'] }); // #2
    create({ title: 'Its part', parent: '#2' }); // #3
    assert.throws(() => op('a1', 'refine', { item: '#2', parent: '#3' }), /part of #2/); // the existing check still comes first
    op('a1', 'refine', { item: '#1', depends_on: [] });
    create({ title: 'Waits on four' }); // #4
    create({ title: 'Four' }); // #5
    op('a1', 'refine', { item: '#4', depends_on: ['#5'] });
    assert.throws(() => op('a1', 'refine', { item: '#4', parent: '#5' }), /#5 → #4 → #5/);
    assert.equal(hub.item(hub.project('p'), '#4').parent_id, null);
  });

  test('dependencies without a cycle are set as before, even across a few hundred items', () => {
    const { create, op, deps } = world();
    create({ title: 'Diamond top' }); // #1
    create({ title: 'Left', depends_on: ['#1'] }); // #2
    create({ title: 'Right', depends_on: ['#1'] }); // #3
    create({ title: 'Bottom', depends_on: ['#2', '#3', '#1'] }); // #4
    assert.deepEqual(deps('#4'), ['#1', '#2', '#3']);
    op('a1', 'refine', { item: '#4', depends_on: ['#4', '#2'] }); // itself is still skipped quietly
    assert.deepEqual(deps('#4'), ['#2']);
    for (let s = 5; s <= 300; s++) create({ title: `Chain ${s}`, depends_on: [`#${s - 1}`] });
    const t0 = performance.now();
    op('a1', 'refine', { item: '#1', depends_on: [] });
    create({ title: 'End', depends_on: ['#300', '#150'] }); // #301
    assert.ok(performance.now() - t0 < 200);
    assert.throws(() => op('a1', 'refine', { item: '#1', depends_on: ['#301'] }), /#1 → #301 → #150 → … → #2 → #1/);
  });
});
