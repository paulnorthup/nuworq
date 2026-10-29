import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The project page at each depth (web/app.js, project()): 30s is what needs you and what's moving, and each
// deeper level adds sections rather than repeating them (#144).
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const body = app.slice(app.indexOf('${pulse(v)}'), app.indexOf("That's the 30-second view."));
const at = (section) => body.match(new RegExp(`\\$\\{(?:z\\(\\) >= (\\d) \\? )?${section}\\(v\\)`))?.[1] ?? '0';

test('at 30s a project shows the pulse, composer, Needs you and In motion; Flow first appears at 5m', () => {
  for (const s of ['pulse', 'composer', 'needsYou', 'motion']) assert.equal(at(s), '0', `${s} at 30s`);
  for (const s of ['worthKnowing', 'flow', 'upNext', 'finished', 'steering', 'agents']) assert.equal(at(s), '1', `${s} from 5m`);
  for (const s of ['activity', 'allWork']) assert.equal(at(s), '2', `${s} from 30m`);
});

test("the 30s footer names what 5m adds", () => {
  const footer = app.match(/That's the 30-second view\.[^`]*`/)[0];
  for (const words of ['worth knowing', 'flow', "what's next", 'what finished', 'agents']) assert.ok(footer.includes(words), words);
});
