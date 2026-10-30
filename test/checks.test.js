import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkChip, checkResult } from '../web/checks.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

describe('a failing check shows a red ✗, never inside a green ✓ (#192)', () => {
  test('failed: red with ✗ and no ✓; passed: ✓; anything else: no mark, and it says what it is', () => {
    const failed = checkChip({ name: 'test', conclusion: 'failure', url: 'https://ci.example/1' }, esc);
    assert.equal(failed, '<span class="ev check fail"><a href="https://ci.example/1" target="_blank" rel="noopener">✗ test</a></span>');
    assert.doesNotMatch(failed, /✓/);
    assert.equal(checkChip({ name: 'lint', conclusion: 'success' }, esc), '<span class="ev check pass">✓ lint</span>');
    for (const c of ['pending', 'neutral', 'skipped']) {
      const chip = checkChip({ name: 'e2e', conclusion: c }, esc);
      assert.equal(chip, `<span class="ev check other">e2e: ${c}</span>`);
      assert.doesNotMatch(chip, /[✓✗]/);
    }
    for (const c of ['timed_out', 'cancelled', 'action_required', 'startup_failure', 'error']) assert.equal(checkResult(c), 'fail', c);
    assert.match(checkChip({ name: '<b>', conclusion: 'failure' }, esc), /✗ &lt;b&gt;/, 'names are escaped');
  });

  test("the styles: no chip gets a ✓ from CSS (a check carries its own mark), and failed is --bad", () => {
    assert.doesNotMatch(css, /\.ev[^{]*::before \{[^}]*✓/, 'since #191 evidence chips have no ✓, so a check never sits inside one');
    assert.match(css, /\.ev\.check\.fail \{ background: var\(--bad-tint\); color: var\(--bad\); \}/);
    assert.match(css, /\.tl\.t-pr_failed::before, \.tl\.t-pr_merge_failed::before \{ background: var\(--bad\); \}/);
    assert.match(css, /^\.bad \{ color: var\(--bad\);/m);
  });

  test("the page uses it for the CI card and the drawer's checks; failing CI and Not linked are red", () => {
    assert.equal((app.match(/checkChip\(c, esc\)/g) ?? []).length, 2);
    assert.doesNotMatch(app, /<span class="ev">[^`]*✗/, 'no hand-built ✗ inside a ✓ chip');
    assert.match(app, /pr\.ci === 'fail' \? 'bad'/);
    assert.match(app, /<div class="bad">\$\{r\.refused/);
  });
});
