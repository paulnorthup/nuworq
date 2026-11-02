import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';

// A blocking question parks only work the asker holds; whoever else holds the item hears about it (#731).
function world() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 10, 2, 12) });
  hub.tx(() => hub.project('p', { create: true }));
  for (const t of ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven']) hub.humanOp('p', 'create', { title: t, acceptance: 'x' });
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const item = (ref) => hub.item(hub.project('p'), ref);
  return { hub, op, item };
}
const steersFor = (hub, agent) => hub.q("SELECT body FROM notes WHERE kind = 'steer' AND target = ?").all(agent).map((n) => n.body);

describe('a blocking question on work someone else holds', () => {
  test('a2 asks about #7, which a1 holds: #7 stays active with a1, the question is open, and a1 is steered to it', () => {
    const { hub, op, item } = world();
    op('a1', 'claim', { item: '#7' });
    const r = op('a2', 'ask', { item: '#7', question: 'Should #7 also cover the CLI?', blocking: true, to: 'operator' });
    assert.equal(r.blocking, true);
    assert.deepEqual([item('#7').stage, item('#7').holder], ['active', 'a1']);
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(r.question).status, 'open');
    const steers = steersFor(hub, 'a1');
    assert.equal(steers.length, 1);
    assert.match(steers[0], new RegExp(`a2 asked about #7 \\(question ${r.question}\\)`));
    assert.match(steers[0], /Should #7 also cover the CLI\?/);
    assert.match(r.hint, /a1 holds #7 and keeps it/);
    const p = op('a1', 'progress', { item: '#7', headline: 'Still going' });
    assert.equal(p.ok, true, 'a1 keeps its lease');
  });

  test('the asker holds the item, or it is ready: a blocking question parks it as before', () => {
    const { hub, op, item } = world();
    op('a1', 'claim', { item: '#1' });
    op('a1', 'ask', { item: '#1', question: 'Which API?', blocking: true, to: 'operator' });
    assert.deepEqual([item('#1').stage, item('#1').holder], ['waiting', null]);
    op('a2', 'ask', { item: '#2', question: 'Is #2 still wanted?', blocking: true, to: 'operator' });
    assert.equal(item('#2').stage, 'waiting');
    assert.deepEqual(steersFor(hub, 'a1'), []);
  });

  test('an operator\'s blocking question still parks work another agent holds', () => {
    const { hub, op, item } = world();
    op('op1', 'checkin', { has: ['operator', 'claude-cli'] });
    op('a1', 'claim', { item: '#3' });
    op('op1', 'ask', { item: '#3', question: 'The deploy key is gone; who rotates it?', blocking: true, to: 'human', steps: [{ do: 'Rotate the key', where: 'GitHub settings', check: 'It lists a new key' }] });
    assert.deepEqual([item('#3').stage, item('#3').holder], ['waiting', null]);
  });
});
