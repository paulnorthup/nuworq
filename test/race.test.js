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

describe('race review', () => {
  // Two attempts submitted on #1: a (claude), then c (gpt-5).
  function finished(opts) {
    const s = setup(opts);
    s.human('create', { title: 'Hard thing', acceptance: 'It works' });
    s.human('update', { item: '#1', race: 2 });
    const a = s.agent('a', 'claude');
    const c = s.agent('c', 'gpt-5');
    a('next'); c('next');
    s.clock.t += 10 * MIN;
    a('submit', { item: '#1', headline: 'A: small patch', evidence: ['npm test: 40 pass'] });
    s.clock.t += 5 * MIN;
    c('submit', { item: '#1', headline: 'C: rewrite', evidence: ['npm test: 41 pass'] });
    return { ...s, a, c };
  }

  test('the review card and item view show every attempt side by side', () => {
    const s = finished({ autonomy: 'balanced' });
    const card = view(s.hub, 'demo').attention.find((x) => x.kind === 'review');
    assert.deepEqual(card.attempts.map((x) => [x.n, x.agent, x.model, x.headline, x.took]), [[1, 'a', 'claude', 'A: small patch', '10m'], [2, 'c', 'gpt-5', 'C: rewrite', '15m']]);
    assert.deepEqual(card.attempts[1].evidence, [{ label: 'npm test: 41 pass' }]);
    assert.equal(itemView(s.hub, 'demo', '#1').submissions.length, 2);
  });

  test('keeping one marks the item done with that implementer, records the rest as not chosen, and names the branch', () => {
    const s = finished({ autonomy: 'balanced' });
    assert.throws(() => s.human('accept', { item: '#1' }), /say which one to keep/);
    assert.throws(() => s.human('accept', { item: '#1', attempt: 7 }), /No submitted attempt "7"/);
    const r = s.human('accept', { item: '#1', attempt: 'c' });
    assert.deepEqual([r.kept, r.merge], ['c', 'nuworq/c']);
    assert.equal(s.row(1).stage, 'done');
    assert.equal(s.row(1).implementer, 'c');
    assert.deepEqual(s.runs(1).map((x) => x.stage), ['not_chosen', 'chosen']);
    const events = s.hub.q(`SELECT type, headline, summary FROM events WHERE type IN ('not_chosen', 'accepted') ORDER BY id`).all();
    assert.match(events[0].headline, /a's attempt on #1 was not chosen/);
    assert.match(events[1].headline, /You accepted #1 \(c's attempt\)/);
    assert.match(events[1].summary, /Merge nuworq\/c/);
  });

  test('send all back returns it to ready and clears the attempts for a fresh race', () => {
    const s = finished({ autonomy: 'balanced' });
    s.human('sendback', { item: '#1', note: 'Neither handles the edge case' });
    assert.equal(s.row(1).stage, 'ready');
    assert.ok(s.runs(1).every((x) => x.closed === 1));
    assert.equal(s.hub.openSlots(s.row(1)), 2);
    assert.match(JSON.parse(s.row(1).handoff).headline, /edge case/);
  });

  test('a peer reviewer picks an attempt by number; racers cannot review; records count races won', () => {
    const s = finished();
    const r = s.agent('r', 'gemini');
    const next = r('next');
    assert.equal(next.mode, 'review');
    assert.equal(next.race.submissions.length, 2);
    assert.match(next.hint, /accept with attempt/);
    assert.throws(() => r('review', { item: '#1', verdict: 'accept', headline: 'x' }), /say which one to keep/);
    assert.throws(() => s.a('review', { item: '#1', verdict: 'accept', headline: 'x', attempt: 2 }), /can't review your own work/);
    const res = r('review', { item: '#1', verdict: 'accept', headline: 'A is smaller', attempt: '1' });
    assert.equal(res.kept, 'a');
    assert.equal(s.row(1).implementer, 'a');
    const rec = (name) => view(s.hub, 'demo').agents.find((x) => x.name === name).record;
    assert.deepEqual([rec('a').races, rec('a').races_won], [1, 1]);
    assert.deepEqual([rec('c').races, rec('c').races_won], [1, 0]);
    assert.equal(rec('a').landed, 1);
  });

  test('changing the race count while verifying leaves no stale attempts behind (#39)', () => {
    const s = finished({ autonomy: 'balanced' });
    s.human('update', { item: '#1', race: 1 });
    s.human('sendback', { item: '#1', note: 'Try again' });
    assert.ok(s.runs(1).every((x) => x.closed === 1));
    s.human('update', { item: '#1', race: 2 });
    assert.equal(s.hub.openSlots(s.row(1)), 2);
    s.agent('x', 'gemini')('claim', { item: '#1' });
    s.agent('y', 'qwen')('claim', { item: '#1' });
    assert.equal(s.runs(1).filter((x) => !x.closed).length, 2, 'two new agents each got a slot');
    // The old racers are free again: one can review the next round, the other could race it.
    s.agent('x', 'gemini')('submit', { item: '#1', headline: 'X' });
    s.agent('y', 'qwen')('submit', { item: '#1', headline: 'Y' });
    s.human('settings', { autonomy: 'full' });
    assert.equal(s.a('next').mode, 'review');
  });

  test('a race with a single submission is accepted without naming the attempt', () => {
    const s = setup({ autonomy: 'balanced' });
    s.human('create', { title: 'Hard thing', acceptance: 'It works' });
    s.human('update', { item: '#1', race: 2 });
    const a = s.agent('a', 'claude');
    s.agent('c', 'gpt-5')('next');
    a('next');
    s.agent('c', 'gpt-5')('handoff', { item: '#1', headline: 'gave up' });
    a('submit', { item: '#1', headline: 'done' });
    assert.equal(s.human('accept', { item: '#1' }).kept, 'a');
    assert.deepEqual(s.runs(1).map((x) => x.stage), ['abandoned', 'chosen']);
  });
});
