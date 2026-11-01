import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, DAY, HOUR } from '../src/core.js';
import { view } from '../src/insight.js';
import { drift } from '../src/tidy.js';
import { boardWork } from '../web/oldwork.js';

// A project whose clock we move: #1 "Workers" with its parts #2 and #3, and a loose #4.
function setup() {
  let now = Date.UTC(2026, 9, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  const human = (op, args) => hub.humanOp('p', op, args);
  // The sweep turns drift into a tidy job (#536): here it runs before each claiming next, as if one had just passed.
  const agent = (op, name, args = {}) => { if (op === 'next' && args.claim !== false) hub.tidyAll(); return hub.agentOp('p', op, name, args); };
  human('create', { title: 'Workers', acceptance: 'x' });
  human('create', { title: 'Start workers', acceptance: 'x', parent: '#1' });
  human('create', { title: 'Stop workers', acceptance: 'x', parent: '#1' });
  human('create', { title: 'Loose end', acceptance: 'x' });
  const later = (ms) => { now += ms; };
  const stale = () => drift(hub, hub.project('p')).filter((d) => d.kind === 'stale');
  return { hub, human, agent, later, stale };
}

// #442: old work leaves the board; search, the launcher, analytics and history keep it.
describe('old work leaves the board (#442)', () => {
  test('done work shows in Recently finished for 3 days, then only off the board', () => {
    const { hub, human, later } = setup();
    human('update', { item: '#4', stage: 'done' });
    let v = view(hub, 'p');
    assert.deepEqual(v.done.map((i) => i.item), ['#4']);
    assert.equal(v.all.find((i) => i.item === '#4').old, undefined);
    assert.deepEqual(boardWork(v.all).rows.map((i) => i.item), ['#1', '#2', '#3', '#4']);
    later(3 * DAY - HOUR);
    assert.deepEqual(view(hub, 'p').done.map((i) => i.item), ['#4'], 'still there just inside 3 days');
    later(HOUR);
    v = view(hub, 'p');
    assert.deepEqual(v.done, []);
    assert.equal(v.all.find((i) => i.item === '#4').old, true, 'search and history still have it');
    const b = boardWork(v.all);
    assert.deepEqual(b.rows.map((i) => i.item), ['#1', '#2', '#3']);
    assert.equal(b.old, 1);
  });

  test('dropped work leaves the board at once, and comes back only behind Show dropped', () => {
    const { hub, human } = setup();
    human('update', { item: '#3', stage: 'dropped' });
    const v = view(hub, 'p');
    const b = boardWork(v.all);
    assert.deepEqual(b.rows.map((i) => i.item), ['#1', '#2', '#4']);
    assert.deepEqual(b.dropped.map((i) => i.item), ['#3']);
    assert.ok(v.all.some((i) => i.item === '#3'), 'still on record');
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /const stages = f\.stages\.filter\(\(s\) => s\.stage !== 'dropped'\);/, "Flow has no dropped pill");
    const all = app.slice(app.indexOf('function allWork('), app.indexOf('\n}\n', app.indexOf('function allWork(')));
    assert.match(all, /data-key="all:dropped"/);
    assert.match(all, /Show dropped \(\$\{dropped\.length\}\)/);
    assert.match(app, /all: z\(\) >= 2 \? allWork\(v\) : ''/, 'All work, and so Show dropped, is at 30m');
  });

  test('a finished milestone folds to one line carrying its parts, which get no lines of their own', () => {
    const { hub, human, later } = setup();
    human('update', { item: '#2', stage: 'done' });
    human('update', { item: '#3', stage: 'dropped' });
    later(HOUR);
    human('update', { item: '#4', stage: 'done' });
    later(HOUR);
    human('update', { item: '#1', stage: 'done' });
    const done = view(hub, 'p').done;
    assert.deepEqual(done.map((i) => i.item), ['#1', '#4']);
    assert.deepEqual(done[0].parts, [{ item: '#2', title: 'Start workers', stage: 'done' }], 'the dropped part is not among them');
    assert.equal(done[1].parts, undefined);
    later(2 * HOUR);
    assert.equal(view(hub, 'p').done[0].ago, '2h', 'it says when it finished');
  });

  test('a ready item untouched for 21 days gets a tidy job; touching it starts the 21 days again', () => {
    const { hub, human, agent, later, stale } = setup();
    later(21 * DAY - HOUR);
    assert.deepEqual(stale(), []);
    human('update', { item: '#4', priority: 'later' }); // a person's touch on #4
    later(HOUR);
    assert.deepEqual(stale().map((d) => d.text.match(/^#\d+/)[0]), ['#1', '#2', '#3']);
    assert.match(stale()[2].text, /#3 "Stop workers" has been ready 21 days and nobody has touched it: recommend keeping, refining or dropping it, with a reason\. To drop it, ask the person \(on #3\); refine drop needs their answer\./);
    agent('checkin', 'w1');
    agent('comment', 'w1', { item: '#3', headline: 'Still wanted: workers must stop cleanly' });
    assert.deepEqual(stale().map((d) => d.text.match(/^#\d+/)[0]), ['#1', '#2']);
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    assert.match(r.summary, /#2 "Start workers" has been ready 21 days/);
    assert.match(r.done_means, /recommendation \(keep, refine or drop\)/);
    // Asking the person whether to drop #2 parks it on them: no longer ready, so no longer stale. Their answer
    // ("keep it") puts it back as ready, and the 21 days start again.
    agent('ask', 'w1', { item: '#2', question: 'Drop #2? Nobody has picked it up in 21 days.' });
    assert.equal(hub.item(hub.project('p'), '#2').stage, 'waiting');
    assert.ok(!stale().some((d) => d.text.startsWith('#2 ')));
    human('answer', { question: hub.q("SELECT id FROM questions WHERE status = 'open'").get().id, answer: 'Keep it' });
    assert.equal(hub.item(hub.project('p'), '#2').stage, 'ready');
    assert.ok(!stale().some((d) => d.text.startsWith('#2 ')));
    assert.ok(!stale().some((d) => d.text.startsWith('#4 ')));
    later(21 * DAY - HOUR);
    assert.ok(stale().some((d) => d.text.startsWith('#4 ')), '#4 goes stale 21 days after its own touch');
  });

  test('a stale item handled by a finished tidy job is not raised again until it changes', () => {
    const { hub, agent, later } = setup();
    later(22 * DAY);
    agent('checkin', 'w1');
    const r = agent('next', 'w1');
    assert.equal(r.mode, 'tidy');
    agent('submit', 'w1', { item: r.item, headline: 'Recommended keeping all four; asked about none' });
    assert.equal(hub.q("SELECT stage FROM items WHERE tidy != ''").get().stage, 'done');
    assert.notEqual(agent('next', 'w1', { claim: false }).mode, 'tidy', 'left alone on purpose: not raised again');
    later(30 * DAY);
    assert.notEqual(agent('next', 'w1', { claim: false }).mode, 'tidy', 'still untouched, so still the same drift');
  });

  test('the tidy hint tells the agent how to handle a stale item (#527)', async () => {
    const { MODE_RULES } = await import('../src/protocol.js');
    assert.match(MODE_RULES.tidy, /ready items untouched for 21 days/);
    assert.match(MODE_RULES.tidy, /A stale ready item: recommend keeping, refining or dropping it, with a reason/);
  });
});
