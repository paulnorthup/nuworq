import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, LIMITS } from '../src/core.js';

// One agent can't flood a hub (#766): a write window per agent, and caps on what a project or hub holds.
function hub() {
  let t = Date.UTC(2026, 10, 2, 12);
  const h = new Hub({ clock: () => t });
  h.tick = (ms) => { t += ms; };
  h.agentOp('app', 'checkin', 'a1');
  h.agentOp('app', 'checkin', 'a2');
  return h;
}

function refused(fn, status, hint) {
  assert.throws(fn, (e) => {
    assert.equal(e.status, status);
    assert.match(e.hint, hint);
    return true;
  });
}

test("an agent's 61st write within a minute is refused with when to retry; reads, heartbeats and other agents go on", () => {
  const h = hub();
  const { item } = h.agentOp('app', 'propose', 'a1', { title: 'Something to do' });
  const writes = [
    () => h.agentOp('app', 'propose', 'a1', { title: 'Another thing' }),
    () => h.agentOp('app', 'ask', 'a1', { question: 'Which port?', assumption: 'Port 0' }),
    () => h.agentOp('app', 'comment', 'a1', { item, headline: 'A note on it' }),
    () => h.agentOp('app', 'learn', 'a1', { note: 'Tests run with node --test' }),
  ];
  for (let i = 1; i < 60; i++) writes[i % writes.length]();
  refused(() => h.agentOp('app', 'learn', 'a1', { note: 'One too many' }), 429, /Try again in \d+ seconds?/);
  refused(() => h.agentOp('app', 'ask', 'a1', { question: 'Still?', assumption: 'Yes' }), 429, /Try again/);
  // Reads aren't writes.
  assert.ok(h.agentOp('app', 'look', 'a1', {}).ok !== false);
  // Nor is a heartbeat: progress without a headline, on work it holds.
  h.agentOp('app', 'claim', 'a1', { item });
  h.agentOp('app', 'progress', 'a1', { item });
  refused(() => h.agentOp('app', 'progress', 'a1', { item, headline: 'Halfway' }), 429, /Try again/);
  // Another agent on the same project has its own window.
  assert.ok(h.agentOp('app', 'learn', 'a2', { note: 'Its own note' }).ok);
  // A minute after the first write, there is room again.
  h.tick(61_000);
  assert.ok(h.agentOp('app', 'progress', 'a1', { item, headline: 'Halfway' }).ok);
});

test('one token checking in under new names shares one write window: past 240 a minute it is refused (#831)', () => {
  const h = hub();
  const as = { identity: { id: 7 } };
  // Four names, 60 writes each: each name is under its own limit, the token reaches its own.
  for (let n = 0; n < 4; n++) {
    h.agentOp('app', 'checkin', `t${n}`, {}, as);
    for (let i = 0; i < 60; i++) h.agentOp('app', 'learn', `t${n}`, { note: `Note ${n}.${i}` }, as);
  }
  h.agentOp('app', 'checkin', 'fresh', {}, as);
  refused(() => h.agentOp('app', 'learn', 'fresh', { note: 'Under a new name' }, as), 429, /another name adds no room/);
  // On another project too: the window is the token's, not the project's.
  h.agentOp('other', 'checkin', 'fresh2', {}, as);
  refused(() => h.agentOp('other', 'learn', 'fresh2', { note: 'Elsewhere' }, as), 429, /Try again/);
  // Another token, and calls without one, have their own room.
  assert.ok(h.agentOp('app', 'learn', 'u1', { note: 'Its own token' }, { identity: { id: 8 } }).ok);
  assert.ok(h.agentOp('app', 'learn', 'a1', { note: 'No token' }).ok);
  h.tick(61_000);
  assert.ok(h.agentOp('app', 'learn', 'fresh', { note: 'A minute on' }, as).ok);
});

test('a token brings at most 100 new names an hour; names it has still work (#831)', () => {
  const h = hub();
  const as = { identity: { id: 7 } };
  for (let i = 0; i < 100; i++) h.agentOp(i % 2 ? 'app' : 'other', 'checkin', `n${i}`, {}, as);
  refused(() => h.agentOp('app', 'checkin', 'n100', {}, as), 429, /name this token already has/);
  assert.ok(!h.q(`SELECT 1 FROM agents WHERE name = 'n100'`).get(), 'the refused name is not recorded');
  assert.ok(h.agentOp('app', 'checkin', 'n1', {}, as).project);
  // A person's browser session and another token aren't counted against it.
  assert.ok(h.agentOp('app', 'checkin', 'm1', {}, { identity: { id: 8 } }).project);
  assert.ok(h.agentOp('app', 'look', 'm2', {}, { identity: { id: 7, session: 's1' } }));
  h.tick(61 * 60_000);
  assert.ok(h.agentOp('app', 'checkin', 'n100', {}, as).project);
});

test('a project takes at most 1,000 comments a day and holds at most 500 field notes (#831)', () => {
  const h = hub();
  const p = h.project('app');
  const now = h.now();
  for (let i = 0; i < LIMITS.commentsPerDay; i++) {
    h.q(`INSERT INTO events (project_id, actor, type, headline, at) VALUES (?, 'a2', 'comment', ?, ?)`).run(p.id, `C${i}`, now - i);
  }
  refused(() => h.agentOp('app', 'comment', 'a1', { headline: 'One more' }), 429, /progress instead/);
  h.tick(60 * 60_000); // the oldest fall out of the last day as it moves
  h.q(`UPDATE events SET at = at - ? WHERE project_id = ? AND headline = 'C0'`).run(24 * 60 * 60_000, p.id);
  assert.ok(h.agentOp('app', 'comment', 'a1', { headline: 'One more' }).ok);

  const active = () => h.q(`SELECT COUNT(*) AS n FROM notes WHERE project_id = ? AND kind = 'learning' AND active = 1`).get(p.id).n;
  for (let i = active(); i < LIMITS.fieldNotes; i++) {
    h.q(`INSERT INTO notes (project_id, kind, author, body, at) VALUES (?, 'learning', 'a2', ?, ?)`).run(p.id, `N${i}`, now);
  }
  refused(() => h.agentOp('app', 'learn', 'a1', { note: 'One too many' }), 429, /replaces/);
  refused(() => h.agentOp('app', 'learn', 'a1', { note: 'Replacing nothing', replaces: 999_999 }), 429, /replaces/);
  h.humanOp('app', 'settings', { autonomy: 'full' }); // where agents may replace notes
  const old = h.q(`SELECT id FROM notes WHERE project_id = ? AND kind = 'learning' AND active = 1 LIMIT 1`).get(p.id).id;
  assert.ok(h.agentOp('app', 'learn', 'a1', { note: 'Says it better', replaces: old }).ok);
  assert.equal(active(), LIMITS.fieldNotes);
});

test('a project holds at most 200 open questions and 500 proposed items', () => {
  const h = hub();
  const p = h.project('app');
  const now = h.now();
  for (let i = 0; i < LIMITS.openQuestions; i++) {
    h.q(`INSERT INTO questions (project_id, asked_by, question, at, blocking) VALUES (?, 'a2', ?, ?, 0)`).run(p.id, `Q${i}`, now);
  }
  refused(() => h.agentOp('app', 'ask', 'a1', { question: 'One more?', assumption: 'No' }), 429, /Withdraw/);
  h.q(`UPDATE questions SET status = 'withdrawn' WHERE project_id = ? AND question = 'Q0'`).run(p.id);
  assert.ok(h.agentOp('app', 'ask', 'a1', { question: 'One more?', assumption: 'No' }).ok);

  for (let i = 0; i < LIMITS.proposed; i++) {
    h.tick(1_100); // under the write window
    h.agentOp('app', 'propose', i % 2 ? 'a1' : 'a2', { title: `Idea ${i}` });
  }
  refused(() => h.agentOp('app', 'propose', 'a1', { title: 'Idea 501' }), 429, /refine them with acceptance criteria/);
});

test("a checkin creates a new project only below 100 on the hub; past that a person creates it", () => {
  const h = hub();
  for (let i = h.projects().length; i < LIMITS.projects; i++) h.project(`p${i}`, { create: true });
  refused(() => h.agentOp('one-too-many', 'checkin', 'a1'), 429, /\+ Project/);
  assert.equal(h.projects().length, LIMITS.projects);
  // Checking in to one that exists still works, and a person may create more.
  assert.ok(h.agentOp('app', 'checkin', 'a1').project);
  h.project('by-a-person', { create: true });
  assert.equal(h.projects().length, LIMITS.projects + 1);
});
