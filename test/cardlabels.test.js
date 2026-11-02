import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

// Every Needs you card says what it is in plain words, never its raw kind (#196).
test('each kind the hub puts at level "act" has a label in CARD_LABELS', () => {
  // An entry is pushed as { key, level, kind, ... }; a level that can be 'act' is the literal or an expression naming it.
  const kinds = [...read('src/insight.js').matchAll(/level: ([^,]+), kind: '([a-z-]+)'/g)].filter(([, level]) => level.includes("'act'")).map(([, , kind]) => kind);
  assert.ok(kinds.length >= 10, `found the act-level kinds (${kinds.join(', ')})`);
  for (const k of ['operator-missing', 'kept-parked', 'question', 'no-agents']) assert.ok(kinds.includes(k), k);
  const map = appSource().match(/const CARD_LABELS = \{([\s\S]*?)\n\};/);
  assert.ok(map, 'web/app.js has CARD_LABELS');
  const labels = Object.fromEntries([...map[1].matchAll(/'?([a-z-]+)'?: '([^']+)'/g)].map(([, k, v]) => [k, v]));
  for (const k of new Set(kinds)) assert.ok(labels[k], `"${k}" has a plain-words label`);
  assert.equal(labels['operator-missing'], 'No operator connected');
  assert.equal(labels['kept-parked'], 'Kept parked');
});
