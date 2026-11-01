import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { MIGRATIONS } from '../src/db.js';
import { view } from '../src/insight.js';

// Steering about an item retires itself once the item is done or dropped (#551).
const MIN = 60_000;
function world(file) {
  let t = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ ...(file ? { file } : {}), clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  const add = (title) => hub.humanOp('p', 'create', { title, acceptance: 'x' }).item;
  const active = () => hub.q(`SELECT id, body FROM notes WHERE kind = 'steer' AND active = 1 ORDER BY id`).all().map((n) => n.body);
  return { hub, add, active, later: (ms) => { t += ms; } };
}

describe('steering about an item retires with the item (#551)', () => {
  test("when the item is done, its steers retire, a person's and an agent's, with the reason on the record", () => {
    const { hub, add, active } = world();
    const k = add('Exports retry');
    hub.humanOp('p', 'steer', { item: k, body: 'this is done - mark as done and move on' });
    hub.agentOp('p', 'checkin', 'op', { has: ['operator'] });
    hub.addNote(hub.project('p'), 'steer', 'The operator answered: the key is in place.', hub.item(hub.project('p'), k), null, 'op');
    assert.equal(active().length, 2);
    hub.humanOp('p', 'update', { item: k, stage: 'done' });
    assert.deepEqual(active(), []);
    const said = hub.q(`SELECT headline, data FROM events WHERE type = 'retired' ORDER BY id`).all();
    assert.equal(said.length, 2);
    assert.match(said[0].headline, new RegExp(`^nuworq retired a steer, as ${k} landed: this is done`));
    assert.equal(JSON.parse(said[0].data).reason, `${k} landed`);
    // History keeps it, and a person can bring it back.
    const note = hub.q(`SELECT id FROM notes WHERE kind = 'steer' ORDER BY id`).get().id;
    hub.humanOp('p', 'unretire', { note });
    assert.equal(active().length, 1);
  });

  test('when the item is dropped, its steers retire with that reason', () => {
    const { hub, add, active } = world();
    const k = add('Old idea');
    hub.humanOp('p', 'steer', { item: k, body: 'Keep it small.' });
    hub.humanOp('p', 'update', { item: k, stage: 'dropped' });
    assert.deepEqual(active(), []);
    assert.match(hub.q(`SELECT headline FROM events WHERE type = 'retired'`).get().headline, new RegExp(`as ${k} was dropped`));
  });

  test("steering for the whole project, and about items still open, stays; retired steering isn't unseen, nor in checkin", () => {
    const { hub, add, active, later } = world();
    const open = add('Still going'), closed = add('Finished');
    hub.humanOp('p', 'steer', { body: 'Prefer small pull requests.' });
    hub.humanOp('p', 'steer', { item: open, body: 'Start with the tests.' });
    const p = hub.project('p');
    hub.addNote(p, 'steer', 'Ship it today.', hub.item(p, closed), 'w1', '@paul'); // to w1, so its checkin shows it
    later(20 * MIN); // the unseen card waits 15 minutes
    const unseen = () => view(hub, 'p').attention.filter((a) => a.kind === 'steer-unseen').map((a) => a.sub).join(' ');
    const told = (agent) => (hub.agentOp('p', 'checkin', agent, {}).steers ?? []).map((s) => s.body);
    assert.match(unseen(), /Ship it today/, 'shown before');
    assert.ok(told('w1').includes('Ship it today.'), 'in checkin before');
    hub.humanOp('p', 'update', { item: closed, stage: 'done' });
    assert.deepEqual(active(), ['Prefer small pull requests.', 'Start with the tests.']);
    assert.doesNotMatch(unseen(), /Ship it today/);
    assert.ok(!told('w1').includes('Ship it today.'), 'checkin leaves it out');
  });

  test('on first start, steers on items closed before this retire the same way, and the count is logged', (t) => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-steers-')), 'hub.db');
    const { hub, add } = world(file);
    const done = add('Landed earlier'), dropped = add('Dropped earlier'), open = add('Open');
    hub.humanOp('p', 'steer', { item: done, body: 'Mark it done and move on.' });
    hub.humanOp('p', 'steer', { item: dropped, body: 'Not now.' });
    hub.humanOp('p', 'steer', { item: open, body: 'Keep going.' });
    hub.humanOp('p', 'steer', { body: 'Whole project.' });
    hub.humanOp('p', 'update', { item: done, stage: 'done' });
    hub.humanOp('p', 'update', { item: dropped, stage: 'dropped' });
    // As before #551: those steers still active, the database one migration behind.
    hub.q(`UPDATE notes SET active = 1 WHERE kind = 'steer'`).run();
    hub.q(`DELETE FROM events WHERE type = 'retired'`).run();
    hub.db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    hub.db.close();
    const logged = [];
    t.mock.method(console, 'log', (m) => logged.push(m));
    const again = new Hub({ file });
    const left = again.q(`SELECT body FROM notes WHERE kind = 'steer' AND active = 1 ORDER BY id`).all().map((n) => n.body);
    assert.deepEqual(left, ['Keep going.', 'Whole project.']);
    const why = again.q(`SELECT headline FROM events WHERE type = 'retired' ORDER BY id`).all().map((e) => e.headline);
    assert.equal(why.length, 2);
    assert.match(why[0], new RegExp(`as ${done} landed: Mark it done`));
    assert.match(why[1], new RegExp(`as ${dropped} was dropped: Not now`));
    assert.deepEqual(logged, ['Retired 2 of 4 active steers: they were about items already done or dropped (#551).']);
    again.db.close();
  });
});
