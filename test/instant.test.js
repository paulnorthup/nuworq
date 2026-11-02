import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Hub } from '../src/core.js';
import { view } from '../src/insight.js';
import { predict, placeholder } from '../web/instant.js';

// #393: a tap shows its result at once; the hub's answer then agrees with it, or the old view comes back.
function setup() {
  const hub = new Hub({ clock: () => Date.UTC(2026, 9, 31, 9) });
  hub.tx(() => hub.project('o', { create: true }));
  hub.humanOp('o', 'create', { title: 'Retries back off', acceptance: 'x' });
  hub.agentOp('o', 'checkin', 'w1', {});
  hub.agentOp('o', 'claim', 'w1', { item: '#1' });
  hub.agentOp('o', 'submit', 'w1', { item: '#1', headline: 'Done', evidence: [{ label: 'npm test' }] });
  return hub;
}

describe('an action shows its result at once', () => {
  test('autonomy: the prediction is what the hub then shows', () => {
    const hub = setup();
    const before = view(hub, 'o');
    const to = Object.keys(before.project.autonomy_options).find((k) => k !== before.project.autonomy);
    const guess = predict(before, 'settings', { autonomy: to });
    hub.humanOp('o', 'settings', { autonomy: to });
    const after = view(hub, 'o');
    assert.equal(guess.project.autonomy, after.project.autonomy);
    assert.equal(guess.project.autonomy_label, after.project.autonomy_label);
    assert.notEqual(before.project.autonomy, to, 'the view it came from is left as it was, to go back to');
  });

  test('accept: the review card goes, and the item leaves verifying; the hub agrees', () => {
    const hub = setup();
    const before = view(hub, 'o');
    assert.ok(before.attention.some((a) => a.kind === 'review' && a.item === '#1'));
    const guess = predict(before, 'accept', { item: '#1' });
    assert.ok(!guess.attention.some((a) => a.kind === 'review' && a.item === '#1'));
    assert.ok(!guess.verifying.some((i) => i.item === '#1'));
    assert.equal(guess.all.find((i) => i.item === '#1').stage, 'landing');
    hub.humanOp('o', 'accept', { item: '#1' });
    assert.ok(!view(hub, 'o').attention.some((a) => a.kind === 'review' && a.item === '#1'));
    assert.equal(predict(before, 'accept', { item: '#1', attempt: '2' }), null, 'which raced attempt lands is the hub\'s to say');
  });

  test('park, priority, mark seen and a sent message show at once', () => {
    const hub = setup();
    const v = view(hub, 'o');
    assert.equal(predict(v, 'settings', { parked: true }).project.parked, true);
    const pri = predict(v, 'update', { item: '#1', priority: 'now' });
    assert.ok([...pri.all, ...pri.verifying].filter((i) => i.item === '#1').every((i) => i.priority === 'now'));
    assert.equal(predict(v, 'update', { item: '#1', title: 'x' }), null, 'an edit whose result the hub shapes waits for it');
    const seen = predict(v, 'seen', {});
    assert.ok(seen.since.at && Object.values(seen.since.counts).every((n) => n === 0) && !seen.since.finished.length);
    const sent = predict(v, 'steer', { body: 'Use the staging VM' });
    assert.equal(sent.activity[0].actor, 'you');
    assert.match(sent.activity[0].headline, /Use the staging VM/);
    assert.equal(predict(v, 'decide', { body: 'Node 24' }).decisions[0].body, 'Node 24');
  });

  test('a step ticks and unticks on its card, on a project or the home', () => {
    const card = { kind: 'question', key: 'q:7', question: { id: 7 }, steps: [{ do: 'a' }, { do: 'b' }], ticked: [2] };
    for (const list of ['attention', 'needs']) {
      const v = { [list]: [card] };
      assert.deepEqual(predict(v, 'step', { question: 7, step: 1, done: true })[list][0].ticked, [1, 2]);
      assert.deepEqual(predict(v, 'step', { question: 7, step: 2, done: false })[list][0].ticked, []);
      assert.deepEqual(card.ticked, [2], 'the card shown before is untouched');
    }
    assert.equal(predict({ attention: [card] }, 'step', { question: 8, step: 1, done: true }), null);
  });

  test('answering, dismissing and unparking take their card away; unknown actions predict nothing', () => {
    const v = { attention: [{ key: 'q:3', question: { id: 3 } }, { key: 'k', kind: 'churn' }, { key: 'p', kind: 'kept-parked', item: '#4' }] };
    assert.deepEqual(predict(v, 'answer', { question: 3 }).attention.map((a) => a.key), ['k', 'p']);
    assert.deepEqual(predict(v, 'dismiss', { key: 'k' }).attention.map((a) => a.key), ['q:3', 'p']);
    assert.deepEqual(predict(v, 'unpark', { item: '#4' }).attention.map((a) => a.key), ['q:3', 'k']);
    assert.equal(predict(v, 'sendback', { item: '#4', note: 'x' }), null);
    assert.equal(predict(null, 'seen', {}), null);
  });
});

describe('controls and loading', () => {
  test('a placeholder holds the place quietly, with no "Loading…" text', () => {
    const html = placeholder(3);
    assert.match(html, /aria-busy="true"/);
    assert.equal((html.match(/ph-row/g) ?? []).length, 3);
    assert.doesNotMatch(html.replace(/aria-label="Loading"/, ''), /Loading/);
  });

  test('no page shows "Loading…" where content goes', () => {
    const web = new URL('../web/', import.meta.url);
    for (const f of readdirSync(web, { recursive: true }).filter((f) => /\.(js|html)$/.test(f))) {
      assert.doesNotMatch(readFileSync(new URL(f, web), 'utf8'), /Loading[^"]*…/, f);
    }
  });

  test('buttons have hover, pressed, focus-visible and disabled states, with no animation', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const state of ['.btn:hover', '.btn:active', '.btn.primary:active', '.btn.ghost:active', '.seg button:active', ':focus-visible', '.btn:disabled'])
      assert.ok(css.includes(state), state);
    assert.doesNotMatch(css, /transition:\s*(?!none)|@keyframes|animation:/);
  });
});
