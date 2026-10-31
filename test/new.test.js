import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NEW, isNew, seenNew, markSeen } from '../web/new.js';

const DAY = 864e5;
const shipped = '2026-10-29';
const at = Date.parse(shipped);
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
const refusing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };

// #130: a tiny "new" tag for 7 days after a feature ships, until this viewer has used it.
describe('what just shipped', () => {
  test('new from its ship day for 7 days, then not; never before it ships, never for a key nobody listed', () => {
    assert.equal(isNew('x', { now: at, shipped }), true, 'day 0');
    assert.equal(isNew('x', { now: at + 6 * DAY, shipped }), true, 'day 6');
    assert.equal(isNew('x', { now: at + 7 * DAY, shipped }), false, 'day 7: gone');
    assert.equal(isNew('x', { now: at + 8 * DAY, shipped }), false, 'day 8');
    assert.equal(isNew('x', { now: at - 1, shipped }), false, 'not before it ships');
    assert.equal(isNew('no-such-feature', { now: at }), false, 'unknown key');
  });

  test('once used, not new for this viewer, and that is remembered', () => {
    const store = memory();
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(store) }), true);
    markSeen('x', store);
    markSeen('x', store);
    assert.deepEqual(seenNew(store), ['x'], 'kept once');
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(store) }), false);
  });

  test('a browser that refuses storage still renders: nothing is seen, so the tag shows', () => {
    assert.deepEqual(seenNew(refusing), []);
    assert.doesNotThrow(() => markSeen('x', refusing));
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(refusing) }), true);
    // No store given and none in this runtime (or one whose very access throws): still nothing seen, no throw.
    assert.deepEqual(seenNew(), []);
    assert.doesNotThrow(() => markSeen('x'));
  });

  test('every listed key has a real date and is used by some element in the app', () => {
    // The page and the pure modules it renders with (e.g. web/milestones.js, web/groupline.js).
    const web = new URL('../web/', import.meta.url);
    const app = readdirSync(web).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, web), 'utf8')).join('\n');
    assert.ok(Object.keys(NEW).length >= 2);
    for (const [key, date] of Object.entries(NEW)) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, key);
      assert.ok(app.includes(`data-new="${key}"`), `${key} marks an element`);
    }
  });

  test('the pill takes no room (absolutely positioned) and its text meets WCAG AA on its own background', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.is-new::after \{[^}]*position: absolute/);
    const v = (name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    assert.ok(ratio(v('agents'), v('agents-tint')) >= 4.5, `contrast ${ratio(v('agents'), v('agents-tint')).toFixed(2)}`);
  });
});
