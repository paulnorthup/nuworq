import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The project page at each depth (web/app.js, projectBody()'s sections): 30s is what needs you and what's moving,
// and each deeper level adds sections rather than repeating them (#144).
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function projectBody(');
const body = app.slice(start, app.indexOf('\n}\n', start));
const at = (section) => body.match(new RegExp(`\\b\\w+: (?:z\\(\\) >= (\\d) \\? )?${section}\\(v\\)`))?.[1] ?? '0';

// Flow is at every depth by Paul's standing decision (2026-10-29): the lifecycle belongs in the glance.
test('at 30s a project shows the pulse, composer, Needs you, In motion and Flow', () => {
  for (const s of ['pulse', 'composer', 'needsYou', 'motion', 'flow']) assert.equal(at(s), '0', `${s} at 30s`);
  for (const s of ['worthKnowing', 'upNext', 'finished', 'steering', 'agents']) assert.equal(at(s), '1', `${s} from 5m`);
  for (const s of ['activity', 'allWork']) assert.equal(at(s), '2', `${s} from 30m`);
});

// All work's headings stay on one line, and on a phone the table scrolls sideways instead of being cut off (#413).
test('All work keeps its headings on one line and scrolls on a narrow screen', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(css, /table\.work th \{[^}]*white-space: nowrap/);
  assert.match(css, /\.work-scroll \{[^}]*overflow-x: auto/);
  assert.match(app, /<div class="work-scroll"><table class="work">/);
});

test("the 30s footer names what 5m adds", () => {
  const footer = app.match(/That's the 30-second view\.[^`]*`/)[0];
  for (const words of ['worth knowing', "what's next", 'what finished', 'agents']) assert.ok(footer.includes(words), words);
});
