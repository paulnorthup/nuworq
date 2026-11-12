// Security reviews (#480): in a project with them on, security stays checked the way tidy jobs keep milestones
// true (#202). Before each release, the hub opens a review of what it ships, and the release waits for it; an
// agent that built any of those changes can't take it. Each month a review of one area, in turn. Each review reads
// the changes against the project's threat model (docs/SECURITY-MODEL.md in nuworq's own repository).
// A pre-release review reads main up to the commit it was claimed at (#936), and the release ships nothing past
// it unreviewed: what landed since holds the release until another review reads it.
import { SYSTEM } from './core.js';
import { baseOf, changedPast, lastRelease, shaOf } from './git.js';
import { draftRelease, tagRelease } from './releases.js';

export const SECURITY_EVERY = 30 * 24 * 60 * 60_000; // 30 days (not 30 * DAY: core.js imports this module before DAY exists)

// The areas the monthly reviews take in turn: those of the first full review (2026-11-01).
export const AREAS = [
  'sign-in, accounts and tenancy: who can reach which workspace, project and data',
  'the web client and the HTTP edge: pages, the API, headers, rendering of what people and agents wrote',
  'integrations, webhooks and updates: GitHub, Stripe, llm-proxy, the self-update and release signing',
  "worker machines and prompt injection: what an agent on someone's machine may run, read and push",
  'data, secrets and open-source readiness: what the database, logs, evidence and the repository hold',
];

const MODEL = 'docs/SECURITY-MODEL.md';

const FINDINGS = [
  `- Every finding is rated critical, high, medium or low, by the threat model's attackers (${MODEL}): who can do it, and what they get.`,
  '- Each finding is proposed as its own item with the fix and a regression test named for what it guards; set fixes when it repairs landed work.',
  '- A threat the model misses goes into the model, on this item\'s branch.',
  '- Nothing found: submit what was read and why it holds, as evidence.',
];

const RELEASE_ACCEPTANCE = (release, from = 'the last release tag') => [
  `- Every change ${release} ships was read against the threat model, its diff included (git diff from ${from} to the commit the hint names: main when this was claimed).`,
  ...FINDINGS,
  `- A critical or high finding holds the release: add its fix to ${release}'s depends_on (refine), and ask the human, with options "Fix it before the release" and "Accept it for this release". Only on "Accept" does it come off.`,
].join('\n');

const AREA_ACCEPTANCE = [
  '- The area was read end to end against the threat model: its code, its tests, and what changed in it since the last review of it.',
  ...FINDINGS,
  '- A critical or high finding is priority now.',
].join('\n');

// A project's open security review of a kind ('release' or 'area').
export const openSecurity = (hub, p, kind) => hub.q(`SELECT * FROM items WHERE project_id = ? AND security = ? AND stage NOT IN ('done', 'dropped') ORDER BY seq LIMIT 1`).get(p.id, kind);

// A release was drafted: in a project with security reviews on, the release waits for a review of what it ships.
// One open review serves whichever release is open, so a release that was dropped and drafted again keeps it.
// gap: what landed after a done review read main (#936); the review it opens reads just that range.
export function reviewRelease(hub, p, release, by = SYSTEM, gap = null) {
  if (!p.security) return null;
  let it = openSecurity(hub, p, 'release');
  if (!it) {
    const from = gap?.from.slice(0, 7);
    it = hub.createItem(p, by, gap ? {
      title: `Security audit of what landed after #${gap.review.seq} (#${release.seq})`,
      summary: `#${gap.review.seq} read main up to ${from}, and ${changes(gap.commits)} landed after it that #${release.seq} would ship. Read them against the threat model (${MODEL}) before it's tagged and signed. Whoever built any of them can't take this review.${list(gap.commits)}`,
      acceptance: RELEASE_ACCEPTANCE(`#${release.seq}`, from),
      priority: 'now',
    } : {
      title: `Security audit before the next release (#${release.seq})`,
      summary: `Read what #${release.seq} ships against the threat model (${MODEL}) before it's tagged and signed. Its summary lists the changes. Whoever built any of them can't take this review.`,
      acceptance: RELEASE_ACCEPTANCE(`#${release.seq}`),
      priority: 'now',
    });
    hub.patch(it, { security: 'release', security_from: gap?.from ?? '' });
    if (it.stage !== 'ready') hub.move(it, 'ready', by); // the hub's own work: there's nothing to shape or approve
  }
  hub.q('INSERT OR IGNORE INTO deps (item_id, depends_on) VALUES (?, ?)').run(release.id, it.id);
  return it;
}

const changes = (commits) => (commits.length === 1 ? 'a change' : commits.length ? `${commits.length} changes` : 'changes');
const list = (commits) => (commits.length ? `\n\n${commits.slice(0, 30).map((c) => `- ${c}`).join('\n')}${commits.length > 30 ? `\n- and ${commits.length - 30} more` : ''}` : '');

// A pre-release review records the main commit it reads (#936): main when it is claimed (again when it is claimed
// again), or when it is marked done if nobody claimed it. Its hint names the range: from where it starts (the last
// release tag, or where the review before it stopped) to that commit.
export function coverReview(hub, item, { again = true } = {}) {
  if (item.security !== 'release' || (!again && item.security_sha)) return;
  const p = hub.q('SELECT * FROM projects WHERE id = ?').get(item.project_id);
  const path = hub.repoFor(p, item)?.path;
  const base = path && baseOf(path);
  const sha = base && shaOf(path, base);
  if (sha) hub.patch(item, { security_sha: sha });
}

// The diff a pre-release review reads, for its hint; '' when the hub can't say.
export function reviewRange(hub, p, item) {
  if (item.security !== 'release' || !item.security_sha) return '';
  const from = item.security_from ? item.security_from.slice(0, 7) : lastRelease(hub.repoFor(p, item)?.path)?.tag;
  const to = item.security_sha.slice(0, 7);
  return `Read ${from ? `git diff ${from} ${to}` : `main up to ${to}`}: main as it was when you claimed this. What lands after it gets its own review before the release ships it.`;
}

// What a release at sha would ship that no pre-release review read (#936): null when nothing (or the project has
// no reviews, or its review is from before #936), else { review, from, to, commits }. A review whose commit the
// repository lacks can't vouch for anything, so everything counts. A sha the repository lacks (GitHub just merged
// it, and the mirror hasn't fetched it) isn't known yet: the gap says unseen, with no commits.
export function unreviewed(hub, p, release, sha) {
  if (!p.security || !release.release || !sha) return null;
  const review = hub.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.depends_on WHERE d.item_id = ? AND i.security = 'release' AND i.stage = 'done'
    ORDER BY i.stage_since DESC, i.seq DESC LIMIT 1`).get(release.id);
  const path = hub.repoFor(p, release)?.path;
  if (!review?.security_sha || !path) return null;
  const gap = { review, from: review.security_sha, to: sha, commits: [] };
  if (!shaOf(path, sha)) return { ...gap, unseen: true };
  const past = changedPast(path, review.security_sha, sha);
  if (past && !past.files.length) return null;
  return { ...gap, commits: past?.commits ?? [] };
}

// A release about to land holds changes its review didn't read (#936): it goes back to ready, redrafted so its
// summary lists them, and depends on a review of just that range. Returns that review.
export function holdRelease(hub, p, release, gap, by = SYSTEM) {
  hub.move(release, 'ready', by, { holder: null, lease_until: null, reviewed_sha: '' });
  draftRelease(hub, p, by);
  const it = reviewRelease(hub, p, hub.itemById(release.id), by, gap);
  hub.event(p, {
    item: release, actor: SYSTEM, type: 'release_held',
    headline: `#${release.seq} holds ${changes(gap.commits)} that landed after #${gap.review.seq} read main: it waits for #${it.seq} to review them`,
    summary: `#${gap.review.seq} read main up to ${gap.from.slice(0, 7)}.${list(gap.commits)}`,
    data: { review: it.seq, from: gap.from, to: gap.to },
  });
  return it;
}

// A release that landed holding changes its review didn't read (#936; on GitHub, main can move under its pull
// request): the hub doesn't tag it, so it isn't signed, until a review of that range is done. Returns a sentence
// for whoever landed it.
export function holdTag(hub, p, release, gap, { tag, sha }) {
  const it = reviewRelease(hub, p, release, SYSTEM, gap);
  hub.event(p, {
    item: release, actor: SYSTEM, type: 'tag_held',
    headline: `${tag} waits for #${it.seq}: main got ${changes(gap.commits)} after #${gap.review.seq} read it, and the hub tags it once they are reviewed`,
    summary: `#${gap.review.seq} read main up to ${gap.from.slice(0, 7)}.${gap.unseen ? ` The hub's copy of the repository doesn't have ${sha.slice(0, 7)}, so it can't tell what changed past that.` : ''}${list(gap.commits)}`,
    data: { tag, sha, review: it.seq },
  });
  return `${tag} isn't tagged yet: main got changes after #${gap.review.seq} read it, so #${it.seq} reviews them first and the hub tags it then.`;
}

// A pre-release review is done: it records what it read if no claim did, and a release whose tag waited for it is
// tagged now.
export function reviewDone(hub, item) {
  if (item.security !== 'release') return;
  coverReview(hub, item, { again: false });
  const releases = hub.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.item_id WHERE d.depends_on = ? AND i.release = 1 AND i.stage = 'done'`).all(item.id);
  for (const rel of releases) {
    const held = hub.q(`SELECT id, data FROM events WHERE item_id = ? AND type = 'tag_held' ORDER BY id DESC LIMIT 1`).get(rel.id);
    if (!held || hub.q(`SELECT 1 FROM events WHERE item_id = ? AND type IN ('tagged', 'tag_failed') AND id > ?`).get(rel.id, held.id)) continue;
    const p = hub.q('SELECT * FROM projects WHERE id = ?').get(rel.project_id);
    tagRelease(hub, p, rel, JSON.parse(held.data).sha ?? '');
  }
}

// Whether agent may not take a pre-release review: it built a change the release ships (implemented it, or
// submitted an attempt at it). The changes are the items the release's summary names, "(#N)".
export function builtWhatItReviews(hub, item, agent) {
  if (item.security !== 'release' || !agent) return false;
  const releases = hub.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.item_id WHERE d.depends_on = ? AND i.release = 1`).all(item.id);
  const seqs = [...new Set(releases.flatMap((r) => [...String(r.summary).matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1]))))];
  if (!seqs.length) return false;
  const marks = seqs.map(() => '?').join(',');
  // Under any name its token acts as (#622).
  const names = hub.namesOf(item.project_id, agent);
  const who = names.map(() => '?').join(',');
  return !!hub.q(`SELECT 1 FROM items i WHERE i.project_id = ? AND i.seq IN (${marks}) AND (i.implementer IN (${who})
      OR EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = i.id AND a.agent IN (${who}) AND a.stage = 'submitted')) LIMIT 1`)
    .get(item.project_id, ...seqs, ...names, ...names);
}

// Opens the monthly area reviews that are due. Run on the hub's timer; returns the items it opened.
export function securityUp(hub) {
  const t = hub.now();
  const due = hub.q('SELECT * FROM projects WHERE security = 1 AND parked = 0 AND archived_at = 0 AND security_at <= ?').all(t - SECURITY_EVERY);
  const opened = [];
  for (const p of due) {
    const item = hub.tx(() => {
      hub.q('UPDATE projects SET security_at = ? WHERE id = ?').run(t, p.id);
      if (openSecurity(hub, p, 'area')) return null; // last month's is still open: this month's is skipped
      const n = p.security_area % AREAS.length;
      hub.q('UPDATE projects SET security_area = ? WHERE id = ?').run(n + 1, p.id);
      const area = AREAS[n];
      const it = hub.createItem(p, SYSTEM, {
        title: `Security audit: ${area.split(':')[0]}`,
        summary: `This month's security audit, area ${n + 1} of ${AREAS.length}: ${area}. Read it against the threat model (${MODEL}).`,
        acceptance: AREA_ACCEPTANCE,
        priority: 'soon',
      });
      hub.patch(it, { security: 'area' });
      if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM);
      return it;
    });
    if (item) { opened.push(item); hub.changed(p); }
  }
  return opened;
}
