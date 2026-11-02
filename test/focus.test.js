import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isTextBox, saveFocus, restoreFocus } from '../web/focus.js';
import { appSource } from './appsource.js';

// Just enough of a page: boxes with a value, a cursor and a scroll, and a document that knows which one is focused.
function box(tag, { type, draft, id, value = '' } = {}) {
  const el = {
    tagName: tag, type, id: id ?? '', value, dataset: draft ? { draft } : {}, scrollTop: 0, scrollLeft: 0,
    selectionStart: value.length, selectionEnd: value.length, selectionDirection: 'none',
    setSelectionRange(s, e, d) { Object.assign(this, { selectionStart: s, selectionEnd: e, selectionDirection: d }); },
    focus() { doc.activeElement = this; },
  };
  return el;
}
let doc;
const page = (...els) => {
  doc = {
    activeElement: null, els,
    querySelectorAll: (sel) => (sel === '[data-draft]' ? doc.els.filter((e) => e.dataset.draft) : []),
    getElementById: (id) => doc.els.find((e) => e.id === id) ?? null,
  };
  return doc;
};
// A redraw: every box replaced by a fresh one, focus gone to the page.
const redraw = (make) => { doc.els = make(); doc.activeElement = null; };

describe('a box someone is writing in', () => {
  test('counts as typing whether or not it has text; checkboxes, radios and buttons do not', () => {
    assert.equal(isTextBox(box('TEXTAREA')), true, 'an empty textarea');
    assert.equal(isTextBox(box('INPUT')), true, 'an empty input with no type');
    assert.equal(isTextBox(box('INPUT', { type: 'text', value: 'hi' })), true);
    assert.equal(isTextBox(box('INPUT', { type: 'number' })), true);
    assert.equal(isTextBox({ tagName: 'DIV', isContentEditable: true }), true, 'contenteditable');
    for (const type of ['checkbox', 'radio', 'button', 'submit']) assert.equal(isTextBox(box('INPUT', { type })), false, type);
    assert.equal(isTextBox({ tagName: 'BUTTON' }), false);
    assert.equal(isTextBox(null), false, 'nothing focused');
  });

  test('a redraw puts focus, cursor, selection and scroll back in the same box, found by its draft', () => {
    page(box('TEXTAREA', { draft: 'compose', id: 'compose', value: 'Please look at the login page' }), box('INPUT', { draft: 'ans-3' }));
    const was = doc.els[0];
    was.focus();
    was.setSelectionRange(7, 11, 'backward');
    was.scrollTop = 40;
    const saved = saveFocus(doc);
    redraw(() => [box('TEXTAREA', { draft: 'compose', id: 'compose', value: 'Please look at the login page' }), box('INPUT', { draft: 'ans-3' })]);
    assert.equal(restoreFocus(doc, saved), true);
    const now = doc.els[0];
    assert.notEqual(now, was, 'a new element');
    assert.equal(doc.activeElement, now);
    assert.deepEqual([now.selectionStart, now.selectionEnd, now.selectionDirection, now.scrollTop], [7, 11, 'backward', 40]);
  });

  test('an empty focused box comes back focused too', () => {
    page(box('INPUT', { draft: 'ic:#4', id: 'ic:#4' }));
    doc.els[0].focus();
    const saved = saveFocus(doc);
    redraw(() => [box('INPUT', { draft: 'ic:#4', id: 'ic:#4' })]);
    restoreFocus(doc, saved);
    assert.equal(doc.activeElement, doc.els[0]);
  });

  test("a box with no draft keeps what's typed in it, by its id", () => {
    page(box('INPUT', { id: 'np-name', value: 'llm-proxy' }));
    doc.els[0].focus();
    const saved = saveFocus(doc);
    redraw(() => [box('INPUT', { id: 'np-name' })]);
    restoreFocus(doc, saved);
    assert.deepEqual([doc.activeElement, doc.els[0].value, doc.els[0].selectionStart], [doc.els[0], 'llm-proxy', 9]);
  });

  test('never moves focus that was not in a box, and never focuses a box that is gone', () => {
    page(box('INPUT', { draft: 'a' }));
    doc.activeElement = { tagName: 'BUTTON' };
    assert.equal(saveFocus(doc), null, 'focus on a button: nothing to bring back');
    assert.equal(restoreFocus(doc, null), false);
    doc.els[0].focus();
    const saved = saveFocus(doc);
    redraw(() => []);
    assert.equal(restoreFocus(doc, saved), false);
    assert.equal(doc.activeElement, null);
  });

  test('a box the redraw left in place keeps focus untouched', () => {
    page(box('TEXTAREA', { draft: 'compose', value: 'abc' }));
    const el = doc.els[0];
    el.focus();
    el.setSelectionRange(1, 1, 'none');
    const saved = saveFocus(doc);
    el.setSelectionRange(2, 2, 'none'); // still typing meanwhile
    assert.equal(restoreFocus(doc, saved), true);
    assert.equal(el.selectionStart, 2, 'not wound back');
  });
});

describe('the page', () => {
  const app = appSource();
  test('live updates wait while any box is focused, and every redraw, forced ones too, brings focus back', () => {
    assert.match(app, /const typing = \(\) => isTextBox\(document\.activeElement\);/);
    const render = app.slice(app.indexOf('function render('), app.indexOf('// ── modals ──'));
    assert.ok(render.indexOf('saveFocus(document)') > 0 && render.indexOf('saveFocus(document)') < render.indexOf('REGIONS[r]()'), 'saved before the HTML changes');
    assert.ok(render.indexOf('restoreFocus(document, writing)') > render.indexOf('el.value = v'), 'restored after the drafts are back');
  });
});
