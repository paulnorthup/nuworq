import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #308: on a Free workspace the rail's Workspace settings carries Upgrade as a tag, not a "·" that wraps alone.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('Workspace settings: the label whole, Upgrade a tag beside it, no separator', () => {
  const line = app.split('\n').find((l) => l.includes('data-action="workspace-settings"'));
  assert.ok(line, 'the rail entry');
  assert.match(line, /<span class="name">Workspace settings<\/span>\$\{S\.billing\.plans\?\.length \? '<span class="tag now">Upgrade<\/span>' : ''\}/);
  assert.ok(!line.includes('·'), 'no separator to wrap');
  assert.match(css, /\.rail-foot \.tag \{[^}]*text-transform: none/, 'a narrow tag, so the label fits the desktop rail');
});
