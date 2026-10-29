import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LEASE_MS, MIN } from '../src/core.js';
import { view, itemView } from '../src/insight.js';

function setup({ autonomy = 'full' } = {}) {
  const clock = { t: Date.UTC(2026, 9, 1, 9) };
  const hub = new Hub({ clock: () => clock.t });
  hub.tx(() => hub.project('demo', { create: true }));
  const human = (action, args = {}) => hub.humanOp('demo', action, args);
  human('settings', { autonomy });
  const agent = (name, model = '') => {
    hub.agentOp('demo', 'checkin', name, { model });
    return (op, args = {}) => hub.agentOp('demo', op, name, args);
  };
  const row = (seq) => hub.q('SELECT * FROM items WHERE seq = ?').get(seq);
  const runs = (seq) => hub.q('SELECT a.* FROM attempts a JOIN items i ON i.id = a.item_id WHERE i.seq = ? ORDER BY a.id').all(seq);
  return { hub, clock, human, agent, row, runs };
}

// #1 is the race; #2 is ordinary work at the same priority.
function raced(s, race = 2) {
  s.human('create', { title: 'Hard thing', acceptance: 'It works' });
  s.human('create', { title: 'Other thing', acceptance: 'It works' });
  s.human('update', { item: '#1', race });
}

describe('races', () => {
  test('the human sets race on a ready item; refine accepts it too, within bounds', () => {
    const s = setup();
    raced(s);
    assert.equal(s.row(1).race, 2);
    const a = s.agent('a');
    assert.deepEqual(a('refine', { item: '#2', race: 3 }).changed, ['race → 3 agents']);
    assert.throws(() => a('refine', { item: '#2', race: 9 }), /race must be a whole number from 1 to 4/);
    assert.throws(() => a('refine', { item: '#2', race: 'x' }), /race must be/);
  });

  test('two agents claim it, a third gets other work; a slot goes to a different model first', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude-opus-5-5');
    const b = s.agent('b', 'claude-opus-5-5');
    const c = s.agent('c', 'gpt-5');
    const d = s.agent('d', 'qwen3-coder');
    assert.equal(a('next').item, '#1');
    assert.equal(s.row(1).stage, 'active');
    assert.equal(s.row(1).holder, null);
    // b runs the same model as a: it gets the other work first, though #1 comes first by seq.
    assert.equal(b('next', { claim: false }).item, '#2');
    assert.equal(c('next').item, '#1', 'a different model takes the second slot');
    assert.equal(d('next').item, '#2', 'the race is full: the next agent gets other work');
    assert.throws(() => b('claim', { item: '#1' }), /All 2 race slots on #1 are taken \(a, c\)/);
    assert.deepEqual(s.runs(1).map((r) => [r.agent, r.model, r.stage]), [['a', 'claude-opus-5-5', 'active'], ['c', 'gpt-5', 'active']]);
  });

  test('a same-model agent still gets the slot when nothing else is waiting', () => {
    const s = setup();
    s.human('create', { title: 'Hard thing', acceptance: 'It works', });
    s.human('update', { item: '#1', race: 2 });
    s.agent('a', 'claude-opus-5-5')('next');
    assert.equal(s.agent('b', 'claude-opus-5-5')('next').item, '#1');
  });

  test('each attempt has its own lease, progress and touching; a lapsed one frees only its slot', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('claim', { item: '#1', touching: ['src/a'] });
    c('claim', { item: '#1', touching: ['src/a/x'] });
    assert.match(c('progress', { item: '#1', headline: 'half way' }).heads_up, /a is also changing src\/a \(for #1\)/);
    assert.deepEqual(a('look', { item: '#1' }).touching, ['src/a']);
    assert.ok(a('checkin').others_working.some((o) => o.startsWith('c → #1')));
    s.clock.t += LEASE_MS - MIN;
    a('progress', { item: '#1' }); // heartbeat renews a's attempt only
    s.clock.t += 2 * MIN;
    s.hub.sweep();
    assert.deepEqual(s.runs(1).map((r) => r.stage), ['active', 'abandoned']);
    assert.equal(s.row(1).stage, 'active', 'the race goes on');
    assert.throws(() => c('submit', { item: '#1', headline: 'done' }), /no running attempt in the race/);
    // c's slot is open again, for someone new.
    assert.equal(s.agent('e', 'gemini')('next').item, '#1');
    assert.equal(s.runs(1).filter((r) => r.stage === 'active').length, 2);
  });

  test('the item goes to verifying once every attempt is submitted or abandoned, and racers cannot review it', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('next');
    c('next');
    assert.match(a('submit', { item: '#1', headline: 'Built it', evidence: ['npm test: ok'] }).hint, /goes to review when the other racers finish/);
    assert.equal(s.row(1).stage, 'active');
    assert.equal(a('next').item, '#2', 'a submitted; it does not get its own race back');
    c('handoff', { item: '#1', headline: 'Gave up' });
    assert.equal(s.row(1).stage, 'verifying');
    assert.equal(s.row(1).implementer, 'a');
    assert.throws(() => a('review', { item: '#1', verdict: 'accept', headline: 'x' }), /can't review your own work/);
    const r = s.agent('r', 'gemini');
    assert.equal(r('next').mode, 'review');
    r('review', { item: '#1', verdict: 'accept', headline: 'Good' });
    assert.equal(s.row(1).stage, 'done');
  });

  test('a racer who submitted is not offered the review', () => {
    const s = setup();
    s.human('create', { title: 'Hard thing', acceptance: 'It works' });
    s.human('update', { item: '#1', race: 2 });
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('next'); c('next');
    a('submit', { item: '#1', headline: 'A' });
    c('submit', { item: '#1', headline: 'C' });
    assert.equal(s.row(1).stage, 'verifying');
    assert.equal(a('next').mode, 'idle');
    assert.equal(c('next').mode, 'idle');
    assert.throws(() => a('review', { item: '#1', verdict: 'accept', headline: 'x' }), /can't review your own work/);
  });

  test('all attempts abandoned sends it back to ready, and a new round starts clean', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('next'); c('next');
    a('handoff', { item: '#1', headline: 'Stuck' });
    s.clock.t += LEASE_MS + MIN;
    s.hub.sweep();
    assert.equal(s.row(1).stage, 'ready');
    assert.ok(s.runs(1).every((r) => r.closed === 1));
    // Next round: both slots open again.
    s.agent('x', 'claude')('claim', { item: '#1' });
    s.agent('y', 'gpt-5')('claim', { item: '#1' });
    assert.equal(s.runs(1).filter((r) => !r.closed).length, 2);
  });

  test('a sent-back race opens a fresh round', () => {
    const s = setup({ autonomy: 'balanced' });
    s.human('create', { title: 'Hard thing', acceptance: 'It works' });
    s.human('update', { item: '#1', race: 2 });
    const a = s.agent('a', 'claude');
    a('next');
    a('submit', { item: '#1', headline: 'A' });
    assert.equal(s.row(1).stage, 'verifying', 'the only running attempt submitted: the race is over');
    s.human('sendback', { item: '#1', note: 'Not yet' });
    assert.equal(s.row(1).stage, 'ready');
    assert.equal(a('next').item, '#1', 'a may race again in the new round');
  });

  test('signoff hands off race attempts; steering on the item reaches every racer', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('next'); c('next');
    s.human('steer', { item: '#1', body: 'Keep it small' });
    assert.ok(a('progress', { item: '#1' }).steers.some((x) => x.about === '#1'));
    assert.ok(c('progress', { item: '#1' }).steers.some((x) => x.about === '#1'));
    assert.deepEqual(a('signoff', { headline: 'bye' }).handed_off, ['#1']);
    assert.equal(s.row(1).stage, 'active');
    assert.equal(s.runs(1).find((r) => r.agent === 'a').stage, 'abandoned');
  });

  test('race count cannot change mid-race; dropping it tells every racer', () => {
    const s = setup();
    raced(s);
    s.agent('a', 'claude')('next');
    s.agent('c', 'gpt-5')('next');
    assert.throws(() => s.human('update', { item: '#1', race: 1 }), /change its race count while it is ready/);
    s.human('update', { item: '#1', stage: 'dropped' });
    const p = s.hub.project('demo');
    for (const who of ['a', 'c']) assert.ok(s.hub.pendingSteers(p, who).some((x) => /#1 was dropped/.test(x.body)));
    assert.ok(s.runs(1).every((r) => r.closed === 1));
  });

  test('the views show each attempt, and route counts open slots', () => {
    const s = setup();
    raced(s, 3);
    assert.equal(s.hub.route()[0].slots, 3);
    s.agent('a', 'claude')('next');
    s.agent('c', 'gpt-5')('next');
    const v = view(s.hub, 'demo');
    assert.deepEqual(v.motion.map((m) => [m.item, m.agent, m.race]), [['#1', 'a', 3], ['#1', 'c', 3]]);
    assert.equal(v.pulse.working, 2);
    assert.deepEqual(itemView(s.hub, 'demo', '#1').racers.map((r) => r.agent), ['a', 'c']);
    s.agent('d', 'gemini')('claim', { item: '#2' }); // the race is the only open work now
    assert.equal(s.hub.route()[0].item, '#1');
    assert.equal(s.hub.route()[0].slots, 1);
  });

  test('a blocking question from one racer does not park the race', () => {
    const s = setup();
    raced(s);
    const a = s.agent('a', 'claude');
    s.agent('c', 'gpt-5')('next');
    a('next');
    a('ask', { item: '#1', question: 'Which way?', blocking: true });
    assert.equal(s.row(1).stage, 'active');
  });
});
