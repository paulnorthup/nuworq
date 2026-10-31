// Field notes stay few and relevant (#443). checkin, next and look give an agent at most NOTES_SHOWN of them,
// ranked by what it is working on: notes about its item first, then its parent's and siblings', then notes naming
// the paths it touches, then words shared with the item. Newer breaks ties. A person can mark up to ALWAYS_MAX notes
// always-show (a safety rule, say): those come first, whatever the work.
//
// Notes also get reviewed. When an item lands, the notes about it are due; once a week, every note older than a day
// is. The hub opens one "review the field notes" tidy job listing them (next offers it like the milestones' tidy
// job). Its holder merges duplicates and retires notes whose lesson is now in the code, the guide or a test, with
// the reason (retire), under "Run with it"; under lower autonomy it asks the person with one question listing them.
// Submitting the job marks every note it listed as reviewed, so a note is due again only when its item lands anew
// or a week passes.
import { DAY, SYSTEM } from './core.js';

export const NOTES_SHOWN = 10;
export const ALWAYS_MAX = 3;
export const NOTES_EVERY = 7 * 24 * 60 * 60_000; // a week (not 7 * DAY: core.js imports this module before DAY exists)

const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const pathOf = (t) => String(t ?? '').split(' (')[0].trim().replace(/^\.\//, '');
// Words too common here to say two things are about the same work.
const STOP = new Set(('that this with from when what then them they their there have does done into only once each every than '
  + 'make made your you work item items agent agents nuworq hub note notes need needs must should would could also just like '
  + 'before after while which where about other others more most some same here test tests file files').split(' '));
const wordsOf = (s) => new Set((String(s ?? '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((w) => !STOP.has(w)));

// What an agent is working on, from the items it holds or would be offered: their ids, their parents, the paths
// they touch and their words.
function workOf(hub, items) {
  const ids = new Set(), parents = new Set(), paths = new Set(), words = new Set();
  for (const i of items) {
    ids.add(i.id);
    if (i.parent_id) parents.add(i.parent_id);
    for (const t of json(i.touching, [])) { const x = pathOf(t); if (x) paths.add(x); }
    for (const w of wordsOf(`${i.title} ${i.summary ?? ''}`)) words.add(w);
  }
  return { ids, parents, paths: [...paths], words };
}

// How relevant one note is to that work: 0 when it shares nothing.
function score(n, work) {
  let s = 0;
  if (n.item_id && work.ids.has(n.item_id)) s += 8;
  else if (n.item_id && (work.parents.has(n.item_id) || (n.parent_id && work.parents.has(n.parent_id)))) s += 4;
  const body = n.body.toLowerCase();
  for (const x of work.paths) {
    const base = x.split('/').filter(Boolean).pop() ?? '';
    if (body.includes(x.toLowerCase()) || (base.length >= 4 && body.includes(base.toLowerCase()))) s += 5;
  }
  let shared = 0;
  for (const w of wordsOf(body)) if (work.words.has(w)) shared++;
  return s + Math.min(shared, 5);
}

const out = (n) => ({ id: n.id, note: n.body, by: n.author, about: n.seq ? `#${n.seq}` : undefined, always: n.always ? true : undefined });

const ACTIVE = `SELECT n.id, n.body, n.author, n.at, n.item_id, n.always, n.reviewed_at, i.seq, i.parent_id FROM notes n LEFT JOIN items i ON i.id = n.item_id
  WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at DESC, n.id DESC`;

// The field notes for an agent working on these items (none: the newest). { notes, hidden }: hidden counts the
// active notes left out. all: every active note, newest first (look { notes: "all" }).
export function fieldNotesFor(hub, p, items = [], { all = false } = {}) {
  const rows = hub.q(ACTIVE).all(p.id);
  if (all) return { notes: rows.map(out), hidden: 0 };
  const always = rows.filter((n) => n.always).slice(0, ALWAYS_MAX);
  const work = workOf(hub, items.filter(Boolean));
  // Sorting is stable, and rows come newest first: equal scores stay newest first.
  const rest = rows.filter((n) => !always.includes(n)).map((n) => ({ n, s: score(n, work) })).sort((a, b) => b.s - a.s).map((x) => x.n);
  const notes = [...always, ...rest].slice(0, NOTES_SHOWN);
  return { notes: notes.map(out), hidden: rows.length - notes.length };
}

// Marks a note always-show, or not. At most ALWAYS_MAX are.
export function setAlways(hub, n, on) {
  if (on && !n.always && hub.q(`SELECT COUNT(*) AS c FROM notes WHERE project_id = ? AND kind = 'learning' AND active = 1 AND always = 1`).get(n.project_id).c >= ALWAYS_MAX) {
    return false;
  }
  hub.q('UPDATE notes SET always = ? WHERE id = ?').run(on ? 1 : 0, n.id);
  return true;
}

// ── the review job ──

export const openReview = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND notes_review = 1 AND stage NOT IN ('done', 'dropped') LIMIT 1`).get(p.id);

// Notes due for review now: [{ note, why }]. Those about an item that landed since they were last looked at, and,
// once a week, every note older than a day that nobody looked at this week.
export function dueNotes(hub, p) {
  const t = hub.now();
  const rows = hub.q(`SELECT n.*, i.seq, i.stage AS item_stage, i.stage_since FROM notes n LEFT JOIN items i ON i.id = n.item_id
    WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at, n.id`).all(p.id);
  const weekly = t - (p.notes_at ?? 0) >= NOTES_EVERY;
  const due = [];
  for (const n of rows) {
    if (n.item_stage === 'done' && n.at < n.stage_since && n.reviewed_at < n.stage_since) due.push({ n, why: `#${n.seq} landed` });
    else if (weekly && n.at <= t - DAY && n.reviewed_at <= t - NOTES_EVERY) due.push({ n, why: 'weekly' });
  }
  return { due, weekly };
}

const clip = (s, len = 200) => (s.length > len ? `${s.slice(0, len - 1).trimEnd()}…` : s);
const SUMMARY = (due) => `Review these field notes: merge duplicates into one, and retire each note whose lesson is now in the code, the agents' guide or a test.\n${
  due.map(({ n, why }) => `- note ${n.id}${n.seq ? ` (about #${n.seq})` : ''}${why === 'weekly' ? '' : `, ${why}`}: ${clip(n.body)}`).join('\n')}`;
const ACCEPTANCE = [
  '- Each note listed is kept, merged or retired. Keep it when its lesson still saves the next agent time.',
  '- A merge is one learn with the combined lesson, then retire with into set to its id and the duplicates in notes.',
  '- A retire names where the lesson lives now (a file, the guide section, a test) in its reason.',
  '- Under lower autonomy, nothing is retired by you: ask the person one question listing the notes to retire or merge, and why.',
  '- Submit with what you kept, merged and retired.',
].join('\n');

// Opens a review when notes are due and none is open, or brings the waiting one up to date. Called before next picks
// work, so a note on an item that just landed is reviewed soon after. Returns the open review, if any.
export function reviewUp(hub, p) {
  if (p.parked) return null;
  const { due, weekly } = dueNotes(hub, p);
  const keys = JSON.stringify(due.map(({ n }) => `note:${n.id}`));
  const cur = openReview(hub, p);
  if (cur) {
    if (!cur.holder && cur.stage === 'ready') {
      if (!due.length) { hub.move(cur, 'dropped', SYSTEM); return null; }
      hub.patch(cur, { summary: SUMMARY(due), tidy: keys });
    }
    return cur;
  }
  if (weekly) hub.q('UPDATE projects SET notes_at = ? WHERE id = ?').run(hub.now(), p.id);
  if (!due.length) return null;
  const it = hub.createItem(p, SYSTEM, { title: `Review ${p.name}'s field notes`, summary: SUMMARY(due), acceptance: ACCEPTANCE, priority: 'soon' });
  hub.patch(it, { tidy: keys, notes_review: 1 });
  if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM);
  return it;
}

// The notes a finished review listed were looked at: due again only when their item lands anew, or in a week.
export function reviewed(hub, item) {
  const ids = json(item.tidy, []).map((k) => Number(String(k).replace(/^note:/, ''))).filter(Boolean);
  if (ids.length) hub.q(`UPDATE notes SET reviewed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(hub.now(), ...ids);
}
