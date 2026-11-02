import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #705: ACTIONS defined `keep` twice, so #552's field-note Keep replaced the race's "Keep this one", which then
// sent keep with note NaN and never kept the attempt. A name defined twice in an object literal silently wins last.
const src = readFileSync(new URL('../web/actions.js', import.meta.url), 'utf8');
const parts = readFileSync(new URL('../web/views/parts.js', import.meta.url), 'utf8');
const block = (name) => src.match(new RegExp(`\\nexport const ${name} = \\{\\n([\\s\\S]*?)\\n\\};\\n`))[1];
const keys = (body) => [...body.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z_$][\w$]*)):/gm)].map((m) => m[1] ?? m[2]);

describe('Each app action has one definition (#705)', () => {
  for (const name of ['ACTIONS', 'KEYS']) {
    test(`${name} names no action twice`, () => {
      const seen = keys(block(name));
      assert.ok(seen.length > 10, `found ${name}'s keys`);
      const twice = seen.filter((k, i) => seen.indexOf(k) !== i);
      assert.deepEqual(twice, [], `defined twice in ${name}: ${twice.join(', ')}`);
    });
  }

  test('"Keep this one" keeps that attempt: its action accepts the item with the attempt', () => {
    const action = parts.match(/data-action="([^"]+)" data-item="\$\{esc\(item\)\}" data-attempt="\$\{s\.n\}">Keep this one</)[1];
    const body = block('ACTIONS').match(new RegExp(`^ {2}'?${action}'?: [\\s\\S]*?\\n {2}\\},?$`, 'm'))[0];
    assert.match(body, /human\('accept', \{ item: el\.dataset\.item, attempt: el\.dataset\.attempt \}\)/);
  });

  test('the field-note Keep still keeps the note', () => {
    assert.match(src, /\n {2}keep: async \(el\) => \{ await human\('keep', \{ note: Number\(el\.dataset\.note\) \}/);
  });
});
