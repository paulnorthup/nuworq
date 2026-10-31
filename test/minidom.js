// Just enough of a DOM for web/morph.js, without a browser: elements, text and comments, attributes, a template that
// parses the markup the app writes, and the tree operations morph uses (which count, so a test sees what moved).

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'wbr']);
const unesc = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

class Node {
  constructor(doc, type, name) { Object.assign(this, { ownerDocument: doc, nodeType: type, nodeName: name, parentNode: null, childNodes: [] }); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    this.ownerDocument.ops.push(['insert', n]);
    return n;
  }
  appendChild(n) { return this.insertBefore(n, null); }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; this.ownerDocument.ops.push(['remove', n]); return n; }
  get textContent() { return this.nodeType === 1 ? this.childNodes.map((c) => c.textContent).join('') : this.nodeValue; }
  set textContent(t) { this.childNodes = []; if (t) this.appendChild(this.ownerDocument.createTextNode(t)); }
}

class Element extends Node {
  constructor(doc, tag) { super(doc, 1, tag.toUpperCase()); this.attributes = []; }
  getAttribute(n) { return this.attributes.find((a) => a.name === n)?.value ?? null; }
  hasAttribute(n) { return this.attributes.some((a) => a.name === n); }
  setAttribute(n, v) { const a = this.attributes.find((x) => x.name === n); if (a) a.value = String(v); else this.attributes.push({ name: n, value: String(v) }); }
  removeAttribute(n) { this.attributes = this.attributes.filter((a) => a.name !== n); }
  get id() { return this.getAttribute('id') ?? ''; }
  get classList() { return { contains: (c) => (this.getAttribute('class') ?? '').split(/\s+/).includes(c) }; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get content() { return this; }
  set innerHTML(html) { this.childNodes = []; parse(this, html); }
  get outerHTML() {
    const attrs = this.attributes.map((a) => ` ${a.name}="${a.value}"`).join('');
    const tag = this.nodeName.toLowerCase();
    return VOID.has(tag) ? `<${tag}${attrs}>` : `<${tag}${attrs}>${this.innerHTML}</${tag}>`;
  }
  get innerHTML() { return this.childNodes.map((c) => (c.nodeType === 1 ? c.outerHTML : c.nodeType === 3 ? c.nodeValue : `<!--${c.nodeValue}-->`)).join(''); }
  // The elements under it, in order (no selectors: tests filter them).
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}

function parse(root, html) {
  const doc = root.ownerDocument, stack = [root];
  const re = /<!--([\s\S]*?)-->|<\/(\w+)\s*>|<(\w+)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    const top = stack.at(-1);
    if (m[1] != null) top.appendChild(doc.createComment(m[1]));
    else if (m[2]) { const i = stack.findLastIndex((e) => e.nodeName === m[2].toUpperCase()); if (i > 0) stack.length = i; }
    else if (m[3]) {
      const el = doc.createElement(m[3]);
      for (const a of m[4].matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el.setAttribute(a[1], unesc(a[2] ?? a[3] ?? a[4] ?? ''));
      top.appendChild(el);
      if (!VOID.has(m[3].toLowerCase())) stack.push(el);
    } else top.appendChild(doc.createTextNode(unesc(m[5])));
  }
  doc.ops.length = 0; // building the markup isn't a change to the page
}

export function documentOf(html = '') {
  const doc = {
    ops: [],
    createElement: (tag) => new Element(doc, tag),
    createTextNode: (t) => Object.assign(new Node(doc, 3, '#text'), { nodeValue: t }),
    createComment: (t) => Object.assign(new Node(doc, 8, '#comment'), { nodeValue: t }),
  };
  const body = doc.createElement('body');
  body.innerHTML = html;
  doc.body = body;
  return doc;
}
