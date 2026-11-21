import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view, homeView } from '../src/insight.js';
import { tools, guide } from '../src/protocol.js';
import { PERSON_REASONS } from '../src/audience.js';
import { guidePage } from '../src/userguide.js';
import { appSource } from './appsource.js';

// #133: questions an agent can't settle alone (running things, permissions, real infra) go to an operator session, not the maintainer.
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
    hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Which region?', blocking: true, only_person: 'call' });
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

  test('only operators answer: questions to an operator, and a person\'s that give no reason only a person can', () => {
    const { hub, q } = setup();
    assert.throws(() => hub.agentOp('o', 'answer', 'w1', { question: q, answer: 'yes' }), (e) => e.status === 403 && /Only an operator/.test(e.message) && /has: \["operator"\]/.test(e.hint));
    hub.agentOp('o', 'claim', 'w2', { item: '#2' });
    const person = hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Which region?', blocking: true, only_person: 'call' }).question;
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.throws(() => hub.agentOp('o', 'answer', 'op', { question: person, answer: 'eu' }), (e) => e.status === 403 && /only a person can \(call\)/.test(e.message) && /give no reason/.test(e.hint));
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(person).status, 'open');
    // Asked of a person before only_person (audience ''), as on a hub upgraded with questions open: the operator settles it.
    hub.q(`UPDATE questions SET audience = '' WHERE id = ?`).run(person);
    assert.equal(hub.agentOp('o', 'answer', 'op', { question: person, answer: 'eu-west, as the decision on regions says' }).ok, true);
    assert.equal(hub.q('SELECT status, answered_by FROM questions WHERE id = ?').get(person).answered_by, 'op');
    assert.equal(hub.item(hub.project('o'), '#2').stage, 'ready');
  });

  test('with no operator seen in a day, the blocking one is a card of yours and the rest one line; an operator checking in clears both', () => {
    const { hub, acts, tick } = setup();
    hub.agentOp('o', 'ask', 'w1', { question: 'Can you grant the deploy key?', assumption: 'I will skip deploying', to: 'operator' });
    let lines = acts();
    assert.deepEqual(lines.map((a) => a.kind).sort(), ['question'], 'the one with an assumption waits on nobody: worth knowing, not Needs you');
    const line = view(hub, 'o').attention.find((a) => a.kind === 'operator-missing');
    assert.equal(line.level, 'know');
    assert.equal(line.headline, '1 question waits for an operator; none connected');
    // #797: plain words, and how to start one, nuworq up first.
    assert.match(line.why, /a Claude Code session someone keeps open, acting with their access/);
    assert.ok(line.why.indexOf('`nuworq up`') < line.why.indexOf('`claude`') && line.why.indexOf('`claude`') < line.why.indexOf('`/nuworq:operator`'));
    const card = lines.find((a) => a.kind === 'question');
    for (const t of [line.why, card.why]) assert.doesNotMatch(t, /attended|says how/, t);
    assert.equal(line.guide, 'guide#operator', "the guide's Start an operator, not the agents' protocol");
    assert.equal(homeView(hub).needs.length, 1);

    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.equal(acts().length, 0);
    assert.ok(!view(hub, 'o').attention.some((a) => a.kind === 'operator-missing'));
    tick(DAY + HOUR); // gone for over a day: both come back
    assert.equal(acts().length, 1);
    assert.ok(view(hub, 'o').attention.some((a) => a.kind === 'operator-missing'));
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    assert.equal(acts().length, 0);
  });

  test("the app's operator links open the guide's Start an operator, never the agents' protocol (#712)", () => {
    const src = appSource();
    assert.match(src, /a\.guide \? `<a class="link" href="\$\{esc\(a\.guide\)\}"[^`]*>How to start an operator<\/a>`/, "a question card for an operator links its guide");
    assert.match(src, /a\.kind === 'question' && a\.operator \? 'For an operator'/, 'and says who it was for');
    assert.doesNotMatch(src, /agents\.md#operators/);
    assert.match(guidePage(), /<h4 id="operator">/, '/guide#operator is a part of the guide');
  });

  // #712: a person working alone isn't stuck behind a question only an operator could answer.
  test('with no operator, a question with steps is yours: a card with its steps to tick, answered as if asked of you', () => {
    const { hub, item, acts } = setup();
    hub.agentOp('o', 'claim', 'w2', { item: '#2' });
    const steps = [{ do: 'Add the key NUWORQ_CRED_DEPLOY to the hub host', where: 'nuworq creds set DEPLOY', check: 'nuworq creds list shows DEPLOY' }];
    const asked = hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Add the deploy key?', assumption: 'I go on without deploying', to: 'operator', steps });
    const cards = acts().filter((a) => a.kind === 'question');
    assert.deepEqual(cards.map((a) => a.headline).sort(), ['Add the deploy key?', 'Does the migration run on prod?'], 'blocking or with steps: each its own card');
    const c = cards.find((a) => a.question.id === asked.question);
    assert.equal(c.operator, true);
    assert.equal(c.guide, 'guide#operator');
    assert.deepEqual(c.steps.map((s) => s.do), [steps[0].do]);
    assert.match(c.sub, /no operator connected, so you can do it/);
    assert.match(c.why, /w2 asked an operator/);
    assert.ok(!acts().some((a) => a.kind === 'operator-missing'), 'nothing left for the one line');
    assert.ok(!view(hub, 'o').attention.some((a) => a.kind === 'assumption' && a.question?.id === asked.question), 'not also an assumption line');

    // Ticking its one step answers it (#162), and the asker hears it like an operator's answer.
    hub.humanOp('o', 'step', { question: asked.question, step: 1, done: true });
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(asked.question).status, 'answered');
    // The blocking one, answered by the person: the work goes back to ready, and w1 hears it at checkin.
    const blocking = cards.find((a) => a.headline === 'Does the migration run on prod?').question.id;
    hub.humanOp('o', 'answer', { question: blocking, answer: 'Ran it on prod: fine.' });
    assert.equal(item(1).stage, 'ready');
    assert.equal(hub.agentOp('o', 'checkin', 'w1', {}).answers[0].answer, 'Ran it on prod: fine.');
    assert.equal(acts().filter((a) => a.kind === 'question' || a.kind === 'operator-missing').length, 0);

    // With an operator here, questions with steps are theirs again.
    hub.agentOp('o', 'ask', 'w2', { item: '#2', question: 'Rotate it too?', assumption: 'no', to: 'operator', steps });
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

// Needs you means you: a question goes to an operator first; a person only when the asker says why only a person
// can (only_person). Superseded #138's guess from the words, which sent "OK to…", "which…" and "approve…" to a person.
describe('who a question goes to', () => {
  // Real questions the homelab hub pushed to its person on 2026-11-20, all of which an operator could settle.
  const operators = [
    'Please run one git push for the #93 audit branch',
    'OK the ops-broker firewall, and run its deploy yourself over Tailscale SSH',
    'For homelab-ui v2.7.0: tag it by hand, or let a release item land it so the hub pushes the tag itself?',
    'Command A Plus gave 2 empty answers in the eval run. Does that count as meeting "no answer is cut off"?',
    'OK to remove the MacBook\'s SSH key from the ops-broker VM?',
    'Approve browser workers?',
    'Should #120 come before #118?',
  ];
  for (const question of operators) {
    test(`an operator first: ${question}`, () => {
      const { hub } = setup();
      for (const to of [undefined, 'human']) {
        const r = hub.agentOp('o', 'ask', 'w1', { question, assumption: 'wait', ...(to ? { to } : {}) });
        assert.equal(r.to, 'operator', `to: ${to}`);
        assert.equal(hub.q('SELECT audience FROM questions WHERE id = ?').get(r.question).audience, 'operator');
        assert.match(r.routed, /^To an operator first: no only_person was given\. Only a person can sign in as themselves .*pass only_person \(sign-in, money, physical, call\)/);
      }
    });
  }

  test('only_person sends it to a person, says why on the card, and to: "operator" still wins', () => {
    const { hub } = setup();
    const audience = (id) => hub.q('SELECT audience FROM questions WHERE id = ?').get(id).audience;
    const enrol = hub.agentOp('o', 'ask', 'w1', {
      question: 'Please enrol your iPhone\'s passkey with the ops broker', only_person: 'Sign-In', blocking: true,
      steps: [{ do: 'Open the enrolment link on your iPhone', where: 'https://broker.example/enrol', check: 'It says enrolled' }],
    });
    assert.equal(enrol.to, 'human');
    assert.equal(enrol.only_person, 'sign-in');
    assert.equal(enrol.routed, undefined);
    assert.equal(audience(enrol.question), 'person:sign-in');
    const card = view(hub, 'o').attention.find((a) => a.key === `q:${enrol.question}`);
    assert.equal(card.level, 'act');
    assert.equal(card.to ?? 'person', 'person');
    assert.equal(card.only_person, 'sign-in');
    assert.match(card.sub, /only a person: their sign-in/);
    const money = hub.agentOp('o', 'ask', 'w1', { question: 'Is a $20/month plan worth it?', only_person: 'money', to: 'human', options: ['yes', 'no'] });
    assert.equal(audience(money.question), 'person:money');
    const toOp = hub.agentOp('o', 'ask', 'w1', { question: 'Tabs or spaces?', assumption: 'spaces', to: 'operator', only_person: 'call' });
    assert.equal(audience(toOp.question), 'operator');
    assert.throws(() => hub.agentOp('o', 'ask', 'w1', { question: 'Buy it?', only_person: 'because' }), (e) => e.status === 400 && /only_person must be one of sign-in, money, physical, call/.test(e.message));
  });

  test('an operator asks a person only with a reason; otherwise it settles it, or escalates an operator question', () => {
    const { hub } = setup();
    hub.agentOp('o', 'checkin', 'op', { has: ['operator'] });
    for (const to of [undefined, 'human']) {
      assert.throws(() => hub.agentOp('o', 'ask', 'op', { question: 'OK to commit and push the uncommitted changes to main?', ...(to ? { to } : {}) }),
        (e) => e.status === 400 && /asks a person only for what only a person can do/.test(e.message) && /escalate it/.test(e.hint));
    }
    const r = hub.agentOp('o', 'ask', 'op', { question: 'Which of the two homelab-ui releases should ship first?', only_person: 'call', options: ['v2.7.0', 'v2.8.0'] });
    assert.equal(r.to, 'human');
    assert.equal(hub.agentOp('o', 'ask', 'op', { question: 'Can another operator check the runner logs?', to: 'operator', assumption: 'later' }).to, 'operator');
  });

  test('the ask tool and the guide say the rule', () => {
    const t = tools().find((x) => x.name === 'ask');
    assert.deepEqual(PERSON_REASONS, ['sign-in', 'money', 'physical', 'call']);
    assert.match(t.inputSchema.properties.only_person.description, /^sign-in, money, physical, call: why only a person can$/);
    assert.match(guide(), /An operator answers, unless only a person can: then pass `only_person`: `sign-in` \(theirs\), `money`, `physical` or `call`/);
  });
});
