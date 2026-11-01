import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, dur as hubDur, MIN, HOUR, DAY } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { dur, ago, tick } from '../web/ago.js';

// #530: the page formats relative times itself from the hub's timestamps and keeps them current with one local
// tick, so it needs no 30-second refetch; what only time changes on the hub arrives as a change.
describe('relative times tick in the page', () => {
  test('the page says a time exactly as the hub does', () => {
    for (const ms of [0, 400, 59_000, 61_000, 59 * MIN, HOUR, 9.5 * HOUR, 11 * HOUR, DAY, 3.25 * DAY]) assert.equal(dur(ms), hubDur(ms), String(ms));
  });

  test('ago renders a span the tick keeps current; a time to come counts down; no time falls back to the hub\'s string', () => {
    const now = 1_000_000_000;
    assert.equal(ago(now - 3 * MIN, { now }), `<span data-at="${now - 3 * MIN}">3m</span>`);
    assert.equal(ago(now + 5 * MIN, { left: true, now }), `<span data-at="${now + 5 * MIN}" data-left>5m</span>`);
    assert.equal(ago(null, { fallback: '2h' }), '2h', 'an older hub sends no time');
  });

  test('tick re-says every time in place, with no fetch', () => {
    const now = 1_000_000_000;
    const el = (at, left = false) => ({ dataset: { at: String(at) }, textContent: 'old', hasAttribute: (a) => a === 'data-left' && left });
    const els = [el(now - 3 * MIN), el(now + 2 * HOUR, true)];
    tick({ querySelectorAll: (sel) => (assert.equal(sel, '[data-at]'), els) }, now + MIN);
    assert.deepEqual(els.map((e) => e.textContent), ['4m', '2h']);
  });

  test('views send the time beside each relative string the page shows', () => {
    let now = Date.UTC(2026, 10, 1, 9);
    const hub = new Hub({ clock: () => now });
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'create', { title: 'A', acceptance: 'x' });
    hub.agentOp('p', 'checkin', 'w1', {});
    const created = now;
    now += 5 * MIN;
    hub.agentOp('p', 'next', 'w1', {});
    now += 2 * MIN;
    const v = view(hub, 'p');
    const m = v.motion[0];
    assert.equal(m.since_at, created + 5 * MIN);
    assert.ok(m.lease_until > now && m.last.at <= now);
    const a = v.agents.find((x) => x.name === 'w1');
    assert.equal(a.seen_at, created + 5 * MIN);
    const it = itemView(hub, 'p', '#1');
    assert.equal(it.created_at, created);
    assert.equal(it.stage_since, created + 5 * MIN);
    assert.ok(it.lease_until > now);
    for (const e of it.timeline ?? it.events ?? []) assert.ok(e.at, 'events carry at');
  });
});

describe('what only time changes reaches the page as a change', () => {
  function world() {
    let now = Date.UTC(2026, 10, 1, 9);
    const hub = new Hub({ clock: () => now });
    hub.tx(() => hub.project('p', { create: true }));
    hub.tx(() => hub.project('q', { create: true }));
    hub.agentOp('p', 'checkin', 'w1', {});
    const changes = [];
    hub.on('change', (c) => changes.push(c));
    return { hub, changes, tick: (ms) => { now += ms; hub.sweep(); } };
  }

  test('an agent going quiet, away, absent for an hour and unseen for a day: one change each, for its project', () => {
    const { hub, changes, tick } = world();
    hub.sweep();
    const at = (ms) => { changes.length = 0; tick(ms); return changes.filter((c) => c.kind === 'time').map((c) => c.project); };
    assert.deepEqual(at(9 * MIN), [], 'nothing flips before 10m');
    assert.deepEqual(at(2 * MIN), ['p'], 'quiet at 10m');
    assert.deepEqual(at(10 * MIN), [], 'nothing between');
    assert.deepEqual(at(10 * MIN), ['p'], 'away at 30m');
    assert.deepEqual(at(31 * MIN), ['p'], 'not present at 1h');
    assert.deepEqual(at(5 * HOUR), [], 'nothing between');
    assert.deepEqual(at(DAY), ['p'], 'a day unseen');
    assert.deepEqual(at(DAY), [], 'once');
  });

  test('a runner going down is a change; looking more often than every 5 s costs nothing', () => {
    const { hub, changes, tick } = world();
    hub.sweep();
    hub.reportRunner({ name: 'mac', machine: 'mac', running: 0, poll_seconds: 30 }, { name: '' });
    changes.length = 0;
    tick(60_000);
    assert.equal(changes.filter((c) => c.kind === 'time').length, 0, 'two polls missed: still up');
    tick(40_000);
    assert.equal(changes.filter((c) => c.kind === 'time' && c.project === null).length, 1, 'three missed: down');
    changes.length = 0;
    tick(1000);
    assert.equal(changes.length, 0);
  });
});
