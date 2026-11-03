#!/usr/bin/env node
// How fast is the hub where it matters? #514's numbers, from a copy of a workspace's file, as timings and sizes only.
//   node scripts/measure.js <workspace.db> [--project nuworq] [--runs 20]
//   node scripts/measure.js --seed [--runs 20]    (a hub the size of nuworq's own, built in memory)
// It never writes the hub's file: SQLite copies it (VACUUM INTO, a read) to a temporary file, and the hub's own code
// runs on the copy as the server runs it (views cached per change). Measured: the project's view built cold and read
// from the cache, and its size at each depth; a worker's checkin and next, timed and their statements counted; and
// a repeat checkin's size in the same session (#539). The checkins and nexts are made by agents the script invents,
// on the copy only. It prints JSON with milliseconds, counts and characters: no titles, names or other words.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/core.js';
import { view, DEPTHS } from '../src/insight.js';

const round = (ms) => Math.round(ms * 10) / 10;
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const spread = (xs) => ({ median: round(quantile(xs, 0.5)), p95: round(quantile(xs, 0.95)), max: round(Math.max(...xs)) });
const timed = (fn) => { const t = performance.now(); const r = fn(); return [performance.now() - t, r]; };

// The statements fn runs, counted as the snapshot test counts them (test/snapshot.test.js).
function statements(hub, fn) {
  let n = 0;
  const q = hub.q;
  hub.q = (sql) => {
    const s = q.call(hub, sql);
    return { get: (...a) => (n++, s.get(...a)), all: (...a) => (n++, s.all(...a)), run: (...a) => (n++, s.run(...a)) };
  };
  try { fn(); } finally { hub.q = q; }
  return n;
}

// The figures, from a hub (a copy) and a project slug. runs: how many times each call is timed.
export function measure(hub, slug, { runs = 20 } = {}) {
  hub.cacheViews = true; // as the server runs it (#501)
  const p = hub.project(slug);
  const cold = () => { hub._views?.clear(); hub._snaps?.clear?.(); return view(hub, slug); };
  cold(); // the first build also warms SQLite's page cache and V8; the server's builds are warm too
  const viewCold = Array.from({ length: runs }, () => timed(cold)[0]);
  const viewCached = Array.from({ length: runs }, () => timed(() => view(hub, slug, { depth: '5m' }))[0]);
  const bytes = Object.fromEntries(DEPTHS.map((d) => [d, JSON.stringify(view(hub, slug, { depth: d })).length]));
  hub._views?.clear();
  const viewStatements = statements(hub, () => view(hub, slug));

  // Workers the script invents, each with a session of its own: a first checkin, a repeat in the same session
  // (the reply carries what changed since the first), and a peek at next (claim: false, so the copy's queue stays
  // as it was for every run), then one next that claims.
  const op = (name, agent, args, session, cursor) => hub.agentOp(slug, name, agent, args, { session: [session], cursor });
  const first = [], repeat = [], next = [], firstSize = [], repeatSize = [];
  let checkinStatements = 0, nextStatements = 0, claimed = 0;
  for (let k = 0; k < runs; k++) {
    const agent = `measure-${k}`, session = `measure-session-${k}`, args = { role: 'worker', runner: 'measure', model: 'claude-opus-5-5' };
    const [a, r1] = timed(() => op('checkin', agent, args, session, ''));
    const [b, r2] = timed(() => op('checkin', agent, args, session, r1.cursor));
    const [c] = timed(() => op('next', agent, { claim: false }, session, r2.cursor));
    first.push(a); repeat.push(b); next.push(c);
    firstSize.push(JSON.stringify(r1).length); repeatSize.push(JSON.stringify(r2).length);
  }
  checkinStatements = statements(hub, () => op('checkin', 'measure-count', { role: 'worker', runner: 'measure' }, 'measure-count', ''));
  nextStatements = statements(hub, () => { claimed = op('next', 'measure-count', {}, 'measure-count', '')?.item ? 1 : 0; });

  return {
    project: { items: hub.q('SELECT COUNT(*) AS n FROM items WHERE project_id = ?').get(p.id).n,
      agents: hub.q("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND name NOT LIKE 'measure-%'").get(p.id).n,
      events: hub.q('SELECT COUNT(*) AS n FROM events WHERE project_id = ?').get(p.id).n },
    runs,
    view_ms: { cold: spread(viewCold), cached: spread(viewCached), statements: viewStatements, target: 100 },
    view_chars: bytes,
    checkin_ms: { first: spread(first), repeat: spread(repeat), statements: checkinStatements, target: 15 },
    next_ms: { peek: spread(next), statements: nextStatements, claimed_a_job: Boolean(claimed), target: 15 },
    checkin_chars: { first: spread(firstSize), repeat: spread(repeatSize), target_repeat: 1000 },
  };
}

// A read of file, copied so the hub's own file is never opened for writing.
export function fromFile(file, slug, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-measure-'));
  const copy = join(dir, 'copy.db');
  try {
    const src = new DatabaseSync(resolve(file), { readOnly: true });
    src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    src.close();
    const hub = new Hub({ file: copy });
    try { return measure(hub, slug, opts); } finally { hub.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const runs = Number(flag('runs', 20));
  if (args.includes('--seed')) { // no file: a hub the size of nuworq's own, built in memory (test/seedhub.js)
    const { seedHub, SLUG } = await import('../test/seedhub.js');
    console.log(JSON.stringify(measure(seedHub().hub, SLUG, { runs }), null, 2));
  } else if (!file) {
    console.error('usage: node scripts/measure.js <workspace.db> [--project nuworq] [--runs 20]\n       node scripts/measure.js --seed [--runs 20]');
    process.exit(2);
  } else console.log(JSON.stringify(fromFile(file, flag('project', 'nuworq'), { runs }), null, 2));
}
