import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { runChecks } from '../src/precondition.js';
import { tools } from '../src/protocol.js';

// #859: a worker who finds its item waits on an outside event, or is the operator's to do, parks it in one handoff.
const DAY = 24 * 60 * 60_000;
function world() {
  let t = Date.UTC(2026, 10, 3, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  const op = (agent, name, args = {}) => hub.agentOp('p', name, agent, args);
  const it = (ref) => hub.item(hub.project('p'), ref);
  const take = (agent, has) => { op(agent, 'checkin', has ? { has } : {}); return op(agent, 'next'); };
  const k = hub.humanOp('p', 'create', { title: 'Live check', acceptance: 'x' }).item;
  return { hub, op, it, take, k, advance: (ms) => (t += ms), tomorrow: () => new Date(t + DAY).toISOString().slice(0, 10) };
}

describe('handoff holds work back (#859)', () => {
  test('a precondition: outside, no holder, event records it, not offered; ready again once it passes', async () => {
    const { hub, op, it, take, k, advance, tomorrow } = world();
    assert.equal(take('w1').item, k);
    const r = op('w1', 'handoff', { item: k, headline: 'Waits on the date', precondition: { kind: 'date', after: tomorrow() } });
    assert.equal(r.stage, 'outside');
    assert.match(r.hint, /held back/);
    assert.equal(it(k).stage, 'outside');
    assert.equal(it(k).holder, null);
    const ev = hub.q(`SELECT data FROM events WHERE type = 'handoff'`).get();
    assert.equal(JSON.parse(ev.data).precondition.kind, 'date');
    op('w2', 'checkin', {});
    assert.notEqual(op('w2', 'next', { claim: false }).item, k);

    advance(2 * DAY);
    await runChecks(hub, { fetch: async () => { throw new Error('no network'); } });
    assert.equal(it(k).stage, 'ready');
    assert.equal(op('w2', 'next', { claim: false }).item, k);
  });

  test('an operator tag: ready, operator-only, offered to an operator, with the infra hint', () => {
    const { op, it, take, k } = world();
    take('w1');
    const r = op('w1', 'handoff', { item: k, headline: 'Needs the live hub', needs: ['operator'] });
    assert.equal(it(k).stage, 'ready');
    assert.match(r.hint, /only the operator can take it/);
    op('w2', 'checkin', {});
    assert.notEqual(op('w2', 'next', { claim: false }).item, k);
    op('o', 'checkin', { has: ['operator'] });
    assert.equal(op('o', 'next', { claim: false }).item, k);
  });

  test('held hand-backs never count toward the park at 3; plain ones still do', () => {
    const { hub, op, it, take, k } = world();
    for (const w of ['a', 'b', 'c']) {
      assert.equal(take(w).item, k);
      op(w, 'handoff', { item: k, headline: 'Operator only', needs: ['operator'] });
      hub.humanOp('p', 'update', { item: k, needs: [] }); // a person splits it; the next worker takes the code part
    }
    assert.equal(it(k).stage, 'ready');
    assert.equal(hub.q(`SELECT COUNT(*) n FROM events WHERE type = 'kept_parked'`).get().n, 0);
    for (const w of ['d', 'e', 'f']) { take(w); op(w, 'handoff', { item: k, headline: 'Plain' }); }
    assert.equal(it(k).stage, 'waiting');
  });

  test('an invalid precondition is refused with its hint, and the worker still holds the item', () => {
    const { op, it, take, k } = world();
    take('w1');
    assert.throws(() => op('w1', 'handoff', { item: k, headline: 'x', precondition: { kind: 'nope' } }), (e) => /precondition/i.test(e.message + (e.hint ?? '')));
    assert.equal(it(k).stage, 'active');
    assert.equal(it(k).holder, 'w1');
  });

  test('refused for work that is not being built', () => {
    const { op, it, take, k } = world();
    take('w1');
    op('w1', 'submit', { item: k, headline: 'done', evidence: [{ label: 'x' }] });
    op('r', 'checkin', {});
    const rv = op('r', 'next');
    assert.equal(rv.item, k);
    assert.throws(() => op('r', 'handoff', { item: k, headline: 'x', needs: ['operator'] }), (e) => e.status === 409 && /only hold work you are building/.test(e.message));
    assert.equal(it(k).stage, 'verifying');
  });

  test('the tool schema and hints say it', () => {
    const h = tools('worker').find((x) => x.name === 'handoff');
    assert.ok(h.inputSchema.properties.precondition && h.inputSchema.properties.needs);
    assert.match(h.description, /precondition/);
    assert.match(h.description, /operator/);
  });
});
