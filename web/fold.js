// Sections fold away (#809): a section's heading is a button; folded, the section keeps its heading, count and hint
// and its body shuts. The state is per browser (web/prefs.js), by section name, the same for every project and depth.
import { store } from './prefs.js';

export const foldedNow = () => { try { const f = JSON.parse(store.get('folded', '[]')); return new Set(Array.isArray(f) ? f : []); } catch { return new Set(); } };
export const keep = (set) => store.set('folded', JSON.stringify([...set]));
const keyOf = (name) => name.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const HEAD = /^<section class="sec([^"]*)">\s*<header>\s*<h2([^>]*)>([\s\S]*?)<\/h2>([\s\S]*?)<\/header>([\s\S]*)<\/section>\s*$/;
// One section's markup, made foldable: a section without a heading is returned as it is. folded: the Set of keys shut.
export function foldable(html, folded) {
  const m = HEAD.exec(html);
  if (!m) return html;
  const [, cls, attrs, name, rest, body] = m;
  const key = keyOf(name);
  if (!key) return html;
  const shut = folded.has(key);
  return `<section class="sec${cls} foldable${shut ? ' folded' : ''}" data-fold="${key}"><header><h2${attrs}>`
    + `<button type="button" class="fold" data-action="fold" data-fold="${key}" aria-expanded="${!shut}"><svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>${name}</button></h2>${rest}</header>`
    + `<div class="fold-body"${shut ? ' inert' : ''}><div class="fold-in">${body}</div></div></section>`;
}
