import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub, MIN, HOUR } from '../src/core.js';
import { fromFile } from '../scripts/effective.js';

// #699: the effective audit's numbers, taken from a copy of a workspace's file, as aggregates only.
describe('scripts/effective.js', () => {
  test('counts what landed without a person, first-time accepts, bounces by kind and waits; never a word of the workspace', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nuworq-effective-')), 'ws.db');
    let t = Date.UTC(2026, 10, 2, 9);
    const hub = new Hub({ file, clock: () => t });
    hub.tx(() => hub.project('p', { create: true }));
    hub.humanOp('p', 'settings', { autonomy: 'full' }); // agents review each other
    const a = hub.humanOp('p', 'create', { title: 'SECRET-TITLE-A', acceptance: 'x' }).item;
    const b = hub.humanOp('p', 'create', { title: 'SECRET-TITLE-B', acceptance: 'x' }).item;
    // a: handed back once, then built and accepted by a peer: no person touched it.
    hub.agentOp('p', 'claim', 'secret-agent-1', { item: a });
    hub.agentOp('p', 'handoff', 'secret-agent-1', { item: a, headline: 'low on context' });
    t += 40 * MIN;
    hub.agentOp('p', 'claim', 'w2', { item: a });
    t += 10 * MIN;
    hub.agentOp('p', 'submit', 'w2', { item: a, headline: 'done', evidence: ['tests'] });
    hub.agentOp('p', 'claim', 'r1', { item: a });
    hub.agentOp('p', 'review', 'r1', { item: a, verdict: 'accept', headline: 'ok' });
    // b: a blocking question a person answers after 2 hours, then sent back by a peer once, then accepted.
    hub.agentOp('p', 'claim', 'w3', { item: b });
    const q = hub.agentOp('p', 'ask', 'w3', { item: b, question: 'Which ZZQ region?', blocking: true, to: 'human' }).question;
    t += 2 * HOUR;
    hub.humanOp('p', 'answer', { question: q, answer: 'SECRET-ANSWER' });
    hub.agentOp('p', 'claim', 'w3', { item: b });
    hub.agentOp('p', 'submit', 'w3', { item: b, headline: 'done', evidence: ['tests'] });
    hub.agentOp('p', 'claim', 'r1', { item: b });
    hub.agentOp('p', 'review', 'r1', { item: b, verdict: 'reject', headline: 'needs a test' });
    hub.agentOp('p', 'claim', 'w3', { item: b });
    hub.agentOp('p', 'submit', 'w3', { item: b, headline: 'done', evidence: ['tests'] });
    hub.agentOp('p', 'claim', 'r2', { item: b });
    hub.agentOp('p', 'review', 'r2', { item: b, verdict: 'accept', headline: 'ok' });
    hub.db.close(); // closing checkpoints the WAL into the file
    const before = readFileSync(file);

    const r = fromFile(file, 'p', 14, t + MIN);
    assert.deepEqual(r.finished, { total: 2, landed: 2, dropped: 0 });
    assert.deepEqual(r.without_a_person, { landed: 1, share: 0.5 }, 'a needed nobody; b needed an answer');
    assert.deepEqual(r.first_review_accepted, { landed: 1, share: 0.5 });
    assert.equal(r.bounces.sent_back, 1);
    assert.deepEqual(r.bounces.sent_back_by, { agent: 1 });
    assert.equal(Object.values(r.bounces.handed_back_from).reduce((s, n) => s + n, 0), 1, 'one hand-back (by stage once #734 records it)');
    assert.equal(r.people.blocking_questions, 1);
    assert.equal(r.people.answered_by_a_person, 1);
    assert.equal(r.people.answer_hours.median, 2);
    assert.ok(r.building_jobs.taken >= 4);
    const text = JSON.stringify(r);
    assert.doesNotMatch(text, /SECRET|secret-agent|ZZQ/, 'aggregates only: no titles, questions, answers or agent names');
    assert.ok(readFileSync(file).equals(before), "the hub's own file is never written");
  });
});
