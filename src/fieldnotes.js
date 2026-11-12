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
//
// The same review distills memory for people (#552, distill): Direction today (at most DIRECTION_MAX plain lines from
// the decisions, people's live steering and the notes that matter, each naming its source), a one-line gist for each
// decision and field note, and for each field note a recommendation with its reason: keep, retire, or make it a
// decision (a draft only a person turns into one). Under "Run with it" a retire it recommends is carried out at once;
// otherwise the person decides with one tap. A review opens when those inputs change (at most hourly) and weekly.
// Agents still get every note's full text.
import { createHash } from 'node:crypto';
import { DAY, HUMAN, NO_ITEM_HINT, SYSTEM, UserError } from './core.js';

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

// Notes due for review now: [{ note, why }]. Those about an item that landed since they were last looked at, and
// those of this week's review: every note older than a day before it fired that nobody looked at in the week before.
// The week counts from when it fired (notes_at), so a review still waiting for an agent keeps its notes.
// A review finishing isn't a landing: the notes it merged into wait for the week, or each review would open the next.
export function dueNotes(hub, p) {
  const t = hub.now();
  const rows = hub.q(`SELECT n.*, i.seq, i.stage AS item_stage, i.stage_since, i.notes_review FROM notes n LEFT JOIN items i ON i.id = n.item_id
    WHERE n.project_id = ? AND n.kind = 'learning' AND n.active = 1 ORDER BY n.at, n.id`).all(p.id);
  const weekly = t - (p.notes_at ?? 0) >= NOTES_EVERY;
  const since = weekly ? t : p.notes_at ?? 0; // when this week's review fired, or fires now
  const due = [];
  for (const n of rows) {
    if (n.item_stage === 'done' && !n.notes_review && n.at < n.stage_since && n.reviewed_at < n.stage_since) due.push({ n, why: `#${n.seq} landed` });
    else if (since && n.at <= since - DAY && n.reviewed_at <= since - NOTES_EVERY) due.push({ n, why: 'weekly' });
  }
  return { due, weekly };
}

const clip = (s, len = 200) => (s.length > len ? `${s.slice(0, len - 1).trimEnd()}…` : s);

// ── memory for people (#552) ──

export const DIRECTION_MAX = 7;
export const DISTILL_EVERY = 60 * 60_000; // inputs that changed are distilled again at most hourly
const GIST_MAX = 160;
export const ADVICE = ['keep', 'retire', 'decide'];

// What memory is distilled from: the active decisions, people's live steering (about the project, not an item: that
// retires itself; and not the hub's own notices, #550) and field notes. sig changes whenever any of them does.
export function memoryInputs(hub, p) {
  const rows = hub.q(`SELECT id, kind, body, gist, advice, author, always FROM notes WHERE project_id = ? AND active = 1
    AND (kind IN ('decision', 'learning') OR (kind = 'steer' AND item_id IS NULL AND target IS NULL AND notice = 0 AND (author = ? OR author LIKE '@%'))) ORDER BY id`).all(p.id, HUMAN);
  const sig = createHash('sha256').update(rows.map((n) => `${n.id}:${n.kind}:${n.body}`).join('\n')).digest('hex').slice(0, 16);
  return { rows, sig };
}

// Whether memory needs distilling: its inputs changed since the last distill, and that was an hour ago or more.
export function distillDue(hub, p) {
  const { rows, sig } = memoryInputs(hub, p);
  // Steering alone (and the hub's own notices, such as an autonomy change) is already plain: nothing to distill.
  return rows.some((n) => n.kind !== 'steer') && sig !== (p.distilled_sig ?? '') && hub.now() - (p.distilled_at ?? 0) >= DISTILL_EVERY;
}

const sourceOf = (n) => `${n.kind === 'learning' ? 'note' : n.kind} ${n.id}`;
// then: it follows the tidy part, so it reads "Then distill…"; alone it starts its own sentence (#719). Each list is
// a paragraph of its own, so the drawer renders it as a list.
const DISTILL = (hub, p, then) => {
  const { rows } = memoryInputs(hub, p);
  // Decisions and steers by id and words (checkin gives their words only); field notes by id: look with notes "all".
  const stale = rows.filter((n) => n.kind === 'learning' && !n.gist).map((n) => n.id);
  const list = [
    ...rows.filter((n) => n.kind !== 'learning').map((n) => `- ${sourceOf(n)}${n.gist ? ` (gist: ${n.gist})` : ''}: ${clip(n.body)}`),
    ...(stale.length ? [`- field notes without a gist: ${stale.join(', ')} (look with notes "all" for their words)`] : []),
  ];
  return `${then ? 'Then distill' : 'Distill'} memory for people with distill: Direction today (at most ${DIRECTION_MAX} plain lines a person reads in a minute, from the decisions, people's steering and the notes that matter, each naming its source as "decision 12", "steer 40", "note 7" or "#468"), and a one-line gist a person understands without looking anything up for each decision and field note without one, or whose gist no longer fits. For each field note also recommend keep, retire (why: where the lesson lives now, or what supersedes it) or decide (a draft decision for a person to accept).${list.length ? `\n\n${list.join('\n')}` : ''}`;
};

const SUMMARY = (hub, p, due) => `${due.length ? `Tidy these field notes: merge duplicates into one, and retire each note whose lesson is now in the code, the agents' guide or a test.\n\n${
  due.map(({ n, why }) => `- note ${n.id}${n.seq ? ` (about #${n.seq})` : ''}${why === 'weekly' ? '' : `, ${why}`}: ${clip(n.body)}`).join('\n')}\n\n` : ''}${DISTILL(hub, p, due.length > 0)}`;
const ACCEPTANCE = [
  '- Each note listed is kept, merged or retired. Keep it when its lesson still saves the next agent time.',
  '- A merge is one learn with the combined lesson, then retire with into set to its id and the duplicates in notes.',
  '- A retire names where the lesson lives now (a file, the guide section, a test) in its reason.',
  '- Under lower autonomy, nothing is retired by you: distill records each recommendation, and the person decides with one tap.',
  '- distill was called: Direction today, a gist for each decision and field note, and a recommendation for each field note.',
  '- Submit with what you kept, merged, retired and recommended.',
].join('\n');

// distill (#552), for the holder of the open review: stores Direction today, and each note's gist and advice. Under
// "Run with it" a retire it recommends is carried out at once, with its reason; "decide" always waits for a person.
export function distill(hub, p, agent, review, args) {
  const notes = new Map(memoryInputs(hub, p).rows.map((n) => [n.id, n]));
  const sourceRef = (s) => {
    const m = String(s ?? '').trim().match(/^(?:(decision|steer|note) (\d+)|#(\d+))$/);
    if (!m) throw new UserError(`Not a source: "${s}"`, { hint: 'Name it as "decision 12", "steer 40", "note 7" or "#468".' });
    if (m[3]) {
      if (!hub.q('SELECT 1 FROM items WHERE project_id = ? AND seq = ?').get(p.id, Number(m[3]))) throw new UserError(`No item #${m[3]}`, { status: 404, hint: NO_ITEM_HINT });
      return `#${m[3]}`;
    }
    const n = notes.get(Number(m[2]));
    if (!n || sourceOf(n) !== `${m[1]} ${m[2]}`) throw new UserError(`No active ${m[1]} ${m[2]}`, { status: 404, hint: 'Sources are the active decisions, steers and field notes the review lists.' });
    return `${m[1]} ${m[2]}`;
  };
  let direction = null;
  if (args.direction != null) {
    const lines = [].concat(args.direction).map((d) => (typeof d === 'string' ? { line: d } : d ?? {}));
    if (lines.length > DIRECTION_MAX) throw new UserError(`Direction today is at most ${DIRECTION_MAX} lines`, { hint: 'Keep what a person must know to check direction in a minute; the rest lives in the decisions and notes.' });
    direction = lines.map((d) => {
      const line = clip(String(d.line ?? '').trim(), 240);
      if (!line) throw new UserError('Each direction line needs its line', { hint: 'e.g. { line: "Agents are primary users: small responses, every error a hint", source: "decision 3" }' });
      return { line, source: sourceRef(d.source) };
    });
  }
  const done = { gists: 0, retired: [], waiting: [] };
  for (const g of [].concat(args.notes ?? [])) {
    const n = notes.get(Number(g?.note ?? g?.id));
    if (!n || n.kind === 'steer') throw new UserError(`No active decision or field note ${g?.note ?? g?.id}`, { status: 404, hint: 'Gists are for the decisions and field notes the review lists.' });
    const gist = clip(String(g.gist ?? '').trim(), GIST_MAX);
    if (!gist) throw new UserError(`${sourceOf(n)} needs a gist`, { hint: 'One plain line a person understands without looking anything up.' });
    let advice = '';
    if (n.kind === 'learning') {
      const rec = g.recommend ?? 'keep';
      if (!ADVICE.includes(rec)) throw new UserError(`recommend is keep, retire or decide, not "${rec}"`, { hint: 'Pass recommend: "keep", "retire" or "decide".' });
      const why = clip(String(g.why ?? '').trim(), 240);
      const draft = clip(String(g.draft ?? '').trim(), 600);
      if (rec !== 'keep' && !why) throw new UserError(`Say why to ${rec} note ${n.id}`, { hint: rec === 'retire' ? 'Where the lesson lives now (a file, a test, the guide), or what supersedes it.' : 'Why it should bind every agent as a standing rule.' });
      if (rec === 'decide' && !draft) throw new UserError(`A decision draft for note ${n.id} is required`, { hint: 'The decision as a person would write it, for them to accept or edit.' });
      advice = JSON.stringify({ do: rec, why, ...(rec === 'decide' ? { draft } : {}) });
      // Under Run with it the job retires on its own, but never a note a person pinned (#633, as retire refuses it: #611).
      // That advice waits for a person's tap, as under lower autonomy.
      if (rec === 'retire' && p.autonomy === 'full' && !n.always) {
        hub.q('UPDATE notes SET active = 0, gist = ?, advice = ? WHERE id = ?').run(gist, advice, n.id);
        hub.event(p, { item: review, actor: agent, type: 'retired', headline: `${agent} retired field note ${n.id}: ${gist}`, summary: `Why: ${why}`, data: { note: n.id, reason: why } });
        done.retired.push(n.id);
        continue;
      }
      if (rec !== 'keep') done.waiting.push(n.id);
    }
    hub.q('UPDATE notes SET gist = ?, advice = ? WHERE id = ?').run(gist, advice, n.id);
    done.gists++;
  }
  // What it was distilled from, as it stands now: what it retired is part of it.
  if (direction) hub.q('UPDATE projects SET direction = ?, distilled_sig = ?, distilled_at = ? WHERE id = ?').run(JSON.stringify(direction), memoryInputs(hub, p).sig, hub.now(), p.id);
  else hub.q('UPDATE projects SET distilled_sig = ?, distilled_at = ? WHERE id = ?').run(memoryInputs(hub, p).sig, hub.now(), p.id);
  hub.event(p, { item: review, actor: agent, type: 'distilled', headline: `${agent} distilled memory: ${direction ? `Direction today in ${direction.length} lines, ` : ''}${done.gists + done.retired.length} gists${done.retired.length ? `, retired ${done.retired.length}` : ''}${done.waiting.length ? `, ${done.waiting.length} waiting for a person` : ''}` });
  return {
    ok: true, direction: direction?.length ?? null, gists: done.gists + done.retired.length, retired: done.retired, waiting: done.waiting,
    hint: done.waiting.length ? 'The person sees each recommendation with its reason on the project page and decides with one tap. Submit the review when you are done.' : 'Submit the review when you are done.',
  };
}

// Opens a review when notes are due or memory needs distilling and none is open, or brings the waiting one up to
// date. Called on the sweep timer, so a note on an item that just landed is reviewed soon after. Returns the open
// review, if any.
export function reviewUp(hub, p) {
  if (p.parked) return null;
  const { due, weekly } = dueNotes(hub, p);
  const stale = distillDue(hub, p); // the weekly review distills too: its summary always asks
  const keys = JSON.stringify(due.map(({ n }) => `note:${n.id}`));
  const cur = openReview(hub, p);
  if (cur) {
    if (!cur.holder && cur.stage === 'ready') {
      if (!due.length && !stale) { hub.move(cur, 'dropped', SYSTEM); return null; }
      hub.patch(cur, { summary: SUMMARY(hub, p, due), tidy: keys });
    }
    return cur;
  }
  if (weekly) hub.q('UPDATE projects SET notes_at = ? WHERE id = ?').run(hub.now(), p.id);
  if (!due.length && !stale) return null;
  const it = hub.createItem(p, SYSTEM, { title: `Tidy ${p.name}'s field notes`, summary: SUMMARY(hub, p, due), acceptance: ACCEPTANCE, priority: 'soon' });
  hub.patch(it, { tidy: keys, notes_review: 1 });
  if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM);
  return it;
}

// The notes a finished review listed were looked at: due again only when their item lands anew, or in a week.
export function reviewed(hub, item) {
  const ids = json(item.tidy, []).map((k) => Number(String(k).replace(/^note:/, ''))).filter(Boolean);
  if (ids.length) hub.q(`UPDATE notes SET reviewed_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(hub.now(), ...ids);
}
