import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, HOUR, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { readFileSync } from 'node:fs';

const DAY_PLUS = 25 * HOUR; // past a day: the Worth knowing line's window

// "Signup website" (#1, a group) whose next step #2 needs nuworq-infra; the clock moves.
function setup(priority = 'now') {
  let t = Date.UTC(2026, 10, 2, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('site', { create: true, name: 'Site' }));
  hub.humanOp('site', 'create', { title: 'Signup website', acceptance: 'people can sign up', priority });
  hub.humanOp('site', 'create', { title: 'Point the DNS at the hub', acceptance: 'resolves', priority: 'soon', parent: '#1', needs: ['nuworq-infra'] });
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
    assert.equal(a.headline, '"Signup website" is stalled: #2 needs nuworq-infra');
    assert.equal(a.group, '#1');
    assert.equal(a.item, '#2');
    assert.deepEqual(a.missing, ['nuworq-infra']);
    assert.deepEqual(a.how.map((s) => s.where), ['nuworq operator --project site --has nuworq-infra', 'claude']);
    assert.ok(a.how.every((s) => s.do && s.check));
    assert.equal(stalled().length, 1, 'one per group');
  });

  test('an agent with the capability checking in, or the step claimed, clears it', () => {
    const { hub, stalled, tick } = setup();
    tick(5 * HOUR);
    assert.equal(stalled().length, 1);
    hub.agentOp('site', 'checkin', 'op', { has: ['operator', 'nuworq-infra'] });
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
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /a\.kind === 'unfit' && a\.operator\) acts = `<button class="btn ghost small" data-action="dismiss"/);
  });
});
