// nuworq run: keep up to N headless workers on waiting work in the projects the human opted in.
// plan() decides, run() does the I/O; everything outside is injected so tests start no real agents.

// What to launch now. routes: the hub's /api/route?runner=1 (value order, one entry per project, with
// how much is claimable and who holds work there). running: live workers this runner started.
// A worker that hasn't claimed anything yet still counts against its project's claimable work,
// so one waiting item never draws a herd.
export function plan(routes, running, { workers = 1, maxRuns = Infinity, launched = 0 } = {}) {
  let slots = Math.min(workers - running.length, maxRuns - launched);
  const out = [];
  for (const r of routes) {
    if (slots <= 0) break;
    const held = new Set(r.holders ?? []);
    const idle = running.filter((w) => w.project === r.project && !held.has(w.name)).length;
    const n = Math.min(slots, (r.claimable ?? 1) - idle);
    for (let i = 0; i < n; i++) out.push(r);
    slots -= Math.max(n, 0);
  }
  return out;
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
// claimed(worker): whether the hub saw it take a job since it started (absent: assume it did).
// onInterrupt(fn): register fn for Ctrl-C. The first stops launching and asks workers to stop; the next kills them.
// maxUsd: stop launching once the workers' reported spend reaches it; running workers finish.
export async function run({
  routes, launch, claimed = async () => true, log = console.log,
  workers = 1, maxRuns = Infinity, maxMinutes = Infinity, maxUsd = Infinity, pollSeconds = 30, untilIdle = false,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onInterrupt,
}) {
  const running = [];
  const done = [];
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
  const cant = new Map(); // project → why this machine can't work on it, as last said
  const stop = (reason) => { if (!stopping) { stopping = true; why = reason; } wake(); };
  let interrupted = false;
  onInterrupt?.(() => {
    running.forEach((w) => w.kill(interrupted ? 'SIGKILL' : 'SIGTERM'));
    interrupted = true;
    stop('interrupted');
  });
  const failedFast = () => {
    fastFails++;
    if (fastFails >= FAST_FAILS) stop(`${FAST_FAILS} workers in a row failed within seconds; check the agent runs on its own (see its log)`);
  };
  const foundNothing = (w) => {
    empties.push(w.project);
    if (empties.length < EMPTIES) return;
    const reason = `${EMPTIES} workers in a row found nothing to claim in ${[...new Set(empties)].join(', ')}`;
    empties = [];
    if (untilIdle) return stop(reason);
    log(`Paused ${pauseMs / 60_000}m: ${reason}. The hub routed them to work they couldn't take; check the project's needs and opt-ins.`);
    pausedUntil = now() + pauseMs;
    pauseMs = Math.min(pauseMs * 2, MAX_PAUSE_MS);
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
      for (let again = true; again && !stopping;) {
        again = false;
        for (const r of plan(list.filter((x) => !skip.has(x.project)), running, { workers, maxRuns, launched })) {
          if (stopping) break;
          let w;
          try {
            w = await launch(r);
          } catch (e) {
            if (e.skip) {
              if (cant.get(r.project) !== e.message) log(`Skipping ${r.name ?? r.project}: ${e.message}${e.hint ? `\n  ${e.hint}` : ''}`);
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
          w.started = now();
          running.push(w);
          log(`▶ ${w.name} → ${r.name ?? r.project}: ${r.item} ${r.title} (${r.mode})${w.where ? `  ${w.where}` : ''}`);
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
            const empty = code === 0 && !interrupted && !w.killedAt && ms < EMPTY_MS && !(await claimed(w).catch(() => true));
            if (empty) foundNothing(w);
            else if (code === 0) empties = [];
            running.splice(running.indexOf(w), 1);
            wake();
          });
        }
      }
      // Work starts the moment it's ready: by default, wait for it rather than exit.
      // Work this machine can't take doesn't count.
      const elsewhere = list.some((x) => cant.has(x.project));
      if (list.some((x) => !cant.has(x.project))) idle = false;
      else if (!running.length && untilIdle) stop(elsewhere ? 'no work this machine can take is waiting' : 'no work is waiting in opted-in projects');
      else if (!running.length && !idle) {
        idle = true;
        log(`${elsewhere ? 'Nothing this machine can take is waiting' : 'Nothing is waiting in opted-in projects'}; checking every ${pollSeconds}s. Ctrl-C stops.`);
      }
    }
    if (!stopping && launched >= maxRuns && !running.length) stop(`reached --max-runs ${maxRuns}`);
    if (stopping && !running.length) break;
    await Promise.race([sleep(pollSeconds * 1000), new Promise((r) => { wake = r; })]);
  }

  const failed = done.filter((d) => d.code !== 0).length;
  const each = done.map((d) => `${d.name}@${d.project}:${d.code}`).join(', ');
  log(`Done: ${why}. ${launched} launched, ${done.length - failed} exited cleanly, ${failed} failed${each ? ` (${each})` : ''}${spent || maxUsd !== Infinity ? `; $${spent.toFixed(2)} spent` : ''}.`);
  return { launched, done, why, spent };
}
