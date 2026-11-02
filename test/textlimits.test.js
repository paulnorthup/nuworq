// Agents' long text has limits (#765): past one, the write is refused with a hint naming the limit, never cut
// silently. Before, 20 comments of 900 KB each were taken, and the project view grew from 6 KB to 18 MB.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';

// The limits, as docs/API.md lists them (src/core.js LIMITS).
const LIMITS = {
  summary: 4_000, detail: 32_000, acceptance: 4_000, context: 2_000, assumption: 2_000, step: 500, option: 200,
  evidence: 20, evidence_label: 300, evidence_url: 2_000, depends_on: 30,
};

function setup() {
  const hub = new Hub();
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'create', { title: 'Build it', acceptance: 'it is built' }); // #1
  hub.humanOp('demo', 'create', { title: 'Shape it' }); // #2, proposed
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  op('a1', 'checkin');
  op('a1', 'claim', { item: '#1' });
  return { hub, op };
}
const over = (n) => 'x'.repeat(n + 1);
const refused = (fn, re) => assert.throws(fn, (e) => re.test(e.message) && /repository/.test(e.hint ?? ''), `refused: ${re}`);

describe("agents' long text fields have limits (#765)", () => {
  test('a summary over 4,000 and a detail over 32,000 are refused on comment, progress, submit, propose, refine and ask', () => {
    const { hub, op } = setup();
    const summary = over(LIMITS.summary), detail = over(LIMITS.detail);
    const s = /summary is 4,001 characters, over the 4,000 limit/, d = /detail is 32,001 characters, over the 32,000 limit/;
    refused(() => op('a1', 'comment', { item: '#1', headline: 'x', summary }), s);
    refused(() => op('a1', 'comment', { item: '#1', headline: 'x', detail }), d);
    refused(() => op('a1', 'progress', { item: '#1', headline: 'x', summary }), s);
    refused(() => op('a1', 'submit', { item: '#1', headline: 'Built', detail }), d);
    refused(() => op('a1', 'propose', { title: 'More', summary }), s);
    refused(() => op('a1', 'refine', { item: '#2', summary }), s);
    refused(() => op('a1', 'refine', { item: '#2', detail }), d);
    refused(() => op('a1', 'ask', { item: '#1', question: 'Which?', context: over(LIMITS.context), assumption: 'this one' }), /context is 2,001 characters, over the 2,000 limit/);
    refused(() => op('a1', 'ask', { item: '#1', question: 'Which?', detail, assumption: 'this one' }), d);
    // At the limit, each is taken whole.
    op('a1', 'comment', { item: '#1', headline: 'x', summary: 'y'.repeat(LIMITS.summary), detail: 'z'.repeat(LIMITS.detail) });
    const e = hub.q("SELECT summary, detail FROM events WHERE type = 'comment' ORDER BY id DESC LIMIT 1").get();
    assert.equal(e.summary.length, LIMITS.summary);
    assert.equal(e.detail.length, LIMITS.detail);
    // Nothing refused reached the record.
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM events WHERE type IN ('comment', 'progress', 'submitted') AND length(summary) > 4000").get().n, 0);
  });

  test('acceptance 4,000, assumption 2,000, step fields 500, options 200: each refused with a hint, never cut', () => {
    const { op } = setup();
    refused(() => op('a1', 'propose', { title: 'More', acceptance: over(LIMITS.acceptance) }), /acceptance is 4,001 characters, over the 4,000 limit/);
    refused(() => op('a1', 'refine', { item: '#2', acceptance: over(LIMITS.acceptance) }), /acceptance is 4,001/);
    refused(() => op('a1', 'ask', { item: '#1', question: 'Which?', assumption: over(LIMITS.assumption) }), /assumption is 2,001 characters, over the 2,000 limit/);
    assert.throws(() => op('a1', 'ask', { item: '#1', question: 'Add the key?', assumption: 'later', steps: [{ do: 'Open settings' }, { do: 'Add it', where: over(LIMITS.step) }] }),
      /step 2's where is 501 characters, over the 500 limit/);
    assert.throws(() => op('a1', 'ask', { item: '#1', question: 'Which?', assumption: 'A', options: ['A', over(LIMITS.option)] }), /option 2 is 201 characters, over the 200 limit/);
    // Within them, as before.
    const ok = op('a1', 'ask', { item: '#1', question: 'Which?', assumption: 'A', options: ['A', 'B'.repeat(LIMITS.option)] });
    assert.ok(ok.question);
  });

  test('evidence at most 20 entries (label 300, url 2,000), depends_on at most 30', () => {
    const { op } = setup();
    const many = Array.from({ length: LIMITS.evidence + 1 }, (_, i) => `check ${i}`);
    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Built', evidence: many }), /At most 20 pieces of evidence, not 21/);
    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Built', evidence: [{ label: over(LIMITS.evidence_label) }] }), /an evidence label is 301 characters, over the 300 limit/);
    assert.throws(() => op('a1', 'submit', { item: '#1', headline: 'Built', evidence: [{ label: 'run', url: `https://e.test/${over(LIMITS.evidence_url)}` }] }), /an evidence url is 2,016 characters, over the 2,000 limit/);
    const refs = Array.from({ length: LIMITS.depends_on + 1 }, () => '#1');
    assert.throws(() => op('a1', 'refine', { item: '#2', depends_on: refs }), /At most 30 dependencies, not 31/);
    assert.equal(op('a1', 'submit', { item: '#1', headline: 'Built', evidence: many.slice(0, 20) }).ok, true, '20 is fine');
  });

  test("the project view can't be blown up by one agent's comments any more", () => {
    const { hub, op } = setup();
    for (let i = 0; i < 20; i++) assert.throws(() => op('a1', 'comment', { item: '#1', headline: `c${i}`, summary: 'a'.repeat(900_000) }), /over the 4,000 limit/);
    assert.ok(JSON.stringify(view(hub, 'demo')).length < 100_000, 'still small');
  });
});
