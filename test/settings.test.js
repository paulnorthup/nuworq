import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A project's settings are in one dialog (#213): the header keeps Depth, Autonomy and Settings.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fn = (name) => { const s = app.indexOf(`function ${name}(`); return app.slice(s, app.indexOf('\n}\n', s)); };
const header = (() => { const p = fn('project'); return p.slice(p.indexOf('<div class="phead">'), p.indexOf('${projectBody(')); })();
const dialog = fn('settingsModal');

test('the project header renders none of the settings actions, only Settings', () => {
  for (const a of ['runner-on', 'runner-off', 'fresh-on', 'fresh-off', 'park', 'unpark-project', 'remove-project', 'github', 'staffing']) {
    const inHeader = header.slice(0, header.indexOf('staff-ask'));
    assert.ok(!inHeader.includes(`data-action="${a}"`), `${a} is not in the header`);
  }
  assert.match(header, /z\(\) >= 1 \? `<div class="ctl-row"><span class="seg-label">Autonomy<\/span>\$\{autoSeg\}<\/div>\s*<button class="btn settings-btn" data-action="settings"/);
});

test('Settings has a row per setting, switches for staffing and freshness, Park and Remove set apart', () => {
  for (const name of ['Staff it with nuworq run', 'Keep it fresh weekly', 'GitHub']) assert.ok(dialog.includes(`'${name}'`), name);
  assert.match(dialog, /role="switch" aria-checked="\$\{on\}" aria-labelledby="set-\$\{id\}"/);
  assert.match(dialog, /sw\('runner', !!P\.runner, P\.runner \? 'runner-off' : 'runner-on'\)/);
  assert.match(dialog, /data-action="staffing-from-settings">Change</);
  assert.match(dialog, /\$\{P\.github \? 'Manage' : 'Connect GitHub'\}/);
  const below = dialog.slice(dialog.indexOf('<h3>This project</h3>'));
  assert.ok(below.includes('data-action="park"') && below.includes('data-action="unpark-project"') && below.includes('data-action="remove-project"'));
  assert.ok(dialog.indexOf('<h3>This project</h3>') > dialog.indexOf("'GitHub'"), 'Park and Remove come last');
});

test('turning staffing off asks first', () => {
  assert.match(app, /'runner-off': \(\) => \{ if \(confirm\('Stop nuworq run staffing this project\?/);
});

test("an item's Unpark and the project's are different actions", () => {
  assert.equal(app.match(/^ {2}unpark: /gm).length, 1, 'one unpark action, for items');
  assert.match(app, /'unpark-project': \(\) => setting\(\{ parked: false \}/);
});

test("the Runners section's header gives the staffing in words, with a Staffing button", () => {
  const r = fn('runners');
  assert.match(r, /const staff = `<span class="right">\$\{esc\(staffLine\(v\.project\.staffing\)\)\} <button class="link" data-action="staffing">Staffing<\/button><\/span>`/);
  assert.equal(r.match(/\$\{staff\}<\/header>/g).length, 2, 'with and without runners');
});
