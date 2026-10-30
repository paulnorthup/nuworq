import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HOUR, MIN, DAY } from '../src/core.js';
import { view } from '../src/insight.js';
import { outcomes, humanCost } from '../src/outcomes.js';

// A known fortnight: 8 things a person did, 2 items landed, 4 spells of work waiting on them.
function fortnight() {
  let t = Date.UTC(2026, 9, 20, 9);
  const hub = new Hub({ clock: () => t });
  const tick = (ms) => (t += ms);
  hub.tx(() => hub.project('p', { create: true }));
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, args = {}) => hub.agentOp('p', op, 'w1', args);
  for (const title of ['One', 'Two', 'Three']) human('create', { title, acceptance: 'works' });
  agent('checkin');

  // #1: a blocking question waits 2h for its answer (1), then waits 1h to be accepted (2).
  agent('next');
  agent('ask', { item: '#1', question: 'Which database?', blocking: true });
  tick(2 * HOUR);
  human('answer', { question: 1, answer: 'Postgres' });
  agent('next');
  agent('submit', { item: '#1', headline: 'Built' });
  tick(HOUR);
  human('accept', { item: '#1' });

  // #2: sent back after 30m (3), accepted 3h after the resubmit (4).
  agent('next');
  agent('submit', { item: '#2', headline: 'Built' });
  tick(30 * MIN);
  human('sendback', { item: '#2', note: 'Missing the test' });
  agent('next');
  agent('submit', { item: '#2', headline: 'Built, with the test' });
  tick(3 * HOUR);
  human('accept', { item: '#2' });

  // A steer (5), a comment (6), a decision (7), and an override (8: its answer and its steer are one action).
  human('steer', { item: '#3', body: 'Keep it small' });
  human('comment', { item: '#3', body: 'Looks right' });
  human('decide', { body: 'Postgres everywhere' });
  agent('next');
  agent('ask', { item: '#3', question: 'Tabs or spaces?', assumption: 'tabs' });
  human('answer', { question: 2, answer: 'spaces' });
  // Agents' own comments and creating work aren't counted.
  agent('comment', { item: '#3', headline: 'noted' });
  return { hub, tick };
}

describe('what work costs you (#175)', () => {
  test("Flow: your actions per landed item, and how long work waited for you, over its 14 days", () => {
    const { hub } = fortnight();
    const y = view(hub, 'p').flow.you;
    assert.deepEqual(y, { actions: 8, landed: 2, per_landed: 4, median_wait: '2h', waits: 4 });
  });

  test('the outcomes API: human_actions per item, and the window total', () => {
    const { hub } = fortnight();
    const o = outcomes(hub, 'p');
    assert.equal(o.version, 1, 'only fields added');
    assert.deepEqual(o.items.map((i) => [i.item, i.human_actions]), [['#1', 2], ['#2', 2]]);
    assert.deepEqual(o.human_actions, { total: 8, landed: 2, per_landed: 4, median_wait_ms: 2 * HOUR });
  });

  test('outside the window it counts nothing; with nothing landed, per landed item is null', () => {
    const { hub, tick } = fortnight();
    tick(15 * DAY);
    assert.deepEqual(humanCost(hub, hub.project('p'), hub.now() - 14 * DAY), { actions: 0, landed: 0, per_landed: null, median_wait_ms: null, waits: 0 });
    hub.humanOp('p', 'comment', { item: '#3', body: 'still here' });
    assert.deepEqual(view(hub, 'p').flow.you, { actions: 1, landed: 0, per_landed: null, median_wait: null, waits: 0 });
  });

  test('a wait an agent ended is not yours: with agents reviewing, verification never waits on you', () => {
    let t = Date.UTC(2026, 9, 20, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'settings', { autonomy: 'full' });
    hub.humanOp('p', 'create', { title: 'One', acceptance: 'works' });
    hub.agentOp('p', 'next', 'w1');
    hub.agentOp('p', 'submit', 'w1', { item: '#1', headline: 'Built' });
    t += HOUR;
    hub.agentOp('p', 'review', 'w2', { item: '#1', verdict: 'accept', headline: 'Checked' });
    const y = view(hub, 'p').flow.you;
    assert.equal(y.waits, 0);
    assert.equal(y.actions, 1, 'setting the autonomy is a steer, and counts');
    assert.equal(y.landed, 1);
    assert.equal(y.per_landed, 1);
  });
});
