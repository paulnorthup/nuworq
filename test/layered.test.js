import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, layered } from '../src/core.js';
import { view, itemView } from '../src/insight.js';
import { compose } from '../src/notify.js';

// #387: a question is shown whole; other long first lines are cut at a sentence, and the agent is told.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 31, 9) });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Turn on llm-proxy usage', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', { has: ['macos'] });
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  const lastEvent = (type) => hub.q('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type);
  return { hub, a: (op, args) => hub.agentOp('o', op, 'w1', args), lastEvent };
}

const QUESTION = "Can you turn on llm-proxy usage for the hub and for workers on your Mac? Two short steps; the second needs llm-proxy's owner token, which only you have, so I can't do it myself.";

describe('a question is shown whole', () => {
  test('a long question is stored, shown in Needs you, on the item and in the notification whole, and the hint asks for a shorter one', () => {
    const { hub, a } = setup();
    assert.ok(QUESTION.length > 140);
    const r = a('ask', { item: '#1', question: QUESTION, context: 'Steps below.', to: 'operator' });
    assert.match(r.hint, /Your question is stored whole \(\d+ characters\), but keep a question to one short sentence/);
    const row = hub.q('SELECT * FROM questions WHERE id = ?').get(r.question);
    assert.equal(row.question, QUESTION);
    assert.equal(row.context, 'Steps below.', 'nothing moved into the context');

    const q2 = a('ask', { item: '#1', question: QUESTION.replace('Mac?', 'Mac, please?'), assumption: '', blocking: true, steps: [{ do: 'Run it' }] });
    const card = view(hub, 'o').attention.find((x) => x.kind === 'question' && x.key === `q:${q2.question}`);
    assert.ok(card.headline.length > 140 && !card.headline.includes('…'), card.headline);
    assert.ok(itemView(hub, 'o', '#1').questions.some((x) => x.question === QUESTION));

    const msg = compose([{ project: 'o', name: 'o', entry: card }]);
    assert.ok(msg.text.includes(card.headline), msg.text);
  });

  test('a short question gets no extra hint', () => {
    const { a } = setup();
    const r = a('ask', { item: '#1', question: 'Which region?', to: 'operator' });
    assert.doesNotMatch(r.hint, /stored whole/);
  });
});

describe('other first lines are cut at a sentence', () => {
  test('a long progress headline ends after its last sentence that fits; the rest opens the summary without "…"', () => {
    const { a, lastEvent } = setup();
    const long = 'Retries now back off per upstream. The config lives in src/retry.js and defaults to three tries. Tests cover the 502 path, the timeout path and the reset path too.';
    assert.ok(long.length > 140);
    const r = a('progress', { item: '#1', headline: long, summary: 'Next: docs.' });
    const e = lastEvent('progress');
    assert.equal(e.headline, 'Retries now back off per upstream. The config lives in src/retry.js and defaults to three tries.');
    assert.equal(e.summary, 'Tests cover the 502 path, the timeout path and the reset path too.\n\nNext: docs.');
    assert.match(r.hint, /Your headline was over 140 characters: it now ends after the last sentence that fit/);
  });

  test('a single sentence over 140 is cut at a space with "…", and the hint says so', () => {
    const { a, lastEvent } = setup();
    const long = 'Refactored the retry module so that backoff is configurable per upstream, '.repeat(2) + 'and the tail end lives here';
    const r = a('progress', { item: '#1', headline: long });
    const e = lastEvent('progress');
    assert.ok(e.headline.length <= 141 && e.headline.endsWith('…'), e.headline);
    assert.match(e.summary, /^….*tail end lives here$/);
    assert.match(r.hint, /first sentence was over 140 characters: it was cut at a space with "…"/);
  });

  test('a short headline gets no hint; layered says what moved', () => {
    const { a } = setup();
    const r = a('progress', { item: '#1', headline: 'Retries back off. Tests pass.' });
    assert.ok(!r.hint || !/characters/.test(r.hint));
    assert.equal(layered('Short.').moved, '');
    assert.equal(layered('x'.repeat(50) + '. ' + 'y'.repeat(120)).moved, 'sentence');
    assert.equal(layered('x '.repeat(100)).moved, 'space');
    assert.equal(layered('Q? '.repeat(80), '', '', 'question', { whole: true }).headline, 'Q? '.repeat(80).trim());
  });
});
