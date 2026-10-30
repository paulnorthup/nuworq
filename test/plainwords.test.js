import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Copy a person shouldn't have to decode (#150): the pulse's first visit, the card's "why" link, All work's column.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

test('no "First look", no "Why? (5m)", no bare "Who" column; their plain replacements are there', () => {
  for (const old of ['First look', 'Why? (5m)', '<th>Who</th>']) assert.ok(!app.includes(old), old);
  for (const now of ['Everything here is new to you.', 'Why it needs you', '<th>Worked on by</th>']) assert.ok(app.includes(now), now);
  assert.match(app, /data-action="seen" title="[^"]{20,}">Mark all seen/, 'Mark all seen says what it does');
});
