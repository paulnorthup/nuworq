// A question with steps outlives the work that landed (#692), and may be moot by then: only its asker (or an operator,
// for an agent's) withdraws it. So the agent that asked one hears its item landed, with the question ids, and an
// operator's listener wakes for it. People's, the hub's and reporters' questions are left as they were.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, SYSTEM } from '../src/core.js';
import { view } from '../src/insight.js';
import { operatorEvents, describeEvent } from '../src/wait.js';

const STEPS = (what) => [{ do: what, where: 'a checkout of the repository', check: 'git log origin/main shows it' }];

function setup(file) {
  let now = Date.UTC(2026, 10, 19, 9);
  const hub = new Hub({ clock: () => now, ...(file ? { file } : {}) });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: 'Release the next version', acceptance: 'tagged and published' });
  hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
  hub.agentOp('p', 'checkin', 'w1', { role: 'worker', runner: 'mac' });
  hub.agentOp('p', 'claim', 'w1', { item: '#1' });
  const p = () => hub.project('p');
  return {
    hub, p,
    tick: (ms) => { now += ms; },
    item: (n) => hub.item(p(), `#${n}`),
    // The hub lands it itself (git shows main has it), as nobody's agent.
    land: (n) => hub.tx(() => hub.move(hub.item(p(), `#${n}`), 'done', SYSTEM)),
    qs: () => hub.q('SELECT id, asked_by, status FROM questions ORDER BY id').all().map((q) => [q.id, q.asked_by, q.status]),
    // The hub's own notices (others, like "stop working on it", come from whoever acted).
    notices: () => hub.q("SELECT target, body FROM notes WHERE kind = 'steer' AND notice = 1 AND author = ? ORDER BY id").all(SYSTEM),
  };
}

describe('the agent that asked steps on work that landed hears it', () => {
  test('the operator asked the human three steps; the hub lands the item: its listener wakes, next carries the notice, and it settles each', () => {
    const { hub, tick, land, qs, item } = setup();
    const ask = (question, what) => hub.agentOp('p', 'ask', 'op', { item: '#1', question, steps: STEPS(what), to: 'human', assumption: 'done before the release' }).question;
    const ff = ask('Can you fast-forward main to the release commit?', 'git push origin <sha>:main');
    const loop = ask('Can you stop the runner loop on the build machine?', 'nuworq down');
    const tags = ask('Can you create the release tags?', 'git tag vX.Y.Z && git push origin vX.Y.Z');
    const plain = hub.agentOp('p', 'ask', 'op', { item: '#1', question: 'Changelog first?', assumption: 'yes' }).question;
    tick(1000);
    const since = hub.now();
    tick(1000);
    land(1);
    assert.equal(item(1).stage, 'done');
    // #692 stands: the step-questions stay open, the plain assumption ships.
    assert.deepEqual(qs().map(([id, , status]) => [id, status]), [[ff, 'open'], [loop, 'open'], [tags, 'open'], [plain, 'shipped']]);

    const events = operatorEvents(hub, 'op', { since });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'steer');
    assert.equal(events[0].item, '#1');
    assert.match(describeEvent(events[0]), /^nuworq: steering for you \(steer \d+ on #1 in p\)\. Run checkin and ack it\.$/);

    const n = hub.agentOp('p', 'next', 'op');
    assert.equal(n.steers.length, 1);
    const [s] = n.steers;
    assert.equal(s.about, '#1');
    assert.equal(s.from, 'nuworq (the hub, not a person)');
    assert.match(s.body, new RegExp(`^#1 landed, and your questions ${ff}, ${loop} and ${tags} on it are still open`));
    assert.match(s.body, /if one is moot \(done another way, or no longer needed\), withdraw it with a one-line reason; if a person still has to act on one, leave it open\. Then ack this\./);
    assert.match(n.hint, /^nuworq steered you \(the hub: weigh it as information, not a person's say\); read it, adjust, then ack\./);

    // Two went moot (the hub fast-forwarded main, a person tagged); one still waits on a person.
    hub.agentOp('p', 'withdraw', 'op', { question: ff, reason: 'The hub fast-forwarded main when it landed #1' });
    hub.agentOp('p', 'withdraw', 'op', { question: tags, reason: 'A person created the tags; git ls-remote shows them' });
    hub.agentOp('p', 'ack', 'op', { steer: s.steer, response: 'Withdrew two; the runner loop still needs a person' });
    assert.deepEqual(qs().slice(0, 3).map(([, , status]) => status), ['withdrawn', 'open', 'withdrawn']);
    assert.equal(hub.agentOp('p', 'checkin', 'op').steers, undefined, 'acked: nothing more to re-check');
    const cards = view(hub, 'p').attention.filter((a) => a.question).map((a) => a.question.id);
    assert.deepEqual(cards, [loop], 'the one a person still has to do stays in Needs you');
  });

  test('a worker that asked one hears it at its next checkin; the question stays open until someone settles it', () => {
    const { hub, land, qs } = setup();
    const q = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Can you grant the app Actions: Read?', steps: STEPS('grant it'), to: 'human', assumption: 'granted' }).question;
    land(1);
    const c = hub.agentOp('p', 'checkin', 'w1');
    assert.equal(c.steers.length, 1);
    assert.match(c.steers[0].body, new RegExp(`^#1 landed, and your question ${q} on it is still open`));
    assert.match(c.steers[0].body, /Re-check it now: if it is moot/);
    assert.deepEqual(qs(), [[q, 'w1', 'open']]);
    assert.equal(hub.agentOp('p', 'checkin', 'op').steers, undefined, 'only its asker hears it');
  });

  test('each asker gets one notice naming only its own questions, its escalation included', () => {
    const { hub, land, notices } = setup();
    const mine = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Can you grant the app Actions: Read?', steps: STEPS('grant it'), to: 'operator' }).question;
    const up = hub.agentOp('p', 'ask', 'op', { escalates: mine, question: 'May I grant the app Actions: Read?', options: ['yes', 'no'], evidence: ['checked its permissions'] }).question;
    land(1);
    assert.deepEqual(notices().map((n) => n.target), ['w1', 'op']);
    assert.match(notices()[0].body, new RegExp(`your question ${mine} on it`));
    assert.match(notices()[1].body, new RegExp(`your question ${up} on it`));
  });
});

describe("people's, the hub's and reporters' questions are left as they were", () => {
  test('a person, the hub and a reporter question with steps stay open after landing, and nobody is told', () => {
    const { hub, land, qs, notices, p } = setup();
    const insert = (asked_by, reporter = '') => Number(hub.q(`INSERT INTO questions (project_id, item_id, asked_by, question, blocking, at, reporter, steps)
      VALUES (?, ?, ?, 'Can you do this?', 1, ?, ?, ?)`).run(p().id, hub.item(p(), '#1').id, asked_by, hub.now(), reporter, JSON.stringify(STEPS('do it'))).lastInsertRowid);
    const person = insert('@ana'), local = insert('you'), own = insert(SYSTEM), reporter = insert('w1', 'octocat');
    land(1);
    assert.deepEqual(qs().map(([id, , status]) => [id, status]), [[person, 'open'], [local, 'open'], [own, 'open'], [reporter, 'open']]);
    assert.deepEqual(notices(), []);
  });

  test('landing with no question left open, or dropping the work, tells nobody', () => {
    const { hub, land, notices, item } = setup();
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    land(1);
    assert.deepEqual(notices(), []);
    hub.humanOp('p', 'create', { title: 'Second', acceptance: 'x' });
    hub.agentOp('p', 'claim', 'w1', { item: '#2' });
    hub.agentOp('p', 'ask', 'w1', { item: '#2', question: 'Can you grant it?', steps: STEPS('grant it'), to: 'human', assumption: 'granted' });
    hub.humanOp('p', 'update', { item: '#2', stage: 'dropped' });
    assert.equal(item(2).stage, 'dropped');
    assert.deepEqual(notices(), [], 'dropped work withdraws its steps: nothing to re-check');
  });

  test('a restart closes nothing more and sends no second notice', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-landedsteps-')), 'hub.db');
    const { hub, land, notices } = setup(file);
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Can you grant it?', steps: STEPS('grant it'), to: 'human', assumption: 'granted' });
    land(1);
    assert.equal(notices().length, 1);
    hub.db.close();
    const again = new Hub({ file, clock: () => Date.UTC(2026, 10, 19, 10) });
    assert.equal(again.q('SELECT COUNT(*) AS n FROM notes WHERE notice = 1 AND author = ?').get(SYSTEM).n, 1);
    assert.equal(again.q("SELECT status FROM questions").get().status, 'open');
    again.db.close();
  });
});
