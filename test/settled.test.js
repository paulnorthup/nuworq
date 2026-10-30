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
