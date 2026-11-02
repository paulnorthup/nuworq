// Wherever nuworq names the shaper and operator commands to a person, it gives both forms (#645, hesitation C in
// docs/evals/setup.md): /nuworq:shaper with the plugin, /nuworq-shaper without it, as connect itself says on a
// machine that declined the plugin. A unit about the plugin menu itself names only the plugin's form.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, ESSENTIALS, guidePage } from '../src/userguide.js';
import { SETUP, setupSection } from '../web/connect.js';
import { getStartedCard } from '../web/getstarted.js';

// Every string in a value, at any depth.
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
// A page's units: each paragraph, list item and heading's text.
const units = (html) => [...html.matchAll(/<(p|li|h\d|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"'));
const missing = (texts) => texts.filter((t) => !/\/plugin\b/.test(t)).flatMap((t) => ['shaper', 'operator']
  .filter((r) => t.includes(`/nuworq:${r}`) && !t.includes(`/nuworq-${r}`)).map((r) => `${r}: ${t.slice(0, 120)}`));

describe('the shaper and operator commands, in both forms (#645)', () => {
  test('wherever the guide, Get started or Connect an agent names one, it names the other', () => {
    const sources = {
      'the setup (web/connect.js SETUP)': strings(SETUP),
      "the guide's steps": strings(STEPS),
      "the guide's essentials": strings(ESSENTIALS),
      'the guide page': units(guidePage()),
      'Connect an agent (setupSection)': units(setupSection()),
      // Get started shows a session's how under it while it's the next step: each session as the next one.
      'Get started': SETUP.flatMap((s) => units(getStartedCard({ show: true, steps: [{ key: s.key, label: s.name, done: false, action: { label: 'Start', command: s.key } }] },
        { commands: Object.fromEntries(SETUP.map((x) => [x.key, x.how])) }))),
    };
    for (const [where, texts] of Object.entries(sources)) assert.deepEqual(missing(texts), [], where);
    // And it does name them: the check isn't vacuous.
    assert.ok(Object.values(sources).flat().some((t) => t.includes('/nuworq:shaper') && t.includes('/nuworq-shaper')));
    assert.ok(Object.values(sources).flat().some((t) => t.includes('/nuworq:operator') && t.includes('/nuworq-operator')));
  });

  test('the check catches a unit that names only the plugin form', () => {
    assert.equal(missing(['Then type `/nuworq:shaper`.']).length, 1);
    assert.deepEqual(missing(['Type `/nuworq:operator` ("/nuworq-operator" without the plugin).', 'In the `/plugin` menu you get /nuworq:shaper.']), []);
  });
});
