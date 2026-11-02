// A card's written text can't forge or break its times (#781). Titles, questions and headlines sit in the same
// sentence as the hub's times (#689), and agents and outsiders write them: marker characters in them stay plain text,
// timed() never throws, and one card that fails to render is left out while the rest draws.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { timed } from '../web/ago.js';

globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FORGED = 'Fix \u00011\u00029m\u0003 and \u00009\u0000 now';

function world() {
  let now = Date.UTC(2026, 10, 1, 9);
  const hub = new Hub({ clock: () => now });
  hub.tx(() => hub.project('p', { create: true }));
  hub.humanOp('p', 'create', { title: FORGED, acceptance: 'x' });
  hub.agentOp('p', 'checkin', 'w1', {});
  hub.agentOp('p', 'next', 'w1', {});
  const asked = now;
  hub.agentOp('p', 'ask', 'w1', { item: '#1', question: `Which \u00012\u00025m\u0003 way \u00000\u0000?`, blocking: true });
  hub.agentOp('p', 'ask', 'w1', { item: '#1', question: `Tabs \u00013\u00024m\u0003?`, assumption: 'spaces' });
  now += 2 * MIN;
  return { hub, asked, now };
}

describe("a card's written text can't forge or break its times", () => {
  test('the hub reads only its own marks: written ones stay plain text beside the real time', () => {
    const { hub, asked } = world();
    const v = view(hub, 'p');
    const q = v.attention.find((a) => a.kind === 'question');
    assert.equal(q.sub, 'Fix 19m and 9 now · w1 asked 2m ago · work is parked until you answer');
    assert.deepEqual(q.sub_at, [[asked, '2m']], 'only the real time');
    assert.match(q.headline, /^Which 25m way 0\?/);
    assert.equal(q.headline_at, undefined, 'a question holds no time');
    const as = v.attention.find((a) => a.kind === 'assumption');
    assert.deepEqual(as.sub_at, [[asked, '2m']]);
    for (const a of v.attention) assert.ok(!/[\u0000-\u0003]/.test(a.headline + (a.sub ?? '')), 'no control characters reach the page');
  });

  test('timed() renders a stray placeholder as plain text and never throws', () => {
    const at = 1_000_000_000;
    const html = timed('a \u00007\u0000 b 2m', [[at, '2m']], esc, at + 3 * MIN);
    assert.equal(html, `a 7 b <span data-at="${at}">3m</span>`);
    assert.equal(timed('a \u00000\u0000', [], esc), 'a 0');
    for (const times of [[null], [[at]], [[at, 5]], 'x', { length: 1 }, [[at, '']]]) {
      assert.doesNotThrow(() => timed('a \u00000\u0000 2m', times, esc), JSON.stringify(times));
    }
  });

  test('a card that fails to render is left out and logged, and the rest of the page draws', async () => {
    const { hub } = world();
    const v = JSON.parse(JSON.stringify(view(hub, 'p')));
    const act = v.attention.filter((a) => a.level === 'act');
    assert.ok(act.length >= 1);
    v.attention.unshift({ ...act[0], key: 'broken', headline: 'Broken card', evidence: { length: 1 } }); // evidence.map throws
    const { setState } = await import('../web/store.js');
    const { mainHtml } = await import('../web/views/main.js');
    setState({ slug: 'p', view: v, shellOnly: null, zoom: '30s' });
    const logged = [];
    const error = console.error;
    console.error = (...a) => logged.push(a);
    let html;
    try { html = mainHtml(); } finally { console.error = error; }
    assert.doesNotMatch(html, /Broken card/, 'the bad card is left out');
    assert.match(html, /Which 25m way 0\?/, 'the good card draws');
    assert.match(html, /Needs you/);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /broken/);
  });
});
