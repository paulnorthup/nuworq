import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';

// #81 (2026-10-29): "I'll run it … keep #81 parked until then". Answering shouldn't always hand the work back.
function parkedOnQuestion() {
  const hub = new Hub();
  hub.tx(() => hub.project('k', { create: true }));
  hub.humanOp('k', 'create', { title: 'Needs a manual run', acceptance: 'x' });
  hub.humanOp('k', 'create', { title: 'Other work', acceptance: 'x' });
  hub.agentOp('k', 'claim', 'a1', { item: '#1' });
  hub.agentOp('k', 'ask', 'a1', { item: '#1', question: 'Can you run the migration on prod?', blocking: true });
  const q = hub.q("SELECT id FROM questions WHERE status = 'open'").get().id;
  return { hub, q, item: (n) => hub.item(hub.project('k'), `#${n}`) };
}

describe('answering can keep the work parked', () => {
  test('keep_parked: answered and recorded, still waiting, next hands out other work; unpark releases it', () => {
    const { hub, q, item } = parkedOnQuestion();
    assert.equal(item(1).stage, 'waiting');
    hub.humanOp('k', 'answer', { question: q, answer: "I'll run it tonight; keep #1 parked until then", keep_parked: true });
    assert.equal(item(1).stage, 'waiting');
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(q).status, 'answered');
    assert.equal(hub.agentOp('k', 'next', 'a2').item, '#2', 'other work, not #1');

    const card = view(hub, 'k').attention.find((a) => a.kind === 'kept-parked');
    assert.equal(card.level, 'act');
    assert.equal(card.item, '#1');
    assert.match(card.headline, /#1 is parked by you/);
    assert.match(card.sub, /answered: I'll run it tonight/);

    hub.humanOp('k', 'unpark', { item: '#1' });
    assert.equal(item(1).stage, 'ready');
    assert.equal(item(1).parked_by, '');
    assert.ok(!view(hub, 'k').attention.some((a) => a.kind === 'kept-parked'));
    assert.equal(hub.agentOp('k', 'next', 'a3').item, '#1');
    assert.throws(() => hub.humanOp('k', 'unpark', { item: '#2' }), /isn't parked by anyone/);
  });

  test('without keep_parked nothing changes: the answer hands the work back', () => {
    const { hub, q, item } = parkedOnQuestion();
    assert.equal(view(hub, 'k').attention.find((a) => a.kind === 'question').parked, true, 'the card offers to keep it parked');
    hub.humanOp('k', 'answer', { question: q, answer: 'Done, carry on' });
    assert.equal(item(1).stage, 'ready');
    assert.equal(hub.agentOp('k', 'next', 'a2').item, '#1');
  });

  test('moved out of waiting any other way, it is no longer kept parked', () => {
    const { hub, q, item } = parkedOnQuestion();
    hub.humanOp('k', 'answer', { question: q, answer: 'later', keep_parked: true });
    hub.humanOp('k', 'update', { item: '#1', stage: 'ready' });
    assert.equal(item(1).stage, 'ready');
    assert.equal(item(1).parked_by, '');
  });
});
