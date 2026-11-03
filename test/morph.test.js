import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { morph } from '../web/morph.js';
import { untimed } from '../web/ago.js';
import { documentOf } from './minidom.js';
import { appSource } from './appsource.js';

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

// The markup morph parses, as it parses it.
function parsedBy(doc) {
  const parsed = [], make = doc.createElement;
  doc.createElement = (tag) => {
    const el = make(tag);
    if (tag !== 'template') return el;
    const own = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'innerHTML');
    Object.defineProperty(el, 'innerHTML', { get: () => own.get.call(el), set: (h) => { parsed.push(h); own.set.call(el, h); } });
    return el;
  };
  return parsed;
}
const sec = (k, html) => `<!--sec:${k}-->${html}<!--/sec:${k}-->`;
const big = (n) => `<section class="sec"><h2>All work</h2>${rows(...Array.from({ length: n }, (_, i) => i + 1))}</section>`;

describe('a live update redraws only the sections whose markup changed (#682)', () => {
  const pageOf = (activity) => sec('needs', '<section class="sec"><div class="card">Verify #3</div></section>') + sec('activity', `<section class="sec"><p>${activity}</p></section>`) + sec('all', big(50));

  test('a section the same as last time is neither parsed nor touched: its nodes stay, only the changed one changes', () => {
    const { doc, root } = page('');
    const memory = new Map();
    morph(root, pageOf('#4 commented'), { memory });
    const before = root.all();
    const parsed = parsedBy(doc);
    morph(root, pageOf('#5 commented'), { memory });
    assert.deepEqual(root.all(), before, 'the same nodes, in the same order');
    assert.equal(root.innerHTML, pageOf('#5 commented'), 'the page reads as the new markup');
    assert.equal(parsed.length, 1);
    assert.doesNotMatch(parsed[0], /All work|Verify #3/, 'the unchanged sections were not parsed');
    assert.match(parsed[0], /#5 commented/);
    assert.equal(parsed[0].length < pageOf('').length / 10, true, `parsed ${parsed[0].length} of ${pageOf('').length} characters`);
  });

  test('without a memory, the same markup is parsed and compared whole, as before', () => {
    const { doc, root } = page(pageOf('a'));
    const parsed = parsedBy(doc);
    morph(root, pageOf('a'));
    assert.equal(parsed[0], pageOf('a'));
  });

  test('a section cleared from the page meanwhile is drawn from its markup after all', () => {
    const { root } = page('');
    const memory = new Map();
    morph(root, pageOf('a'), { memory });
    root.childNodes.length = 0; // a project switch empties the page first (web/router.js)
    morph(root, pageOf('a'), { memory });
    assert.equal(root.innerHTML, pageOf('a'));
  });

  test('a changed section never takes nodes from an unchanged one, wherever the sections move or go', () => {
    const { root } = page('');
    const memory = new Map();
    const a = sec('a', '<div>A</div><div>A2</div>'), b = sec('b', '<div>B</div>'), c = sec('c', '<div>C</div>');
    morph(root, a + b + c, { memory });
    const [bEl] = root.children.filter((e) => e.textContent === 'B');
    const grown = sec('a', '<div>A</div><div>A2</div><div>A3</div><div>A4</div>');
    morph(root, grown + b + c, { memory });
    assert.equal(root.innerHTML, grown + b + c);
    assert.equal(root.children.find((e) => e.textContent === 'B'), bEl, 'B is still its own node');
    morph(root, c + b, { memory }); // a gone, c moved ahead of b
    assert.equal(root.innerHTML, c + b);
    assert.equal(root.children.find((e) => e.textContent === 'B'), bEl);
    morph(root, c + sec('b', '<div>B!</div>') + a, { memory });
    assert.equal(root.innerHTML, c + sec('b', '<div>B!</div>') + a);
  });

  test('a section that differs only in its ticking times is alike: kept, as the tick keeps those times itself', () => {
    const { doc, root } = page('');
    const memory = new Map();
    const at = (t) => sec('agents', `<div class="agent">seen <span data-at="1000">${t}</span> ago</div>`) + sec('activity', `<p>${t}</p>`);
    morph(root, at('33s'), { memory, alike: untimed });
    const agent = root.children[0];
    const parsed = parsedBy(doc);
    morph(root, at('36s'), { memory, alike: untimed });
    assert.equal(root.children[0], agent);
    assert.doesNotMatch(parsed[0], /class="agent"/, 'the agents section was not parsed');
    assert.match(parsed[0], /<p>36s<\/p>/, 'a plain 36s is a real change');
  });

  // #747: widening the window put the unchanged pulse and Flow inside a new <aside>, as <!--same:…--> stand-ins
  // nothing drew, so the side column was empty until a reload.
  test('one column becoming two, and back, draws every section once, the unchanged ones too', () => {
    const { root } = page('');
    const memory = new Map();
    const s = { pulse: sec('pulse', '<div class="pulse">2 things need you</div>'), composer: sec('composer', '<div class="composer">Steer</div>'),
      needs: sec('needs', '<section class="sec"><div class="card">Verify #3</div></section>'), flow: sec('flow', '<section class="sec"><h2>Flow</h2></section>') };
    const narrow = s.pulse + s.needs + s.composer + s.flow;
    const wide = `<div class="cols"><div class="col-main">${s.composer}${s.needs}</div><aside class="col-side">${s.pulse}${s.flow}</aside></div>`;
    for (const html of [narrow, wide, narrow, wide, wide]) {
      morph(root, html, { memory });
      assert.equal(root.innerHTML, html, 'the page reads as its markup, every section in it once');
    }
  });

  test('the project page marks its sections, and the page region paints with a memory of them', () => {
    assert.match(readFileSync(new URL('../web/views/main.js', import.meta.url), 'utf8'), /<!--sec:\$\{k\}-->\$\{foldable\(s\[k\], S\.folded\)\}<!--\/sec:\$\{k\}-->/);
    assert.match(appSource(), /paint\(el, mainHtml\(\), mainSections\)/);
  });
});

describe('the page', () => {
  const app = appSource();
  test('the rail, the page and the drawer are painted with morph, never replaced with innerHTML', () => {
    assert.match(app, /paint\(el, railHtml\(\)\)/);
    assert.match(app, /paint\(el, mainHtml\(\)(, mainSections)?\)/);
    assert.match(app, /const el = \$\('#drawer'\), html = drawerHtml\(\)[^\n]*\n[^\n]*\n\s*if \(show\) paint\(el, html\);/);
    assert.doesNotMatch(app, /\$\('#(rail|drawer)'\)\.innerHTML|\bd\.innerHTML/);
  });
});
