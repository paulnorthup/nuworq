import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ackList, ACKS_INLINE } from '../web/acks.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const acks = (n) => Array.from({ length: n }, (_, i) => ({ agent: `claude-${String(i).padStart(4, '0')}`, response: `on it ${i}`, at: 1000 + i }));

// #211: a steer many agents acknowledged reads as one line, not 150 chips.
describe('who acknowledged a steer', () => {
  test('many acks collapse to the count, the latest three and "+N more"', () => {
    const html = ackList({ acks: acks(152), key: 'acks:5' }, { esc });
    assert.match(html, /152 agents acknowledged<\/span> · latest: claude-0151, claude-0150, claude-0149/);
    assert.match(html, /data-action="toggle" data-key="acks:5" aria-expanded="false">\+149 more</);
    assert.ok(!html.includes('ack-all'), 'the full list stays behind the tap');
    assert.ok(!html.includes('claude-0000'));
  });

  test('open, every agent is listed in a dense list, and the control collapses it', () => {
    const html = ackList({ acks: acks(152), key: 'acks:5', open: true }, { esc });
    assert.match(html, /aria-expanded="true">Show fewer</);
    assert.match(html, /<ul class="ack-all">/, 'names alone: dense columns');
    assert.equal(html.match(/<li>/g).length, 152);
    assert.match(html, /<li><span class="ack" title="on it 0">claude-0000<\/span><\/li>/);
  });

  test('responses show inline when asked, one full-width row each, and are always in the title', () => {
    const html = ackList({ acks: acks(8), key: 'k', open: true, responses: true }, { esc });
    assert.match(html, /<ul class="ack-all rows">/);
    assert.match(html, /claude-0003: on it 3</);
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.ack-all\.rows \{ columns: auto; \}/, 'a response runs to a few hundred characters: no columns');
    assert.match(css, /\.ack-all \{[^}]*columns: 6\.5em;/, 'two columns of names in a 205px steering body at 375px');
    assert.match(css, /\.more-acks \{[^}]*min-height: 44px;[^}]*margin: calc\(-1 \* var\(--sp-3\)\) 0;/, 'a thumb-sized "+N more" that keeps its line short');
  });

  test('active agents who haven\'t acknowledged are never hidden, and come before the count', () => {
    const missing = ['claude-aaaa', 'claude-bbbb', 'claude-cccc', 'claude-dddd'];
    const html = ackList({ acks: acks(152), missing, key: 'k' }, { esc });
    for (const n of missing) assert.match(html, new RegExp(`${n} hasn't acknowledged`));
    assert.ok(html.indexOf("claude-dddd hasn't acknowledged") < html.indexOf('152 agents acknowledged'));
  });

  test(`${ACKS_INLINE} or fewer look as before: one chip each, then who hasn't`, () => {
    const html = ackList({ acks: acks(ACKS_INLINE), missing: ['claude-zzzz'], key: 'k' }, { esc });
    assert.equal(html.match(/class="ack"/g).length, ACKS_INLINE);
    assert.ok(!html.includes('more-acks'));
    assert.ok(html.indexOf('claude-0004') < html.indexOf("claude-zzzz hasn't acknowledged"));
    assert.equal(ackList({ acks: [], key: 'k' }, { esc }), '<span class="unacked">not seen yet</span>');
  });

  test('agent names and responses are escaped', () => {
    const html = ackList({ acks: [...acks(6), { agent: '<b>x', response: '"><img>', at: 9999 }], key: 'k', open: true, responses: true }, { esc });
    assert.ok(!html.includes('<b>x') && !html.includes('<img>'));
  });

  test('the steering section and the item drawer both use it, collapsed at every depth until tapped', () => {
    const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    assert.match(app, /ackList\(\{ acks: s\.acks, missing, key: `acks:\$\{s\.id\}`, open: S\.open\.has\(`acks:\$\{s\.id\}`\), responses: z\(\) >= 2 \}/);
    assert.match(app, /ackList\(\{ acks: s\.acks, key: `dacks:\$\{s\.id\}`, open: S\.open\.has\(`dacks:\$\{s\.id\}`\), responses: true,/);
  });
});
