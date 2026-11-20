import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HOUR as HOUR_MS } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { guide, skill, tools, operatorSkill, MODE_RULES } from '../src/protocol.js';

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

    const r = hub.agentOp('p', 'withdraw', 'w1', { question: a.question, reason: 'Remy answered in a planning session: he is the only admin.' });
    assert.equal(r.ok, true);
    hub.agentOp('p', 'withdraw', 'w1', { question: b.question, reason: 'No longer matters: billing moved to #9' });
    assert.equal(asks(hub).length, 0);
    assert.equal(hub.item(hub.project('p'), '#1').stage, 'ready', 'nothing parks it any more');

    const it = itemView(hub, 'p', 1);
    assert.deepEqual(it.questions.map((q) => [q.status, q.closed_reason]), [
      ['withdrawn', 'Remy answered in a planning session: he is the only admin.'],
      ['withdrawn', 'No longer matters: billing moved to #9'],
    ]);
    const ev = hub.q("SELECT headline, summary FROM events WHERE type = 'question_withdrawn' ORDER BY id").all();
    assert.equal(ev.length, 2);
    assert.match(ev[0].headline, /w1 withdrew its question: Who are the admins\?/);
    assert.equal(ev[0].summary, 'Why: Remy answered in a planning session: he is the only admin.');
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
    // The guide carries the detail and the tool stays one sentence (#527 with #529).
    assert.match(g, /`withdraw` it with a one-line reason \(quote who said it\)/);
    assert.match(tools().find((t) => t.name === 'withdraw').description, /Withdraw a question you asked: answered another way, or no longer matters/);
    assert.match(g, /A person decides\? Give `options`, no assumption/);
    assert.match(skill(), /- `withdraw`: Withdraw a question you asked/);
    assert.ok(tools().some((t) => t.name === 'withdraw'));
  });
});

// An operator may withdraw another agent's open question for it, in its own project: its asker is often a runner's
// worker long gone, and the question keeps its item waiting. Never a person's, the hub's or a reporter's.
describe("an operator withdraws an agent's moot question for it", () => {
  function hubWithOperator() {
    let now = Date.UTC(2026, 10, 19, 9);
    const hub = new Hub({ clock: () => now });
    hub.tx(() => hub.project('p', { create: true }));
    hub.tx(() => hub.project('q', { create: true }));
    hub.humanOp('p', 'create', { title: 'Publish the docs', acceptance: 'x' });
    hub.humanOp('p', 'create', { title: 'Announce it', acceptance: 'x' });
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    return { hub, tick: (ms) => { now += ms; }, item: (n) => hub.item(hub.project('p'), `#${n}`) };
  }
  // A worker takes item n, asks a blocking question the hub parks it on, and leaves.
  const strand = (hub, worker, n, question) => {
    hub.agentOp('p', 'checkin', worker, { role: 'worker', runner: 'mac' });
    hub.agentOp('p', 'claim', worker, { item: `#${n}` });
    const id = hub.agentOp('p', 'ask', worker, { item: `#${n}`, question, blocking: true, to: 'human', steps: [{ do: 'Check the tags', where: 'git ls-remote --tags origin' }] }).question;
    hub.agentOp('p', 'signoff', worker, {});
    return id;
  };

  test('two gone workers asked "Is v2.6.0 tagged?": the operator withdraws both for them, and their items are ready again', () => {
    const { hub, item, tick } = hubWithOperator();
    const a = strand(hub, 'w1', 1, 'Is v2.6.0 tagged?');
    const b = strand(hub, 'w2', 2, 'Is v2.6.0 tagged yet?');
    assert.deepEqual([item(1).stage, item(2).stage], ['waiting', 'waiting']);
    tick(2 * HOUR_MS);
    const r = hub.agentOp('p', 'withdraw', 'op', { question: a, reason: 'A person tagged v2.6.0 at 10:12; git ls-remote shows it' });
    assert.equal(r.ok, true);
    assert.match(r.hint, /^Withdrawn for w1; #1 is ready\./);
    hub.agentOp('p', 'withdraw', 'op', { question: b, reason: 'Moot: v2.6.0 is tagged' });
    assert.deepEqual([item(1).stage, item(2).stage], ['ready', 'ready']);
    assert.equal(asks(hub).length, 0, 'out of Needs you');

    const q = itemView(hub, 'p', 1).questions[0];
    assert.equal(q.status, 'withdrawn');
    assert.equal(q.closed_reason, 'by op, an operator, for w1: A person tagged v2.6.0 at 10:12; git ls-remote shows it');
    const ev = hub.q("SELECT actor, headline, summary, data FROM events WHERE type = 'question_withdrawn' ORDER BY id").all();
    assert.equal(ev[0].actor, 'op');
    assert.equal(ev[0].headline, "op withdrew w1's question for them: Is v2.6.0 tagged?");
    assert.equal(ev[0].summary, 'Why: A person tagged v2.6.0 at 10:12; git ls-remote shows it');
    assert.deepEqual(JSON.parse(ev[0].data), { question: a, for: 'w1' });
    // A gone asker gets no notice; there is nobody to read it.
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM notes WHERE target = 'w1'").get().n, 0);
  });

  test('its escalation closes with it, and an asker still here hears who withdrew it and why', () => {
    const { hub } = hubWithOperator();
    hub.agentOp('p', 'checkin', 's1');
    hub.agentOp('p', 'claim', 's1', { item: '#1' });
    const q = hub.agentOp('p', 'ask', 's1', { item: '#1', question: 'Can the old tables on prod be dropped?', blocking: true, to: 'operator' }).question;
    hub.agentOp('p', 'checkin', 'op2', { has: ['operator'] });
    const e = hub.agentOp('p', 'ask', 'op2', { escalates: q, question: 'Drop the old tables?', evidence: ['dry run: 3 tables'] }).question;
    hub.agentOp('p', 'withdraw', 'op', { question: q, reason: 'The tables were dropped in the migration that landed' });
    const status = (id) => hub.q('SELECT status, closed_reason FROM questions WHERE id = ?').get(id);
    assert.equal(status(q).status, 'withdrawn');
    assert.deepEqual({ ...status(e) }, { status: 'withdrawn', closed_reason: 'by op, an operator, for s1: The tables were dropped in the migration that landed' });
    const c = hub.agentOp('p', 'checkin', 's1');
    assert.equal(c.steers.length, 1);
    assert.equal(c.steers[0].body, `op, an operator, withdrew your question ${q} for you: The tables were dropped in the migration that landed`);
    assert.equal(c.steers[0].from, 'op (an agent, not a person)');
  });

  test("a person's, the hub's and a reporter's question are refused, as is an operator elsewhere; a reason is still required", () => {
    const { hub } = hubWithOperator();
    const p = hub.project('p');
    const insert = (asked_by, reporter = '') => Number(hub.q(`INSERT INTO questions (project_id, item_id, asked_by, question, blocking, at, reporter)
      VALUES (?, ?, ?, 'Ship it?', 1, ?, ?)`).run(p.id, hub.item(p, '#1').id, asked_by, hub.now(), reporter).lastInsertRowid);
    for (const [id, why] of [[insert('@ana'), /a person's/], [insert('you'), /a person's/], [insert('nuworq'), /the hub's own/], [insert('w1', 'octocat'), /put to @octocat, the issue's reporter/]]) {
      assert.throws(() => hub.agentOp('p', 'withdraw', 'op', { question: id, reason: 'moot' }), (e) => e.status === 403 && why.test(e.message) && /an operator withdraws only another agent's/.test(e.message) && !!e.hint, String(id));
      assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(id).status, 'open');
    }
    const theirs = strand(hub, 'w1', 2, 'Is it tagged?');
    // An operator of another project is just an agent here.
    hub.agentOp('q', 'checkin', 'op-q', { has: ['operator'] });
    hub.agentOp('p', 'checkin', 'op-q');
    assert.throws(() => hub.agentOp('p', 'withdraw', 'op-q', { question: theirs, reason: 'moot' }), (e) => e.status === 403 && /w1's, not yours/.test(e.message) && /or an operator, for an agent's/.test(e.hint));
    assert.throws(() => hub.agentOp('p', 'withdraw', 'op', { question: theirs, reason: ' ' }), /reason is required/);
    assert.equal(hub.q('SELECT status FROM questions WHERE id = ?').get(theirs).status, 'open');
  });

  test('the operator skill and the hint next gives an operator say it may', () => {
    assert.match(operatorSkill(), /\*\*Withdraw a moot question for its asker\.\*\*/);
    assert.match(MODE_RULES.operator, /withdraw another agent's moot question for it when its asker is gone/);
  });
});
