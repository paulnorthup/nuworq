import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HOUR, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

const DAY_PLUS = 25 * HOUR; // past a day: the Worth knowing line's window

// "Signup website" (#1, a group) whose next step #2 needs infra; the clock moves.
function setup(priority = 'now') {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('site', { create: true, name: 'Site' }));
  hub.humanOp('site', 'create', { title: 'Signup website', acceptance: 'people can sign up', priority });
  hub.humanOp('site', 'create', { title: 'Point the DNS at the hub', acceptance: 'resolves', priority: 'soon', parent: '#1', needs: ['infra'] });
  hub.agentOp('site', 'checkin', 'w1', { has: ['macos'] });
  const v = () => view(hub, 'site');
  const stalled = () => v().attention.filter((a) => a.kind === 'group-stalled');
  return { hub, v, stalled, tick: (ms) => (t += ms) };
}

describe('a "now" group stalled on a capability reaches Needs you (#201)', () => {
  test('after 4 hours with nobody who has it: one act entry naming the group, the step and the capability, with steps', () => {
    const { stalled, tick } = setup();
    tick(4 * HOUR - MIN);
    assert.deepEqual(stalled(), [], 'at 3h59m, nothing');
    tick(2 * MIN);
    const [a] = stalled();
    assert.equal(a.level, 'act');
    assert.equal(a.headline, '"Signup website" is stalled: #2 needs infra');
    assert.equal(a.group, '#1');
    assert.equal(a.item, '#2');
    assert.deepEqual(a.missing, ['infra']);
    assert.deepEqual(a.how.map((s) => s.where), ['nuworq operator --project site --has infra', 'claude']);
    assert.ok(a.how.every((s) => s.do && s.check));
    assert.equal(stalled().length, 1, 'one per group');
  });

  test('an agent with the capability checking in, or the step claimed, clears it', () => {
    const { hub, stalled, tick } = setup();
    tick(5 * HOUR);
    assert.equal(stalled().length, 1);
    hub.agentOp('site', 'checkin', 'op', { has: ['operator', 'infra'] });
    assert.deepEqual(stalled(), [], 'someone who can do it is here');
    tick(5 * HOUR);
    assert.equal(stalled().length, 1, 'gone quiet again');
    hub.agentOp('site', 'claim', 'op', { item: '#2' });
    assert.deepEqual(stalled(), []);
  });

  test('a "soon" or "later" group gets only the Worth knowing line', () => {
    for (const priority of ['soon', 'later']) {
      const { v, stalled, tick } = setup(priority);
      tick(DAY_PLUS);
      assert.deepEqual(stalled(), [], priority);
      assert.ok(v().attention.some((a) => a.kind === 'unfit' && a.level === 'know'), priority);
    }
  });

  test('the Worth knowing line for operator-only work gives operator steps, not "Let any agent take it"', () => {
    const { v, tick } = setup('soon');
    tick(DAY_PLUS);
    const unfit = v().attention.find((a) => a.kind === 'unfit');
    assert.equal(unfit.operator, true);
    assert.match(unfit.how[0].where, /^nuworq operator --project site/);
    const app = appSource();
    assert.match(app, /a\.kind === 'unfit' && a\.operator\) acts = `<button class="btn ghost small" data-action="dismiss"/);
  });
});

// #214: the group's line under Groups follows the same rule as Needs you, not a second copy of it.
describe('a group Needs you calls stalled says Stuck on its Groups line (#214)', () => {
  test('stalled: Stuck, naming the step and the capability; once someone who has it checks in, back to Queued', () => {
    const { hub, v, stalled, tick } = setup();
    // An operator with the capability was here 5 hours ago: within the day, so the old rule said "ready for the next agent".
    hub.agentOp('site', 'checkin', 'op', { has: ['operator', 'infra'] });
    tick(5 * HOUR);
    hub.agentOp('site', 'checkin', 'w1', { has: ['macos'] });
    const line = () => v().groups.find((g) => g.item === '#1');
    assert.equal(stalled().length, 1, 'Needs you: stalled');
    assert.equal(line().state, 'stuck');
    assert.equal(line().reason, '#2 needs an operator (infra); none has checked in for 4 hours');
    hub.agentOp('site', 'checkin', 'op', { has: ['operator', 'infra'] });
    assert.deepEqual(stalled(), []);
    assert.equal(line().state, 'queued');
    assert.equal(line().reason, '#2 ready for the next agent');
  });

  test('stalled outranks moving: one agent busy elsewhere in the group doesn\'t make it look fine', () => {
    const { hub, v, stalled, tick } = setup();
    hub.humanOp('site', 'create', { title: 'Write the copy', acceptance: 'written', priority: 'soon', parent: '#1' });
    hub.agentOp('site', 'checkin', 'ui', { has: ['browser'] });
    hub.humanOp('site', 'create', { title: 'Check the form on a phone', acceptance: 'fits', priority: 'soon', parent: '#1', needs: ['browser'] });
    tick(5 * HOUR);
    hub.agentOp('site', 'claim', 'w1', { item: '#3' });
    assert.equal(stalled().length, 1);
    const line = v().groups.find((g) => g.item === '#1');
    assert.equal(line.state, 'stuck', 'not "Moving": Needs you says it is stalled');
    assert.match(line.reason, /^#2 needs an operator \(infra\)/, 'the oldest stuck step, as in Needs you');
  });
});

// #266: the line finds the stalled step in its tree, wherever its "now" comes from.
describe('a Groups line is Stuck when its stalled step ranks "now" from a sub-group or a dependent (#266)', () => {
  test('a "now" sub-group inside a "soon" group', () => {
    const { hub, v, stalled, tick } = setup('soon');
    hub.humanOp('site', 'create', { title: 'Launch checklist', acceptance: 'checked', priority: 'now', parent: '#1' }); // #3
    hub.humanOp('site', 'create', { title: 'Check the form on a phone', acceptance: 'fits', priority: 'soon', parent: '#3', needs: ['browser'] }); // #4
    hub.humanOp('site', 'create', { title: 'Write the copy', acceptance: 'written', priority: 'soon', parent: '#1' }); // #5
    tick(5 * HOUR);
    hub.agentOp('site', 'checkin', 'w1', { has: ['macos'] });
    assert.equal(stalled().length, 1, 'Needs you: #3 is stalled');
    assert.match(stalled()[0].headline, /"Launch checklist" is stalled: #4 needs browser/);
    const line = v().groups.find((g) => g.item === '#1');
    assert.equal(line.state, 'stuck', 'not "Queued": #5 is ready, but Needs you says #4 stalls the group');
    assert.equal(line.reason, '#4 needs browser; no agent connected in 4 hours has it');
  });

  test('a "now" item outside the group depends on its step', () => {
    const { hub, v, stalled, tick } = setup('soon');
    hub.humanOp('site', 'create', { title: 'Write the copy', acceptance: 'written', priority: 'soon', parent: '#1' }); // #3
    hub.humanOp('site', 'create', { title: 'Go live', acceptance: 'live', priority: 'now', depends_on: ['#2'] }); // #4
    tick(5 * HOUR);
    hub.agentOp('site', 'checkin', 'w1', { has: ['macos'] });
    assert.equal(stalled().length, 1, 'Needs you: #4 is stalled on #2');
    const line = v().groups.find((g) => g.item === '#1');
    assert.equal(line.state, 'stuck');
    assert.equal(line.reason, '#2 needs an operator (infra); none has checked in for 4 hours');
  });
});
