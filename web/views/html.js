// What every view writes markup with (#602): escaping, plurals, markdown, times, the window's widths. Reads no state.
import { ago } from '../ago.js';
import { commandBlocks } from '../copy.js';

export const Z = { '30s': 0, '5m': 1, '30m': 2 };
// Wide enough for two columns (#141); crossing it re-lays the page out (keep in step with style.css).
// (Outside a browser, as in the tests, a query matches nothing.)
const media = (q) => globalThis.matchMedia?.(q) ?? { matches: false, addEventListener() {} };
export const WIDE = media('(min-width: 1024px)');
// A keyboard, a mouse and room: only then does a keyboard hint fit in the copy (cf. .kbd-hint in style.css).
export const KEYBOARD = media('(hover: hover) and (pointer: fine) and (min-width: 421px)');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const needYou = (n) => `${plural(n, 'thing')} ${n === 1 ? 'needs' : 'need'} you`;
export const MAC = /Mac|iP(hone|ad)/.test(navigator.platform);

// A flag in a sentence or in inline code stays whole on a phone (#716): a line never ends in "--" or "--can-".
const FLAG = /(^|[\s(])(--[A-Za-z][\w-]*)/g;
export const flags = (h) => h.replace(FLAG, '$1<span class="flag">$2</span>');
const codeOnly = (h) => h.replace(/`([^`\n]+)`|[^`]+/g, (m, code) => (code != null ? `<code>${flags(code)}</code>` : flags(m)));
export const inline = (t) => codeOnly(esc(t));

const MD_INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(^|[\s(])(https?:\/\/[^\s<)]+)|(^|[\s(])(--[A-Za-z][\w-]*)/gm;

export function md(text) {
  if (!text) return '';
  const blocks = [];
  let s = String(text).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  // One pass: each piece of text becomes code, bold, a link or an address once, and markup made here is never
  // scanned again (a URL inside a link's address would otherwise close its href early).
  const a = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  s = esc(s).replace(MD_INLINE, (m, code, bold, label, href, lead, url, flagLead, flag) =>
    code != null ? `<code>${flags(code)}</code>` : bold != null ? `<strong>${codeOnly(bold)}</strong>` : label != null ? a(href, codeOnly(label))
      : url != null ? `${lead}${a(url, url)}` : `${flagLead}<span class="flag">${flag}</span>`);
  return s.split(/\n{2,}/).map((par) => {
    const ls = par.split('\n');
    const bullet = /^\s*([-*•]|\d+\.)\s+/;
    if (ls.every((l) => bullet.test(l))) return `<ul>${ls.map((l) => `<li>${l.replace(bullet, '')}</li>`).join('')}</ul>`;
    return `<p>${ls.join('<br>')}</p>`;
  }).join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

export function providerOf(model = '') {
  const m = (model || '').toLowerCase();
  if (!m) return '';
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(m)) return 'Anthropic';
  if (/gpt|openai|codex|^o\d/.test(m)) return 'OpenAI';
  if (/gemini/.test(m)) return 'Google';
  return 'Open-weight';
}
// An empty section: one line on why it's empty, and the one thing to do about it.
export const zero = (why, action = '') => `<div class="zero"><span class="check">→</span><div>${why}${action ? ` ${action}` : ''}</div></div>`;
// A question's number (#710), quiet beside its item's ref: what agents and the hub call it, and what ⌘K finds.
export const qref = (id) => `<span class="qref" title="Question ${esc(id)}: ⌘K finds it as q${esc(id)}">Q${esc(id)}</span>`;
export const refLink = (ref) => (ref ? `<a class="ref" data-action="open" data-item="${esc(ref)}">${esc(ref)}</a>` : '');
// A step's place: a URL opens in a new tab; commands each get their own Copy, joined by their words (#379).
export const stepWhere = (where) => (!where ? '' : /^https?:\/\/\S+$/i.test(where.trim())
  ? `<a class="step-where" href="${esc(where.trim())}" target="_blank" rel="noopener">${esc(where.trim())}</a>`
  : commandBlocks(where));

// The repository an item lands in, when its project has several (the hub sends null otherwise).
export const repoTag = (i) => i.repo ? ` <span class="tag" title="Lands in this repository">${esc(i.repo)}</span>` : '';

// A relative time from the hub that keeps ticking (#530): o[at] is when (ms), o[key] the hub's own string, shown
// if a view from an older hub has no time. left: a time still to come (a lease, a pause).
export const when = (o, key = 'ago', at = 'at', left = false) => ago(o?.[at], { left, fallback: esc(o?.[key]) });
export const stageAge = (it) => when(it, 'in_stage', 'stage_since');

// What git says the worker committed, read by the hub from the repo at submit time.
export function commits(g) {
  if (!g?.commits?.length) return '';
  return `<div class="evidence" title="Read from the repo when the work was submitted"><span class="age">On <code>${esc(g.branch)}</code>:</span>${g.commits.map((c) => `<span class="ev"><code>${esc(c.hash)}</code> ${esc(c.subject)}</span>`).join('')}</div>`;
}
