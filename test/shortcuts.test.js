import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHORTCUTS, shortcutFor, shortcutsHtml } from '../web/shortcuts.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const key = (k, mods = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const none = { inField: false, input: false, compose: false, modal: false, item: false, launcher: false };
const launcher = { ...none, inField: true, input: true, launcher: true }; // focus in the launcher's box

describe('keyboard shortcuts come from one list (#274)', () => {
  test("the handler's KEYS and SHORTCUTS name the same shortcuts", () => {
    const keys = app.match(/const KEYS = \{([\s\S]*?)\n\};/);
    assert.ok(keys, 'web/app.js has KEYS');
    const ids = [...keys[1].matchAll(/^ {2}'?([\w-]+)'?:/gm)].map((m) => m[1]);
    assert.deepEqual(ids.sort(), SHORTCUTS.map((s) => s.id).sort());
  });

  test('the keydown handler acts on no key of its own: it dispatches from the list', () => {
    const handler = app.match(/document\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n\}\);/);
    assert.ok(handler, 'web/app.js has one keydown handler');
    assert.equal((app.match(/addEventListener\('keydown'/g) ?? []).length, 1);
    assert.doesNotMatch(handler[1], /e\.key\b/, 'no key compared outside SHORTCUTS');
    assert.match(handler[1], /shortcutFor\(e/);
    assert.match(handler[1], /KEYS\[s\.id\]\(e\)/);
  });

  test('each listed key does what its entry says, where it says', () => {
    assert.equal(shortcutFor(key('?', { shiftKey: true }), none)?.id, 'help');
    assert.equal(shortcutFor(key('?'), { ...none, inField: true }), null, 'a ? typed in a text box stays a ?');
    assert.equal(shortcutFor(key('?', { metaKey: true }), none), null);
    assert.equal(shortcutFor(key('?'), { ...none, modal: true })?.id, 'help', '? again closes it');
    for (const d of ['1', '2', '3']) assert.equal(shortcutFor(key(d), none)?.id, 'depth');
    assert.equal(shortcutFor(key('2', { ctrlKey: true }), none), null);
    assert.equal(shortcutFor(key('2'), { ...none, inField: true }), null);
    assert.equal(shortcutFor(key('Escape'), { ...none, modal: true, item: true })?.id, 'close', 'a dialog closes first');
    assert.equal(shortcutFor(key('Escape'), { ...none, item: true, inField: true })?.id, 'leave-item');
    assert.equal(shortcutFor(key('Escape'), { ...none, inField: true })?.id, 'blur');
    assert.equal(shortcutFor(key('Escape'), none), null);
    assert.equal(shortcutFor(key('Enter', { metaKey: true }), { ...none, inField: true, compose: true })?.id, 'send');
    assert.equal(shortcutFor(key('Enter', { ctrlKey: true }), { ...none, inField: true, compose: true })?.id, 'send');
    assert.equal(shortcutFor(key('Enter'), { ...none, inField: true, compose: true }), null, 'a plain Enter in the message box is a new line');
    assert.equal(shortcutFor(key('Enter'), { ...none, inField: true, input: true })?.id, 'press');
  });

  test('the quick launcher (#290): ⌘K or Ctrl+K opens it except in a text box, and its keys win while it is open', () => {
    assert.equal(shortcutFor(key('k', { metaKey: true }), none)?.id, 'launcher');
    assert.equal(shortcutFor(key('k', { ctrlKey: true }), { ...none, item: true, modal: true })?.id, 'launcher');
    assert.equal(shortcutFor(key('K', { metaKey: true, shiftKey: true }), none)?.id, 'launcher');
    assert.equal(shortcutFor(key('k', { metaKey: true }), { ...none, inField: true, input: true }), null, 'a text box keeps its own ⌘K');
    assert.equal(shortcutFor(key('k', { metaKey: true }), launcher)?.id, 'launcher', 'again closes it');
    assert.equal(shortcutFor(key('k'), none), null);
    assert.equal(shortcutFor(key('ArrowDown'), launcher)?.id, 'ln-move');
    assert.equal(shortcutFor(key('ArrowUp'), launcher)?.id, 'ln-move');
    assert.equal(shortcutFor(key('ArrowDown'), none), null);
    assert.equal(shortcutFor(key('Enter'), launcher)?.id, 'ln-run', "not the field's press");
    assert.equal(shortcutFor(key('Escape'), { ...launcher, modal: true, item: true })?.id, 'ln-close', 'Esc closes the launcher before anything under it');
    const html = shortcutsHtml({ mac: true });
    assert.ok(html.includes('<h4>The quick launcher</h4>'));
    assert.match(html, /<kbd>⌘<\/kbd> \+ <kbd>K<\/kbd><\/dt><dd>Open the quick launcher/);
    assert.match(html, /<kbd>↑<\/kbd> <kbd>↓<\/kbd><\/dt>/);
    assert.match(shortcutsHtml({ mac: false }), /<kbd>Ctrl<\/kbd> \+ <kbd>K<\/kbd>/);
  });

  test('every entry fires on its own keys somewhere', () => {
    const places = [none, { ...none, modal: true }, { ...none, item: true }, { ...none, inField: true }, { ...none, inField: true, input: true }, { ...none, inField: true, compose: true }, launcher];
    const named = { Esc: 'Escape', '↑': 'ArrowUp', '↓': 'ArrowDown' };
    for (const s of SHORTCUTS) {
      const k = named[s.keys.at(-1)] ?? s.keys.at(-1);
      const mods = s.keys.includes('mod') ? { metaKey: true } : {};
      assert.ok(places.some((c) => shortcutFor(key(k, mods), c)?.id === s.id), `${s.id} fires on ${s.keys.join('+')}`);
    }
  });

  test('the dialog lists every shortcut by place, as keycaps, with ⌘ on a Mac and Ctrl elsewhere', () => {
    const html = shortcutsHtml({ mac: true });
    assert.match(html, /<h2>Keyboard shortcuts<\/h2>/);
    for (const g of ['Everywhere', 'A project or All projects', 'An open item', 'While typing']) assert.ok(html.includes(`<h4>${g}</h4>`), g);
    for (const s of SHORTCUTS) assert.ok(html.includes(s.does), s.id);
    assert.match(html, /<kbd>1<\/kbd> <kbd>2<\/kbd> <kbd>3<\/kbd><\/dt><dd>Depth 30s, 5m, 30m/);
    assert.match(html, /<kbd>\?<\/kbd><\/dt><dd>Show these shortcuts/);
    assert.match(html, /<kbd>⌘<\/kbd> \+ <kbd>Enter<\/kbd>/);
    assert.match(shortcutsHtml({ mac: false }), /<kbd>Ctrl<\/kbd> \+ <kbd>Enter<\/kbd>/);
  });

  test('the rail hints at ? only with a keyboard and a fine pointer', () => {
    assert.match(app, /class="rail-item kbd-hint" data-action="shortcuts"/);
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.kbd-hint \{ display: none !important; \}/);
    assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{ \.kbd-hint \{ display: flex !important; \} \}/);
  });
});
