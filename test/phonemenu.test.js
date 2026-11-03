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
  assert.match(css, /^\.rail-menu, \.rail-break, \.rail-sheet \{ display: none; \}/m, 'no Menu or its sheet on the desktop, where the rail and its menus show everything');
  assert.match(phone, /\.rail-label, \.rail-foot, \.rail-nav \{ display: none; \}/, 'on a phone the rail keeps to its top bar');
  assert.match(phone, /#rail\.menu-open \.rail-sheet \{ display: flex;/, 'open, the sheet shows');
  assert.match(phone, /#rail \.rail-menu \{ display: flex;[^}]*min-height: 44px/, 'Menu is thumb-sized');
  assert.match(phone, /#rail\.menu-open \.rail-sheet \.rail-item, #rail\.menu-open \.rail-sheet \.org-item \{[^}]*min-height: 44px/, 'so is each action');
  assert.match(app, /if \(S\.railMenu && el\.closest\('\.rail-sheet'\)\)/, 'picking from it closes it');
  assert.match(app, /function route\(\) \{\n[^\n]*\n\s*setState\(\{ railMenu: false,/, 'navigating closes it');
});
