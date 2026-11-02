// Feedback that reports the same thing arrives as one group (#688), so the owners decide each report once.
// What a piece is about: the items it names (#640), the error text it quotes, the nuworq tools it names (`next`),
// and its words. Two pieces are the same report when they quote the same error, or name the same item or tool
// and say much the same thing. A group is then matched against the feedback project's open items and recent
// fixes, so it says what's known, and comes with one suggested call. Pure functions: storage is directory.js's.
import { OPS } from './protocol.js';

const TOOLS = new Set(OPS.map((o) => o.name));
const STOP = new Set(('the and for that this with was were are but not you your its it\'s from have has had then than ' +
  'when what which who into onto out about there their they them would could should can\'t cannot don\'t didn\'t ' +
  'doesn\'t isn\'t wasn\'t won\'t just also again even still each every all any some one two our ours i\'m been being ' +
  'got get gets getting very more most much many here how why does did done same only other others over under').split(' '));
const norm = (s) => String(s ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').replace(/[\s.!?:;,]+$/, '').trim();
const stem = (w) => w.replace(/'s$/, '').replace(/(ing|ed|es|s)$/, '');

// What a text is about. item: the item an agent named with the feedback tool ("nuworq#640").
export function features(text, item = '') {
  const t = String(text ?? '');
  const refs = new Set([...`${t} ${item}`.matchAll(/#(\d+)\b/g)].map((m) => `#${m[1]}`));
  // A quote opens and closes with the same mark. Short code spans (`next`) go first, so the text between two of
  // them isn't read as one.
  const unspanned = t.replace(/`[^`\n]{0,11}`/g, ' ');
  const quotes = new Set([...unspanned.matchAll(/"([^"\n]{12,300})"|“([^“”\n]{12,300})”|`([^`\n]{12,300})`/g)].map((m) => norm(m[1] ?? m[2] ?? m[3])));
  const tools = new Set([
    ...[...t.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]),
    ...[...t.matchAll(/\b([a-z_]+) (?:tool|call)\b/gi)].map((m) => m[1].toLowerCase()),
    ...[...t.matchAll(/\b(?:call(?:ed|ing)?|ran) ([a-z_]+)\b/gi)].map((m) => m[1].toLowerCase()),
  ].filter((w) => TOOLS.has(w)));
  const words = new Set((norm(t).match(/[a-z][a-z0-9']{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem));
  return { refs, quotes, tools, words };
}

const shared = (a, b) => [...a].filter((x) => b.has(x)).length;
const overlap = (a, b) => (a.size && b.size ? shared(a, b) / Math.min(a.size, b.size) : 0);
const jaccard = (a, b) => (a.size || b.size ? shared(a, b) / new Set([...a, ...b]).size : 0);
const quoteIn = (q, text) => !!q && text.includes(q);

// Whether two pieces quote the same error: the surest sign they report the same thing.
export const sameQuote = (a, b) => [...a.quotes].some((q) => [...b.quotes].some((r) => quoteIn(q, r) || quoteIn(r, q)));

// Whether two pieces report the same thing.
export function sameReport(a, b) {
  if (sameQuote(a, b)) return true;
  const words = jaccard(a.words, b.words);
  if (shared(a.refs, b.refs) && (shared(a.tools, b.tools) || words >= 0.2)) return true;
  if (shared(a.tools, b.tools) && words >= 0.35) return true;
  return words >= 0.6;
}

// One feature set for a whole group: what any of its pieces says.
export function merge(list) {
  const all = { refs: new Set(), quotes: new Set(), tools: new Set(), words: new Set() };
  for (const f of list) for (const k of Object.keys(all)) for (const x of f[k]) all[k].add(x);
  return all;
}

// The open item or recent fix that covers a group, or null. items: the feedback project's, each with seq, title,
// summary, acceptance and stage. An item the reports name (the one they were on) isn't the fix; one that quotes
// their error, or names that item and shares their words, is.
export function knownFor(g, items) {
  let best = null;
  for (const it of items) {
    if (g.refs.has(`#${it.seq}`)) continue;
    const text = norm(`${it.title}\n${it.summary}\n${it.acceptance ?? ''}`);
    const mine = features(`${it.title} ${it.summary} ${it.acceptance ?? ''}`);
    let score = [...g.quotes].some((q) => quoteIn(q, text)) ? 3 : 0;
    if (shared(g.refs, mine.refs)) score += 2;
    score += 2 * overlap(features(it.title).words, g.words);
    if (score >= 2.5 && (!best || score > best.score)) best = { item: it, score };
  }
  return best?.item ?? null;
}

const WHERE = {
  proposed: "it's proposed", ready: "it's ready to build", active: "it's being built", verifying: "it's in review",
  landing: "it's landing", waiting: 'it waits on a person', outside: 'it waits on something outside', done: 'it landed',
};
// "#654 fixes this; it's in review."
export const knownLine = (it) => `#${it.seq} ${it.stage === 'done' ? 'fixed' : 'fixes'} this; ${WHERE[it.stage] ?? `it's ${it.stage}`}.`;

export const VAGUE_NOTE = "Thanks. We couldn't tell what got in your way: send it again with what you did and what happened.";

// The one call a group comes with: link it to what covers it, make it new work, or decline it with a note.
export function suggest(group, known) {
  if (known) return { action: 'link', ref: `#${known.seq}`, why: knownLine(known) };
  const words = merge(group.pieces.map((p) => features(p.text, p.item))).words;
  if (words.size < 4) return { action: 'decline', note: VAGUE_NOTE, why: 'Too short to act on: it doesn\'t say what happened.' };
  const n = new Set(group.pieces.map((p) => p.sender)).size;
  return { action: 'approve', why: `Nothing on the board covers it${n > 1 ? `, and ${n} sent it` : ''}.` };
}
