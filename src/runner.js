// nuworq run: keep up to N headless workers on waiting work in the projects the human opted in.
// plan() decides, run() does the I/O; everything outside is injected so tests start no real agents.

// What to launch now. routes: the hub's /api/route?runner=1 (value order, one entry per project, with
// how much is claimable and who holds work there). running: live workers this runner started.
// A worker that hasn't claimed anything yet still counts against its project's claimable work,
// so one waiting item never draws a herd. r.limit: the most agents working in that project at once, set on
// the hub (#174): everyone holding work there, and this runner's workers that haven't claimed yet, count.
export function plan(routes, running, { workers = 1, maxRuns = Infinity, launched = 0 } = {}) {
  let slots = Math.min(workers - running.length, maxRuns - launched);
  const out = [];
  for (const r of routes) {
    if (slots <= 0) break;
    const held = new Set(r.holders ?? []);
    const idle = running.filter((w) => w.project === r.project && !held.has(w.name)).length;
    const room = r.limit == null ? Infinity : r.limit - held.size - idle;
    const n = Math.min(slots, (r.claimable ?? 1) - idle, room);
    // A raced trial (#348) names a model per open slot: each worker started takes the next one.
    for (let i = 0; i < n; i++) out.push(r.models?.[idle + i] ? { ...r, model: r.models[idle + i] } : r);
    slots -= Math.max(n, 0);
  }
  return out;
}

// --workers auto (#533): how many workers this machine takes now, from how busy it is. running: how many run;
// machine: { load (the 1-minute load average), cores, free (bytes of memory available) }; max: --max-workers;
// sinceStart: ms since this runner last started one. One more only while the load is under 80% of the cores and
// 2 GB is free, and only once the load average has had a minute to count the last one. At least one, always,
// so waiting work never stalls. holding: why it adds none now, or null.
export const autoMax = (cores) => Math.max(1, Math.floor(cores / 2));
const LOAD_SHARE = 0.8, MIN_FREE = 2 * 1024 ** 3, SETTLE_MS = 60_000;
export function capacity(running, { load = 0, cores = 1, free = Infinity } = {}, { max = autoMax(cores), sinceStart = Infinity } = {}) {
  if (running >= max) return { workers: max, holding: `--max-workers ${max}` };
  if (running < 1) return { workers: 1, holding: null };
  if (sinceStart < SETTLE_MS) return { workers: running, holding: null }; // the last one isn't in the load yet
  if (load >= cores * LOAD_SHARE) return { workers: running, holding: `load ${load.toFixed(1)} on ${cores} cores` };
  if (free < MIN_FREE) return { workers: running, holding: `${(free / 1024 ** 3).toFixed(1)} GB memory free` };
  return { workers: running + 1, holding: null };
}

// After a worker exits, its worktree goes (#172), unless something in it would be lost: uncommitted changes, or
// commits no branch holds. git(args) runs git and resolves to its output. Returns { kept, why? }.
export async function cleanWorktree(worktree, git) {
  if ((await git(['-C', worktree, 'status', '--porcelain'])).trim()) return { kept: true, why: 'it has uncommitted changes' };
  if (!(await git(['-C', worktree, 'for-each-ref', '--contains', 'HEAD', '--count=1', 'refs/heads', 'refs/remotes'])).trim()) {
    return { kept: true, why: 'it has commits that are on no branch' };
  }
  const common = (await git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  await git(['--git-dir', common, 'worktree', 'remove', worktree]);
  return { kept: false };
}

// The commits on ref whose work would be lost with it (#455), as "<short sha> <subject>" lines: none when every
// commit is on origin, when its item's PR merged (merged: a Set of branch names), or when main has each one's
// changes (`git cherry` finds no "+"): a branch rebased or squashed before landing keeps commits origin never had.
async function unlanded(cwd, ref, branch, merged, git) {
  if (!(await git(['-C', cwd, 'rev-list', '-n1', ref, '--not', '--remotes'])).trim()) return [];
  if (branch && merged.has(branch)) return [];
  const main = (await git(['-C', cwd, 'rev-parse', '--abbrev-ref', 'origin/HEAD']).catch(() => '')).trim() || 'origin/main';
  const lacks = (await git(['-C', cwd, 'cherry', main, ref])).split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.slice(2));
  return Promise.all(lacks.map(async (sha) => (await git(['-C', cwd, 'log', '-1', '--format=%h %s', sha])).trim()));
}
// Once, short: "1a2b3c4 Add x; 5d6e7f8 Fix y and 3 more".
const commitsLine = (c) => `${c.slice(0, 2).join('; ')}${c.length > 2 ? ` and ${c.length - 2} more` : ''}`;

// A worker's branch, once it has gone with its worktree (#444): deleted when its item is done or dropped and
// nothing on it would be lost (see unlanded). Returns whether it was deleted.
export async function cleanBranch(home, branch, finished, git, merged = new Set()) {
  if (!branch || !finished.has(branch)) return false;
  if ((await unlanded(home, `refs/heads/${branch}`, branch, merged, git)).length) return false;
  await git(['-C', home, 'branch', '-D', branch]);
  return true;
}

export const SWEEP_EVERY_MS = 7 * 24 * 3600_000;
// A worktree with no branch (a reviewer's, or one never used) is only swept once nothing touched it for a day:
// another runner's worker may be in it.
const DETACHED_IDLE_MS = 24 * 3600_000;

// The weekly sweep (#444) of one checkout, home: the worktrees nuworq made for it (each directly in a folder
// named <checkout>.worktrees, also one from before the checkout was renamed) and its nuworq/* branches, where
// their item is done or dropped (finished: a Set of branch names), and nothing would be lost: no uncommitted
// changes, no commits whose work main lacks (see unlanded; merged: branches whose item's PR merged). A worktree
// with no branch goes when it is clean, landed, and idle a day.
// Never home itself, never another branch, never one in keep (running workers' worktrees). A worktree git still
// can't read after repair is only reported, by its path.
// idle(path): ms since that worktree's HEAD last moved. dryRun: only say what would go.
// Returns { worktrees, branches, pruned, kept: [{ what, why, detail? }] }.
export async function sweep({ home, finished, merged = new Set(), git, idle, keep = [], dryRun = false }) {
  const out = { worktrees: [], branches: [], pruned: 0, kept: [] };
  const ours = (path) => /\.worktrees\/[^/]+$/.test(path);
  const name = (path) => path.split('/').slice(-2).join('/');
  // Worktrees made before the checkout moved can't find it until repaired (their .git names the old path).
  // Repair only fixes those links and deletes nothing, so a dry run does it too and judges them like the rest.
  await git(['-C', home, 'worktree', 'repair']).catch(() => '');
  const trees = [];
  for (const block of (await git(['-C', home, 'worktree', 'list', '--porcelain'])).split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    trees.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null, prunable: /^prunable/m.test(block) });
  }
  // Records of worktrees whose folder is gone.
  out.pruned = trees.filter((t) => t.prunable).length;
  if (out.pruned && !dryRun) await git(['-C', home, 'worktree', 'prune']);
  const left = new Set(trees.map((t) => t.branch).filter(Boolean)); // branches still checked out somewhere
  for (const t of trees) {
    if (!ours(t.path) || keep.includes(t.path) || t.prunable || t.branch && !finished.has(t.branch)) continue;
    try {
      if (!t.branch && await idle(t.path) < DETACHED_IDLE_MS) continue;
      // --no-optional-locks: looking doesn't rewrite its index, so the worktree stays as idle as it was.
      if ((await git(['--no-optional-locks', '-C', t.path, 'status', '--porcelain'])).trim()) { out.kept.push({ what: name(t.path), why: 'uncommitted changes' }); continue; }
      const lacks = await unlanded(t.path, 'HEAD', t.branch, merged, git);
      if (lacks.length) { out.kept.push({ what: name(t.path), why: 'commits main lacks', detail: commitsLine(lacks) }); continue; }
      if (!dryRun) await git(['-C', home, 'worktree', 'remove', t.path]);
    } catch (e) {
      out.kept.push({ what: t.path, why: "git can't read it", detail: String(e.stderr || e.message).trim().split('\n')[0] });
      continue;
    }
    out.worktrees.push(name(t.path));
    if (t.branch) left.delete(t.branch);
  }
  for (const branch of (await git(['-C', home, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/nuworq/'])).split('\n').filter(Boolean)) {
    if (!finished.has(branch) || left.has(branch)) continue;
    const lacks = await unlanded(home, `refs/heads/${branch}`, branch, merged, git);
    if (lacks.length) { out.kept.push({ what: branch, why: 'commits main lacks', detail: commitsLine(lacks) }); continue; }
    if (!dryRun) await git(['-C', home, 'branch', '-D', branch]);
    out.branches.push(branch);
  }
  return out;
}

// The sweep's one line, e.g. "Swept nuworq: removed 3 worktrees and 5 branches, pruned 1 stale record; kept 2 (1 uncommitted
// changes, 1 commits main lacks)".
export function sweepLine(name, r, { dryRun = false } = {}) {
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const did = [r.worktrees.length && n(r.worktrees.length, 'worktree'), r.branches.length && n(r.branches.length, 'branch').replace(/branchs$/, 'branches')].filter(Boolean);
  const parts = [did.length ? `${dryRun ? 'would remove' : 'removed'} ${did.join(' and ')}` : 'nothing to remove',
    r.pruned && `${dryRun ? 'would prune' : 'pruned'} ${n(r.pruned, 'stale record')}`].filter(Boolean);
  const why = new Map();
  for (const k of r.kept) why.set(k.why, (why.get(k.why) ?? 0) + 1);
  return `${dryRun ? 'Sweep (dry run)' : 'Swept'} ${name}: ${parts.join(', ')}${r.kept.length ? `; kept ${r.kept.length} (${[...why].map(([w, k]) => `${k} ${w}`).join(', ')})` : ''}`;
}

// Before the first poll (#491): staffing is never off without saying so. projects: the hub's, as this machine's token
// reaches them; here: the one whose clone this runs in (or null); staff: --staff <project>, opted in first.
// ask(question): the person's answer, at a terminal (absent: none). optIn(project): turns on its "Staff it with
// nuworq run" switch, as Settings does. Returns the projects, with any it opted in marked.
const STAFF_HOW = 'turn on "Staff it with nuworq run" in its Settings on the hub, or run nuworq run --staff <project>';
export async function staffCheck({ projects, here = null, staff, ask, optIn, log = console.log }) {
  const live = projects.filter((p) => !p.parked);
  const find = (s) => live.find((p) => [p.slug, String(p.name ?? '').toLowerCase()].includes(String(s).trim().toLowerCase()));
  const names = live.map((p) => p.name ?? p.slug).join(', ');
  const take = async (p) => { await optIn(p); p.runner = true; log(`nuworq run now staffs ${p.name ?? p.slug}: its workers start whenever work is waiting there.`); };
  if (typeof staff === 'string' && staff) {
    const p = find(staff);
    if (!p) throw Object.assign(new Error(`No project "${staff}" on this hub that this machine reaches`), { hint: `Its projects: ${names || 'none'}.` });
    if (!p.runner) await take(p);
  }
  if (!live.length || live.some((p) => p.runner)) return projects;
  log(`No project is staffed by nuworq run: ${names}. Workers start only in projects whose "Staff it with nuworq run" switch is on.`);
  if (!ask) { log(`To staff one, ${STAFF_HOW}.`); return projects; }
  const yes = (a) => /^y(es)?$/i.test(String(a ?? '').trim());
  let pick = null;
  if (here && live.includes(here)) {
    if (yes(await ask(`Let nuworq run staff ${here.name ?? here.slug}, the project of this clone? Its workers can cost money. [y/N] `))) pick = here;
  } else {
    const a = String(await ask(`Which project should nuworq run staff? Its workers can cost money. (${live.map((p) => p.slug).join(', ')}; Enter for none) `) ?? '').trim();
    pick = a ? find(a) ?? null : null;
    if (a && !pick) log(`No project "${a}".`);
  }
  if (pick) await take(pick);
  else log(`None staffed, so no worker starts. Later, ${STAFF_HOW}.`);
  return projects;
}

// The once-per-run line (#491) on work waiting where nuworq run doesn't staff: routes, the hub's /api/route without
// runner=1 (every project the token reaches); projects, the hub's list. Null when none waits there.
export function unstaffedLine(routes, projects) {
  const off = new Map(projects.filter((p) => !p.runner && !p.parked).map((p) => [p.slug, p]));
  const waiting = routes.filter((r) => off.has(r.project));
  if (!waiting.length) return null;
  const n = waiting.reduce((k, r) => k + (r.claimable ?? 1), 0);
  const where = waiting.map((r) => `${off.get(r.project).name ?? r.project} (${r.claimable ?? 1})`).join(', ');
  return `${n} item${n === 1 ? ' waits' : 's wait'} in projects nuworq run doesn't staff: ${where}. To staff one, ${STAFF_HOW}.`;
}

const FAST_FAIL_MS = 15_000;
const FAST_FAILS = 3;
// Clean exits this soon without claiming anything: the hub routed a worker to work it couldn't take.
const EMPTY_MS = 60_000;
const EMPTIES = 3;
const PAUSE_MS = 5 * 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;

// routes(): the hub's runner routes. launch(route): starts a worker, returns { name, project, where, kill(signal),
// exited: Promise<code>, spent?(): dollars its CLI reported, read once it has exited }.
// launch throws an error with skip: true when this machine can't work on the route's project (no
// checkout of it here): that project is left to others for this round, said once, and isn't a failure.
// With pause: true too (its checkout couldn't be updated, e.g. git can't reach origin), the project is left
// alone for 5 minutes, then 10, up to 30, and said each time; the others go on.
// claimed(worker): whether the hub saw it take a job since it started (absent: assume it did).
// onInterrupt(fn): register fn for Ctrl-C. The first stops launching and asks workers to stop; the next kills them.
// maxUsd: stop launching once the workers' reported spend reaches it; running workers finish.
// report(state): tells the hub how this runner is, once per poll and once more when it stops (#171); a
// report that fails is let go (the hub shows the runner down until one gets through).
// sweep(running): the weekly sweep (#444), run once sweptAt (when it last ran) is a week old; it says what it removed.
// updated(): checked between rounds (#456); "<from> → <to>" once the package installed under this runner differs
// from the one it started on, else null. supervised: a service (launchd, systemd) restarts it when it exits, so it
// stops launching, lets running workers finish, and returns restart: true; started by hand, it only says so, once.
// workers: how many at once, or 'auto' (#533): as many as the machine has room for (capacity(), from machine(),
// up to maxWorkers), saying once per change why it holds. took(worker): what a worker started for no one job
// claimed, e.g. "#12 Fix x (review)", or null while it hasn't; said once, when it has.
// unstaffed(): the line on work waiting in projects it doesn't staff (see unstaffedLine), or null; said the first
// time nothing is waiting for it (#491), once per run. signoff(worker): signs off a worker that exited, handing back what
// it held (#558), so a crashed one's item doesn't wait out its lease; the hub ignores it for one that already signed off.
export async function run({
  routes, launch, claimed = async () => true, took = async () => null, log = console.log, report = async () => {}, sweep, sweptAt = 0,
  updated = () => null, supervised = false, signoff = async () => {}, machine = () => ({}), maxWorkers, unstaffed = async () => null,
  workers = 1, maxRuns = Infinity, maxMinutes = Infinity, maxUsd = Infinity, pollSeconds = 30, untilIdle = false,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onInterrupt,
}) {
  const running = [];
  const done = [];
  const auto = workers === 'auto';
  const most = auto ? (maxWorkers ?? autoMax(machine().cores ?? 1)) : workers;
  let holding = null; // why --workers auto starts no more now, as last said
  let lastStart = -Infinity;
  let launched = 0;
  let spent = 0;
  let fastFails = 0;
  let empties = [];
  let pausedUntil = 0;
  let pauseMs = PAUSE_MS;
  let stopping = false;
  let why = '';
  let wake = () => {};
  let hubDown = false;
  let idle = false;
  let toldUnstaffed = false;
  let moved = null; // "<from> → <to>": the installed package changed under this runner
  const cant = new Map(); // project → why this machine can't work on it, as last said
  const resting = new Map(); // project → { until, ms }: its checkout couldn't be updated, so it waits until then
  const stop = (reason) => { if (!stopping) { stopping = true; why = reason; } wake(); };
  let interrupted = false;
  onInterrupt?.(() => {
    running.forEach((w) => w.kill(interrupted ? 'SIGKILL' : 'SIGTERM'));
    interrupted = true;
    stop('interrupted');
  });
  // A streak that would only repeat itself: with --until-idle, stop; otherwise wait 5m, then 10m, up to 30m.
  let pausedWhy = '';
  const pause = (reason, advice) => {
    if (untilIdle) return stop(reason);
    log(`Paused ${pauseMs / 60_000}m: ${reason}. ${advice}`);
    pausedWhy = reason;
    pausedUntil = now() + pauseMs;
    pauseMs = Math.min(pauseMs * 2, MAX_PAUSE_MS);
  };
  // How this runner is, for the hub: what's running against its limit, what it leaves alone and why, any pause.
  const state = () => {
    const t = now();
    return {
      running: running.length, workers: most, ...(auto ? { auto: true, holding } : {}), spent, poll_seconds: pollSeconds,
      // Its live workers by name (#540): the hub renews the leases they hold, so none has to spend a turn on it.
      live: running.map((w) => w.name),
      skipping: [
        ...[...resting].filter(([, r]) => r.until > t).map(([project, r]) => ({ project, reason: cant.get(project) ?? "its checkout couldn't be updated", until: r.until })),
        ...[...cant].filter(([project]) => !(resting.get(project)?.until > t)).map(([project, reason]) => ({ project, reason })),
      ],
      paused: pausedUntil > t ? { until: pausedUntil, reason: pausedWhy } : null,
    };
  };
  const tell = (s) => Promise.resolve().then(() => report(s)).catch(() => {});
  const failedFast = () => {
    if (++fastFails < FAST_FAILS) return;
    fastFails = 0;
    pause(`${FAST_FAILS} workers in a row failed within seconds`, 'Check the agent runs on its own (see its log).');
  };
  const foundNothing = (w) => {
    empties.push(w.project);
    if (empties.length < EMPTIES) return;
    const reason = `${EMPTIES} workers in a row found nothing to claim in ${[...new Set(empties)].join(', ')}`;
    empties = [];
    pause(reason, "The hub routed them to work they couldn't take; check the project's needs and opt-ins.");
  };

  for (;;) {
    const t = now();
    for (const w of running) {
      if (!w.killedAt && t - w.started > maxMinutes * 60_000) {
        log(`${w.name} ran past ${maxMinutes}m: stopping it (its lease expires and the item returns to the queue)`);
        w.kill('SIGTERM');
        w.killedAt = t;
      } else if (w.killedAt && t - w.killedAt > KILL_GRACE_MS) {
        w.kill('SIGKILL');
      }
    }

    if (!moved && !stopping) {
      let change = null;
      try { change = updated(); } catch {}
      if (change) {
        moved = change;
        if (supervised) {
          stop(`nuworq updated ${moved}`);
          if (running.length) log(`nuworq updated ${moved}: restarting onto it once ${running.length} running worker(s) finish; starting no new ones.`);
        } else log(`nuworq updated ${moved}, but this runner still runs the old code: restart it (Ctrl-C, then nuworq run again) to use the new one.`);
      }
    }

    // What each worker started for no one job took, once it has (#533).
    for (const w of running.filter((x) => !x.told)) {
      const what = await Promise.resolve().then(() => took(w)).catch(() => null);
      if (what) { w.told = true; log(`  ${w.name} took ${what}`); }
    }

    if (sweep && !stopping && t - sweptAt >= SWEEP_EVERY_MS) {
      sweptAt = t;
      await Promise.resolve().then(() => sweep(running)).catch((e) => log(`The sweep failed: ${e.message}`));
    }

    let list = null;
    if (!stopping && t >= pausedUntil) {
      try {
        list = await routes();
        if (hubDown) log('The hub is back.');
        hubDown = false;
      } catch (e) {
        if (!hubDown) log(`Can't reach the hub (${e.message}); retrying every ${pollSeconds}s.`);
        hubDown = true;
      }
    }
    if (list && !stopping) {
      // Projects this machine can't work on this round; their slots go to the others (plan again).
      const skip = new Set();
      let held = null;
      for (let again = true; again && !stopping;) {
        again = false;
        const open = list.filter((x) => !skip.has(x.project) && !(resting.get(x.project)?.until > t));
        let cap = workers;
        if (auto) {
          const c = capacity(running.length, machine(), { max: most, sinceStart: now() - lastStart });
          cap = c.workers;
          // Holding only when there's work it would otherwise start.
          held = c.holding && plan(open, running, { workers: Infinity, maxRuns, launched }).length > plan(open, running, { workers: cap, maxRuns, launched }).length ? c.holding : null;
        }
        for (const r of plan(open, running, { workers: cap, maxRuns, launched })) {
          if (stopping) break;
          let w;
          try {
            w = await launch(r);
          } catch (e) {
            if (e.skip) {
              const hint = e.hint ? `\n  ${e.hint}` : '';
              if (e.pause) {
                const ms = Math.min(2 * (resting.get(r.project)?.ms ?? PAUSE_MS / 2), MAX_PAUSE_MS);
                resting.set(r.project, { until: now() + ms, ms });
                log(`Skipping ${r.name ?? r.project} for ${ms / 60_000}m: ${e.message}${hint}`);
              } else if (cant.get(r.project) !== e.message) log(`Skipping ${r.name ?? r.project}: ${e.message}${hint}`);
              cant.set(r.project, e.message);
              skip.add(r.project);
              again = true;
              break;
            }
            launched++;
            log(`Couldn't start a worker for ${r.name ?? r.project}: ${e.message}`);
            done.push({ name: '(not started)', project: r.project, code: 'error', secs: 0 });
            failedFast();
            continue;
          }
          launched++;
          cant.delete(r.project);
          resting.delete(r.project);
          w.started = lastStart = now();
          running.push(w);
          // The job only when it was started for that one (a routed model, #347): otherwise it takes what next
          // gives it, which a later line says (#533).
          w.told = !!r.model;
          log(`▶ ${w.name} → ${r.name ?? r.project}${r.model ? `: ${r.item} ${r.title} (${r.mode} on ${r.model})` : ''}${w.where ? `  ${w.where}` : ''}`);
          w.exited.then(async (code) => {
            const ms = now() - w.started;
            const secs = Math.round(ms / 1000);
            done.push({ name: w.name, project: w.project, code, secs });
            const usd = Number(w.spent?.()) || 0;
            spent += usd;
            log(`■ ${w.name} (${w.project}) exited ${code} after ${secs}s${usd ? `, spent $${usd.toFixed(2)}` : ''}`);
            const others = running.length - 1; // this one is still in the list until the hub answers below
            if (spent >= maxUsd) stop(`reached --max-usd ${maxUsd} ($${spent.toFixed(2)} spent)${others ? `; letting ${others} running worker(s) finish` : ''}`);
            if (code !== 0 && !interrupted && !w.killedAt && ms < FAST_FAIL_MS) failedFast();
            else fastFails = 0;
            // It counts as running until the hub answers, so no replacement starts meanwhile.
            await Promise.resolve().then(() => signoff(w)).catch(() => {});
            const empty = code === 0 && !interrupted && !w.killedAt && ms < EMPTY_MS && !(await claimed(w).catch(() => true));
            if (empty) foundNothing(w);
            else if (code === 0) { empties = []; pauseMs = PAUSE_MS; } // it worked: the next streak pauses 5m again
            running.splice(running.indexOf(w), 1);
            wake();
          });
        }
      }
      if (auto && held !== holding) {
        if (held) log(`Holding at ${running.length}: ${held}`);
        holding = held;
      }
      // Work starts the moment it's ready: by default, wait for it rather than exit.
      // Work this machine can't take doesn't count.
      const elsewhere = list.some((x) => cant.has(x.project));
      const waiting = list.some((x) => !cant.has(x.project));
      // Nothing for it here: work waiting where it doesn't staff is said once, before the waiting line.
      if (!waiting && !running.length && !toldUnstaffed) {
        toldUnstaffed = true;
        const line = await Promise.resolve().then(unstaffed).catch(() => null);
        if (line) log(line);
      }
      if (waiting) idle = false;
      else if (!running.length && untilIdle) stop(elsewhere ? 'no work this machine can take is waiting' : 'no work is waiting in opted-in projects');
      else if (!running.length && !idle) {
        idle = true;
        log(`${elsewhere ? 'Nothing this machine can take is waiting' : 'Nothing is waiting in opted-in projects'}; checking every ${pollSeconds}s. Ctrl-C stops.`);
      }
    }
    if (!stopping && launched >= maxRuns && !running.length) stop(`reached --max-runs ${maxRuns}`);
    if (stopping && !running.length) break;
    if (!hubDown) await tell(state());
    await Promise.race([sleep(pollSeconds * 1000), new Promise((r) => { wake = r; })]);
  }

  await tell({ ...state(), stopped: why });
  const failed = done.filter((d) => d.code !== 0).length;
  const each = done.map((d) => `${d.name}@${d.project}:${d.code}`).join(', ');
  log(`Done: ${why}. ${launched} launched, ${done.length - failed} exited cleanly, ${failed} failed${each ? ` (${each})` : ''}${spent || maxUsd !== Infinity ? `; $${spent.toFixed(2)} spent` : ''}.`);
  const restart = !!(supervised && moved && !interrupted);
  if (restart) log(`nuworq updated ${moved}: restarting onto it`);
  return { launched, done, why, spent, restart };
}
