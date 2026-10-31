import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';

// #216: "Keeps bouncing" asks the human to act. Accepted work in landing is agents' to put on main, so it never asks.
describe('Keeps bouncing', () => {
  const setup = () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'Flaky work', acceptance: 'x' });
    const id = hub.item(hub.project('p'), '#1').id;
    const set = (cols) => hub.q(`UPDATE items SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(cols), id);
    const bouncing = () => view(hub, 'p').attention.filter((a) => a.kind === 'struggling').map((a) => a.headline);
    return { set, bouncing };
  };

  test('an item agents went quiet on twice is struggling while ready, and not once it is accepted into landing', () => {
    const { set, bouncing } = setup();
    set({ stalls: 2 });
    assert.deepEqual(bouncing(), ['Flaky work']);
    set({ stage: 'landing' });
    assert.deepEqual(bouncing(), [], 'nothing left for the human to do');
  });

  test('sent back from landing for review (a land with conflicts), it can show again', () => {
    const { set, bouncing } = setup();
    set({ stalls: 1, rejections: 1, stage: 'landing' });
    assert.deepEqual(bouncing(), []);
    set({ stage: 'verifying' });
    assert.deepEqual(bouncing(), ['Flaky work']);
  });
});
