import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { foldable, foldedNow, keep } from '../web/fold.js';
import { morph } from '../web/morph.js';
import { documentOf } from './minidom.js';

const sec = (n) => `<section class="sec"><header><h2>Up next</h2><span class="count">${n}</span><span class="hint">ready for any agent</span></header><div class="rows"><div data-item="#1">one</div></div></section>`;
const el = (root, pred) => root.all().find(pred);

describe('sections fold away (#809)', () => {
  test('the heading is a button with aria-expanded; the count and hint stay in the header', () => {
    const html = foldable(sec(13), new Set());
    assert.match(html, /<h2><button type="button" class="fold" data-action="fold" data-fold="up-next" aria-expanded="true">/);
    assert.match(html, /<\/h2><span class="count">13<\/span><span class="hint">ready for any agent<\/span><\/header><div class="fold-body">/);
  });

  test('a folded section says so, keeps its heading, count and hint, and shuts its body', () => {
    const html = foldable(sec(13), new Set(['up-next']));
    assert.match(html, /class="sec foldable folded"/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /<span class="count">13<\/span>/);
    assert.match(html, /<div class="fold-body" inert>/);
  });

  test('markup without a heading is left as it is', () => {
    const zero = '<section class="sec"><div class="zero">Nothing</div></section>';
    assert.equal(foldable(zero, new Set()), zero);
  });

  test('a heading keeps its own attributes, so the "new" tag still finds it', () => {
    assert.match(foldable('<section class="sec"><header><h2 data-new="x">Needs you</h2></header><p>a</p></section>', new Set()), /<h2 data-new="x"><button/);
  });

  test('the state is saved in this browser and read back', () => {
    const mem = new Map();
    globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    try {
      keep(new Set(['flow', 'runners']));
      assert.equal(mem.get('nuworq:folded'), '["flow","runners"]');
      assert.deepEqual([...foldedNow()], ['flow', 'runners']);
      mem.set('nuworq:folded', 'not json');
      assert.deepEqual([...foldedNow()], [], 'a bad value reads as nothing folded');
    } finally { delete globalThis.localStorage; }
  });

  test('a live update to a folded section leaves it folded, with its count updated, in the same nodes', () => {
    const shut = new Set(['up-next']);
    const doc = documentOf(foldable(sec(13), shut));
    const root = doc.body;
    const section = root.firstChild, button = el(root, (e) => e.nodeName === 'BUTTON');
    morph(root, foldable(sec(14), shut));
    assert.equal(root.firstChild, section);
    assert.equal(el(root, (e) => e.nodeName === 'BUTTON'), button);
    assert.match(section.getAttribute('class'), /\bfolded\b/);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(el(root, (e) => e.getAttribute('class') === 'count').textContent, '14');
  });

  test('unfolding changes the same section in place: a class and aria-expanded, so the height can animate', () => {
    const doc = documentOf(foldable(sec(13), new Set(['up-next'])));
    const root = doc.body, section = root.firstChild;
    morph(root, foldable(sec(13), new Set()));
    assert.equal(root.firstChild, section);
    assert.doesNotMatch(section.getAttribute('class'), /folded/);
    assert.equal(el(root, (e) => e.nodeName === 'BUTTON').getAttribute('aria-expanded'), 'true');
  });

  test('the style: about 150ms, no fade, instant with reduced motion', () => {
    const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.sec\.foldable > \.fold-body \{[^}]*grid-template-rows 150ms/);
    assert.doesNotMatch(css.match(/\.sec\.foldable > \.fold-body \{[^}]*\}/)[0], /opacity/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.sec \.fold \.chev[^}]*transition: none/);
  });

  test('the project page and the home fold their sections; the fold action saves and redraws', () => {
    const main = readFileSync(new URL('../web/views/main.js', import.meta.url), 'utf8');
    assert.match(main, /foldable\(s\[k\], S\.folded\)/);
    assert.match(main, /fold: \(x\) => foldable\(x, S\.folded\)/);
    assert.match(readFileSync(new URL('../web/home.js', import.meta.url), 'utf8'), /\.map\(fold\)/);
    assert.match(readFileSync(new URL('../web/actions.js', import.meta.url), 'utf8'), /fold: \(el\) => \{ toggleIn\('folded', el\.dataset\.fold\); keep\(S\.folded\)/);
  });
});
