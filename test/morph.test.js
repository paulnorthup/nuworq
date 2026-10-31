import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { morph } from '../web/morph.js';
import { documentOf } from './minidom.js';

const rows = (...ids) => `<h2>Ready</h2><ul>${ids.map((id) => `<li data-item="#${id}"><b>#${id}</b> <span class="t">Item ${id}</span></li>`).join('')}</ul>`;
const page = (html) => { const doc = documentOf(html); return { doc, root: doc.body }; };
const byItem = (root) => new Map(root.all().filter((e) => e.getAttribute('data-item')).map((e) => [e.getAttribute('data-item'), e]));

describe('a redraw changes only what changed (#392)', () => {
  test('the same markup again: every node stays the same node, and nothing is touched', () => {
    const { doc, root } = page(rows(1, 2, 3));
    const before = root.all();
    morph(root, rows(1, 2, 3));
    assert.deepEqual(root.all(), before, 'the same nodes, in the same order');
    assert.deepEqual(doc.ops, [], 'no insert, no removal');
    assert.equal(root.innerHTML, rows(1, 2, 3));
  });

  test('one number changes: only that text node changes; its element and every other node are the same', () => {
    const html = (n) => `<div id="counts"><span class="badge">${n}</span><span>needs you</span></div>${rows(1, 2)}`;
    const { doc, root } = page(html(2));
    const before = root.all(), text = root.all()[1].firstChild;
    morph(root, html(3));
    assert.deepEqual(root.all(), before);
    assert.equal(root.all()[1].firstChild, text, 'the text node itself, given its new value');
    assert.equal(text.nodeValue, '3');
    assert.deepEqual(doc.ops, []);
  });

  test('an attribute that changed is set, one that went is removed, the element stays', () => {
    const { root } = page('<a class="rail-item on" href="#/p/a" title="x">A</a>');
    const a = root.firstChild;
    morph(root, '<a class="rail-item" href="#/p/a">A</a>');
    assert.equal(root.firstChild, a);
    assert.equal(a.getAttribute('class'), 'rail-item');
    assert.equal(a.hasAttribute('title'), false);
  });

  test('a new row appears in place: the rows around it are the same nodes, and it is the only insert', () => {
    const { doc, root } = page(rows(1, 3));
    const before = byItem(root);
    morph(root, rows(1, 2, 3));
    const after = byItem(root);
    assert.equal(after.get('#1'), before.get('#1'));
    assert.equal(after.get('#3'), before.get('#3'));
    assert.deepEqual([...after.keys()], ['#1', '#2', '#3'], 'in its place');
    assert.deepEqual(doc.ops.map(([op, n]) => [op, n.getAttribute?.('data-item')]), [['insert', '#2']]);
  });

  test('a removed row disappears in place: the rows after it are not moved, only it is removed', () => {
    const { doc, root } = page(rows(1, 2, 3, 4));
    const before = byItem(root);
    morph(root, rows(1, 3, 4));
    const after = byItem(root);
    for (const id of ['#1', '#3', '#4']) assert.equal(after.get(id), before.get(id), id);
    assert.deepEqual(doc.ops.map(([op, n]) => [op, n.getAttribute?.('data-item')]), [['remove', '#2']]);
  });

  test('a row that moved up the list is the same node, carried there', () => {
    const { root } = page(rows(1, 2, 3));
    const before = byItem(root);
    morph(root, rows(3, 1, 2));
    const after = byItem(root);
    assert.deepEqual([...after.keys()], ['#3', '#1', '#2']);
    for (const id of ['#1', '#2', '#3']) assert.equal(after.get(id), before.get(id), id);
    assert.equal(root.innerHTML, rows(3, 1, 2));
  });

  test('a different screen: what is left of the old one goes, and the result is exactly the new markup', () => {
    const { root } = page(`${rows(1, 2)}<p>Old</p><!-- c -->`);
    const next = '<div class="phead"><h1>nuworq</h1></div><section id="flow"><p>Flow</p></section>';
    morph(root, next);
    assert.equal(root.innerHTML, next);
  });

  test('a row\'s id is its key too, and a key seen twice is matched by place, not lost', () => {
    const { root } = page('<p id="a">A</p><p data-key="k">1</p><p data-key="k">2</p>');
    const [a, k1, k2] = root.children;
    morph(root, '<p data-key="k">1</p><p data-key="k">2</p><p id="a">A!</p>');
    assert.deepEqual(root.children, [k1, k2, a]);
    assert.equal(root.innerHTML, '<p data-key="k">1</p><p data-key="k">2</p><p id="a">A!</p>');
  });

  test('a <details> stays open or shut as the person left it', () => {
    const { root } = page('<details><summary>Detail</summary><pre>x</pre></details>');
    const d = root.firstChild;
    d.setAttribute('open', ''); // they opened it
    morph(root, '<details><summary>Detail</summary><pre>y</pre></details>');
    assert.equal(root.firstChild, d);
    assert.equal(d.hasAttribute('open'), true);
  });

  test('a box keeps what was typed in it unless the markup now says something else', () => {
    const { root } = page('<input data-draft="q" value="">');
    const box = root.firstChild;
    box.value = 'half-typed';
    morph(root, '<input data-draft="q" value="">');
    assert.equal(root.firstChild, box);
    assert.equal(box.value, 'half-typed');
    morph(root, '<input data-draft="q" value="saved">');
    assert.equal(box.value, 'saved');
  });

  test('nodes the page added itself (the "new" tags) are left where they are', () => {
    const { root } = page('<button data-new="home">Projects</button><button class="new-tag">new</button><p>1</p>');
    const tag = root.children[1];
    morph(root, '<button data-new="home">Projects</button><p>2</p>', { keep: (n) => n.classList.contains('new-tag') });
    assert.equal(root.children[1], tag);
    assert.equal(root.innerHTML, '<button data-new="home">Projects</button><button class="new-tag">new</button><p>2</p>');
  });
});

describe('the page', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  test('the rail, the page and the drawer are painted with morph, never replaced with innerHTML', () => {
    assert.match(app, /paint\(\$\('#main'\), /);
    assert.match(app, /paint\(\$\('#rail'\), `/);
    assert.match(app, /paint\(d, `/);
    assert.doesNotMatch(app, /\$\('#(rail|drawer)'\)\.innerHTML|\bd\.innerHTML/);
  });
});
