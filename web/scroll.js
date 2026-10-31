// Live updates never move what a person is reading (#376). A redraw replaces the page's HTML, and with it every
// area that scrolls on its own (the side column, the rail, the drawer, a dialog): each would start at the top again.
// This keeps where each one was, found again by a stable key (data-scroll, else id; the page itself is "page"),
// and anchors it to the row the person was looking at, so rows added or removed above don't push it away.
// Pure but for the document passed in, so it's tested without a browser.

// Rows a place is anchored to: anything that says which thing it shows.
const ROWS = '[data-item], [data-key], [id]';
const PAGE = 'page';

const keyOf = (el) => el.dataset?.scroll || (el.id ? `#${el.id}` : null);
const rowKey = (el) => (el.dataset?.item ? `item:${el.dataset.item}` : el.dataset?.key ? `key:${el.dataset.key}` : el.id ? `#${el.id}` : null);
const topOf = (doc, el) => (el === doc.scrollingElement ? 0 : el.getBoundingClientRect().top);
const contains = (doc, box, el) => box === doc.scrollingElement || box.contains(el);

// The rows inside box, in order, each with its key and which of that key it is (the same item can show twice).
// The page's rows are those in <main>: the rail beside it is sticky, so it doesn't move when the page scrolls.
function rows(doc, box) {
  const root = box === doc.scrollingElement ? doc.querySelector?.('main') ?? box : box;
  const seen = new Map();
  return [...root.querySelectorAll(ROWS)].map((el) => {
    const key = rowKey(el), n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return { el, key, n };
  });
}

// Before a redraw: every scrolled area with a key, its offset, and the first row in view with its place on screen.
export function saveScroll(doc) {
  const page = doc.scrollingElement;
  const boxes = [...doc.querySelectorAll('[data-scroll], [id]')].filter((el) => el !== page && keyOf(el) && (el.scrollTop > 0 || el.scrollLeft > 0));
  if (page && (page.scrollTop > 0 || page.scrollLeft > 0)) boxes.unshift(page);
  return boxes.map((box) => {
    const top = topOf(doc, box);
    // Its own rows only: not ones inside another area that scrolls (they move with that one).
    const inner = boxes.filter((b) => b !== box && contains(doc, box, b));
    const row = rows(doc, box).find(({ el, key }) => {
      if (!key || inner.some((b) => b.contains(el))) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && r.bottom > top;
    });
    return {
      key: box === page ? PAGE : keyOf(box), top: box.scrollTop, left: box.scrollLeft,
      anchor: row ? { key: row.key, n: row.n, at: row.el.getBoundingClientRect().top - top } : null,
    };
  });
}

// After a redraw: each area back where it was; then nudged so the row the person was on sits where it sat.
export function restoreScroll(doc, saved) {
  for (const s of saved ?? []) {
    const box = s.key === PAGE ? doc.scrollingElement : [...doc.querySelectorAll('[data-scroll], [id]')].find((el) => keyOf(el) === s.key);
    if (!box) continue;
    box.scrollTop = s.top;
    box.scrollLeft = s.left;
    if (!s.anchor) continue;
    const row = rows(doc, box).find((r) => r.key === s.anchor.key && r.n === s.anchor.n);
    if (row) box.scrollTop += row.el.getBoundingClientRect().top - topOf(doc, box) - s.anchor.at;
  }
}

// Redraw with fn, keeping every place.
export function keepScroll(doc, fn) {
  const saved = saveScroll(doc);
  fn();
  restoreScroll(doc, saved);
}
