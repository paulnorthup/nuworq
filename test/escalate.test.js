import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { tools } from '../src/protocol.js';

// #134: an operator escalates what it may not settle alone to Paul, with evidence; Paul's answer reaches the asker.
function setup() {
  let now = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Clean up prod', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  const q = hub.agentOp('o', 'ask', 'w1', { item: '#1', question: 'Can the orphaned tables on prod be dropped?', blocking: true, to: 'operator' }).question;
  hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
  const evidence = [{ label: 'dry run: 3 tables, 0 rows referenced', url: 'https://example.com/run/1' }, 'backup taken'];
  const escalate = (args = {}) => hub.agentOp('o', 'ask', 'op', { escalates: q, question: 'Drop the 3 orphaned tables on prod?', evidence, ...args });
  return {
    hub, q, escalate,
    item: (n) => hub.item(hub.project('o'), `#${n}`),
    tick: (ms) => { now += ms; },
    attention: () => view(hub, 'o').attention,
  };
}

describe('an operator escalates to the human', () => {
  test('the escalation is in Needs you with the original question, its asker and the evidence, and on the item page', () => {
    const { hub, q, escalate, attention } = setup();
    const r = escalate();
    assert.equal(r.ok, true);
    assert.equal(r.escalates, q);
    assert.match(r.hint, /answers question \d+ too/);
    const a = attention().find((x) => x.kind === 'question');
    assert.equal(a.level, 'act');
    assert.equal(a.headline, 'Drop the 3 orphaned tables on prod?');
    assert.deepEqual(a.escalation, { question: 'Can the orphaned tables on prod be dropped?', asked_by: 'w1' });
    assert.deepEqual(a.evidence, [{ label: 'dry run: 3 tables, 0 rows referenced', url: 'https://example.com/run/1' }, { label: 'backup taken' }]);
    assert.match(a.sub, /op \(operator\) escalated w1's question/);
    assert.match(a.why, /w1 asked an operator: "Can the orphaned tables/);
    assert.equal(a.item, '#1');
    assert.equal(a.question.id, r.question);

    const page = itemView(hub, 'o', '#1');
    const e = page.questions.find((x) => x.id === r.question);
    assert.deepEqual(e.escalation, { question: 'Can the orphaned tables on prod be dropped?', asked_by: 'w1' });
    assert.equal(e.evidence.length, 2);

    // Escalated: operators' next no longer hands out the original.
    assert.notEqual(hub.agentOp('o', 'next', 'op', { claim: false }).mode, 'answer');
  });

  test("the human's answer answers the original too: the item unparks and the asker hears it", () => {
    const { hub, q, escalate, item } = setup();
    assert.equal(item(1).stage, 'waiting');
    const e = escalate().question;
    hub.humanOp('o', 'answer', { question: e, answer: 'Yes, drop them.' });
    const rows = hub.q('SELECT id, status, answer, answered_by FROM questions WHERE id IN (?, ?) ORDER BY id').all(q, e).map((x) => ({ ...x }));
    assert.deepEqual(rows, [
      { id: q, status: 'answered', answer: 'Yes, drop them.', answered_by: 'you' },
      { id: e, status: 'answered', answer: 'Yes, drop them.', answered_by: 'you' },
    ]);
    assert.equal(item(1).stage, 'ready');
    const brief = hub.agentOp('o', 'checkin', 'w1', {});
    assert.equal(brief.answers.find((x) => x.question === 'Can the orphaned tables on prod be dropped?')?.answer, 'Yes, drop them.');
    assert.ok(!view(hub, 'o').attention.some((a) => a.kind === 'question' || a.kind === 'operator-answered'), 'nothing left, and not shown as settled by the operator');
  });

  test('keep parked holds the work even though both are answered', () => {
    const { hub, escalate, item } = setup();
    hub.humanOp('o', 'answer', { question: escalate().question, answer: 'Yes', keep_parked: true });
    assert.equal(item(1).stage, 'waiting');
    assert.equal(item(1).parked_by, 'you');
  });

  test('only an operator escalates, only an open operator question, and only with evidence', () => {
    const { hub, q, escalate } = setup();
    assert.throws(() => hub.agentOp('o', 'ask', 'w1', { escalates: q, question: 'x?', evidence: ['y'] }), (e) => e.status === 403 && /Only an operator/.test(e.message) && /has: \["operator"\]/.test(e.hint));
    assert.throws(() => escalate({ escalates: 999 }), (e) => e.status === 404 && /escalates takes/.test(e.hint));
    hub.humanOp('o', 'create', { title: 'Other', acceptance: 'x' });
    hub.agentOp('o', 'claim', 'w1', { item: '#2' });
    const human = hub.agentOp('o', 'ask', 'w1', { item: '#2', question: 'Which region?', blocking: true }).question;
    assert.throws(() => escalate({ escalates: human }), (e) => e.status === 403 && /wasn't asked to an operator/.test(e.message) && /to: "operator"/.test(e.hint));
    assert.throws(() => escalate({ evidence: [] }), (e) => /needs evidence/.test(e.message) && /evidence/.test(e.hint));
    escalate();
    assert.throws(() => escalate(), (e) => e.status === 409 && /already escalated/.test(e.message));
    hub.agentOp('o', 'answer', 'op', { question: q, answer: 'Checked again: safe, dropped.' });
    assert.throws(() => escalate(), (e) => e.status === 409 && /already answered/.test(e.message));
  });

  test('an operator answering after all withdraws its escalation from Needs you', () => {
    const { hub, q, escalate, attention, item } = setup();
    const e = escalate().question;
    hub.agentOp('o', 'answer', 'op', { question: q, answer: 'Found the owner: safe, dropped.' });
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(e).status, 'withdrawn');
    assert.ok(!attention().some((a) => a.kind === 'question'));
    assert.equal(item(1).stage, 'ready');
  });

  test('what an operator settled alone is a know line for a day, never act', () => {
    const { hub, q, attention, tick } = setup();
    hub.agentOp('o', 'answer', 'op', { question: q, answer: 'Dropped them; backup in s3.' });
    const lines = attention().filter((a) => a.kind === 'operator-answered');
    assert.equal(lines.length, 1);
    assert.equal(lines[0].level, 'know');
    assert.equal(lines[0].headline, 'Operator answered w1: Dropped them; backup in s3.');
    assert.match(lines[0].sub, /Q: Can the orphaned tables/);
    assert.equal(lines[0].item, '#1');
    tick(DAY - HOUR);
    assert.equal(attention().filter((a) => a.kind === 'operator-answered').length, 1);
    tick(2 * HOUR);
    assert.equal(attention().filter((a) => a.kind === 'operator-answered').length, 0);
  });

  test("ask's schema offers escalates and evidence", () => {
    const props = tools().find((t) => t.name === 'ask').inputSchema.properties;
    assert.equal(props.escalates.type, 'integer');
    assert.equal(props.evidence.type, 'array');
  });
});
