// The weekly freshness sweep (#181): every FRESH_EVERY the hub opens one "keep <project> fresh" item per
// project, on unless a person turned it off. An agent does the sweep with the project's own tools on its own
// machine; the hub only sends the item (it never runs anything). At most one open sweep per project: while
// last week's is open, this week's is skipped. It is priority later, and next offers it only when nothing
// more urgent is ready (src/core.js claimable), so it never takes a workspace's one agent from real work.
import { DAY, SYSTEM } from './core.js';

export const FRESH_EVERY = 7 * DAY;

const SUMMARY = `The weekly freshness sweep: library dependencies, the runtime version and CI actions, checked with the project's own tools on your machine (npm outdated / npm audit, pip list --outdated / pip-audit, cargo outdated / cargo audit, go list -m -u all, osv-scanner if present). The hint next gives with this item says how.`;

const ACCEPTANCE = [
  '- Patch and minor updates of dependencies land in one batch on this branch, lockfiles included, with the tests passing.',
  '- Each breaking upgrade (a major version, a runtime near or past end of life, a CI action\'s new major) is its own proposal, saying what breaks and how to migrate, with `breaking` set to who must do what when it changes what people install, instead of being done here.',
  '- Nothing goes against a standing decision (e.g. "stay on React 18"); an upgrade that needs a person\'s call is asked with options, not done.',
  '- Nothing to update: submit "fresh: nothing to update" with the commands\' output as evidence.',
].join('\n');

// The project's open sweep, if any.
export const openSweep = (hub, p) => hub.q(`SELECT * FROM items WHERE project_id = ? AND sweep = 1 AND stage NOT IN ('done', 'dropped') LIMIT 1`).get(p.id);

// Opens this week's sweeps that are due. Run on the hub's timer; returns the items it opened.
export function freshen(hub) {
  const t = hub.now();
  const due = hub.q('SELECT * FROM projects WHERE fresh = 1 AND parked = 0 AND archived_at = 0 AND fresh_at <= ?').all(t - FRESH_EVERY);
  const opened = [];
  for (const p of due) {
    const item = hub.tx(() => {
      hub.q('UPDATE projects SET fresh_at = ? WHERE id = ?').run(t, p.id);
      if (openSweep(hub, p)) return null;
      const it = hub.createItem(p, SYSTEM, { title: `Keep ${p.name} fresh`, summary: SUMMARY, acceptance: ACCEPTANCE, priority: 'later' });
      hub.patch(it, { sweep: 1 });
      if (it.stage !== 'ready') hub.move(it, 'ready', SYSTEM); // the hub's own work: there's nothing to shape or approve
      return it;
    });
    if (item) { opened.push(item); hub.changed(p); }
  }
  return opened;
}
