import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mapParts } from '../web/groupmap.js';
import { appSource } from './appsource.js';

const part = (seq, stage, priority = 'soon') => ({ item: `#${seq}`, stage, priority });

// #215: a group's map shows what's left first and folds the done parts. #442: dropped parts leave it.
describe("a group's map", () => {
  test('open parts first, in the order next offers them, then the rest that is open; done fold behind one line, dropped set apart', () => {
    const kids = [
      ...Array.from({ length: 26 }, (_, i) => part(100 + i, 'done')),
      part(187, 'ready', 'soon'), part(211, 'ready', 'later'), part(213, 'verifying'), part(214, 'active'),
      part(215, 'proposed'), part(216, 'waiting'), part(217, 'landing'), part(218, 'outside'), part(219, 'ready', 'now'),
      part(220, 'dropped'), part(221, 'dropped'),
    ];
    const { open, folded, label, dropped } = mapParts(kids);
    assert.deepEqual(open.map((n) => n.item), ['#217', '#213', '#219', '#187', '#211', '#215', '#214', '#216', '#218']);
    assert.equal(folded.length, 26);
    assert.ok(folded.every((n) => n.stage === 'done'));
    assert.equal(label, '26 done');
    assert.deepEqual(dropped.map((n) => n.item), ['#220', '#221']);
  });

  test('dropped parts never fold in with the done ones', () => {
    assert.deepEqual(mapParts([part(1, 'ready'), part(2, 'dropped')]), { open: [part(1, 'ready')], folded: [], label: '', dropped: [part(2, 'dropped')] });
    assert.equal(mapParts([part(1, 'ready'), part(2, 'done'), part(3, 'done')]).label, '2 done');
  });

  test('a group whose parts are all done shows them as before, nothing folded; dropped ones stay apart', () => {
    const kids = [part(3, 'done'), part(1, 'done'), part(2, 'dropped')];
    assert.deepEqual(mapParts(kids), { open: [part(3, 'done'), part(1, 'done')], folded: [], label: '', dropped: [part(2, 'dropped')] });
  });

  test('the drawer folds at every level, behind a toggle that unfolds the done parts after the open ones; dropped only at 30m', () => {
    const app = appSource();
    const fn = app.slice(app.indexOf('function groupMap('), app.indexOf('\n}\n', app.indexOf('function groupMap(')));
    assert.match(fn, /const \{ open, folded, label, dropped \} = mapParts\(x\.children\);/);
    assert.match(fn, /data-action="toggle" data-key="\$\{esc\(key\)\}" aria-expanded="\$\{shown\}">\$\{shown \? `Hide \$\{label\}` : label\}<\/button>/);
    assert.match(fn, /const drops = z\(\) >= 2 && dropped\.length \?/);
    assert.match(fn, /Show dropped \(\$\{dropped\.length\}\)/);
    assert.match(fn, /`<ul>\$\{open\.map\(li\)\.join\(''\)\}\$\{fold\}\$\{shown \? folded\.map\(li\)\.join\(''\) : ''\}\$\{drops\}<\/ul>`/);
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.m-fold \.link \{ min-height: 44px;/);
  });
});
