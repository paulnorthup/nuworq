import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';

// A review blocked on a reviewer's open question isn't offered round after round to agents who can't
// answer it, and a reviewer who handed it off doesn't get it back until something new arrives (#259).
function setup() {
  const clock = { t: Date.UTC(2026, 9, 31, 9) };
  const hub = new Hub({ clock: () => clock.t });
  const agent = (name) => (op, args = {}) => hub.agentOp('demo', op, name, args);
  const human = (action, args = {}) => hub.humanOp('demo', action, args);
  const builder = agent('builder');
  builder('checkin');
  human('settings', { autonomy: 'full' });
  human('create', { title: 'CI matrix', acceptance: 'every leg passes on the PR' });
  builder('next');
  builder('submit', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
  return { hub, clock, agent, human };
}

describe('reviews waiting on a question (#259)', () => {
  test("an open operator question keeps the review from runners until it's answered; operators still get it", () => {
    const { hub, clock, agent, human } = setup();
    const first = agent('r0');
    first('checkin');
    assert.equal(first('next').mode, 'review');
    const asked = first('ask', { item: '#1', to: 'operator', question: 'Do the PR checks pass?', assumption: 'Accept once they are green' });
    first('handoff', { item: '#1', headline: 'Waiting on the operator' });

    for (const name of ['r1', 'r2', 'r3', 'r4']) {
      const r = agent(name);
      r('checkin');
      assert.equal(r('next', { claim: false }).mode, 'idle', `${name} isn't offered a review it can't finish`);
    }
    const op = agent('op');
    op('checkin', { has: ['operator'] });
    assert.equal(op('next', { claim: false }).item, '#1', 'an operator can answer, so it still gets the review');

    clock.t += 5 * MIN;
    human('answer', { question: asked.question, answer: 'All legs green' });
    const r5 = agent('r5');
    r5('checkin');
    const n = r5('next');
    assert.equal(n.mode, 'review');
    assert.equal(n.item, '#1');
    assert.ok(hub.q("SELECT 1 FROM items WHERE seq = 1 AND holder = 'r5'").get());
  });

  test("a question for the human keeps the review from every agent until it's settled", () => {
    const { agent, human } = setup();
    const first = agent('r0');
    first('checkin');
    first('next');
    const asked = first('ask', { item: '#1', to: 'human', question: 'Is 22 still the floor?', assumption: 'Yes' });
    first('handoff', { item: '#1', headline: 'Waiting on Remy' });
    const op = agent('op');
    op('checkin', { has: ['operator'] });
    assert.equal(op('next', { claim: false }).mode, 'idle');
    human('confirm', { question: asked.question });
    assert.equal(op('next', { claim: false }).item, '#1');
  });

  test("the builder's own open question doesn't hold up review", () => {
    const { hub, agent } = setup();
    hub.agentOp('demo', 'ask', 'builder', { item: '#1', question: 'Raise the floor?', assumption: 'No' });
    const r = agent('r1');
    r('checkin');
    assert.equal(r('next', { claim: false }).item, '#1');
  });

  test("the builder's open operator question holds the review from runners until it's answered (#298)", () => {
    const { hub, agent, human } = setup();
    const asked = hub.agentOp('demo', 'ask', 'builder', { item: '#1', to: 'operator', question: 'Does it wake live?', assumption: 'The code stands' });
    for (const name of ['r1', 'r2', 'r3']) {
      const r = agent(name);
      r('checkin');
      assert.equal(r('next', { claim: false }).mode, 'idle', `${name} isn't offered a review whose evidence hasn't come`);
    }
    assert.match(JSON.stringify(hub.agentOp('demo', 'look', 'r1', { item: '#1' })), /verifying/, 'still on the board, in verifying');
    const op = agent('op');
    op('checkin', { has: ['operator'] });
    assert.equal(op('next', { claim: false }).item, '#1', 'an operator can answer, so it still gets the review');

    human('answer', { question: asked.question, answer: 'Woke in 3s on both surfaces' });
    const r = agent('r1');
    const n = r('next');
    assert.equal(n.mode, 'review');
    assert.equal(n.item, '#1');
    assert.equal(n.questions[0].answer, 'Woke in 3s on both surfaces', 'the reviewer sees the answer');
  });

  test("an operator question asked while building, still open at submit, holds the review too (#298)", () => {
    const clock = { t: Date.UTC(2026, 9, 31, 9) };
    const hub = new Hub({ clock: () => clock.t });
    hub.agentOp('demo', 'checkin', 'builder');
    hub.humanOp('demo', 'settings', { autonomy: 'full' });
    hub.humanOp('demo', 'create', { title: 'Wake on work', acceptance: 'an idle session wakes' });
    hub.agentOp('demo', 'next', 'builder');
    hub.agentOp('demo', 'ask', 'builder', { item: '#1', to: 'operator', question: 'Try it live?', assumption: 'It works' });
    clock.t += MIN;
    hub.agentOp('demo', 'submit', 'builder', { item: '#1', headline: 'Done', evidence: [{ label: 'tests pass' }] });
    hub.agentOp('demo', 'checkin', 'r1');
    assert.equal(hub.agentOp('demo', 'next', 'r1', { claim: false }).mode, 'idle');
  });

  test("a reviewer who handed off doesn't get the review back until something new arrives, however long it waits", () => {
    const { clock, agent } = setup();
    const r = agent('r1');
    r('checkin');
    assert.equal(r('next').item, '#1');
    r('handoff', { item: '#1', headline: 'Not sure yet' });
    clock.t += 3 * 60 * MIN; // well past the handoff cooldown
    assert.equal(r('next', { claim: false }).mode, 'idle');

    const other = agent('r2');
    other('checkin');
    other('comment', { item: '#1', headline: 'The 26 leg ran green locally' });
    assert.equal(r('next', { claim: false }).item, '#1', 'a comment is news: it comes back');
  });
});
