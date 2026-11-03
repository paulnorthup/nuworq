import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { itemView } from '../src/insight.js';
import { MODE_RULES, tools } from '../src/protocol.js';
import { appSource } from './appsource.js';

// #1 Workers goal, #2 Operator lane (#3 its part), #4 a lone item.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('p', { create: true }));
  const human = (op, args) => hub.humanOp('p', op, args);
  human('create', { title: 'Workers are on waiting work', acceptance: 'x' });
  human('create', { title: 'An operator lane', acceptance: 'x' });
  human('create', { title: 'Document the operator role', acceptance: 'x', parent: '#2' });
  human('create', { title: 'A lone item', acceptance: 'x' });
  hub.agentOp('p', 'checkin', 'w1');
  const refine = (args) => hub.agentOp('p', 'refine', 'w1', args);
  const view = (n) => itemView(hub, 'p', n);
  const said = (n) => view(n).events.filter((e) => e.type === 'regrouped').map((e) => e.headline);
  return { hub, human, refine, view, said };
}

describe('moving an item to another group, or out of one (#199)', () => {
  test('refine with parent moves it; both groups say so, and the drawer shows the new one', () => {
    const { refine, view, said } = setup();
    refine({ item: '#2', parent: '#1' });
    assert.deepEqual(view(2).parent, { item: '#1', title: 'Workers are on waiting work', stage: 'ready' });
    assert.deepEqual(view(1).children.map((c) => c.item), ['#2']);
    assert.deepEqual(said(1), ['w1 moved #2 into #1: An operator lane']);

    refine({ item: '#3', parent: '#1' });
    assert.deepEqual(said(2), ['w1 moved #3 out of #2 into #1: Document the operator role']);
    assert.deepEqual(said(1).at(-1), 'w1 moved #3 into #1 from #2: Document the operator role');
    assert.match(view(3).events.at(-1).headline, /refined #3: part of #1/);
  });

  test('parent "" makes it top-level', () => {
    const { refine, view, said } = setup();
    refine({ item: '#3', parent: '' });
    assert.equal(view(3).parent, null);
    assert.deepEqual(said(2), ['w1 moved #3 out of #2: Document the operator role']);
    assert.deepEqual(refine({ item: '#4', parent: '' }).changed, [], 'already top-level: nothing to record');
    assert.deepEqual(said(4), []);
  });

  test('never under itself or its own descendant: 400 with a hint', () => {
    const { refine } = setup();
    refine({ item: '#2', parent: '#1' });
    for (const [item, parent, msg] of [['#1', '#1', /can't be part of itself/], ['#1', '#3', /#3 is part of #1, so #1 can't go under it/], ['#2', '#3', /#3 is part of #2/]]) {
      assert.throws(() => refine({ item, parent }), (e) => e.status === 400 && msg.test(e.message) && /Pick a parent outside/.test(e.hint));
    }
  });

  test('a done item can move; nothing moves into a done or dropped group', () => {
    const { hub, human, refine, view } = setup();
    human('update', { item: '#4', stage: 'done' });
    refine({ item: '#4', parent: '#1' });
    assert.equal(view(4).parent.item, '#1');
    human('update', { item: '#2', stage: 'dropped' });
    assert.throws(() => refine({ item: '#4', parent: '#2' }), (e) => e.status === 400 && /#2 is dropped/.test(e.message) && /Pick an open parent/.test(e.hint));
    human('update', { item: '#1', stage: 'done' });
    assert.throws(() => hub.humanOp('p', 'update', { item: '#3', parent: '#1' }), /#1 is done/);
  });

  test('people do it from the drawer; the shape hint and the refine tool name the field', () => {
    const { human, view, said } = setup();
    human('update', { item: '#4', parent: '#2' });
    assert.equal(view(4).parent.item, '#2');
    assert.deepEqual(said(2), ['You moved #4 into #2: A lone item']);
    const app = appSource();
    assert.match(app, /Part of <input data-draft="ei-parent"/);
    assert.match(app, /parent: val\('ei-parent'\)/);
    assert.match(MODE_RULES.shape, /refine it with parent \("" takes it out\)/);
    assert.match(tools().find((t) => t.name === 'refine').description, /parent "": top-level/);
  });
});
