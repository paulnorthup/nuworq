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
