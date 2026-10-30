import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';

// A runner on duty (#185): its polls tell the hub a worker is coming, so Needs you doesn't ask for an agent.
describe('a project nuworq run staffs', () => {
  test('stays quiet while its runner polls, and says no agent is working once the runner stops', () => {
    const clock = { t: Date.UTC(2026, 9, 30, 9) };
    const hub = new Hub({ clock: () => clock.t });
    for (const s of ['staffed', 'unstaffed']) {
      hub.tx(() => hub.project(s, { create: true }));
      hub.humanOp(s, 'create', { title: 'Do it', acceptance: 'x' });
    }
    hub.humanOp('staffed', 'settings', { runner: true });
    const noAgents = (s) => view(hub, s).attention.filter((a) => a.kind === 'no-agents').map((a) => a.level);

    assert.deepEqual(noAgents('staffed'), ['act'], 'no runner has asked yet');
    hub.route('', { runner: true });
    assert.deepEqual(noAgents('staffed'), [], 'the runner asked: a worker is on its way');
    assert.deepEqual(noAgents('unstaffed'), ['act'], "a project the runner doesn't staff still asks");
    hub.route('');
    clock.t += 4 * MIN;
    assert.deepEqual(noAgents('staffed'), [], 'within a few polls');
    clock.t += 2 * MIN;
    assert.deepEqual(noAgents('staffed'), ['act'], 'the runner went quiet: the line is back');
    hub.route('', { runner: true });
    assert.deepEqual(noAgents('staffed'), [], 'and back on duty');
    hub.humanOp('staffed', 'settings', { runner: false });
    assert.deepEqual(noAgents('staffed'), ['act'], 'no longer staffed by run: its old poll means nothing');
  });
});
