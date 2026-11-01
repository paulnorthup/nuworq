import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { Notifier, addChannel } from '../src/notify.js';

// Only real changes travel (#517): reads and lease renewals wake no browser, listener or notifier, and each
// change says which project and item it touched.
function setup() {
  let t = 1_000_000;
  const hub = new Hub({ clock: () => t });
  const changes = [];
  hub.on('change', (e) => changes.push(e));
  return { hub, changes, tick: (ms) => { t += ms; } };
}

describe('only real changes travel (#517)', () => {
  test('reads emit nothing: look, a peek, a heartbeat, a checkin of an agent already here', () => {
    const { hub, changes, tick } = setup();
    hub.agentOp('acme', 'checkin', 'claude-a');
    hub.agentOp('acme', 'propose', 'claude-a', { title: 'Export to CSV', acceptance: 'A CSV downloads.' });
    hub.agentOp('acme', 'next', 'claude-a');
    changes.length = 0;
    tick(MIN);
    hub.agentOp('acme', 'look', 'claude-a');
    hub.agentOp('acme', 'look', 'claude-a', { item: '#1' });
    hub.agentOp('acme', 'next', 'claude-a', { claim: false });
    hub.agentOp('acme', 'progress', 'claude-a', { item: '#1' });
    hub.agentOp('acme', 'checkin', 'claude-a');
    assert.deepEqual(changes, []);
  });

  test('a write names its project and item, and the counter goes up', () => {
    const { hub, changes } = setup();
    hub.agentOp('acme', 'checkin', 'claude-a');
    hub.agentOp('acme', 'propose', 'claude-a', { title: 'Export to CSV', acceptance: 'A CSV downloads.' });
    hub.agentOp('acme', 'next', 'claude-a');
    const before = hub.changeSeq;
    changes.length = 0;
    hub.agentOp('acme', 'progress', 'claude-a', { item: '#1', headline: 'Halfway there' });
    assert.equal(changes.length, 1);
    assert.deepEqual({ ...changes[0], at: undefined }, { project: 'acme', item: '#1', kind: 'progress', seq: before + 1, at: undefined });
    hub.agentOp('acme', 'progress', 'claude-a', { item: '#1', touching: ['src/csv.js'] });
    assert.equal(changes.at(-1).item, '#1', 'touching changed: a heartbeat that others see');
    const n = changes.length;
    hub.agentOp('acme', 'progress', 'claude-a', { item: '#1', touching: ['src/csv.js'] });
    assert.equal(changes.length, n, 'the same touching again: nothing');
  });

  test('presence that changes travels: a new agent, one back after a while, a tag gained', () => {
    const { hub, changes: all, tick } = setup();
    // Its going quiet and away while unseen are time changes (#530), counted in ago.test.js.
    const changes = { get length() { return all.filter((c) => c.kind !== 'time').length; } };
    hub.agentOp('acme', 'checkin', 'claude-a');
    assert.equal(changes.length, 1, 'a new agent');
    tick(31 * MIN);
    hub.agentOp('acme', 'look', 'claude-a');
    assert.equal(changes.length, 2, 'back after a while');
    hub.agentOp('acme', 'checkin', 'claude-a', { has: ['docker'] });
    assert.equal(changes.length, 3, 'a tag it did not have');
    hub.agentOp('acme', 'checkin', 'claude-a', { has: ['docker'] });
    assert.equal(changes.length, 3);
  });

  test('the Notifier works out only the project that changed, and nothing without a push channel', () => {
    const { hub } = setup();
    for (const slug of ['acme', 'beta', 'gamma']) hub.agentOp(slug, 'checkin', 'claude-a');
    const n = new Notifier(hub, { debounce: 1 });
    const looked = [];
    const current = n.current.bind(n);
    n.current = (only) => { looked.push(only ? [...only].sort() : 'all'); return current(only); };
    n.onChange({ project: 'beta' });
    n.onChange({ project: 'acme' });
    clearTimeout(n.scanTimer); n.scanTimer = null;
    n.scan(new Set(['beta']));
    assert.deepEqual(looked, [], 'no channel: nothing worked out');
    addChannel(hub.db, 'webhook', 'https://hooks.example.test/x');
    n.scan(new Set(['beta']));
    n.scan(new Set());
    assert.deepEqual(looked, [['beta']], 'one project, and nothing for no change');
    // What the debounced scan gets: the projects named since the last one; a change naming none means all.
    n.changedSlugs = new Set();
    n.onChange({ project: 'acme' }); n.onChange({ project: 'beta' });
    assert.deepEqual([...n.changedSlugs].sort(), ['acme', 'beta']);
    n.onChange({ project: null });
    assert.equal(n.changedSlugs, null);
    n.stop();
  });
});
