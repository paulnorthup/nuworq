import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

// Phone first (#127, #148). The page is browser code, so this reads its stylesheet: on a phone the targets a thumb
// hits are at least 44px. The measured heights at 375px are in each item's evidence.
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const phone = css.slice(css.indexOf('@media (max-width: 420px)'), css.indexOf('\n}\n', css.indexOf('@media (max-width: 420px)')));

describe('on a phone', () => {
  test('card and pulse buttons are thumb-sized', () => {
    assert.match(phone, /\.card \.btn, .*\.pulse \.btn.* \{ min-height: 44px; \}/);
  });

  test('every drawer button and input is thumb-sized, the close ✕ and options wide enough too', () => {
    assert.match(phone, /#drawer \.btn, #drawer \.opt, #drawer input \{ min-height: 44px; \}/);
    assert.match(phone, /#drawer \.d-top \.x, #drawer \.opt \{ min-width: 44px; \}/);
  });

  test('the note input gets its own row, so its placeholder fits', () => {
    assert.match(phone, /#drawer \.d-sec \.inline-form \{ flex-wrap: wrap; \}/);
    assert.match(phone, /#drawer \.d-sec \.inline-form input \{ flex: 1 1 100%; \}/);
  });

  test('an item without done_means wraps its fallback line instead of scrolling the drawer sideways (#256)', () => {
    const app = appSource();
    const fallback = app.match(/<p class="([^"]+)">No acceptance criteria yet\./);
    assert.ok(fallback, 'the Done means fallback is still there');
    assert.notEqual(fallback[1], 'age', '.age is nowrap, for timestamps');
    assert.equal(fallback[1], 'faint');
    const faint = css.match(/^([^{\n]*\.d-sec \.faint[^{\n]*)\{([^}]*)\}/m);
    assert.ok(faint, '.faint is styled inside the drawer');
    assert.match(faint[2], /color: var\(--muted\)/);
    assert.doesNotMatch(faint[2], /nowrap/);
  });
});
