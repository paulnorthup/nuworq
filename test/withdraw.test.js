import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { guide, skill, tools } from '../src/protocol.js';

function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: 'Admin page', acceptance: 'only admins get in' });
  hub.agentOp('p', 'checkin', 'w1');
  hub.agentOp('p', 'next', 'w1');
  return hub;
}
const asks = (hub) => view(hub, 'p').attention.filter((a) => a.question);

describe('an agent withdraws its own open question (#184)', () => {
  test('with a reason: withdrawn, out of Needs you and Worth knowing, the reason on the record and in the drawer', () => {
    const hub = setup();
    const a = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Who are the admins?', assumption: 'everyone in the workspace' });
    const b = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Should admins see billing?', options: ['yes', 'no'] });
    assert.equal(asks(hub).length, 2);
    assert.equal(hub.item(hub.project('p'), '#1').stage, 'waiting', 'the blocking one parked it');

    const r = hub.agentOp('p', 'withdraw', 'w1', { question: a.question, reason: 'Paul answered in a planning session: he is the only admin.' });
    assert.equal(r.ok, true);
    hub.agentOp('p', 'withdraw', 'w1', { question: b.question, reason: 'No longer matters: billing moved to #9' });
    assert.equal(asks(hub).length, 0);
    assert.equal(hub.item(hub.project('p'), '#1').stage, 'ready', 'nothing parks it any more');

    const it = itemView(hub, 'p', 1);
    assert.deepEqual(it.questions.map((q) => [q.status, q.closed_reason]), [
      ['withdrawn', 'Paul answered in a planning session: he is the only admin.'],
      ['withdrawn', 'No longer matters: billing moved to #9'],
    ]);
    const ev = hub.q("SELECT headline, summary FROM events WHERE type = 'question_withdrawn' ORDER BY id").all();
    assert.equal(ev.length, 2);
    assert.match(ev[0].headline, /w1 withdrew its question: Who are the admins\?/);
    assert.equal(ev[0].summary, 'Why: Paul answered in a planning session: he is the only admin.');
    // A person can't answer it any more either.
    assert.throws(() => hub.humanOp('p', 'answer', { question: a.question, answer: 'x' }), /already withdrawn/);
  });

  test("someone else's question is 403 with a hint; one that's no longer open is 409; a reason is required", () => {
    const hub = setup();
    hub.agentOp('p', 'checkin', 'w2');
    const { question } = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs?', assumption: 'tabs' });
    assert.throws(() => hub.agentOp('p', 'withdraw', 'w2', { question, reason: 'nah' }), (e) => e.status === 403 && /w1's, not yours/.test(e.message) && /comment/.test(e.hint));
    assert.throws(() => hub.agentOp('p', 'withdraw', 'w1', { question, reason: ' ' }), /reason is required/);
    hub.humanOp('p', 'confirm', { question });
    assert.throws(() => hub.agentOp('p', 'withdraw', 'w1', { question, reason: 'late' }), (e) => e.status === 409 && /already confirmed/.test(e.message));
  });

  test('the guide and the skill list it and say when to use it; decisions are asked without an assumption', () => {
    const g = guide();
    assert.match(g, /withdraw.*one-line reason/);
    assert.match(g, /quote who said it/);
    assert.match(g, /without an `assumption`, with `options`/);
    assert.match(skill(), /- `withdraw`: Withdraw a question you asked/);
    assert.ok(tools().some((t) => t.name === 'withdraw'));
  });
});
