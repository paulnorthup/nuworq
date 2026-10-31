import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view, homeView, isPresent } from '../src/insight.js';
import { byRole, roleCounts } from '../web/agentline.js';

// #441: an agent shows in the app's lists only while it holds work, or within an hour of when it was last seen;
// signing off takes it out at once. Gone agents stay in the view (for history and "Show earlier agents").
function setup() {
  let now = Date.UTC(2026, 9, 31, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('r', { create: true }));
  hub.humanOp('r', 'settings', { autonomy: 'full' });
  hub.humanOp('r', 'create', { title: 'Some work', acceptance: 'x' });
  return {
    hub,
    a: (agent, op, args = {}) => hub.agentOp('r', op, agent, args),
    tick: (ms) => { now += ms; },
    present: () => view(hub, 'r').agents.filter((x) => x.present).map((x) => x.name).sort(),
  };
}

describe('agents show only while they matter', () => {
  test('the rule: holding work, seen 59 vs 61 minutes ago, signed off', () => {
    const t = 1e12;
    assert.equal(isPresent({ signed_off: 0, last_seen: t - 59 * MIN }, [], t), true);
    assert.equal(isPresent({ signed_off: 0, last_seen: t - 61 * MIN }, [], t), false);
    assert.equal(isPresent({ signed_off: 0, last_seen: t - 600 * MIN }, ['#1'], t), true);
    assert.equal(isPresent({ signed_off: 1, last_seen: t }, [], t), false);
  });

  test('the project view marks who is present; the rest stay in the list for history', () => {
    const { hub, a, tick, present } = setup();
    a('holder', 'checkin', { model: 'm' });
    a('holder', 'next');
    a('early', 'checkin', { model: 'm' });
    tick(2 * MIN);
    a('late', 'checkin', { model: 'm' });
    a('quitter', 'checkin', { model: 'm' });
    a('quitter', 'signoff', { headline: 'done' });
    assert.deepEqual(present(), ['early', 'holder', 'late']);
    tick(58 * MIN); // early: 60m, late: 58m, holder: 60m but holds #1
    assert.deepEqual(present(), ['holder', 'late']);
    tick(2 * MIN);
    assert.deepEqual(present(), ['holder']);
    assert.equal(view(hub, 'r').agents.length, 4); // nobody is lost
  });

  test('the home lists the agents here now, with role and project, for its counts', () => {
    const { hub, a, tick } = setup();
    a('w', 'checkin', { role: 'worker', runner: 'mini' });
    a('op', 'checkin', { has: ['operator'] });
    a('gone', 'checkin', {});
    a('gone', 'signoff', { headline: 'bye' });
    tick(MIN);
    const h = homeView(hub);
    assert.deepEqual(h.agents.map((x) => [x.name, x.role, x.project.slug]).sort(), [['op', 'operator', 'r'], ['w', 'worker', 'r']]);
  });
});

describe('counts by role', () => {
  const esc = (s) => String(s);
  const who = (x) => x.name;
  const agents = [{ name: 'w1', role: 'worker' }, { name: 'o', role: 'operator' }, { name: 'w2', role: 'worker' }, { name: 's', role: 'session' }];

  test('workers first, then operators, shapers and other agents, each with its count', () => {
    assert.deepEqual(byRole(agents).map((g) => g.label), ['2 workers', '1 operator', '1 agent']);
  });

  test('each count is a button; an open one shows its agents by name', () => {
    const closed = roleCounts(agents, { scope: 'r', esc, who });
    assert.match(closed, /data-key="roles:r:worker" aria-expanded="false">2 workers</);
    assert.doesNotMatch(closed, /w1/);
    const open = roleCounts(agents, { scope: 'r', esc, who, isOpen: (k) => k === 'roles:r:worker' });
    assert.match(open, /role-names.*w1.*w2/);
    assert.doesNotMatch(open, />o</);
    assert.equal(roleCounts([], { esc, who }), '');
  });
});
