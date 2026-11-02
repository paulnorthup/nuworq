import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkChip } from '../web/checks.js';
import { appSource } from './appsource.js';

const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const app = appSource();
// The declarations of the rule whose selector is exactly sel ('' when there's none).
const rule = (sel) => css.match(new RegExp(`(?:^|\\n|\\}\\s*)${sel.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
const green = (decl) => /var\(--ok(-tint)?\)/.test(decl);

// Green means finished or passed, and nothing else (#191).
describe('green means finished or passed', () => {
  test("Flow: Done's count is green, Dropped's isn't", () => {
    assert.ok(green(rule('.stage.stage-done .n')), 'Done is green');
    assert.equal(rule('.stage.court-none .n'), '', 'no green rule for every court-less stage (Dropped is one)');
    assert.match(app, /class="stage stage-\$\{s\.stage\} court-/, 'each Flow tile names its stage');
  });

  test('an empty state is green only with a ✓', () => {
    assert.ok(!green(rule('.zero .check')), 'a nudge (→) is neutral');
    assert.ok(green(rule('.zero .check.good')));
    assert.match(app, /const zero = [^\n]*<span class="check">→<\/span>/, 'zero() nudges, neutral');
    assert.match(app, /<span class="check good">✓<\/span><div><b>Nothing needs you\.<\/b>/, 'good news is green');
    assert.match(app, /<span class="check">→<\/span><div>No projects yet/, '"No projects yet" is a nudge');
  });

  test('the current workspace is marked without green', () => {
    assert.ok(!green(rule('.org-item.on::before')));
  });

  test("what an agent attached (evidence, commits) is neutral with no ✓; a check the hub saw pass is green", () => {
    assert.ok(!green(rule('.ev')), 'evidence and commit chips are neutral');
    assert.equal(rule('.ev::before'), '', 'no ✓ before an agent\'s claim');
    assert.ok(green(rule('.ev.check.pass')));
    const esc = (s) => s;
    assert.match(checkChip({ name: 'test', conclusion: 'success' }, esc), /class="ev check pass">✓ test</);
    assert.match(checkChip({ name: 'test', conclusion: 'failure' }, esc), /class="ev check fail">✗ test</);
  });

  test('green stays where it means finished: Done pills, the sparkline, acknowledgements, finished steps, a kept attempt', () => {
    for (const sel of ['.stage-pill.done', '.spark span', '.ack', '.steps li.on .box', '.get-started li.done .tick', '.tag.go']) assert.ok(green(rule(sel)), sel);
  });
});
