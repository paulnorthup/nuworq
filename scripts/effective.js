#!/usr/bin/env node
// Is nuworq doing its job? The effective audit's numbers (#699), from a project's own history, as aggregates only.
//   node scripts/effective.js <workspace.db> [--project nuworq] [--days 14]
// It never writes the hub's file: SQLite copies it (VACUUM INTO, a read) to a temporary file, and the hub's own
// outcomes (src/outcomes.js, the published /outcomes figures) run on the copy, plus the event counts outcomes
// doesn't break down: hand-backs, lapsed leases by cause, who sent work back, and how long people took. It prints
// JSON with counts, shares and durations: no titles, names, notes or other words from the workspace.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Hub, DAY } from '../src/core.js';
import { outcomes } from '../src/outcomes.js';

const share = (n, of) => (of ? Math.round((n / of) * 100) / 100 : null);
const quantile = (xs, q) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
const hours = (ms) => (ms == null ? null : Math.round((ms / 3_600_000) * 10) / 10);
const cents = (x) => (x == null ? null : Math.round(x * 100) / 100);
const count = (rows, key) => Object.fromEntries([...rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));

// The figures, from a hub (a copy) and a project slug over [since, until].
export function effective(hub, slug, { since, until }) {
  const o = outcomes(hub, slug, { since, until });
  const p = hub.project(slug);
  const landed = o.items.filter((i) => i.outcome === 'landed');
  const cost = (i) => (i.usage.length && i.usage.every((u) => u.cost_usd != null) ? i.usage.reduce((s, u) => s + u.cost_usd, 0) : null);
  const costs = landed.map(cost);
  const priced = costs.filter((c) => c != null);
  const events = (types) => hub.q(`SELECT type, actor, data FROM events WHERE project_id = ? AND at >= ? AND at <= ? AND type IN (${types.map(() => '?').join(', ')})`)
    .all(p.id, o.since, o.until, ...types);
  const data = (e) => { try { return JSON.parse(e.data || '{}'); } catch { return {}; } };
  const kindOf = (actor) => (actor === 'you' || String(actor).startsWith('@') ? 'person' : actor === 'github' ? 'github (CI or a closed PR)' : actor === 'nuworq' ? 'nuworq' : 'agent');
  // What people were asked, and how long it took them (asked → answered), blocking ones only.
  const asked = hub.q(`SELECT asked_by, audience, blocking, status, at, answered_at, answered_by FROM questions WHERE project_id = ? AND at >= ? AND at <= ?`).all(p.id, o.since, o.until);
  const toPeople = asked.filter((q) => q.blocking && q.audience !== 'operator');
  const answeredByPerson = toPeople.filter((q) => q.status === 'answered' && (q.answered_by === 'you' || String(q.answered_by).startsWith('@')));
  const work = o.jobs.filter((j) => j.job === 'work');
  return {
    period: { since: new Date(o.since).toISOString(), until: new Date(o.until).toISOString(), days: Math.round((o.until - o.since) / DAY) },
    finished: { total: o.items.length, landed: landed.length, dropped: o.items.length - landed.length },
    without_a_person: { landed: landed.filter((i) => i.human_actions === 0).length, share: share(landed.filter((i) => i.human_actions === 0).length, landed.length) },
    first_review_accepted: { landed: landed.filter((i) => i.sent_back === 0).length, share: share(landed.filter((i) => i.sent_back === 0).length, landed.length) },
    escaped: { landed: landed.filter((i) => i.escaped).length, share: share(landed.filter((i) => i.escaped).length, landed.length) },
    bounces: {
      sent_back: landed.reduce((s, i) => s + i.sent_back, 0) + o.items.filter((i) => i.outcome === 'dropped').reduce((s, i) => s + i.sent_back, 0),
      stalls: o.items.reduce((s, i) => s + i.stalls, 0),
      landed_with_any: landed.filter((i) => i.sent_back + i.stalls > 0).length,
      sent_back_by: count(events(['sent_back']), (e) => kindOf(e.actor)),
      handed_back_from: count(events(['handoff']), (e) => data(e).stage ?? 'unrecorded (before #734)'),
      lapsed_leases_by_cause: count(events(['lease_expired']), (e) => ({ '': 'went quiet', restart: 'hub restart', session: 'worker or session ended' })[data(e).cause] ?? (data(e).cause === undefined ? 'review or landing' : data(e).cause)),
      landing_blocked: count(events(['pr_blocked', 'pr_merge_failed', 'conflict']), (e) => e.type),
    },
    building_jobs: { taken: work.length, results: count(work, (j) => j.result), cheaper_model_trials: work.filter((j) => j.trial).length },
    other_jobs: count(o.jobs.filter((j) => j.job !== 'work'), (j) => `${j.job}: ${j.result}`),
    cycle_hours: { median: hours(quantile(landed.map((i) => i.cycle_ms), 0.5)), p90: hours(quantile(landed.map((i) => i.cycle_ms), 0.9)) },
    people: {
      actions: o.human_actions.total, per_landed: o.human_actions.per_landed, median_wait_hours: hours(o.human_actions.median_wait_ms),
      blocking_questions: toPeople.length, answered_by_a_person: answeredByPerson.length,
      answer_hours: { median: hours(quantile(answeredByPerson.map((q) => q.answered_at - q.at), 0.5)), p90: hours(quantile(answeredByPerson.map((q) => q.answered_at - q.at), 0.9)) },
      operator_questions: asked.filter((q) => q.audience === 'operator').length,
    },
    cost_usd: {
      landed_priced: priced.length, landed_unpriced: costs.length - priced.length,
      total: cents(priced.reduce((s, c) => s + c, 0)), per_landed_median: cents(quantile(priced, 0.5)), per_landed_p90: cents(quantile(priced, 0.9)),
      by_model: o.by_model.filter((m) => m.landed).map((m) => ({ model: m.model, landed: m.landed, sent_back: m.sent_back, stalls: m.stalls, cost_per_landed: m.cost_per_landed, escape_rate: m.escape_rate })),
    },
  };
}

// A read of file, copied so the hub's own file is never opened for writing.
export function fromFile(file, slug, days, now = Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-effective-'));
  const copy = join(dir, 'copy.db');
  try {
    const src = new DatabaseSync(resolve(file), { readOnly: true });
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    src.close();
    const hub = new Hub({ file: copy, clock: () => now });
    try { return effective(hub, slug, { since: now - days * DAY, until: now }); } finally { hub.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!file) { console.error('usage: node scripts/effective.js <workspace.db> [--project nuworq] [--days 14]'); process.exit(2); }
  console.log(JSON.stringify(fromFile(file, flag('project', 'nuworq'), Number(flag('days', 14))), null, 2));
}
