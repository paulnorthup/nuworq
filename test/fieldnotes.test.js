import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, DAY } from '../src/core.js';
import { guide } from '../src/protocol.js';
import { NOTES_SHOWN } from '../src/fieldnotes.js';

// A project with a milestone #1 and its parts #2 (exports), #3 (imports) and #4 (billing), 31 field notes about
// nothing in particular, and three that bear on #2.
function setup({ autonomy = 'full' } = {}) {
  let now = Date.UTC(2026, 9, 31, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true, name: 'App' }));
  const human = (op, args) => hub.humanOp('p', op, args);
  const agent = (op, name, args = {}) => hub.agentOp('p', op, name, args);
  human('settings', { autonomy });
  human('create', { title: 'Data moves in and out', acceptance: 'x' });
  human('create', { title: 'Exports retry when storage times out', acceptance: 'x', parent: '#1' });
  human('create', { title: 'Imports keep their order', acceptance: 'x', parent: '#1' });
  human('create', { title: 'Billing page shows the plan', acceptance: 'x', parent: '#1' });
  agent('checkin', 'a1');
  for (let i = 0; i < 30; i++) { now += 1000; agent('learn', 'a1', { note: `Unrelated lesson number ${i} about deploy scripts and dashboards.` }); }
  const ids = {};
  now += 1000; ids.item = agent('learn', 'a1', { note: 'Storage timeouts surface as ETIMEDOUT, never as a 504.', item: '#2' }).note;
  now += 1000; ids.sibling = agent('learn', 'a1', { note: 'Imports read the fixture in test/data.', item: '#3' }).note;
  now += 1000; ids.path = agent('learn', 'a1', { note: 'src/export.js streams rows; never buffer a whole table.' }).note;
  now += 1000; agent('learn', 'a1', { note: 'The newest lesson: dashboards cache for a minute.' }); // newest, but about nothing here
  const tick = (ms) => { now += ms; };
  const ofIds = (r) => (r.field_notes ?? []).map((n) => n.id);
  return { hub, human, agent, ids, tick, ofIds };
}

describe('field notes stay few and relevant (#443)', () => {
  test('checkin gives at most ten, the ones bearing on the held item first, and says how many it left out', () => {
    const { agent, ids, ofIds } = setup();
    const before = agent('checkin', 'a2');
    assert.equal(before.field_notes.length, NOTES_SHOWN);
    assert.match(before.field_notes_hidden, /^24 more.*notes: "all"/);

    agent('claim', 'a2', { item: '#2', touching: ['src/export.js'] });
    const r = agent('checkin', 'a2');
    assert.equal(r.field_notes.length, NOTES_SHOWN);
    assert.deepEqual(ofIds(r).slice(0, 3), [ids.item, ids.path, ids.sibling], 'its own item, then a path it touches, then a sibling\'s');
    assert.equal(r.field_notes[0].about, '#2');
  });

  test('next and claim carry the notes for the item they hand over; look lists every one on request', () => {
    const { agent, ids, ofIds } = setup();
    agent('checkin', 'a2');
    agent('checkin', 'a3');
    const r = agent('claim', 'a2', { item: '#3' });
    assert.equal(ofIds(r)[0], ids.sibling);
    assert.ok(ofIds(r).length <= NOTES_SHOWN);
    assert.equal(agent('look', 'a2').field_notes.length, NOTES_SHOWN);
    const all = agent('look', 'a2', { notes: 'all' });
    assert.equal(all.field_notes.length, 34);
    assert.equal(all.field_notes_hidden, undefined);
    const n = agent('next', 'a3');
    assert.equal(n.mode, 'work');
    assert.ok(n.field_notes.length <= NOTES_SHOWN, 'next hands the item with its notes');
  });

  test('with nothing to rank by, the newest; a person marks up to three always-show, and they come first', () => {
    const { hub, human, agent, ids, ofIds } = setup();
    const oldest = hub.q("SELECT id FROM notes WHERE kind = 'learning' ORDER BY id LIMIT 3").all().map((r) => r.id);
    for (const id of oldest) human('always', { note: id });
    assert.throws(() => human('always', { note: ids.item }), /At most 3 field notes are always shown/);
    const r = agent('look', 'a2');
    assert.deepEqual(ofIds(r).slice(0, 3).sort(), oldest.sort(), 'the oldest notes, ahead of every newer one');
    assert.ok(r.field_notes.slice(0, 3).every((n) => n.always));
    assert.equal(r.field_notes.length, NOTES_SHOWN);
    human('always', { note: oldest[0], on: false });
    human('always', { note: ids.item });
    assert.ok(agent('look', 'a2').field_notes.some((n) => n.id === ids.item && n.always));
    assert.match(hub.q("SELECT headline FROM events WHERE type = 'always' ORDER BY id DESC").get().headline, /always shows a field note: Storage timeouts/);
  });
});

describe('a tidy job reviews the field notes (#443)', () => {
  test('when an item lands, its notes come up in a review; retire and merge go on the record with their reasons', () => {
    const { hub, human, agent, ids } = setup();
    assert.equal(agent('next', 'a2', { claim: false }).mode, 'work', 'nothing landed yet: no review');
    human('update', { item: '#2', stage: 'done' });
    const r = agent('next', 'a2');
    assert.equal(r.mode, 'tidy');
    assert.equal(r.title, "Review App's field notes");
    assert.match(r.summary, new RegExp(`note ${ids.item} \\(about #2\\), #2 landed: Storage timeouts`));
    assert.doesNotMatch(r.summary, /Unrelated lesson/, 'only the landed item\'s notes');
    assert.match(r.hint, /retire \{ notes, reason \}/);
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM items WHERE tidy != '' AND notes_review = 0").get().n, 0, 'not a milestones tidy job');

    assert.throws(() => agent('retire', 'a2', { notes: [ids.item] }), /reason is required/);
    agent('retire', 'a2', { notes: [ids.item], reason: 'Now in src/export.js retry(), covered by test/export.test.js' });
    assert.equal(hub.q('SELECT active FROM notes WHERE id = ?').get(ids.item).active, 0);
    const merged = agent('learn', 'a2', { note: 'Export and import fixtures live in test/data; src/export.js streams rows.' }).note;
    agent('retire', 'a2', { notes: [ids.sibling, ids.path], into: merged, reason: 'Duplicates about where fixtures and streaming live' });
    const history = agent('look', 'a2', { item: r.item }).history.map((e) => `${e.headline} | ${e.summary ?? ''}`).join('\n');
    assert.match(history, new RegExp(`retired field note ${ids.item}: Storage timeouts.* \\| Why: Now in src/export.js retry\\(\\)`));
    assert.match(history, new RegExp(`merged field note ${ids.sibling} into note ${merged}`));

    human('unretire', { note: ids.item }); // a person can undo it
    assert.equal(hub.q('SELECT active FROM notes WHERE id = ?').get(ids.item).active, 1);

    assert.equal(agent('submit', 'a2', { item: r.item, headline: 'Retired 1, merged 2 into 1, kept the rest' }).ok, true);
    assert.equal(hub.q('SELECT stage FROM items WHERE seq = ?').get(Number(r.item.slice(1))).stage, 'done');
    assert.notEqual(agent('next', 'a2', { claim: false }).mode, 'tidy', 'reviewed: not raised again');
  });

  test('notes learned during a review aren\'t raised again when it finishes, only in the weekly review (#451)', () => {
    const { human, agent, tick } = setup();
    human('update', { item: '#2', stage: 'done' });
    const r = agent('next', 'a2');
    assert.equal(r.mode, 'tidy');
    const merged = agent('learn', 'a2', { note: 'Storage timeouts and retries: see src/export.js.', item: r.item }).note;
    agent('submit', 'a2', { item: r.item, headline: 'Merged 1, kept the rest' });
    assert.notEqual(agent('next', 'a2', { claim: false }).mode, 'tidy', 'no review of the note it just wrote');
    tick(8 * DAY);
    const weekly = agent('next', 'a2');
    assert.equal(weekly.mode, 'tidy');
    assert.match(weekly.summary, new RegExp(`- note ${merged} \\(about ${r.item}\\): Storage timeouts and retries`), 'the weekly review has it');
  });

  test('every week the rest is reviewed; below "Run with it" the agent asks instead of retiring', () => {
    const { human, agent, tick, ids } = setup({ autonomy: 'balanced' });
    assert.notEqual(agent('next', 'a2', { claim: false }).mode, 'tidy');
    tick(8 * DAY);
    const r = agent('next', 'a2');
    assert.equal(r.mode, 'tidy');
    assert.equal((r.summary.match(/^- note /gm) ?? []).length, 34, 'every note older than a day');
    assert.match(r.hint, /Don't retire anything yourself.*ask the person one question/);
    assert.throws(() => agent('retire', 'a2', { notes: [ids.item], reason: 'built in' }), /a person retires field notes/);
    agent('submit', 'a2', { item: r.item, headline: 'Asked about 2 notes; kept the rest' });
    tick(DAY);
    assert.notEqual(agent('next', 'a2', { claim: false }).mode, 'tidy', 'not again until next week');
    human('settings', { autonomy: 'full' });
  });

  test('a weekly review waiting behind other work keeps its notes until someone takes it', () => {
    const { hub, human, agent, tick } = setup();
    human('create', { title: 'Urgent fix', acceptance: 'x', priority: 'now' });
    human('create', { title: 'Another urgent fix', acceptance: 'x', priority: 'now' });
    tick(8 * DAY);
    const review = () => hub.q('SELECT stage, summary FROM items WHERE notes_review = 1').get();
    assert.equal(agent('next', 'a2').mode, 'work', 'urgent work comes first');
    assert.equal(review().stage, 'ready');
    agent('checkin', 'a3');
    assert.equal(agent('next', 'a3').mode, 'work');
    tick(DAY);
    agent('checkin', 'a4');
    agent('next', 'a4');
    assert.equal(review().stage, 'ready', 'the review is still there');
    assert.equal((review().summary.match(/^- note /gm) ?? []).length, 34, 'with every note it listed');
  });

  test('only a review retires notes', () => {
    const { agent, ids } = setup();
    agent('checkin', 'a2');
    assert.throws(() => agent('retire', 'a2', { notes: [ids.item], reason: 'x' }), /Only a field-notes review retires notes/);
  });

  test('the guide says how', () => {
    const g = guide();
    assert.match(g, /## Field notes\n/);
    assert.match(g, /at most ten field notes/);
    assert.match(g, /`retire`/);
  });
});
