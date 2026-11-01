// Security reviews (#480): in a project with them on, security stays checked the way tidy jobs keep milestones
// true (#202). Before each release, the hub opens a review of what it ships, and the release waits for it; an
// agent that built any of those changes can't take it. Each month a review of one area, in turn. Each review reads
// the changes against the project's threat model (docs/SECURITY-MODEL.md in nuworq's own repository).
import { SYSTEM } from './core.js';

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

const RELEASE_ACCEPTANCE = (release) => [
  `- Every change ${release} ships was read against the threat model, its diff included (git diff from the last release tag to origin/main).`,
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
export function reviewRelease(hub, p, release, by = SYSTEM) {
  if (!p.security) return null;
  let it = openSecurity(hub, p, 'release');
  if (!it) {
    it = hub.createItem(p, by, {
      title: `Security review before the next release (#${release.seq})`,
      summary: `Read what #${release.seq} ships against the threat model (${MODEL}) before it's tagged and signed. Its summary lists the changes. Whoever built any of them can't take this review.`,
      acceptance: RELEASE_ACCEPTANCE(`#${release.seq}`),
      priority: 'now',
    });
    hub.patch(it, { security: 'release' });
    if (it.stage !== 'ready') hub.move(it, 'ready', by); // the hub's own work: there's nothing to shape or approve
  }
  hub.q('INSERT OR IGNORE INTO deps (item_id, depends_on) VALUES (?, ?)').run(release.id, it.id);
  return it;
}

// Whether agent may not take a pre-release review: it built a change the release ships (implemented it, or
// submitted an attempt at it). The changes are the items the release's summary names, "(#N)".
export function builtWhatItReviews(hub, item, agent) {
  if (item.security !== 'release' || !agent) return false;
  const releases = hub.q(`SELECT i.* FROM deps d JOIN items i ON i.id = d.item_id WHERE d.depends_on = ? AND i.release = 1`).all(item.id);
  const seqs = [...new Set(releases.flatMap((r) => [...String(r.summary).matchAll(/\(#(\d+)\)/g)].map((m) => Number(m[1]))))];
  if (!seqs.length) return false;
  const marks = seqs.map(() => '?').join(',');
  return !!hub.q(`SELECT 1 FROM items i WHERE i.project_id = ? AND i.seq IN (${marks}) AND (i.implementer = ?
      OR EXISTS (SELECT 1 FROM attempts a WHERE a.item_id = i.id AND a.agent = ? AND a.stage = 'submitted')) LIMIT 1`)
    .get(item.project_id, ...seqs, agent, agent);
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
        title: `Security review: ${area.split(':')[0]}`,
        summary: `This month's security review, area ${n + 1} of ${AREAS.length}: ${area}. Read it against the threat model (${MODEL}).`,
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
