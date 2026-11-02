import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { NEW, isNew, seenNew, markSeen, markNew, dismissNew } from '../web/new.js';

const DAY = 864e5;
const shipped = '2026-10-29';
const at = Date.parse(shipped);
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
// Just enough DOM for markNew and dismissNew: a feature's button with its tagged label inside, in a row.
class El {
  constructor(tag, doc) {
    Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument: doc, children: [], parentNode: null, dataset: {}, attrs: {}, className: '' });
    this.classList = Object.assign(new Set(), { toggle(c, on) { if (on) this.add(c); else this.delete(c); }, contains(c) { return this.has(c); } });
    this.style = Object.assign(new Map(), { setProperty(k, v) { this.set(k, v); } });
  }
  append(...els) { for (const el of els) { el.parentNode = this; this.children.push(el); } return this; }
  get nextElementSibling() { const s = this.parentNode.children; return s[s.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const s = this.parentNode.children; return s[s.indexOf(this) - 1] ?? null; }
  after(el) { const s = this.parentNode.children; s.splice(s.indexOf(this) + 1, 0, el); el.parentNode = this.parentNode; }
  remove() { const s = this.parentNode.children; s.splice(s.indexOf(this), 1); this.parentNode = null; }
  matches(sel) {
    return sel.split(', ').some((s) => s.startsWith('.') ? this.classList.has(s.slice(1)) || this.className.split(' ').includes(s.slice(1)) : this.tagName === s.toUpperCase());
  }
  closest(sel) { for (let el = this; el instanceof El; el = el.parentNode) if (el.matches(sel)) return el; return null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() { this.ownerDocument.focused = this; }
  *all() { for (const c of this.children) { yield c; yield* c.all(); } }
}
function page() {
  const doc = { activeElement: null, focused: null, createElement: (t) => new El(t, doc) };
  const row = new El('div', doc), btn = new El('button', doc), span = new El('span', doc);
  btn.dataset.action = 'shortcuts';
  span.dataset.new = 'home';
  row.append(btn.append(span));
  doc.querySelectorAll = () => [...row.all()].filter((el) => el.dataset.new);
  return { doc, btn, span };
}
const refusing ={ getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };

// #130: a tiny "new" tag for 7 days after a feature ships, until this viewer has used it.
describe('what just shipped', () => {
  test('new from its ship day for 7 days, then not; never before it ships, never for a key nobody listed', () => {
    assert.equal(isNew('x', { now: at, shipped }), true, 'day 0');
    assert.equal(isNew('x', { now: at + 6 * DAY, shipped }), true, 'day 6');
    assert.equal(isNew('x', { now: at + 7 * DAY, shipped }), false, 'day 7: gone');
    assert.equal(isNew('x', { now: at + 8 * DAY, shipped }), false, 'day 8');
    assert.equal(isNew('x', { now: at - 1, shipped }), false, 'not before it ships');
    assert.equal(isNew('no-such-feature', { now: at }), false, 'unknown key');
  });

  test('once used, not new for this viewer, and that is remembered', () => {
    const store = memory();
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(store) }), true);
    markSeen('x', store);
    markSeen('x', store);
    assert.deepEqual(seenNew(store), ['x'], 'kept once');
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(store) }), false);
  });

  test('a browser that refuses storage still renders: nothing is seen, so the tag shows', () => {
    assert.deepEqual(seenNew(refusing), []);
    assert.doesNotThrow(() => markSeen('x', refusing));
    assert.equal(isNew('x', { now: at, shipped, seen: seenNew(refusing) }), true);
    // No store given and none in this runtime (or one whose very access throws): still nothing seen, no throw.
    assert.deepEqual(seenNew(), []);
    assert.doesNotThrow(() => markSeen('x'));
  });

  test('every listed key has a real date and is used by some element in the app', () => {
    // The page and the pure modules it renders with (e.g. web/milestones.js, web/groupline.js).
    const web = new URL('../web/', import.meta.url);
    const app = readdirSync(web, { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, web), 'utf8')).join('\n');
    assert.ok(Object.keys(NEW).length >= 2);
    for (const [key, date] of Object.entries(NEW)) {
      assert.match(date, /^\d{4}-\d{2}-\d{2}$/, key);
      // A Settings row takes its key last and puts data-new on its name (#721).
      assert.ok(app.includes(`data-new="${key}"`) || app.includes(`, '${key}')}`), `${key} marks an element`);
    }
  });

  // #314: the tag is a button of its own; tapping it dismisses it and never reaches the feature it sits on.
  test('a tag sits beside its feature (never inside a button or link) as a "Dismiss new tag" button', () => {
    const { doc, btn, span } = page();
    markNew(doc, { now: at, store: memory() });
    assert.ok(span.classList.contains('is-new'));
    const tag = btn.nextElementSibling;
    assert.equal(tag?.tagName, 'BUTTON', 'right after the feature\'s button, not inside it');
    assert.equal(tag.parentNode, btn.parentNode);
    assert.equal(tag.className, 'new-tag');
    assert.equal(tag.type, 'button');
    assert.equal(tag.attrs['aria-label'], 'Dismiss new tag');
    assert.equal(tag.title, 'Dismiss');
    assert.equal(tag.textContent, 'new');
    assert.equal(tag.style.get('position-anchor'), span.style.get('anchor-name'), 'anchored over the tagged element');
    markNew(doc, { now: at, store: memory() });
    assert.equal(btn.parentNode.children.filter((c) => c.className === 'new-tag').length, 1, 'redrawing adds no second tag');
  });

  test('tapping the tag retires it at once, without firing the feature\'s action', () => {
    const { doc, btn, span } = page();
    const store = memory();
    markNew(doc, { now: at, store });
    const tag = btn.nextElementSibling;
    doc.activeElement = tag;
    const fired = [];
    const e = { target: tag, preventDefault: () => fired.push('prevented'), stopPropagation: () => fired.push('stopped') };
    assert.equal(dismissNew(e, { root: doc, now: at, store }), true);
    assert.deepEqual(fired, ['prevented', 'stopped'], 'the click goes no further: the data-action handler never sees it');
    assert.deepEqual(seenNew(store), ['home']);
    assert.ok(!span.classList.contains('is-new'));
    assert.ok(!btn.parentNode.children.includes(tag), 'the tag is gone');
    assert.equal(doc.focused, btn, 'the keyboard lands back on the feature');
    // A click anywhere else is left alone, for the feature (and the use-retires-it rule) to handle.
    assert.equal(dismissNew({ target: span }, { root: doc, now: at, store }), false);
  });

  test('after 7 days the tag goes, dismissed or not', () => {
    const { doc, btn } = page();
    markNew(doc, { now: at + 6 * DAY, store: memory() });
    assert.equal(btn.nextElementSibling?.className, 'new-tag', 'day 6');
    markNew(doc, { now: at + 7 * DAY, store: memory() });
    assert.equal(btn.nextElementSibling, null, 'day 7: gone');
  });

  // #721: a tag says "new" only while it's rare.
  test('a screen shows at most 3 tags, the most recently shipped first; the next shows once one is dismissed', () => {
    const doc = { activeElement: null, createElement: (t) => new El(t, doc) };
    const row = new El('div', doc);
    // In the page's order, not the order they shipped; the same feature twice; one not drawn (a closed fold).
    const keys = ['home', 'one-name', 'appearance', 'needs-rank', 'retire-in-menu', 'needs-rank', 'question-numbers'];
    const els = keys.map((k) => { const s = new El('span', doc); s.dataset.new = k; row.append(s); return s; });
    els[6].getClientRects = () => [];
    doc.querySelectorAll = (sel) => [...row.all()].filter((el) => (sel === '.new-tag' ? el.className === 'new-tag' : el.dataset.new));
    const tagged = () => row.children.filter((c) => c.className === 'new-tag').map((t) => t.dataset.newTag);
    const now = Date.parse('2026-11-02T12:00:00Z'), store = memory();
    markNew(doc, { now, store });
    assert.deepEqual(tagged().sort(), ['appearance', 'one-name', 'retire-in-menu'], 'the newest three that are drawn; on one day, the later listed');
    assert.ok(!els[0].classList.contains('is-new'), 'the rest wait, with no pill either');
    dismissNew({ target: els[1].nextElementSibling, preventDefault() {}, stopPropagation() {} }, { root: doc, now, store });
    assert.deepEqual(tagged().sort(), ['appearance', 'needs-rank', 'retire-in-menu'], 'the next one takes its place');
    assert.equal(row.children.filter((c) => c.dataset.newTag === 'needs-rank').length, 1, 'a feature drawn twice is tagged once');
  });

  test('with a dialog open, the dialog is the screen: only its features are tagged', () => {
    const doc = { activeElement: null, createElement: (t) => new El(t, doc) };
    const page = new El('div', doc), dialog = new El('div', doc);
    for (const [k, at] of [['one-name', page], ['setup-folded', dialog]]) { const s = new El('span', doc); s.dataset.new = k; at.append(s); }
    const within = (root) => (sel) => [...root.all()].filter((el) => (sel === '.new-tag' ? el.className === 'new-tag' : el.dataset.new));
    dialog.querySelectorAll = within(dialog);
    doc.querySelectorAll = (sel) => [...within(page)(sel), ...within(dialog)(sel)];
    doc.querySelector = (sel) => (sel === '#modal:not([hidden])' ? dialog : null);
    markNew(doc, { now: Date.parse('2026-11-02T12:00:00Z'), store: memory() });
    assert.deepEqual(dialog.children.filter((c) => c.className === 'new-tag').map((t) => t.dataset.newTag), ['setup-folded']);
    assert.equal(page.children.filter((c) => c.className === 'new-tag').length, 0, 'nothing behind the dialog');
  });

  test('in dialogs a tag belongs to a row\'s label, never the whole row or block', () => {
    const actions = readFileSync(new URL('../web/actions.js', import.meta.url), 'utf8');
    const copy = readFileSync(new URL('../web/copy.js', import.meta.url), 'utf8');
    for (const src of [actions, copy]) assert.doesNotMatch(src, /<(div|details|fieldset|label)[^>]*data-new=/, 'data-new on a row-wide element');
    for (const key of ['security-reviews', 'releases', 'live-view']) assert.match(actions, new RegExp(`'${key}'\\)\\}`), `${key} passed to its row`);
    assert.match(actions, /<span data-new="\$\{shipped\}">\$\{name\}<\/span>/, 'the row wraps its name');
  });

  test('the pill sits clear of its feature\'s text: just above the corner, never over the word', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.new-tag \{[^}]*bottom: calc\(anchor\(top, 9999px\) \+ 1px\)/);
    assert.match(css, /\.is-new::after \{[^}]*bottom: calc\(100% \+ 1px\)/);
  });

  test('the pill takes no room (absolutely positioned) and its text meets WCAG AA on its own background', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.new-tag \{[^}]*position: absolute/);
    assert.match(css, /\.is-new::after \{[^}]*position: absolute/, 'the old pill, where anchors are missing');
    assert.match(css, /@media \(pointer: coarse\) \{ \.new-tag::before \{ content: ''; position: absolute; inset: -30px -8px 0; \}/,
      'on touch the target reaches 44px up and out, never down over the feature');
    const v = (name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
    const lum = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    assert.ok(ratio(v('agents'), v('agents-tint')) >= 4.5, `contrast ${ratio(v('agents'), v('agents-tint')).toFixed(2)}`);
  });
});
