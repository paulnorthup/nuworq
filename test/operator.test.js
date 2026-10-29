import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view, homeView } from '../src/insight.js';
import { tools } from '../src/protocol.js';

// #133: questions an agent can't settle alone (running things, permissions, real infra) go to an operator session, not Paul.
function setup() {
  let now = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Needs a prod check', acceptance: 'x' });
  hub.humanOp('o', 'create', { title: 'Other work', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  const asked = hub.agentOp('o', 'ask', 'w1', { item: '#1', question: 'Does the migration run on prod?', context: 'I have no prod access', blocking: true, to: 'Operator' });
  return {
    hub, q: asked.question, asked,
    item: (n) => hub.item(hub.project('o'), `#${n}`),
    tick: (ms) => { now += ms; },
    // Needs you, less the "no agent is working" line a quiet day brings on its own.
    acts: () => view(hub, 'o').attention.filter((a) => a.level === 'act' && a.kind !== 'no-agents'),
  };
}

describe('questions to an operator', () => {
  test('ask takes to: "operator" (any case) next to human and reporter; anything else names all three', () => {
    const { hub, asked } = setup();
    assert.equal(asked.to, 'operator');
    assert.match(asked.hint, /parked until an operator answers/);
    assert.equal(hub.q('SELECT audience FROM questions WHERE id = ?').get(asked.question).audience, 'operator');
    assert.throws(() => hub.agentOp('o', 'ask', 'w1', { question: 'x?', to: 'boss' }), (e) => /"human", "reporter" or "operator"/.test(e.message) && /operator/.test(e.hint));
    assert.equal(hub.agentOp('o', 'ask', 'w1', { question: 'Fine?', assumption: 'yes', to: 'HUMAN' }).ok, true);
    assert.deepEqual(tools().find((t) => t.name === 'ask').inputSchema.properties.to.enum, ['human', 'reporter', 'operator']);
  });

  test('a blocking operator question parks the work, but is never in Needs you or the home needs', () => {
    const { hub, item } = setup();
    assert.equal(item(1).stage, 'waiting');
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] }); // one is connected: no line at all
    const v = view(hub, 'o');
    assert.ok(!v.attention.some((a) => a.kind === 'question'));
    assert.equal(v.attention.filter((a) => a.level === 'act').length, 0);
    const home = homeView(hub);
    assert.deepEqual(home.needs, []);
    assert.equal(home.projects.find((p) => p.slug === 'o').needs, 0);
    // A question to the human still comes to the human.
    hub.agentOp('o', 'claim', 'w2', { item: '#2' });
    hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Which region?', blocking: true });
    assert.deepEqual(view(hub, 'o').attention.filter((a) => a.kind === 'question').map((a) => a.headline), ['Which region?']);
  });

  test('next gives an operator mode "answer" before anything else; nobody else ever gets it', () => {
    const { hub } = setup();
    hub.humanOp('o', 'create', { title: 'Third', acceptance: 'x' });
    hub.agentOp('o', 'claim', 'w2', { item: '#2' });
    hub.agentOp('o', 'submit', 'w2', { item: '#2', headline: 'done', evidence: ['tests'] }); // a review waits too
    hub.agentOp('o', 'checkin', 'w3', { has: ['macos'] });
    const other = hub.agentOp('o', 'next', 'w3', { claim: false });
    assert.notEqual(other.mode, 'answer');

    hub.agentOp('o', 'checkin', 'op', { has: ['operator', 'linux'] });
    const n = hub.agentOp('o', 'next', 'op');
    assert.equal(n.mode, 'answer');
    assert.equal(n.question.question, 'Does the migration run on prod?');
    assert.equal(n.question.context, 'I have no prod access');
    assert.equal(n.question.asked_by, 'w1');
    assert.equal(n.question.blocking, true);
    assert.equal(n.item, '#1');
    assert.ok('history' in n && n.title === 'Needs a prod check' && n.questions, "with the item's context");
    assert.match(n.hint, /call answer with question \d+/);
    assert.equal(hub.item(hub.project('o'), '#1').holder, null, 'answering claims nothing');
  });

  test('answer settles it: answered_by the operator, the work back to ready, the asker told at its next checkin', () => {
    const { hub, q, item } = setup();
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    const r = hub.agentOp('o', 'answer', 'op', { question: q, answer: 'Ran it on prod: it works, 3s.' });
    assert.equal(r.ok, true);
    const row = hub.q('SELECT status, answer, answered_by FROM questions WHERE id = ?').get(q);
    assert.deepEqual({ ...row }, { status: 'answered', answer: 'Ran it on prod: it works, 3s.', answered_by: 'op' });
    assert.equal(item(1).stage, 'ready');
    const brief = hub.agentOp('o', 'checkin', 'w1', {});
    assert.equal(brief.answers[0].answer, 'Ran it on prod: it works, 3s.');
    assert.match(brief.next, /#1 was answered/);
    assert.notEqual(hub.agentOp('o', 'next', 'op', { claim: false }).mode, 'answer', 'nothing left to answer');
    assert.throws(() => hub.agentOp('o', 'answer', 'op', { question: q, answer: 'again' }), /already answered/);
  });

  test('only operators answer, and only questions asked to an operator', () => {
    const { hub, q } = setup();
    assert.throws(() => hub.agentOp('o', 'answer', 'w1', { question: q, answer: 'yes' }), (e) => e.status === 403 && /Only an operator/.test(e.message) && /has: \["operator"\]/.test(e.hint));
    hub.agentOp('o', 'claim', 'w2', { item: '#2' });
    const human = hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Which region?', blocking: true }).question;
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.throws(() => hub.agentOp('o', 'answer', 'op', { question: human, answer: 'eu' }), (e) => e.status === 403 && /for the human/.test(e.message) && /to: "operator"/.test(e.hint));
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(human).status, 'open');
  });

  test('with no operator seen in a day, Needs you has one line saying how many wait; an operator checking in clears it', () => {
    const { hub, acts, tick } = setup();
    hub.agentOp('o', 'ask', 'w1', { question: 'Can you grant the deploy key?', assumption: 'I will skip deploying', to: 'operator' });
    let lines = acts();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'operator-missing');
    assert.equal(lines[0].headline, '2 questions wait for an operator; none connected');
    assert.match(lines[0].why, /operator session/);
    assert.equal(homeView(hub).needs.length, 1);

    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.equal(acts().length, 0);
    tick(DAY + HOUR); // gone for over a day: the line comes back
    assert.equal(acts().length, 1);
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.equal(acts().length, 0);
  });

  test('answer is a tool every client sees', () => {
    const t = tools().find((x) => x.name === 'answer');
    assert.ok(t);
    assert.deepEqual(t.inputSchema.required, ['question', 'answer']);
  });
});
