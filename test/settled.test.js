import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { view, itemView } from '../src/insight.js';

// One project, one item w1 is working on.
function setup(hub = new Hub({ clock: () => Date.UTC(2026, 9, 30, 9) })) {
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: 'Do the thing', acceptance: 'it works' });
  hub.agentOp('p', 'checkin', 'w1');
  hub.agentOp('p', 'next', 'w1');
  return hub;
}
const qs = (hub) => hub.q('SELECT id, status, closed_reason, blocking FROM questions ORDER BY id').all();
const asks = (v) => v.attention.filter((a) => a.question);

describe('worth knowing only holds what you can still act on (#182)', () => {
  test('an item that lands ships its open assumption: a status of its own, out of the attention list, and the asker hears nothing', () => {
    const hub = setup();
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    assert.equal(asks(view(hub, 'p')).length, 1, 'worth knowing while the work is open');
    hub.agentOp('p', 'submit', 'w1', { item: '#1', headline: 'Done' });
    hub.humanOp('p', 'accept', { item: '#1' });
    assert.equal(hub.item(hub.project('p'), '#1').stage, 'done');
    assert.deepEqual(qs(hub).map((q) => [q.status, q.closed_reason]), [['shipped', '#1 landed']]);
    assert.equal(asks(view(hub, 'p')).length, 0);
    // Nobody confirmed it, so the asker isn't told that anyone did.
    const back = hub.agentOp('p', 'checkin', 'w1');
    assert.ok(!JSON.stringify(back.answers ?? []).includes('Your assumption stands'));
    // The drawer has it, as shipped, with why.
    const q = itemView(hub, 'p', 1).questions[0];
    assert.equal(q.status, 'shipped');
    assert.equal(q.closed_reason, '#1 landed');
    // Too late to confirm or override.
    assert.throws(() => hub.humanOp('p', 'confirm', { question: q.id }), /already shipped/);
  });

  test('dropping an item withdraws its open questions, blocking or not', () => {
    const hub = setup();
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Which database?', blocking: true });
    assert.equal(asks(view(hub, 'p')).length, 2);
    hub.humanOp('p', 'update', { item: '#1', stage: 'dropped' });
    assert.deepEqual(qs(hub).map((q) => [q.status, q.closed_reason]), [['withdrawn', '#1 was dropped'], ['withdrawn', '#1 was dropped']]);
    assert.equal(asks(view(hub, 'p')).length, 0);
  });

  test('a blocking question on work marked done is withdrawn, not shipped', () => {
    const hub = setup();
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Which database?', blocking: true });
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(qs(hub).map((q) => q.status), ['withdrawn']);
  });

  test('questions already left open on landed or dropped work leave the lists, and close on startup', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-settled-')), 'hub.db');
    const hub = setup(new Hub({ file, clock: () => Date.UTC(2026, 9, 30, 9) }));
    hub.humanOp('p', 'create', { title: 'Second', acceptance: 'x' });
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    hub.agentOp('p', 'ask', 'w1', { item: '#2', question: 'Name it?', assumption: 'second' });
    // As before #182: the items settled, the questions stayed open.
    hub.q("UPDATE items SET stage = 'done' WHERE seq = 1").run();
    hub.q("UPDATE items SET stage = 'dropped' WHERE seq = 2").run();
    assert.deepEqual(qs(hub).map((q) => q.status), ['open', 'open']);
    assert.equal(asks(view(hub, 'p')).length, 0, 'not shown even before they are closed');
    hub.db.close();
    const again = new Hub({ file, clock: () => Date.UTC(2026, 9, 30, 10) });
    assert.deepEqual(qs(again).map((q) => [q.status, q.closed_reason]), [['shipped', '#1 landed'], ['withdrawn', '#2 was dropped']]);
    again.db.close();
  });

  test('an open question on work still in progress is untouched', () => {
    const hub = setup();
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    hub.agentOp('p', 'submit', 'w1', { item: '#1', headline: 'Done' });
    assert.deepEqual(qs(hub).map((q) => q.status), ['open']);
    assert.equal(asks(view(hub, 'p')).length, 1);
  });
});

// Q204: the person's steps that landed work needs to run closed with "#648 landed", never done (#692).
describe('steps a person still has to do outlive the work that landed (#692)', () => {
  const STEPS = [{ do: 'Grant the GitHub App Actions: Read', where: 'https://github.com/settings/apps/nuworq/permissions', check: 'Actions shows Read' }];
  const askAll = (hub) => {
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Can you grant the app Actions: Read?', assumption: 'granted before it deploys', steps: STEPS, to: 'human' });
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Tabs or spaces?', assumption: 'spaces' });
    hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Which database?', blocking: true });
  };
  const card = (hub) => asks(view(hub, 'p')).find((a) => a.question.id === 1);

  test('landing leaves the step-question open, as a card to act on that says the work landed; the rest settle as before', () => {
    const hub = setup();
    askAll(hub);
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(qs(hub).map((q) => [q.status, q.closed_reason]), [['open', ''], ['shipped', '#1 landed'], ['withdrawn', '#1 landed']]);
    assert.deepEqual(asks(view(hub, 'p')).map((a) => a.question.id), [1], 'only the steps show');
    const c = card(hub);
    assert.equal(c.level, 'act');
    assert.deepEqual(c.steps.map((s) => s.do), [STEPS[0].do]);
    assert.match(c.sub, /#1 landed; these steps are still to do/);
  });

  test('ticking its steps closes it as before', () => {
    const hub = setup();
    askAll(hub);
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    assert.equal(hub.humanOp('p', 'step', { question: 1, step: 1 }).answered, true);
    assert.equal(qs(hub)[0].status, 'answered');
    assert.equal(card(hub), undefined);
  });

  test('its asker can still withdraw it', () => {
    const hub = setup();
    askAll(hub);
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    hub.agentOp('p', 'withdraw', 'w1', { question: 1, reason: 'Remy granted it in a planning session' });
    assert.equal(qs(hub)[0].status, 'withdrawn');
    assert.equal(card(hub), undefined);
  });

  test('dropping the work withdraws its steps too: they were for work that never shipped', () => {
    const hub = setup();
    askAll(hub);
    hub.humanOp('p', 'update', { item: '#1', stage: 'dropped' });
    assert.deepEqual(qs(hub).map((q) => q.status), ['withdrawn', 'withdrawn', 'withdrawn']);
    assert.equal(asks(view(hub, 'p')).length, 0);
  });

  test("an operator's escalation of them stays open with them, in Needs you", () => {
    const hub = setup();
    const q = hub.agentOp('p', 'ask', 'w1', { item: '#1', question: 'Can you grant the app Actions: Read?', assumption: 'granted', steps: STEPS, to: 'operator' }).question;
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    const e = hub.agentOp('p', 'ask', 'op', { escalates: q, question: 'May I grant the app Actions: Read?', options: ['yes', 'no'], evidence: ['checked its permissions'] }).question;
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(qs(hub).map((q) => [q.status, q.closed_reason]), [['open', ''], ['open', '']]);
    const c = asks(view(hub, 'p')).find((a) => a.question.id === e);
    assert.equal(c.level, 'act');
    assert.match(c.sub, /#1 landed; its steps are still to do/);
  });

  test('a restart leaves them open', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-settled-')), 'hub.db');
    const hub = setup(new Hub({ file, clock: () => Date.UTC(2026, 9, 30, 9) }));
    askAll(hub);
    hub.humanOp('p', 'update', { item: '#1', stage: 'done' });
    hub.db.close();
    const again = new Hub({ file, clock: () => Date.UTC(2026, 9, 30, 10) });
    assert.deepEqual(qs(again).map((q) => q.status), ['open', 'shipped', 'withdrawn']);
    assert.equal(card(again).level, 'act');
    again.db.close();
  });
});
