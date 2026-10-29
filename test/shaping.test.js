import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS, MIN } from '../src/core.js';
import { view } from '../src/insight.js';

function setup(start = Date.UTC(2026, 9, 1, 9)) {
  const clock = { t: start };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('demo', { create: true }));
  const agent = (name) => (op, args = {}) => hub.agentOp('demo', op, name, args);
  const human = (action, args = {}) => hub.humanOp('demo', action, args);
  const row = (seq) => hub.q('SELECT * FROM items WHERE seq = ?').get(seq);
  const idea = (title) => human('create', { title, stage: 'proposed' }).item;
  return { hub, clock, agent, human, row, idea, v: () => view(hub, 'demo') };
}

describe('forward progress', () => {
  test('ideas with nothing moving are not silent: the pulse says stalled and asks what matters most', () => {
    const { idea, v } = setup();
    idea('Runner');
    idea('Git awareness');
    const s = v();
    assert.equal(s.pulse.state, 'needs-you');
    assert.match(s.pulse.sentence, /Nothing is moving: 2 ideas waiting to be shaped/);
    const card = s.attention.find((a) => a.kind === 'direction');
    assert.equal(card.level, 'act');
    assert.deepEqual(card.picks.map((p) => p.item), ['#1', '#2']);
  });

  test('picking one replaces the question with a prompt to start an agent', () => {
    const { idea, human, row, v } = setup();
    idea('Runner');
    idea('Git awareness');
    human('pick', { item: '#2' });
    assert.equal(row(2).priority, 'now');
    const s = v();
    assert.ok(!s.attention.some((a) => a.kind === 'direction'));
    const nobody = s.attention.find((a) => a.kind === 'no-agents');
    assert.equal(nobody.level, 'act');
    assert.equal(s.pulse.state, 'needs-you');
  });

  test('parking makes the silence intended: no cards, and agents start nothing', () => {
    const { idea, human, agent, v } = setup();
    idea('Runner');
    human('settings', { parked: true });
    const s = v();
    assert.equal(s.pulse.state, 'parked');
    assert.equal(s.attention.filter((a) => a.level === 'act').length, 0);
    const a = agent('claude-1');
    a('checkin');
    assert.equal(a('next').mode, 'idle');
    assert.throws(() => a('claim', { item: '#1' }), /parked/);
    human('settings', { parked: false });
    assert.equal(a('next').mode, 'shape');
  });

  test('next hands out the picked proposal to shape; submit makes it ready; the shaper then gets to build it', () => {
    const { idea, human, agent, row } = setup();
    idea('Runner');
    idea('Git awareness');
    human('pick', { item: '#2' });
    const a = agent('claude-1');
    a('checkin');
    const job = a('next');
    assert.equal(job.mode, 'shape');
    assert.equal(job.item, '#2');
    assert.match(job.hint, /shaping #2, not building it/);
    assert.equal(row(2).holder, 'claude-1');
    assert.equal(row(2).stage, 'proposed');
    assert.equal(a('next').mode, 'holding');

    assert.throws(() => a('submit', { item: '#2', headline: 'Shaped' }), /no acceptance criteria/);
    a('refine', { item: '#2', acceptance: 'Commits referencing #N link to the item' });
    assert.equal(row(2).stage, 'proposed', 'refine by the shaper does not promote; submit does');
    const r = a('submit', { item: '#2', headline: 'Scoped to commit trailers' });
    assert.equal(r.stage, 'ready');
    assert.equal(row(2).holder, null);

    const build = a('next');
    assert.equal(build.mode, 'work');
    assert.equal(build.item, '#2');
  });

  test('ready work beats shaping at equal priority; a picked idea beats ordinary ready work', () => {
    const { idea, human, agent } = setup();
    idea('An idea');
    human('create', { title: 'Ready work', acceptance: 'x' });
    const a = agent('a');
    assert.equal(a('next', { claim: false }).item, '#2');
    human('pick', { item: '#1' });
    assert.equal(a('next', { claim: false }).item, '#1');
  });

  test('splitting: children make the parent wait until they are done', () => {
    const { idea, agent, human, row } = setup();
    idea('Big idea');
    const a = agent('a');
    a('next');
    a('propose', { title: 'Part one', parent: '#1', acceptance: 'one' });
    a('propose', { title: 'Part two', parent: '#1', acceptance: 'two' });
    const r = a('submit', { item: '#1', headline: 'Split in two' });
    assert.equal(r.stage, 'ready');
    assert.match(row(1).acceptance, /sub-items/);
    const next = a('next', { claim: false });
    assert.equal(next.item, '#2', 'the parent is skipped while its children are open');
    for (const seq of [2, 3]) {
      a('claim', { item: `#${seq}` });
      a('submit', { item: `#${seq}`, headline: 'done' });
      human('accept', { item: `#${seq}` });
    }
    assert.equal(a('next', { claim: false }).item, '#1');
  });

  test('under "check with me", shaping ends at the human: only shaped proposals reach them', () => {
    const { idea, human, agent, row, v } = setup();
    human('settings', { autonomy: 'ask' });
    idea('Runner');
    assert.ok(!v().attention.some((a) => a.kind === 'proposal'), 'a raw idea is not an approval card');
    const a = agent('a');
    a('checkin');
    a('next');
    a('submit', { item: '#1', headline: 'Scoped', acceptance: 'Starts workers when work is waiting' });
    assert.equal(row(1).stage, 'proposed');
    const card = v().attention.find((x) => x.kind === 'proposal');
    assert.equal(card.level, 'act');
    assert.match(card.acceptance, /Starts workers/);
    assert.equal(a('next').mode, 'idle', 'a shaped proposal is not handed out again');
  });

  test('a shaper that goes quiet frees the proposal for someone else', () => {
    const { idea, agent, clock, hub, row } = setup();
    idea('Runner');
    agent('a')('next');
    clock.t += LEASE_MS + MIN;
    hub.sweep();
    assert.equal(row(1).holder, null);
    assert.equal(row(1).stage, 'proposed');
    assert.equal(agent('b')('next').mode, 'shape');
  });
});
