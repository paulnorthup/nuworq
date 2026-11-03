import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HUMAN, DAY, answerQuestion } from '../src/core.js';
import { itemView, view } from '../src/insight.js';

// A person's answer to the question a parked item waits on (#819): "drop" drops it, "not yet" keeps it waiting.
function world() {
  let t = Date.UTC(2026, 10, 3, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  const p = hub.project('p');
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const item = (n) => hub.item(p, `#${n}`);
  // An item parked on an 'ask' precondition, and the id of the question it waits on.
  const gated = (title = 'Sign releases') => {
    const { item: ref } = op('a', 'propose', { title, acceptance: 'x', precondition: { kind: 'ask', question: 'Is signing set up?' } });
    return { ref, question: JSON.parse(item(ref.slice(1)).last_check).question };
  };
  const answer = (question, text, by = HUMAN) => hub.tx(() => answerQuestion(hub, p, { question, answer: text }, by));
  return { hub, p, op, item, gated, answer, advance: (ms) => (t += ms) };
}
const lastStaged = (hub) => hub.q("SELECT * FROM events WHERE type = 'staged' ORDER BY id DESC LIMIT 1").get();

describe('answering the question a parked item waits on', () => {
  test('the ask precondition\'s question says the choices, on the question and in Needs you', () => {
    const { hub, gated } = world();
    gated();
    const card = view(hub, 'p').attention.find((a) => a.kind === 'question');
    assert.match(card.why, /Answer go to start it, drop to drop it, or not yet to keep it waiting/);
  });

  test('"drop - signing moved" on an ask precondition drops the item, attributed to the person', () => {
    const { hub, item, gated, answer } = world();
    const { question } = gated();
    answer(question, 'drop - signing moved to github', '@ada');
    assert.equal(item(1).stage, 'dropped');
    const e = lastStaged(hub);
    assert.match(e.headline, /dropped #1, as @ada answered: "drop - signing moved to github"/);
    assert.deepEqual(JSON.parse(e.data), { decided_by: '@ada', question });
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(question).status, 'answered');
  });

  test('"Yes, drop it" on a blocking question asked on the parked item drops it, and its holder is steered off', () => {
    const { hub, op, item, answer } = world();
    hub.humanOp('p', 'create', { title: 'Dup', acceptance: 'x' });
    op('w1', 'claim', { item: '#1' });
    const { question } = op('w1', 'ask', { item: '#1', question: 'This duplicates #2. Drop it?', blocking: true });
    assert.equal(item(1).stage, 'waiting');
    answer(question, 'Yes, drop it');
    assert.equal(item(1).stage, 'dropped');
    assert.match(lastStaged(hub).headline, /nuworq dropped #1, as you answered: "Yes, drop it"/);
  });

  test('"don\'t drop it" and "dropping loses the tests" don\'t drop; they make it ready as any answer does', () => {
    // Nor a drop about something else: "drop them" answers whether to drop the tables, not the item.
    for (const text of ["don't drop it", 'dropping loses the tests', 'Yes, drop them.', 'drop the old tables first']) {
      const { item, gated, answer } = world();
      const { question } = gated();
      answer(question, text);
      assert.equal(item(1).stage, 'ready', text);
    }
  });

  test('"go" and other answers make it ready', () => {
    for (const text of ['go', 'Yes, since Monday', 'No problem, start it']) {
      const { hub, item, gated, answer } = world();
      const { question } = gated();
      answer(question, text);
      assert.equal(item(1).stage, 'ready', text);
      assert.equal(itemView(hub, 'p', '#1').precondition.met, true);
    }
  });

  test('"not yet" keeps it waiting; looking at it a day later asks again', () => {
    for (const text of ['not yet', 'No', 'wait - vendor is late', 'Later.', 'hold']) {
      const { hub, op, item, gated, answer, advance } = world();
      const { question } = gated();
      answer(question, text);
      assert.equal(item(1).stage, 'waiting', text);
      assert.equal(op('b', 'next').item, undefined, `${text}: no agent gets it`);
      const open = () => hub.q(`SELECT * FROM questions WHERE item_id = ? AND status = 'open'`).all(item(1).id);
      assert.deepEqual(open(), []);
      assert.equal(itemView(hub, 'p', '#1').precondition.met, false);
      // Looking before the day is up doesn't ask; after, it does, once.
      advance(DAY - 60_000);
      op('b', 'look', { item: '#1' });
      assert.deepEqual(open(), []);
      advance(60_000);
      op('b', 'look', { item: '#1' });
      itemView(hub, 'p', '#1');
      assert.deepEqual(open().map((q) => q.question), ['Is signing set up?']);
      assert.equal(item(1).stage, 'waiting');
      // Answering the new one with go makes it ready.
      answer(open()[0].id, 'go');
      assert.equal(item(1).stage, 'ready');
    }
  });

  test('an agent\'s answer never drops work', () => {
    const { item, gated, answer } = world();
    const { question } = gated();
    answer(question, 'drop it', 'op-1');
    assert.equal(item(1).stage, 'ready');
  });
});
