// trellis run: keep up to N headless workers on waiting work in the projects the human opted in.
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
const KILL_GRACE_MS = 10_000;

// routes(): the hub's runner routes. launch(route): starts a worker, returns { name, project, where, kill(signal), exited: Promise<code> }.
// onInterrupt(fn): register fn for Ctrl-C. The first stops launching and asks workers to stop; the next kills them.
export async function run({
  routes, launch, log = console.log,
  workers = 1, maxRuns = Infinity, maxMinutes = Infinity, pollSeconds = 30,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onInterrupt,
}) {
  const running = [];
  const done = [];
  let launched = 0;
  let fastFails = 0;
  let stopping = false;
  let why = '';
  let wake = () => {};
  let hubDown = false;
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
    if (!stopping) {
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
      for (const r of plan(list, running, { workers, maxRuns, launched })) {
        if (stopping) break;
        let w;
        launched++;
        try {
          w = await launch(r);
        } catch (e) {
          log(`Couldn't start a worker for ${r.name ?? r.project}: ${e.message}`);
          done.push({ name: '(not started)', project: r.project, code: 'error', secs: 0 });
          failedFast();
          continue;
        }
        w.started = now();
        running.push(w);
        log(`▶ ${w.name} → ${r.name ?? r.project}: ${r.item} ${r.title} (${r.mode})${w.where ? `  ${w.where}` : ''}`);
        w.exited.then((code) => {
          running.splice(running.indexOf(w), 1);
          const secs = Math.round((now() - w.started) / 1000);
          done.push({ name: w.name, project: w.project, code, secs });
          log(`■ ${w.name} (${w.project}) exited ${code} after ${secs}s`);
          if (code !== 0 && !interrupted && !w.killedAt && now() - w.started < FAST_FAIL_MS) failedFast();
          else fastFails = 0;
          wake();
        });
      }
      if (!running.length && !list.length) stop('no work is waiting in opted-in projects');
    }
    if (!stopping && launched >= maxRuns && !running.length) stop(`reached --max-runs ${maxRuns}`);
    if (stopping && !running.length) break;
    await Promise.race([sleep(pollSeconds * 1000), new Promise((r) => { wake = r; })]);
  }

  const failed = done.filter((d) => d.code !== 0).length;
  const each = done.map((d) => `${d.name}@${d.project}:${d.code}`).join(', ');
  log(`Done: ${why}. ${launched} launched, ${done.length - failed} exited cleanly, ${failed} failed${each ? ` (${each})` : ''}.`);
  return { launched, done, why };
}
