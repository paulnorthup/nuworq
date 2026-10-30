import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, PERSON_CAN } from '../src/core.js';
import { view } from '../src/insight.js';

// #146: Retire is one click, so it can be undone: the same note, delivered again.
describe('retiring a decision, field note or steer can be undone', () => {
  test('retire → unretire brings the same decision back at checkin, and the record says so', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('u', { create: true }));
    hub.humanOp('u', 'decide', { body: 'Zero runtime dependencies.' });
    const id = hub.q("SELECT id FROM notes WHERE kind = 'decision'").get().id;
    const decisions = () => hub.agentOp('u', 'checkin', 'a1', {}).decisions ?? [];
    assert.deepEqual(decisions(), ['Zero runtime dependencies.']);

    hub.humanOp('u', 'retire', { note: id });
    assert.deepEqual(decisions(), []);
    assert.deepEqual(view(hub, 'u').decisions, []);

    hub.humanOp('u', 'unretire', { note: id });
    assert.deepEqual(decisions(), ['Zero runtime dependencies.'], 'delivered again');
    assert.equal(view(hub, 'u').decisions[0].id, id, 'the same note, not a copy');
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM notes').get().n, 1);
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'restored'").get().headline, /brought back a decision: Zero runtime/);

    hub.humanOp('u', 'unretire', { note: id }); // already active: nothing happens twice
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM events WHERE type = 'restored'").get().n, 1);
  });

  test('field notes and steers come back the same way; whoever may retire may undo it', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('u', { create: true }));
    hub.agentOp('u', 'checkin', 'a1', {});
    hub.agentOp('u', 'learn', 'a1', { note: 'Run npm test before pushing.' });
    hub.humanOp('u', 'steer', { body: 'Smaller commits, please.' });
    for (const kind of ['learning', 'steer']) {
      const id = hub.q('SELECT id FROM notes WHERE kind = ?').get(kind).id;
      hub.humanOp('u', 'retire', { note: id });
      assert.equal(hub.q('SELECT active FROM notes WHERE id = ?').get(id).active, 0);
      hub.humanOp('u', 'unretire', { note: id });
      assert.equal(hub.q('SELECT active FROM notes WHERE id = ?').get(id).active, 1, kind);
    }
    assert.ok(PERSON_CAN.steward.includes('unretire') && !PERSON_CAN.member.includes('unretire'));
    assert.throws(() => hub.humanOp('u', 'unretire', { note: 999 }), /No note 999/);
  });
});
