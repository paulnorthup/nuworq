import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { outcomes } from '../src/outcomes.js';
import { guide } from '../src/protocol.js';

// "Run with it": b1 (opus) builds, r1 (qwen) peer-reviews. #1 and #2 land on r1's verdict.
function project() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  hub.agentOp('p', 'checkin', 'b1', { model: 'opus' });
  hub.agentOp('p', 'checkin', 'r1', { model: 'qwen' });
  for (const title of ['One', 'Two']) {
    const { item } = hub.agentOp('p', 'propose', 'b1', { title, acceptance: 'works' });
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built' });
    hub.agentOp('p', 'review', 'r1', { item, verdict: 'accept', headline: 'Checked' });
  }
  return hub;
}

describe('escapes are counted (#176)', () => {
  test('a fix naming a landed item counts one escape against its builder and its reviewer; an unrelated item counts none', () => {
    const hub = project();
    assert.equal(hub.item(hub.project('p'), '#1').stage, 'done');
    hub.agentOp('p', 'propose', 'r1', { title: 'One crashes on empty input', acceptance: 'no crash', fixes: '#1' });
    hub.agentOp('p', 'propose', 'r1', { title: 'Something new', acceptance: 'x' });

    const o = outcomes(hub, 'p');
    const one = o.items.find((i) => i.item === '#1'), two = o.items.find((i) => i.item === '#2');
    assert.deepEqual([one.escaped, one.fixed_by, one.reviewer, one.reviewer_model, one.overturned], [true, ['#3'], 'r1', 'qwen', true]);
    assert.deepEqual([two.escaped, two.fixed_by, two.overturned], [false, [], false]);
    assert.equal(o.by_model.find((m) => m.model === 'opus').escapes, 1);
    assert.deepEqual(o.by_reviewer, [{ model: 'qwen', reviewed: 2, escapes: 1, overturned: 1 }]);

    const v = view(hub, 'p').flow.verification;
    assert.deepEqual([v.landed, v.escaped, v.peer_accepted, v.overturned], [2, 1, 2, 1]);
    assert.deepEqual(v.by_model.find((m) => m.model === 'opus'), { model: 'opus', built: 2, built_escaped: 1, reviewed: 0, reviewed_escaped: 0, overturned: 0 });
    assert.deepEqual(v.by_model.find((m) => m.model === 'qwen'), { model: 'qwen', built: 0, built_escaped: 0, reviewed: 2, reviewed_escaped: 1, overturned: 1 });

    // The drawer shows both ends; the agent working on the fix sees what it repairs.
    assert.deepEqual(itemView(hub, 'p', 3).fixes, { item: '#1', title: 'One' });
    assert.deepEqual(itemView(hub, 'p', 1).fixed_by.map((f) => f.item), ['#3']);
    assert.match(hub.agentOp('p', 'claim', 'b1', { item: '#3' }).fixes, /^#1 One/);
  });

  test('refine sets and clears it, people set it through update, and it must name landed work', () => {
    const hub = project();
    const { item } = hub.agentOp('p', 'propose', 'r1', { title: 'Later', acceptance: 'x' });
    assert.deepEqual(hub.agentOp('p', 'refine', 'r1', { item, fixes: '#2' }).changed, ['fixes #2']);
    assert.equal(outcomes(hub, 'p').items.find((i) => i.item === '#2').escaped, true);
    assert.deepEqual(hub.agentOp('p', 'refine', 'r1', { item, fixes: '' }).changed, ['fixes nothing']);
    assert.equal(outcomes(hub, 'p').items.find((i) => i.item === '#2').escaped, false);
    hub.humanOp('p', 'update', { item, fixes: '1' });
    assert.deepEqual(itemView(hub, 'p', 3).fixes, { item: '#1', title: 'One' });
    // Not landed, or itself: refused with a hint.
    assert.throws(() => hub.agentOp('p', 'propose', 'r1', { title: 'x', fixes: '#3' }), (e) => /#3 is ready, not landed/.test(e.message) && /already landed/.test(e.hint));
    assert.throws(() => hub.agentOp('p', 'refine', 'r1', { item, fixes: item }), /can't fix itself/);
  });

  test('a peer accept a person later sends back is overturned, even without an escape', () => {
    const hub = project();
    const { item } = hub.agentOp('p', 'propose', 'b1', { title: 'Three', acceptance: 'works' });
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built' });
    hub.agentOp('p', 'review', 'r1', { item, verdict: 'accept', headline: 'Checked' });
    // A person reopens it for review and sends it back; it lands later on their own accept.
    hub.humanOp('p', 'update', { item, stage: 'ready' });
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built again' });
    hub.humanOp('p', 'settings', { autonomy: 'balanced' });
    hub.humanOp('p', 'sendback', { item, note: 'Not what I meant' });
    hub.agentOp('p', 'claim', 'b1', { item });
    hub.agentOp('p', 'submit', 'b1', { item, headline: 'Built right' });
    hub.humanOp('p', 'accept', { item });
    const three = outcomes(hub, 'p').items.find((i) => i.item === item);
    assert.deepEqual([three.reviewer, three.reviewer_model, three.escaped, three.overturned], ['you', null, false, true]);
  });

  test('the guide tells agents to set fixes when their work repairs landed work', () => {
    assert.match(guide(), /set `fixes` to that item/);
  });
});
