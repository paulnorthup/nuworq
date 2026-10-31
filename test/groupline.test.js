import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hub, MIN } from '../src/core.js';
import { view } from '../src/insight.js';
import { groupLine } from '../web/groupline.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

// Each group shows how far along it is as a bar beside its state (#270).
describe('a group line: state, bar, count, then title, then reason (#270)', () => {
  const line = { item: '#203', title: 'A very long milestone title that wraps on a phone', priority: 'soon', effective: 'soon', from: null,
    done: 36, total: 39, state: 'you', reason: '#210 waits on you' };

  test('the first row is the state word, the bar and the count; the title and the reason follow on their own lines', () => {
    const html = groupLine(line, { esc, priority: '<div class="seg g-prio"></div>' });
    const top = html.match(/<span class="g-top">(.*?)<\/span><\/span>\s*<span class="g-title">/s);
    assert.ok(top, 'the title comes right after the first row, outside it');
    assert.ok(html.indexOf('g-state') < html.indexOf('g-bar') && html.indexOf('g-bar') < html.indexOf('g-count'), 'state, bar, count');
    assert.ok(html.indexOf('g-title') < html.indexOf('g-meta'), 'the reason after the title');
    assert.match(html, /<span class="g-count">36\/39<\/span>/);
    assert.match(html, /<span class="g-state">Waits on you<\/span>/);
    assert.ok(html.indexOf('g-prio') > html.indexOf('g-meta'), 'the priority control after the line');
  });

  test('the bar is a progressbar with its values and a label', () => {
    const html = groupLine(line, { esc });
    assert.match(html, /role="progressbar" aria-valuemin="0" aria-valuenow="36" aria-valuemax="39" aria-label="36 of 39 parts done"/);
    assert.match(html, /<i style="width:92%"><\/i>/);
  });

  test('the bar is neutral, with a fixed width and a fixed-width state word; color stays on the state and border', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.g-bar \{[^}]*width: 96px;[^}]*background: var\(--sunken\)/);
    assert.match(css, /\.g-bar i \{[^}]*background: var\(--muted\)/);
    assert.match(css, /\.g-state \{[^}]*flex: none; width: 7\.5em/);
    assert.match(css, /\.g-top \{[^}]*white-space: nowrap/, 'one line at 375px');
    assert.doesNotMatch(css, /\.g-(you|stuck|moving) \.g-bar/, 'no state color on the bar');
    assert.match(css, /\.g-prio button \{ min-height: 44px/);
  });

  test('the group itself is its last step: never full while open, and the reason says when only it is left', () => {
    let t = Date.UTC(2026, 9, 31, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('p', { create: true }));
    const create = (args) => { const r = hub.humanOp('p', 'create', { acceptance: 'x', ...args }).item; t += MIN; return r; };
    const done = (ref) => hub.tx(() => hub.move(hub.item(hub.project('p'), ref), 'done', 'you'));
    create({ title: 'Ship it' }); // #1
    for (const n of [2, 3, 4]) { create({ title: `Part ${n}`, parent: '#1' }); done(`#${n}`); }
    const [g] = view(hub, 'p').groups;
    assert.deepEqual([g.done, g.total], [3, 4]);
    assert.match(g.reason, /^All 3 parts done · closing #1 itself is the last step · /);
    const html = groupLine(g, { esc });
    assert.match(html, /aria-valuenow="3" aria-valuemax="4" aria-label="3 of 4 parts done"/);
    assert.match(html, />3\/4</);
  });
});
