import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appSource } from './appsource.js';

const app = appSource();
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
const phone = css.match(/@media \(max-width: 860px\) \{([\s\S]*?)\n\}/)[1];

// #114's closing pass: the phone top bar hid the rail's actions with no way to them.
test("on a phone the rail's actions are behind Menu, and still reachable", () => {
  assert.match(app, /class="rail-item rail-menu" data-action="rail-menu" aria-expanded=/, 'the rail has a Menu button');
  assert.match(app, /'rail-menu': \(\) => \{ setState\(\{ railMenu: !S\.railMenu \}\); render\(\{ force: true \}\); \}/, 'Menu toggles the list');
  assert.match(css, /^\.rail-menu, \.rail-break \{ display: none; \}/m, 'no Menu on the desktop, where the rail shows everything');
  assert.match(phone, /\.rail-foot \{ display: none; \}/, 'closed, the list is hidden on a phone');
  assert.match(phone, /#rail\.menu-open \.rail-foot \{ display: flex;/, 'open, it shows');
  assert.match(phone, /#rail \.rail-menu \{ display: flex;[^}]*min-height: 44px/, 'Menu is thumb-sized');
  assert.match(phone, /#rail\.menu-open \.rail-foot \.rail-item \{[^}]*min-height: 44px/, 'so is each action');
  assert.match(app, /function route\(\) \{\n[^\n]*\n\s*setState\(\{ railMenu: false,/, 'navigating closes it');
});
