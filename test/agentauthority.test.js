import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';

// Only a person's words carry a person's authority (#610): an operator is an agent, so its answer, and the
// change-of-course steer its answer makes, reach the asker labelled as an agent's, never the human's.
function world() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 10, 1, 9) });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  hub.humanOp('p', 'create', { title: 'Retry exports', acceptance: 'x' });
  const agent = (name, op, args = {}) => hub.agentOp('p', op, name, args);
  for (const s of agent('s', 'checkin').steers ?? []) agent('s', 'ack', { steer: s.steer }); // the autonomy change
  agent('s', 'claim', { item: '#1' });
  const ask = (question) => agent('s', 'ask', { item: '#1', question, assumption: 'Staging is fine', to: 'operator' });
  return { hub, agent, ask };
}

describe("an agent's words are labelled as an agent's", () => {
  test("an operator's answer and steer are labelled as an agent's, never the human's", () => {
    const { agent, ask } = world();
    const q = ask('Can I deploy to staging?');
    agent('op', 'checkin', { has: ['operator', 'infra'] });
    agent('op', 'answer', { question: q.question ?? q.id, answer: 'Use the canary instead.' });

    const r = agent('s', 'progress', { item: '#1', headline: 'Halfway' });
    assert.equal(r.steers.length, 1);
    assert.match(r.steers[0].body, /Change of course/);
    assert.equal(r.steers[0].from, 'op (an agent, not a person)');
    assert.doesNotMatch(r.hint, /The human/);
    assert.match(r.hint, /^op steered you \(an agent/);

    const c = agent('s', 'checkin');
    assert.equal(c.steers[0].from, 'op (an agent, not a person)');
    assert.equal(c.answers[0].answer, 'Use the canary instead.');
    assert.equal(c.answers[0].by, 'op (an agent, not a person)');

    // The item's own context (look, and what next and claim return) carries the same labels.
    const look = agent('s', 'look', { item: '#1' });
    agent('s', 'handoff', { item: '#1', headline: 'Halfway' });
    for (const it of [look, agent('s', 'claim', { item: '#1' })]) {
      assert.equal(it.item, '#1');
      assert.equal(it.steers.find((s) => /Change of course/.test(s.body)).from, 'op (an agent, not a person)');
      assert.equal(it.questions[0].by, 'op (an agent, not a person)');
    }
  });

  test("a person's answer and steer still say the human", () => {
    const { hub, agent, ask } = world();
    const q = ask('Can I deploy to staging?');
    hub.humanOp('p', 'answer', { question: q.question ?? q.id, answer: 'Use the canary instead.' });

    const r = agent('s', 'progress', { item: '#1', headline: 'Halfway' });
    assert.match(r.hint, /^The human has steered you/);
    const c = agent('s', 'checkin');
    assert.equal(c.answers[0].by, 'the human');
    assert.equal(agent('s', 'look', { item: '#1' }).questions[0].by, 'the human');
  });
});
