// Agents keep the groups true (#202). The hub notices drift and opens one "tidy" item per project, which next
// offers as mode "tidy" at priority soon, one at a time. Drift is: open work in no group (once the project has
// groups at all), two groups whose open
// parts touch two or more of the same source files, a group someone could submit whose parts are all finished,
// a pull request no item tracks, and ready work nobody has touched in 21 days (#442). The agent moves items (refine parent), merges or creates groups, closes
// finished ones, and attaches stray pull requests (refine pr); it never changes a priority a person set.
// Submitting the tidy job finishes it. What an agent looked at and left alone isn't raised again until it
// changes: a new tidy job lists only drift no finished one already listed.
import { SYSTEM, DAY } from './core.js';

const json = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
const pathOf = (t) => String(t ?? '').split(' (')[0].trim().replace(/^\.\//, '');
const isDoc = (path) => /^docs\//.test(path) || /\.md$/i.test(path) || /^CHANGELOG/i.test(path.split('/').pop());
const OPEN = "stage NOT IN ('done', 'dropped')";
// The hub's own work items aren't anyone's to group: sweeps, tidy jobs, and releases, which span every
// milestone and stay top-level (#425).
const OWN = "sweep = 0 AND tidy = '' AND release = 0";
// A ready item is stale once untouched this long (#442). What touches it: someone claiming, commenting,
// refining, moving or answering about it. A question asked about it doesn't, so the tidy job's own ask
// can't hide it; the person's answer does.
const STALE_DAYS = 21; // in days: core.js imports this module before it defines DAY
const TOUCH = ['claimed', 'comment', 'refined', 'regrouped', 'shaped', 'handoff', 'sent_back', 'answered', 'assumption_confirmed', 'staged', 'unparked']
  .map((x) => `'${x}'`).join(', ');

// What drifted in this project now: [{ key, kind, text }], most actionable first.
export function drift(hub, p) {
  const items = hub.q(`SELECT * FROM items WHERE project_id = ? AND ${OWN}`).all(p.id);
  const kids = new Map();
  for (const i of items) if (i.parent_id) kids.set(i.parent_id, [...(kids.get(i.parent_id) ?? []), i]);
  const open = (i) => !['done', 'dropped'].includes(i.stage);
  const groups = items.filter((i) => open(i) && kids.has(i.id));
  const out = [];

  // Each key says what the drift looked like, so a tidy job's "left alone" holds until that changes (#243).
  for (const g of groups) {
    // Only a group someone could submit: one already submitted (verifying) or parked on a person's question waits on others.
    if (!['ready', 'active'].includes(g.stage) || hub.q("SELECT 1 FROM questions WHERE item_id = ? AND status = 'open' AND blocking = 1").get(g.id)) continue;
    if (kids.get(g.id).every((k) => !open(k))) {
      out.push({ key: `finished:${g.seq}:${g.stage}:${kids.get(g.id).length}`, kind: 'finished', text: `#${g.seq} "${g.title}" is still ${g.stage}, but all its parts are done or dropped: submit it or close it.` });
    }
  }
  // Source files each group's open parts are changing (what their holders said in progress touching, without
  // notes like "src/server.js (billing routes)"). Docs every group adds to, and one hot file in common, aren't
  // shared work: two groups overlap when they share two source files or more.
  const touched = groups.map((g) => ({ g, paths: new Set(kids.get(g.id).filter(open).flatMap((k) => json(k.touching, [])).map(pathOf).filter((x) => x && !isDoc(x))) }));
  for (let a = 0; a < touched.length; a++) {
    for (let b = a + 1; b < touched.length; b++) {
      const both = [...touched[a].paths].filter((x) => touched[b].paths.has(x)).sort();
      if (both.length >= 2) {
        const [x, y] = [touched[a].g, touched[b].g];
        out.push({ key: `overlap:${x.seq}:${y.seq}:${both.join(',')}`, kind: 'overlap', text: `#${x.seq} "${x.title}" and #${y.seq} "${y.title}" both change ${both.slice(0, 3).join(', ')}${both.length > 3 ? ', …' : ''}: merge them, or move the shared work into one.` });
      }
    }
  }
  for (const r of hub.q(`SELECT * FROM untracked_prs WHERE project_id = ? AND state = 'open' ORDER BY number`).all(p.id)) {
    out.push({ key: `pr:${r.repo}#${r.number}`, kind: 'pr', text: `PR ${r.repo}#${r.number} "${r.title}" (branch ${r.head_ref || '?'}) belongs to no item: attach it (refine an item with pr: "${r.repo}#${r.number}"), or propose an item for it first.` });
  }
  // Ready work nobody has touched in 21 days (#442): no claim, comment, refine, answer or steer. The agent
  // recommends keeping, refining or dropping it; only a person drops it. Touching it starts the 21 days again.
  const t = hub.now();
  for (const i of items) {
    if (i.stage !== 'ready' || i.holder) continue;
    const touched = Math.max(i.stage_since, i.created_at ?? 0,
      hub.q(`SELECT MAX(at) AS at FROM events WHERE item_id = ? AND type IN (${TOUCH})`).get(i.id).at ?? 0,
      hub.q("SELECT MAX(at) AS at FROM notes WHERE item_id = ? AND kind = 'steer'").get(i.id).at ?? 0);
    if (t - touched < STALE_DAYS * DAY) continue;
    out.push({ key: `stale:${i.seq}:${touched}`, kind: 'stale', text: `#${i.seq} "${i.title}" has been ready ${Math.floor((t - touched) / DAY)} days and nobody has touched it: recommend keeping, refining or dropping it, with a reason. To drop it, ask the person (on #${i.seq}); refine drop needs their answer.` });
  }
  // Loose work counts only once the project steers by groups: until then nothing is out of place.
  for (const i of groups.length ? items : []) {
    if (['ready', 'proposed'].includes(i.stage) && !i.parent_id && !kids.has(i.id)) {
      out.push({ key: `ungrouped:${i.seq}:${i.stage}`, kind: 'ungrouped', text: `#${i.seq} "${i.title}" (${i.stage}) is in no milestone: move it into one (refine parent), or start a milestone for it and its kin.` });
    }
  }
  return out;
}

// The project's open tidy item, if any.
export const openTidy = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND tidy != '' AND ${OPEN} LIMIT 1`).get(p.id);

// People read "milestone" for a group (#269), so what the hub writes on the tidy item says it too.
const SUMMARY = (found) => `The milestones drifted. Put them right:\n${found.map((d) => `- ${d.text}`).join('\n')}`;
const ACCEPTANCE = [
  '- Each drift listed is fixed, or left alone on purpose with the reason in your submit.',
  '- Every change is made with refine and a one-line reason (reason), so the affected milestones\' history says why.',
  '- No priority a person set is changed, and no decision is touched.',
  '- Each stale ready item gets your recommendation (keep, refine or drop) with a reason. To drop one, ask the person on it; drop it with refine drop only once they answer.',
].join('\n');

// Opens a tidy job when there is drift the last one didn't list, or brings the waiting one up to date. Called
// before next picks work, so a seeded drift is offered at once. Returns the open tidy item, if any.
export function tidyUp(hub, p) {
  if (p.parked) return null;
  // What a finished tidy job listed was looked at: fixed, or left alone on purpose. It comes back only once it
  // looks different (its key changes), never alongside new drift (#243).
  const handled = new Set(hub.q(`SELECT tidy FROM items WHERE project_id = ? AND tidy != '' AND stage = 'done'`).all(p.id).flatMap((r) => json(r.tidy, [])));
  const found = drift(hub, p).filter((d) => !handled.has(d.key));
  const keys = found.map((d) => d.key);
  const cur = openTidy(hub, p);
  if (cur) {
    // Not yet claimed: it says what has drifted now. Nothing left: it isn't needed any more.
    if (!cur.holder && cur.stage === 'ready') {
      if (!found.length) { hub.move(cur, 'dropped', SYSTEM); return null; }
      hub.patch(cur, { summary: SUMMARY(found), tidy: JSON.stringify(keys) });
    }
    return cur;
  }
  if (!found.length) return null;
  const it = hub.createItem(p, SYSTEM, { title: `Keep ${p.name}'s milestones true`, summary: SUMMARY(found), acceptance: ACCEPTANCE, priority: 'soon' });
  hub.patch(it, { tidy: JSON.stringify(keys) });
  if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM);
  return it;
}

// A pull request no item tracks, on record for the next tidy job (or its update). In the webhook's transaction.
export function untrackedPr(hub, p, repo, pr, state) {
  hub.q(`INSERT INTO untracked_prs (project_id, repo, number, url, title, head_ref, head_sha, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, repo, number) DO UPDATE SET url = excluded.url, title = excluded.title, head_ref = excluded.head_ref,
        head_sha = excluded.head_sha, state = excluded.state, updated_at = excluded.updated_at`)
    .run(p.id, repo, pr.number, pr.html_url ?? '', pr.title ?? '', pr.head?.ref ?? '', pr.head?.sha ?? '', state, hub.now());
  return { untracked: true, pr: pr.number, state };
}
