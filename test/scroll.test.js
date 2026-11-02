import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveScroll, restoreScroll, keepScroll } from '../web/scroll.js';
import { appSource } from './appsource.js';

// Just enough of a page for layout: boxes stack their children 40px apiece, a box's rows sit where its scroll puts
// them, and the page itself (scrollingElement) is a box at the top of the screen.
const ROW = 40;
function el({ id = '', scroll, item, kids = [] } = {}) {
  const e = {
    id, kids, parent: null, scrollTop: 0, scrollLeft: 0,
    dataset: { ...(scroll ? { scroll } : {}), ...(item ? { item } : {}) },
    contains(x) { for (let p = x; p; p = p.parent) if (p === this) return true; return false; },
    all() { return this.kids.flatMap((k) => [k, ...k.all()]); },
    querySelectorAll(sel) {
      const want = sel.includes('[data-item]') ? (x) => x.dataset.item || x.id : (x) => x.dataset.scroll || x.id;
      return this.all().filter(want);
    },
    // Where it sits on screen: its place in its parent, less the parent's scroll, plus where the parent sits.
    getBoundingClientRect() {
      if (!this.parent) return { top: 0, bottom: 1000, height: 1000 };
      const p = this.parent.getBoundingClientRect();
      const top = p.top + this.parent.kids.indexOf(this) * ROW - this.parent.scrollTop;
      return { top, bottom: top + ROW, height: ROW };
    },
  };
  for (const k of kids) k.parent = e;
  return e;
}
const list = (n, from = 1) => Array.from({ length: n }, (_, i) => el({ item: `#${from + i}` }));
const docOf = (page) => ({ scrollingElement: page, querySelectorAll: (s) => page.querySelectorAll(s) });
const find = (page, key) => page.all().find((x) => x.dataset.scroll === key || `#${x.id}` === key);

describe('a redraw keeps every place', () => {
  test('after render({ force: true }) the side column, the rail, the drawer and the page are where they were', () => {
    const make = () => el({ kids: [
      el({ id: 'rail', kids: list(30, 100) }),
      el({ id: 'main', kids: [el({ scroll: 'side:p:nuworq', kids: list(30) })] }),
      el({ id: 'drawer', kids: list(30, 200) }),
    ] });
    const page = make();
    const doc = docOf(page);
    page.scrollTop = 80;
    find(page, '#rail').scrollTop = 120;
    find(page, 'side:p:nuworq').scrollTop = 400;
    find(page, '#drawer').scrollTop = 200;
    const saved = saveScroll(doc);
    // The redraw: every box replaced by a fresh one at the top; the page keeps its own scroll.
    const next = make();
    next.scrollTop = 0;
    restoreScroll(docOf(next), saved);
    assert.equal(next.scrollTop, 80, 'the page');
    assert.equal(find(next, '#rail').scrollTop, 120, 'the rail');
    assert.equal(find(next, 'side:p:nuworq').scrollTop, 400, 'the side column');
    assert.equal(find(next, '#drawer').scrollTop, 200, 'the drawer');
  });

  test('rows added above the one in view: it stays at the same place on screen, not the same offset', () => {
    let side = el({ scroll: 'side:p:nuworq', kids: list(30, 10) });
    let page = el({ kids: [side] });
    side.scrollTop = 200; // #15 is at the top of the column
    const saved = saveScroll(docOf(page));
    assert.equal(saved.find((s) => s.key === 'side:p:nuworq').anchors[0].key, 'item:#15');
    // Three new items arrive above it.
    side = el({ scroll: 'side:p:nuworq', kids: [...list(3, 1), ...list(30, 10)] });
    page = el({ kids: [side] });
    restoreScroll(docOf(page), saved);
    assert.equal(side.scrollTop, 200 + 3 * ROW);
    const top = side.kids.find((k) => k.dataset.item === '#15').getBoundingClientRect().top - side.getBoundingClientRect().top;
    assert.equal(top, 0, '#15 still at the top of what you see');
  });

  test('rows removed above: the row in view comes up with them', () => {
    let side = el({ scroll: 's', kids: list(30, 10) });
    side.scrollTop = 220; // part-way through #15
    const saved = saveScroll(docOf(el({ kids: [side] })));
    side = el({ scroll: 's', kids: list(25, 15) });
    restoreScroll(docOf(el({ kids: [side] })), saved);
    assert.equal(side.scrollTop, 20);
  });

  test('an agent claims the row at the top of the view: it moves to a section above, and the list stays put (#378)', () => {
    // Active above Ready; you're reading Ready from #15. An agent claims #15: it leaves Ready and joins Active.
    let page = el({ kids: [...list(5, 1), ...list(30, 10)] });
    page.scrollTop = 10 * ROW; // #15 at the top of the screen
    const saved = saveScroll(docOf(page));
    assert.equal(saved[0].anchors[0].key, 'item:#15');
    page = el({ kids: [...list(5, 1), el({ item: '#15' }), ...list(30, 10).filter((r) => r.dataset.item !== '#15')] });
    page.scrollTop = 10 * ROW;
    restoreScroll(docOf(page), saved);
    const top = page.kids.find((k) => k.dataset.item === '#16').getBoundingClientRect().top;
    assert.equal(top, ROW, '#16 is still the second row on screen, not thrown up to where #15 went');
  });

  test('rows that stayed together count as one even when layout puts them a pixel apart (#378)', () => {
    // A column three rows tall, showing #15, #16, #17. #15 is claimed and moves up; #16 and #17 stay, but layout
    // puts #17 at a fraction, so their shifts differ by half a pixel. Two of three still agree.
    const column = (kids) => {
      const side = el({ scroll: 's', kids });
      side.getBoundingClientRect = () => ({ top: 0, bottom: 3 * ROW, height: 3 * ROW });
      el({ kids: [side] });
      return side;
    };
    let side = column(list(30, 10));
    side.scrollTop = 5 * ROW;
    const saved = saveScroll(docOf(side.parent));
    assert.deepEqual(saved[0].anchors.map((a) => a.key), ['item:#15', 'item:#16', 'item:#17']);
    side = column([el({ item: '#15' }), ...list(30, 10).filter((r) => r.dataset.item !== '#15')]);
    const r17 = side.kids.find((k) => k.dataset.item === '#17'), at = r17.getBoundingClientRect.bind(r17);
    r17.getBoundingClientRect = () => { const r = at(); return { ...r, top: r.top + 0.5, bottom: r.bottom + 0.5 }; };
    side.scrollTop = 5 * ROW;
    restoreScroll(docOf(side.parent), saved);
    assert.equal(side.scrollTop, 5 * ROW, '#16 and #17 stay where they were, not thrown down to where #15 went');
  });

  test('a row it was anchored to is gone: the area keeps its offset', () => {
    let side = el({ scroll: 's', kids: list(30, 10) });
    side.scrollTop = 200;
    const saved = saveScroll(docOf(el({ kids: [side] })));
    side = el({ scroll: 's', kids: list(30, 50) });
    restoreScroll(docOf(el({ kids: [side] })), saved);
    assert.equal(side.scrollTop, 200);
  });

  test('another page or dialog has another key, so it starts at the top', () => {
    let side = el({ scroll: 'side:p:a', kids: list(30) });
    side.scrollTop = 200;
    const saved = saveScroll(docOf(el({ kids: [side] })));
    side = el({ scroll: 'side:p:b', kids: list(30) });
    restoreScroll(docOf(el({ kids: [side] })), saved);
    assert.equal(side.scrollTop, 0);
  });

  test('the page anchors to its own rows, not ones inside an area that scrolls on its own', () => {
    const page = el({ kids: [el({ id: 'drawer', kids: list(30, 200) }), ...list(30)] });
    page.scrollTop = 120;
    find(page, '#drawer').scrollTop = 400;
    const saved = saveScroll(docOf(page));
    assert.equal(saved.find((s) => s.key === 'page').anchors[0].key, 'item:#3');
  });

  test('the page anchors to a row in <main>, never the sticky rail beside it', () => {
    const make = (extra) => {
      const main = el({ id: 'main', kids: [...list(extra, 90), ...list(30)] });
      main.tag = 'main';
      const rail = el({ id: 'rail', kids: list(5, 100) });
      rail.getBoundingClientRect = () => ({ top: 0, bottom: 1000, height: 1000 }); // sticky: always in view
      return el({ kids: [rail, main] });
    };
    const withMain = (page) => ({ ...docOf(page), querySelector: (s) => (s === 'main' ? page.all().find((x) => x.tag === 'main') : null) });
    let page = make(0);
    page.scrollTop = 200;
    const saved = saveScroll(withMain(page));
    assert.match(saved.find((s) => s.key === 'page').anchors[0].key, /^item:#\d$/, 'a row of the page, not #100 in the rail');
    page = make(2);
    page.scrollTop = 200;
    restoreScroll(withMain(page), saved);
    assert.equal(page.scrollTop, 280, 'two rows arrived above: the page moves down with the row you were on');
  });

  test('keepScroll runs the redraw between saving and restoring', () => {
    const page = el({ kids: [el({ id: 'rail', kids: list(30) })] });
    const doc = docOf(page);
    find(page, '#rail').scrollTop = 80;
    keepScroll(doc, () => { const r = el({ id: 'rail', kids: list(30) }); r.parent = page; page.kids = [r]; });
    assert.equal(find(page, '#rail').scrollTop, 80);
  });
});

describe('the app keeps places', () => {
  const app = appSource();
  test('render() and dialogs redraw through keepScroll; the side column has a key per page', () => {
    assert.match(app, /keepScroll\(document, \(\) => \{ \/\/ every scrolled area/);
    assert.match(app, /keepScroll\(document, \(\) => \{ m\.innerHTML = `<div class="dialog" data-scroll=/);
    assert.match(readFileSync(new URL('../web/home.js', import.meta.url), 'utf8'), /class="col-side" data-scroll="side:\$\{page\}"/);
  });
});
