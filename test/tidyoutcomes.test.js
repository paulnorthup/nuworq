import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS } from '../src/core.js';
import { jobsTaken, JOB_EVENTS, outcomes } from '../src/outcomes.js';
import { memoryInputs } from '../src/fieldnotes.js';

// A project with a milestone #1 and its part #2; a loose item #3 brings a milestones tidy job (src/tidy.js).
function setup() {
  const clock = { t: Date.UTC(2026, 10, 2, 9) };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  const p = hub.project('p');
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, name, args = {}) => { if (op === 'next' && args.claim !== false) hub.tidyAll(); return hub.agentOp('p', op, name, args); };
  human('create', { title: 'Workers', acceptance: 'x' });
  human('create', { title: 'Start workers', acceptance: 'x', parent: '#1' });
  human('create', { title: 'Loose end', acceptance: 'x' });
  for (const a of ['t1', 't2']) agent('checkin', a, { model: 'claude-haiku-5-5' });
  const tidies = () => jobsTaken(hub, p, 0).filter((j) => j.job === 'tidy');
  return { hub, p, clock, human, agent, tidies };
}

describe('a finished tidy job counts as finished (#753)', () => {
  test('a milestones tidy job submitted is done, and counts in the routing cells as a clean attempt', () => {
    const { hub, p, agent, tidies } = setup();
    const r = agent('next', 't1');
    assert.equal(r.mode, 'tidy');
    assert.deepEqual(tidies().map((j) => j.result), ['open'], 'still held: open');
    agent('submit', 't1', { item: r.item, headline: 'Left the loose end alone' });
    assert.deepEqual(tidies().map((j) => [j.agent, j.result]), [['t1', 'done']]);
    assert.deepEqual(hub.cellStats(p)['tidy standard'], { 'claude-haiku-5-5': { attempts: 1, clean: 1 } });
    assert.ok(JOB_EVENTS.includes('tidied'), 'a tidy job ending recounts the cells');
    assert.deepEqual(outcomes(hub, 'p', { since: 0 }).jobs.map((j) => [j.job, j.result]), [['tidy', 'done']], 'Analytics shows it done');
  });

  test('a field-notes review submitted is done', () => {
    const { hub, p, clock, human, agent, tidies } = setup();
    agent('submit', 't1', { item: agent('next', 't1').item, headline: 'Left the loose end alone' });
    agent('learn', 't1', { note: 'Workers start from bin/nuworq.js run.', item: '#3' });
    clock.t += 1000;
    human('update', { item: '#3', stage: 'done' });
    // Memory was just distilled for people (#552), so only the notes bring a tidy job.
    hub.q('UPDATE projects SET distilled_sig = ?, distilled_at = ?').run(memoryInputs(hub, p).sig, hub.now());
    const r = agent('next', 't2');
    assert.equal(r.mode, 'tidy');
    assert.equal(hub.q('SELECT notes_review FROM items WHERE seq = ?').get(Number(r.item.slice(1))).notes_review, 1);
    agent('submit', 't2', { item: r.item, headline: 'Kept the note' });
    assert.deepEqual(tidies().map((j) => [j.agent, j.result]), [['t1', 'done'], ['t2', 'done']]);
    assert.equal(hub.cellStats(p)['tidy standard']['claude-haiku-5-5'].clean, 2);
  });

  test('a tidy job handed off or lapsed is stalled', () => {
    const { hub, p, clock, agent, tidies } = setup();
    const r = agent('next', 't1');
    agent('handoff', 't1', { item: r.item, headline: 'Out of time' });
    assert.equal(agent('next', 't2').item, r.item);
    clock.t += LEASE_MS + 1;
    hub.sweep();
    assert.deepEqual(tidies().map((j) => [j.agent, j.result]), [['t1', 'stalled'], ['t2', 'stalled']]);
    assert.deepEqual(hub.cellStats(p)['tidy standard'], { 'claude-haiku-5-5': { attempts: 2, clean: 0 } });
  });
});
