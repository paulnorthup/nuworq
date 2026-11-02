// The weekly freshness sweep (#181): every FRESH_EVERY the hub opens one "keep <project> fresh" item per
// project, on unless a person turned it off. An agent does the sweep with the project's own tools on its own
// machine; the hub only sends the item (it never runs anything). At most one open sweep per project: while
// last week's is open, this week's is skipped. It is priority later, and next offers it only when nothing
// more urgent is ready (src/core.js claimable), so it never takes a workspace's one agent from real work.
import { DAY, SYSTEM } from './core.js';
import { DEFAULT_TIERS, newerClaude } from './models.js';

export const FRESH_EVERY = 7 * DAY;

const SUMMARY = `The weekly freshness sweep: library dependencies, the runtime version and CI actions, checked with the project's own tools on your machine (npm outdated / npm audit, pip list --outdated / pip-audit, cargo outdated / cargo audit, go list -m -u all, osv-scanner if present). The hint next gives with this item says how.`;

const ACCEPTANCE = [
  '- Patch and minor updates of dependencies land in one batch on this branch, lockfiles included, with the tests passing.',
  '- Each breaking upgrade (a major version, a runtime near or past end of life, a CI action\'s new major) is its own proposal, saying what breaks and how to migrate, with `breaking` set to who must do what when it changes what people install, instead of being done here.',
  '- Nothing goes against a standing decision (e.g. "stay on React 18"); an upgrade that needs a person\'s call is asked with options, not done.',
  '- Nothing to update: submit "fresh: nothing to update" with the commands\' output as evidence.',
].join('\n');

// The default Claude tiers kept current (#723): when agents on this hub checked in on a newer Claude model than a
// default tier, the sweep says which, so an update is proposed. The hub fetches nothing: it knows only the models
// agents named. '' when the defaults are the newest it has seen.
export function modelsLine(hub) {
  const seen = hub.q("SELECT DISTINCT model FROM agents WHERE model != ''").all().map((r) => r.model);
  const newer = newerClaude(seen);
  if (!newer.length) return '';
  return `\n- Newer Claude models than nuworq's default tiers (${DEFAULT_TIERS.claude.join(', ')}) are in use on this hub: ${newer.map((n) => `${n.model} (newer than ${n.replaces})`).join(', ')}. Propose an update: in nuworq's own repository, DEFAULT_TIERS in src/models.js; in any other project that routes on the default tiers, its own tiers in Staffing.`;
}

// The project's open sweep, if any.
export const openSweep = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND sweep = 1 AND stage NOT IN ('done', 'dropped') LIMIT 1`).get(p.id);

// Opens this week's sweeps that are due. Run on the hub's timer; returns the items it opened.
export function freshen(hub) {
  const t = hub.now();
  const due = hub.q('SELECT * FROM projects WHERE fresh = 1 AND parked = 0 AND archived_at = 0 AND fresh_at <= ?').all(t - FRESH_EVERY);
  const opened = [];
  const acceptance = ACCEPTANCE + modelsLine(hub);
  for (const p of due) {
    const item = hub.tx(() => {
      hub.q('UPDATE projects SET fresh_at = ? WHERE id = ?').run(t, p.id);
      if (openSweep(hub, p)) return null;
      const it = hub.createItem(p, SYSTEM, { title: `Keep ${p.name} fresh`, summary: SUMMARY, acceptance, priority: 'later' });
      hub.patch(it, { sweep: 1 });
      if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM); // the hub's own work: there's nothing to shape or approve
      return it;
    });
    if (item) { opened.push(item); hub.changed(p); }
  }
  return opened;
}
