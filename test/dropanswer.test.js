import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HUMAN } from '../src/core.js';

// When a person answers "drop it", the item is dropped and next stops offering it (#207).
function world() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 12) });
  hub.tx(() => hub.project('p', { create: true }));
  for (const t of ['One', 'Two', 'Three', 'Four', 'Five']) hub.humanOp('p', 'create', { title: t, acceptance: 'x' });
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const stage = (ref) => hub.item(hub.project('p'), ref).stage;
  return { hub, op, stage };
}

describe('dropping on a person\'s answer', () => {
  test('a question on the item answered "Drop it": the agent drops it, the person is recorded as deciding, and next never offers it', () => {
    const { hub, op, stage } = world();
    op('w1', 'claim', { item: '#1' });
    // Not blocking: the item stays w1's, so the agent carries the drop out (a parked one the hub drops: #819).
    const { question } = op('w1', 'ask', { item: '#1', question: 'This duplicates #2. Drop it?', assumption: 'Keep building it' });
    hub.humanOp('p', 'answer', { question, answer: 'Drop it' });
    assert.equal(stage('#1'), 'active');
    const r = op('w1', 'refine', { item: '#1', drop: question });
    assert.deepEqual([r.stage, r.decided_by], ['dropped', HUMAN]);
    assert.equal(stage('#1'), 'dropped');
    const e = hub.q("SELECT * FROM events WHERE type = 'staged' ORDER BY id DESC LIMIT 1").get();
    assert.equal(e.actor, 'w1');
    assert.match(e.headline, /w1 dropped #1, as you answered: "Drop it"/);
    assert.deepEqual(JSON.parse(e.data), { decided_by: HUMAN, question });
    for (const a of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      const job = op(a, 'next');
      assert.notEqual(job.item, '#1', `${a} isn't offered it`);
    }
  });

  test('an answer naming items, or a range of them, drops those and no others', () => {
    const { hub, op, stage } = world();
    const { question } = op('w1', 'ask', { item: '#5', question: '#1-#3 duplicate #5. Drop them?', blocking: true });
    hub.humanOp('p', 'answer', { question, answer: 'Drop #1-#3; keep #4' });
    op('w2', 'refine', { item: '#2', drop: question });
    op('w2', 'refine', { item: '#3', drop: String(question) });
    assert.deepEqual(['#1', '#2', '#3', '#4', '#5'].map(stage).slice(1, 3), ['dropped', 'dropped']);
    assert.throws(() => op('w2', 'refine', { item: '#4', drop: question }), (e) => e.status === 403 && /doesn't say to drop #4/.test(e.message), '"keep #4" names it, but not to drop');
    assert.equal(stage('#4'), 'ready');
    assert.throws(() => op('w2', 'refine', { item: '#5', drop: question }), (e) => e.status === 403, 'asked on #5, but the drop names other items');
    assert.equal(stage('#5'), 'ready');
    assert.throws(() => op('w2', 'refine', { item: '#2', drop: question }), (e) => e.status === 409 && /already dropped/.test(e.message));
  });

  test('only a person decides: unanswered, answered by an operator, or an answer that keeps it changes nothing', () => {
    const { hub, op, stage } = world();
    const open = op('w1', 'ask', { item: '#1', question: 'Drop it?', blocking: true }).question;
    assert.throws(() => op('w1', 'refine', { item: '#1', drop: open }), (e) => e.status === 403 && /answered by a person/.test(e.message));
    const toOp = op('w1', 'ask', { item: '#2', question: 'Can someone run the migration?', to: 'operator', blocking: true }).question;
    op('ops', 'checkin', { has: ['operator'] });
    op('ops', 'answer', { question: toOp, answer: 'Drop it, the migration ran already' });
    assert.throws(() => op('w1', 'refine', { item: '#2', drop: toOp }), (e) => e.status === 403 && /answered by a person/.test(e.message));
    const keep = op('w1', 'ask', { item: '#3', question: 'Drop it?', blocking: true }).question;
    hub.humanOp('p', 'answer', { question: keep, answer: 'Keep it: build the scenario test' });
    assert.throws(() => op('w1', 'refine', { item: '#3', drop: keep }), (e) => e.status === 403 && /doesn't say to drop/.test(e.message));
    assert.throws(() => op('w1', 'refine', { item: '#3', drop: 999 }), (e) => e.status === 404);
    assert.deepEqual(['#1', '#2', '#3'].map(stage).map((s) => s === 'dropped'), [false, false, false]);
  });

  test('an answer that says not to drop it is refused, however it mentions drop', () => {
    const { hub, op, stage } = world();
    for (const answer of ["Don't drop it, build it", 'No, do not drop it', 'Never drop #2', 'Keep it; dropping would lose the tests']) {
      const { question } = op('w1', 'ask', { item: '#2', question: 'Drop it?', blocking: true });
      hub.humanOp('p', 'answer', { question, answer });
      assert.throws(() => op('w1', 'refine', { item: '#2', drop: question }), (e) => e.status === 403, answer);
    }
    assert.equal(stage('#2'), 'ready');
    const { question } = op('w1', 'ask', { item: '#2', question: 'Drop it?', blocking: true });
    hub.humanOp('p', 'answer', { question, answer: 'Yes, drop it' });
    // The question parked it, so the person's answer dropped it (#819); refine has nothing left to do.
    assert.equal(stage('#2'), 'dropped');
    assert.throws(() => op('w1', 'refine', { item: '#2', drop: question }), (e) => e.status === 409);
  });

  test('another agent reads the question id from look and next, and drops with it the first time (#366)', () => {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 12) });
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'One', acceptance: 'x' });
    const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
    op('w1', 'claim', { item: '#1' });
    const { question } = op('w1', 'ask', { item: '#1', question: 'This duplicates #2. Drop it?', assumption: 'Keep building it' });
    op('w1', 'handoff', { item: '#1', headline: 'Out of context' });
    hub.humanOp('p', 'answer', { question, answer: 'Drop it' });
    const fromLook = op('w2', 'look', { item: '#1' }).questions.find((q) => q.answer === 'Drop it');
    assert.equal(fromLook.question_id, question);
    const job = op('w2', 'next');
    assert.equal(job.item, '#1');
    assert.deepEqual(job.questions.map((q) => q.question_id), [question]);
    assert.equal(op('w2', 'refine', { item: '#1', drop: job.questions[0].question_id }).stage, 'dropped');
  });

  test('the guide tells agents to drop on the answer instead of handing the item back', async () => {
    const { guide, tools } = await import('../src/protocol.js');
    assert.match(guide(), /`drop` set to that question/);
    assert.ok(tools().find((t) => t.name === 'refine').inputSchema.properties.drop);
  });
});
