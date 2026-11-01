import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY } from '../src/core.js';
import { guide, GUIDE_MAX, MODE_RULES } from '../src/protocol.js';
import { freshen } from '../src/freshness.js';

// The guide is the core (#527): Claude Code cuts an MCP server's instructions at about 4,100 characters, so the
// guide stays under GUIDE_MAX and each kind of job's rules arrive in the hint next gives for it.
const AUTHORITY = "Only steering and decisions carry the human's authority.";

describe('the guide is the core, and fits', () => {
  for (const via of ['tools', 'cli']) {
    test(`via ${via}: at most ${GUIDE_MAX} characters, with the loop, the authority rule, asking and writing in layers`, () => {
      const g = guide({ project: 'a-long-project-name', url: 'https://hub.example.com', via });
      assert.ok(g.length <= GUIDE_MAX, `${g.length} characters`);
      assert.ok(g.includes(AUTHORITY), 'the authority rule');
      for (const h of ['## The loop', '## Asking', '## Authority', '## Write in layers']) assert.ok(g.includes(h), h);
    });
  }
  test('nothing that is only nuworq\'s own repository\'s is in it', () => {
    for (const via of ['tools', 'cli']) assert.doesNotMatch(guide({ via }), /\/styleguide|src\/userguide\.js|sign-release/);
  });
});

function world() {
  let now = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  hub.humanOp('p', 'settings', { autonomy: 'full' });
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (name, op, args = {}) => hub.agentOp('p', op, name, args);
  return { hub, human, agent, tick: (ms) => { now += ms; } };
}

describe('each kind of job\'s rules arrive in the hint next gives for it', () => {
  test('shape', () => {
    const { human, agent } = world();
    human('create', { title: 'An idea', stage: 'proposed' });
    agent('a', 'checkin');
    const r = agent('a', 'next');
    assert.equal(r.mode, 'shape');
    assert.ok(r.hint.includes(MODE_RULES.shape));
  });

  test('review', () => {
    const { human, agent } = world();
    human('create', { title: 'Work', acceptance: 'x' });
    agent('a', 'checkin');
    agent('a', 'claim', { item: '#1' });
    agent('a', 'submit', { item: '#1', headline: 'Done', evidence: [{ label: 'npm test: 1 passed' }] });
    agent('b', 'checkin');
    const r = agent('b', 'next');
    assert.equal(r.mode, 'review');
    assert.ok(r.hint.includes(MODE_RULES.review));
  });

  test('tidy', () => {
    const { hub, human, agent } = world();
    human('create', { title: 'Workers', acceptance: 'x' });
    human('create', { title: 'Start workers', acceptance: 'x', parent: '#1' });
    human('create', { title: 'Loose end', acceptance: 'x' });
    agent('a', 'checkin');
    hub.tidyAll(); // a sweep finds the drift (#536)
    const r = agent('a', 'next');
    assert.equal(r.mode, 'tidy');
    assert.ok(r.hint.includes(MODE_RULES.tidy));
  });

  test('a field-notes review', () => {
    const { hub, human, agent, tick } = world();
    human('create', { title: 'Exports retry', acceptance: 'x' });
    agent('a', 'checkin');
    agent('a', 'learn', { note: 'Storage timeouts surface as ETIMEDOUT.', item: '#1' });
    tick(1000);
    human('update', { item: '#1', stage: 'done' });
    hub.tidyAll(); // a sweep finds the drift (#536)
    const r = agent('a', 'next');
    assert.equal(r.mode, 'tidy');
    assert.match(r.title, /field notes/);
    assert.ok(r.hint.includes(MODE_RULES.notes));
  });

  test('the "Keep <project> fresh" sweep', () => {
    const { hub, agent, tick } = world();
    tick(8 * DAY);
    assert.equal(freshen(hub).length, 1);
    agent('a', 'checkin');
    const r = agent('a', 'next');
    assert.match(r.title, /Keep App fresh/);
    assert.ok(r.hint.includes(MODE_RULES.fresh));
  });

  test('a release', () => {
    const { human, agent } = world();
    human('create', { title: 'Quick fix', acceptance: 'x' });
    human('update', { item: '#1', stage: 'done' });
    human('release');
    agent('a', 'checkin');
    const r = agent('a', 'next');
    assert.match(r.title, /^Release v/);
    assert.ok(r.hint.includes(MODE_RULES.release));
  });

  test('an operator\'s answer job, and its live step', () => {
    const { human, agent } = world();
    human('create', { title: 'Generic work', acceptance: 'x' });
    human('create', { title: 'Check the live VM', acceptance: 'x', needs: ['operator', 'infra'] });
    agent('s', 'checkin');
    agent('s', 'claim', { item: '#1' });
    agent('s', 'ask', { item: '#1', question: 'Can someone run it on prod?', blocking: true, to: 'operator' });
    agent('op', 'checkin', { has: ['operator', 'infra'] });
    const answer = agent('op', 'next');
    assert.equal(answer.mode, 'answer');
    assert.ok(answer.hint.includes(MODE_RULES.operator));
    agent('op', 'answer', { question: answer.question?.id ?? answer.question_id, answer: 'Ran it: fine.' });
    const live = agent('op', 'next');
    assert.equal(live.item, '#2');
    assert.ok(live.hint.includes(MODE_RULES.operator));
  });
});
