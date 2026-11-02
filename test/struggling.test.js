import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';

// #216: "Keeps bouncing" asks the human to act. Accepted work in landing is agents' to put on main, so it never asks.
// What makes it a bounce comes from the item's history (#564, test/bounce.test.js): here, two reviewers sending it
// back for the same reason.
describe('Keeps bouncing', () => {
  const setup = () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'Flaky work', acceptance: 'x' });
    const p = hub.project('p'), item = hub.item(p, '#1');
    for (const by of ['claude-r1', 'claude-r2']) hub.event(p, { item, actor: by, type: 'sent_back', headline: `${by} sent back #1: the export still times out` });
    const set = (cols) => hub.q(`UPDATE items SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), item.id);
    set({ rejections: 2 });
    const bouncing = () => view(hub, 'p').attention.filter((a) => a.kind === 'struggling').map((a) => a.headline);
    return { set, bouncing };
  };

  test('an item two reviewers sent back for the same reason is struggling while ready, and not once it is accepted into landing', () => {
    const { set, bouncing } = setup();
    assert.deepEqual(bouncing(), ['Flaky work']);
    set({ stage: 'landing' });
    assert.deepEqual(bouncing(), [], 'nothing left for the human to do');
  });

  test('sent back from landing for review (a land with conflicts), it can show again', () => {
    const { set, bouncing } = setup();
    set({ stage: 'landing' });
    assert.deepEqual(bouncing(), []);
    set({ stage: 'verifying' });
    assert.deepEqual(bouncing(), ['Flaky work']);
  });
});
