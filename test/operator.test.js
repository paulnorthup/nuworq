import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view, homeView } from '../src/insight.js';
import { tools } from '../src/protocol.js';
import { defaultAudience } from '../src/audience.js';

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

  // #467: two operator sessions never act on the same question.
  test('next holds the question for one operator: the second gets other work, answer from it is refused', () => {
    const { hub, q } = setup();
    hub.agentOp('o', 'checkin', 'op1', { has: ['operator'] });
    hub.agentOp('o', 'checkin', 'op2', { has: ['operator'] });
    const first = hub.agentOp('o', 'next', 'op1');
    assert.equal(first.mode, 'answer');
    assert.equal(first.question.id, q);
    assert.deepEqual(first.question.lease, { holder: 'op1', expires_in: '20m' });
    assert.match(first.hint, /yours for 20m/);
    assert.equal(hub.agentOp('o', 'next', 'op1', { claim: false }).question.id, q, 'still the holder\'s');
    const second = hub.agentOp('o', 'next', 'op2', { claim: false });
    assert.notEqual(second.mode, 'answer');
    assert.throws(() => hub.agentOp('o', 'answer', 'op2', { question: q, answer: 'yes' }),
      (e) => e.status === 409 && /held by op1/.test(e.message) && /leave it to them/.test(e.hint));
    assert.throws(() => hub.agentOp('o', 'ask', 'op2', { escalates: q, question: 'OK?', evidence: ['x'] }), /held by op1/);
    // Who holds it shows in checkin and look.
    const job = (r) => r.agents.find((a) => a.agent === 'op1').job;
    assert.equal(job(hub.agentOp('o', 'look', 'op2', {})), `answering question ${q}`);
    assert.equal(job(hub.agentOp('o', 'checkin', 'op2', {})), `answering question ${q}`);
    // Answering frees it.
    assert.equal(hub.agentOp('o', 'answer', 'op1', { question: q, answer: 'It runs.' }).ok, true);
    assert.equal(job(hub.agentOp('o', 'look', 'op2', {})), null);
  });

  test('a peek holds nothing; a second question goes to the second operator', () => {
    const { hub, q } = setup();
    hub.agentOp('o', 'checkin', 'op1', { has: ['operator'] });
    hub.agentOp('o', 'checkin', 'op2', { has: ['operator'] });
    hub.agentOp('o', 'next', 'op1', { claim: false });
    assert.equal(hub.agentOp('o', 'next', 'op2', { claim: false }).question.id, q, 'a peek left it free');
    hub.agentOp('o', 'next', 'op1');
    const q2 = hub.agentOp('o', 'ask', 'w1', { question: 'Is the VM up?', assumption: 'yes', to: 'operator' }).question;
    assert.equal(hub.agentOp('o', 'next', 'op2').question.id, q2);
    assert.equal(hub.agentOp('o', 'next', 'op1', { claim: false }).question.id, q, 'each keeps its own');
  });

  test('a lapsed lease frees it; progress on its item renews it, and signoff lets it go', () => {
    const { hub, q, tick } = setup();
    hub.agentOp('o', 'checkin', 'op1', { has: ['operator'] });
    hub.agentOp('o', 'checkin', 'op2', { has: ['operator'] });
    hub.agentOp('o', 'next', 'op1');
    tick(15 * 60_000);
    const r = hub.agentOp('o', 'progress', 'op1', { item: '#1', headline: 'Running the migration on a copy' });
    assert.equal(r.ok, true, 'progress on the parked item is fine while holding its question');
    tick(15 * 60_000); // 30 minutes after next, 15 after progress: still held
    assert.notEqual(hub.agentOp('o', 'next', 'op2', { claim: false }).mode, 'answer');
    tick(6 * 60_000); // lapsed
    assert.equal(hub.agentOp('o', 'next', 'op2').question.id, q);
    assert.throws(() => hub.agentOp('o', 'answer', 'op1', { question: q, answer: 'late' }), /held by op2/);
    hub.agentOp('o', 'signoff', 'op2', {});
    assert.equal(hub.agentOp('o', 'answer', 'op1', { question: q, answer: 'It runs.' }).ok, true, 'free again after signoff');
  });

  test('answer is a tool every client sees', () => {
    const t = tools().find((x) => x.name === 'answer');
    assert.ok(t);
    assert.deepEqual(t.inputSchema.required, ['question', 'answer']);
  });
});

// #138: left out, `to` is picked from what the question is about; the human when unsure.
describe('the default audience when to is left out', () => {
  const cases = [
    // Real questions from the board (#97, #81, #20/#21, #46, #120 style).
    ["Can't run `claude` without approval: can someone run the live checks?", '', 'operator'],
    ["Agents can't write .claude/settings.json", 'Adding Bash(claude:*) needs approval in this session', 'operator'],
    ['Can the migration be run on prod tonight?', 'I have no access to the server', 'operator'],
    ['The VM for the Linux runner is down', 'DNS for runner.nuworq.com does not resolve', 'operator'],
    ['Is the GitHub App installed on paulnorthup/nuworq?', 'The webhook gets 401s', 'operator'],
    ['Need a token for the llm-proxy API', '', 'operator'],
    ['Could someone verify the plugin install on a real Claude Code?', '', 'operator'],
    ['Approve browser workers?', 'They would screenshot UI changes', 'human'],
    ['Should #120 come before #118?', 'Both are soon; I can only take one', 'human'],
    ['Which region should it deploy to?', '', 'human'],
    ['Publish the landing page now?', '', 'human'],
    ['OK to delete the old demo projects on the server?', '', 'human'],
    ['Is a $20/month plan worth it?', '', 'human'],
    ['Tabs or spaces?', '', 'human'],
    ['What should the empty state say?', '', 'human'],
  ];
  for (const [question, context, want] of cases) {
    test(`${want}: ${question}`, () => {
      const got = defaultAudience({ question, context });
      assert.equal(got.audience, want);
      assert.ok(got.reason.length > 0);
    });
  }

  test('ask without to stores the picked audience and says why; with to, exactly what was given', () => {
    const { hub } = setup();
    const audience = (id) => hub.q('SELECT audience FROM questions WHERE id = ?').get(id).audience;
    const op = hub.agentOp('o', 'ask', 'w1', { question: 'Can someone run `npm run e2e` against staging?', assumption: 'skip it' });
    assert.equal(op.to, 'operator');
    assert.equal(audience(op.question), 'operator');
    assert.match(op.routed, /^To an operator: it is about a command\. Pass to: "human"/);
    const human = hub.agentOp('o', 'ask', 'w1', { question: 'Should the home show archived projects?', assumption: 'no' });
    assert.equal(human.to, 'human');
    assert.equal(audience(human.question), '');
    assert.match(human.routed, /^To the human: .*Pass to: "operator"/);
    const kept = hub.agentOp('o', 'ask', 'w1', { question: 'Can someone run `npm run e2e` against staging?', assumption: 'skip it', to: 'human' });
    assert.equal(kept.to, 'human');
    assert.equal(audience(kept.question), '');
    assert.equal(kept.routed, undefined, 'given to is never second-guessed');
    const toOp = hub.agentOp('o', 'ask', 'w1', { question: 'Tabs or spaces?', assumption: 'spaces', to: 'operator' });
    assert.equal(audience(toOp.question), 'operator');
  });

  test('the ask tool says what the default does, with an example each way', () => {
    const t = tools().find((x) => x.name === 'ask');
    assert.match(t.inputSchema.properties.to.description, /Left out/);
    assert.match(t.inputSchema.properties.to.description, /`claude`/);
    assert.match(t.inputSchema.properties.to.description, /approve browser workers/);
  });
});
