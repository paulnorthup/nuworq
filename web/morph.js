// Live updates change only what changed, in place (#392). A redraw used to replace the rail, the page and the
// drawer with innerHTML, so everything blinked even when one number moved. morph() takes the new markup and changes
// only the elements, attributes and text that differ: an unchanged element stays the same node, a new row is put in
// where it belongs and a removed one taken out, and nothing else is touched. No animation, no dependencies.
// Pure but for the nodes passed in, so it's tested without a browser.

const ELEMENT = 1, TEXT = 3, COMMENT = 8;

// What says which thing an element shows, so it's found again when rows come and go around it.
const keyOf = (n) => {
  if (n.nodeType !== ELEMENT) return null;
  const k = n.getAttribute('id') || n.getAttribute('data-key') || n.getAttribute('data-item');
  return k ? `${n.nodeName}:${k}` : null;
};
const kids = (n) => { const out = []; for (let c = n.firstChild; c; c = c.nextSibling) out.push(c); return out; };

// Keys among siblings: a key seen twice keys only its first, the rest are matched by place.
function keyed(list) {
  const keys = new Map();
  for (const n of list) { const k = keyOf(n); if (k && !keys.has(k)) keys.set(k, n); }
  return keys;
}

// Sections (#682): markup between <!--sec:K--> and <!--/sec:K-->, siblings of one another. One that reads the same
// as at the last paint is neither parsed nor compared again: it stands as <!--same:K--> and its nodes stay as they are,
// so a live update on a big page costs what changed, not the whole page.
const SECTION = /<!--sec:([\w:-]+)-->([\s\S]*?)<!--\/sec:\1-->/g;
const sameKey = (n) => (n.nodeType === COMMENT && n.nodeValue.startsWith('same:') ? n.nodeValue.slice(5) : null);
// The old nodes of section k among siblings, its two markers included.
function rangeOf(list, k) {
  const at = list.findIndex((n) => n.nodeType === COMMENT && n.nodeValue === `sec:${k}`);
  const end = list.findIndex((n, i) => i > at && n.nodeType === COMMENT && n.nodeValue === `/sec:${k}`);
  return at >= 0 && end > at ? list.slice(at, end + 1) : null;
}

// Replace el's children with the markup in html, changing only what differs. What the page added itself (the "new"
// tags, web/new.js) stays for whatever added it to look after: keep(node) says which nodes, and adopt(old, new)
// copies what it set on an element onto that element's new markup, so it isn't taken off and put back.
// memory: a Map kept for el from paint to paint, of each section's markup as last painted. alike(markup) is what of it
// is compared: what the page keeps current itself (the ticking times, web/ago.js) can be left out.
export function morph(el, html, { keep = () => false, adopt = () => {}, memory = null, alike = (s) => s } = {}) {
  const same = new Map();
  if (memory) {
    const now = new Map();
    html = html.replace(SECTION, (whole, k, body) => {
      body = alike(body);
      now.set(k, body);
      if (memory.get(k) !== body) return whole;
      same.set(k, whole);
      return `<!--same:${k}-->`;
    });
    memory.clear();
    for (const [k, body] of now) memory.set(k, body);
  }
  const t = el.ownerDocument.createElement('template');
  t.innerHTML = html;
  morphChildren(el, t.content, { keep, adopt, same });
}

function morphChildren(from, to, own) {
  const want = kids(to);
  const wantKeys = keyed(want);
  const old = kids(from);
  // Nodes kept for the page count as already placed: never matched, moved or taken out.
  const used = new Set(old.filter((n) => n.nodeType === ELEMENT && own.keep(n)));
  // A section the same as last time holds its old nodes for its place: nothing else matches them.
  const held = new Map();
  for (const k of want.map(sameKey).filter(Boolean)) { const r = rangeOf(old, k); if (r) held.set(k, r); }
  const holding = new Set([...held.values()].flat());
  const have = keyed(old.filter((n) => !used.has(n) && !holding.has(n)));
  let cur = from.firstChild;
  // The next old node still in play: ones a new node took were moved before cur, keyed ones the new markup no
  // longer has are taken out as they're passed, so a removed row goes without the rows after it moving.
  const settle = () => {
    while (cur && (used.has(cur) || (keyOf(cur) && have.get(keyOf(cur)) === cur && !wantKeys.has(keyOf(cur))))) {
      const next = cur.nextSibling;
      if (!used.has(cur)) from.removeChild(cur);
      cur = next;
    }
  };
  for (const n of want) {
    settle();
    const s = sameKey(n);
    if (s != null && own.same.has(s)) {
      const range = held.get(s);
      if (!range) { // not on the page any more: drawn from its markup after all
        const t = from.ownerDocument.createElement('template');
        t.innerHTML = own.same.get(s);
        for (const c of kids(t.content)) from.insertBefore(c, cur);
        continue;
      }
      for (const c of range) {
        if (c === cur) cur = cur.nextSibling; else from.insertBefore(c, cur);
        used.add(c);
      }
      continue;
    }
    const k = keyOf(n) && wantKeys.get(keyOf(n)) === n ? keyOf(n) : null; // a second of a key is matched by place
    let match = k ? have.get(k) ?? null : null;
    if (!match) {
      // Not keyed (or keyed but new): the next old node of the same kind that isn't keyed to something else.
      // Text only ever matches the very next one, so it never pulls whitespace from further down.
      for (let c = cur; c; c = c.nextSibling) {
        if (used.has(c) || holding.has(c) || (keyOf(c) && have.get(keyOf(c)) === c)) continue;
        if (c.nodeType === n.nodeType && c.nodeName === n.nodeName) { match = c; break; }
        if (n.nodeType !== ELEMENT) break;
      }
    }
    if (match) {
      if (match !== cur) from.insertBefore(match, cur);
      else cur = cur.nextSibling;
      used.add(match);
      morphNode(match, n, own);
    } else {
      from.insertBefore(n, cur); // n leaves the parsed markup: nothing to copy
    }
  }
  settle();
  while (cur) { const next = cur.nextSibling; if (!used.has(cur)) from.removeChild(cur); cur = next; }
}

function morphNode(from, to, own) {
  if (from.nodeType === TEXT || from.nodeType === COMMENT) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  own.adopt(from, to); // what the page added to the element itself (a class, a style) goes onto the new markup
  const tag = from.nodeName;
  // A <details> stays open or shut as the person left it.
  const mine = (name) => tag === 'DETAILS' && name === 'open';
  const was = { value: from.getAttribute('value'), checked: from.hasAttribute('checked'), selected: from.hasAttribute('selected') };
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name) && !mine(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value && !mine(name)) from.setAttribute(name, value);
  // What a person set in a control is kept, unless the markup itself now says something else.
  if (tag === 'INPUT') {
    if (to.getAttribute('value') !== was.value) from.value = to.getAttribute('value') ?? '';
    if (to.hasAttribute('checked') !== was.checked) from.checked = to.hasAttribute('checked');
  } else if (tag === 'OPTION' && to.hasAttribute('selected') !== was.selected) {
    from.selected = to.hasAttribute('selected');
  }
  if (tag === 'TEXTAREA') {
    if (from.textContent !== to.textContent) { from.textContent = to.textContent; from.value = to.textContent; }
    return;
  }
  morphChildren(from, to, own);
}
