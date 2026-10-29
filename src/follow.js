// nuworq serve --follow: keep the hub on the latest main that passes its tests.
// Agents land work by fast-forwarding main, and the hub is built that way too, so it moves onto new
// main commits by itself. The hub runs as a child process from its own git worktree (hub-src), detached
// at a commit, never from the human's checkout (which agents move). When main moves, the new commit is
// tested in a second worktree (hub-next), so the running hub's files never change under it. If the
// tests pass, the hub stops, hub-src moves to the commit, and the hub starts again; if the new hub
// doesn't answer, it goes back to the last good commit. If main fails its tests, the hub stays where it
// is and fixing main goes to the front of the queue: stop the line, not the hub.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const short = (sha) => String(sha).slice(0, 7);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP_GRACE_MS = 5000;
const HEALTHY_MS = 15_000;
const TEST_TIMEOUT_MS = 10 * 60_000;

// The tests run without the hub's own NUWORQ_* / TRELLIS_* settings, so they can't reach its database or
// the hub itself (and without NODE_TEST_CONTEXT, so they report normally even when this runs under node --test).
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ_|TRELLIS_|NODE_TEST_CONTEXT$)/.test(k)));

// The first failing test in `npm test` output: "suite › test" from node --test's spec reporter,
// or the test name from TAP (what Node 22 prints when its output is piped). null if none is named.
export function firstFailure(out) {
  const lines = String(out).split('\n');
  const at = lines.findIndex((l) => /^\s*✖ /.test(l) && !/✖ failing tests:/.test(l));
  if (at >= 0) {
    const name = (l) => l.trim().replace(/^[✖▶]\s*/, '').replace(/\s*\([\d.]+m?s\)$/, '');
    const path = [name(lines[at])];
    let indent = lines[at].search(/\S/);
    for (let i = at - 1; i >= 0 && indent > 0; i--) {
      const d = lines[i].search(/\S/);
      if (d >= 0 && d < indent && /^\s*▶ /.test(lines[i])) { path.unshift(name(lines[i])); indent = d; }
    }
    return path.join(' › ');
  }
  return lines.map((l) => l.match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/)?.[1]).find(Boolean) ?? null;
}

async function answers(url) {
  try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

// A worktree of repo at path, detached at sha: added the first time, moved after that.
function place(repo, path, sha) {
  if (existsSync(join(path, '.git'))) return git(path, 'checkout', '-q', '--force', '--detach', sha);
  git(repo, 'worktree', 'prune');
  git(repo, 'worktree', 'add', '-q', '--detach', path, sha);
}

// The real world: git, npm test, the hub as a child process, its health check and its human API.
// repo: the checkout whose main is followed. dir: the worktree the hub runs from. next: the worktree
// candidates are tested in. args: the hub's serve flags. url: where the hub answers. cwd: the hub's
// working directory (relative --db paths mean what they did).
export function system({ repo, dir, next = `${dir}-next`, args = [], url, bin = 'bin/nuworq.js', cwd = process.cwd() }) {
  let child = null;
  let testing = null;
  let closed = false;
  const killGroup = (p, sig) => { try { process.kill(-p.pid, sig); } catch {} };
  return {
    head(branch) {
      try { return git(repo, 'rev-parse', '--verify', '-q', `${branch}^{commit}`); } catch { return null; }
    },
    // Move the hub's own worktree: only while the hub is stopped, right before it starts.
    checkout: (sha) => place(repo, dir, sha),
    // npm test on sha in the candidates' worktree, without blocking: the supervisor keeps answering
    // signals meanwhile, and the running hub's worktree is untouched.
    test(sha) {
      try {
        place(repo, next, sha);
      } catch (e) {
        return Promise.resolve({ ok: false, failed: `couldn't check it out to test it (${e.message.split('\n')[0]})` });
      }
      return new Promise((resolve) => {
        let out = '';
        let done = false;
        const p = testing = spawn('npm', ['test', '--silent'], { cwd: next, env: testEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        const timer = setTimeout(() => killGroup(p, 'SIGKILL'), TEST_TIMEOUT_MS);
        const finish = (ok, why) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (testing === p) testing = null;
          resolve(ok ? { ok: true } : { ok: false, failed: firstFailure(out) ?? why });
        };
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        p.on('error', (e) => finish(false, `npm test didn't run (${e.message})`));
        p.on('close', (code, sig) => finish(code === 0, sig ? `the tests were stopped (${sig})` : 'the test suite exited with an error'));
      });
    },
    async start() {
      if (await answers(url)) throw new Error(`something else already answers at ${url}; stop it or pick another --port`);
      if (closed) return;
      // Its own process group: Ctrl-C reaches the supervisor, which stops the hub in order.
      child = spawn(process.execPath, [join(dir, bin), 'serve', ...args], { cwd, stdio: 'inherit', detached: true });
    },
    alive: () => !!child && child.exitCode == null && child.signalCode == null,
    async stop() {
      const c = child;
      child = null;
      if (!c || c.exitCode != null || c.signalCode != null) return;
      await new Promise((resolve) => {
        const kill = setTimeout(() => c.kill('SIGKILL'), STOP_GRACE_MS);
        c.once('exit', () => { clearTimeout(kill); resolve(); });
        c.kill('SIGTERM');
      });
    },
    async healthy(ms = HEALTHY_MS) {
      const until = Date.now() + ms;
      while (Date.now() < until && !closed) {
        if (!child || child.exitCode != null || child.signalCode != null) return false;
        if (await answers(url)) return true;
        await sleep(250);
      }
      return false;
    },
    // Main is red: one "fix main" item at priority now, in the project that lives in this repo, through
    // the hub's human API (on a hub with login, that needs a human NUWORQ_TOKEN). Returns "#12 in nuworq", or null.
    // running: the commit the hub runs (the red one itself when the supervisor just started on it).
    async redMain(sha, failed, running) {
      const { createClient } = await import('./client.js');
      const hub = createClient({ url, cwd: repo });
      const project = hub.settings.project ?? (await hub.where()).project;
      if (!project) return null;
      const hubIs = running === sha
        ? 'The hub runs it anyway, since it just started and had nothing older to run.'
        : `The hub stays on ${short(running)}, the last commit that passed.`;
      const r = await hub.post(`/api/p/${encodeURIComponent(project)}/human/create`, {
        title: `main fails its tests at ${short(sha)}: ${failed}`.slice(0, 160),
        summary: `\`npm test\` fails on main at ${sha} (${failed}). ${hubIs} Fix main before anything else: everything that lands next builds on it.`,
        acceptance: '`npm test` passes on main, and the hub moves onto it by itself.',
        priority: 'now',
      });
      return `${r.item} in ${project}`;
    },
    async close() {
      closed = true;
      if (testing) killGroup(testing, 'SIGTERM');
      await this.stop();
    },
  };
}

// The loop, apart from the real world (sys: see system()). boot() starts the hub on main and tests
// it; tick() checks once whether main moved and acts on it; close() stops the hub.
// state.skip: a commit not to try again (it failed its tests or didn't start).
// state.red: main is in a red streak and someone has been asked to fix it.
export function follower(sys, { branch = 'main', log = () => {} } = {}) {
  const state = { running: null, good: null, skip: null, red: false, busy: false, closed: false };

  // Main is red at sha: say so, and once per red streak, put fixing it at the front of the queue.
  async function red(sha, failed) {
    state.skip = sha;
    const doing = sha === state.running ? 'running it anyway: there is nothing older to run' : `staying on ${short(state.running)}`;
    if (state.red) return log(`${branch} at ${short(sha)} still fails its tests (${failed}); ${doing}`);
    log(`${branch} at ${short(sha)} fails its tests (${failed}); ${doing}`);
    try {
      const where = await sys.redMain(sha, failed, state.running);
      state.red = !!where;
      log(where ? `asked for ${branch} to be fixed first: ${where}` : `no project on the hub lives in this repo, so nobody was asked to fix ${branch}`);
    } catch (e) {
      log(`couldn't ask for ${branch} to be fixed (${e.message}); will ask again at the next red commit`);
    }
  }

  // Start on main as it is (there is nothing better to run), then test it like any other commit,
  // so a supervisor restarted in a red streak still stops the line.
  async function boot() {
    const sha = sys.head(branch);
    if (!sha) throw new Error(`there is no ${branch} branch to follow`);
    sys.checkout(sha);
    await sys.start();
    if (!(await sys.healthy())) {
      await sys.stop();
      throw new Error(`the hub didn't answer at ${short(sha)} within ${HEALTHY_MS / 1000}s`);
    }
    Object.assign(state, { running: sha, good: sha });
    log(`hub running at ${short(sha)}; following ${branch}, testing ${short(sha)}`);
    state.busy = true;
    try {
      const t = await sys.test(sha);
      if (state.closed) return;
      if (t.ok) log(`${short(sha)} passes its tests`);
      else await red(sha, t.failed);
    } finally {
      state.busy = false;
    }
  }

  async function tick() {
    if (state.busy || state.closed || !state.running) return;
    state.busy = true;
    try {
      if (sys.alive && !sys.alive()) {
        log(`the hub stopped by itself; starting it again at ${short(state.running)}`);
        sys.checkout(state.running);
        await sys.start();
        if (!(await sys.healthy())) log(`the hub didn't answer at ${short(state.running)}; trying again at the next check`);
        return;
      }
      const sha = sys.head(branch);
      if (!sha || sha === state.running || sha === state.skip) return;
      log(`${branch} moved to ${short(sha)}; running its tests`);
      const t = await sys.test(sha);
      if (state.closed) return;
      if (!t.ok) return await red(sha, t.failed);
      log(`${short(sha)} passes its tests${state.red ? ` (${branch} is green again)` : ''}; restarting the hub on it`);
      state.red = false;
      await sys.stop();
      sys.checkout(sha);
      await sys.start();
      if (await sys.healthy()) {
        Object.assign(state, { running: sha, good: sha, skip: null });
        return log(`hub moved to ${short(sha)}`);
      }
      if (state.closed) return;
      log(`the hub didn't answer at ${short(sha)} within ${HEALTHY_MS / 1000}s; going back to ${short(state.good)} and not trying ${short(sha)} again`);
      state.skip = sha;
      await sys.stop();
      sys.checkout(state.good);
      state.running = state.good;
      await sys.start();
      log((await sys.healthy()) ? `hub back at ${short(state.good)}` : `the hub didn't answer at ${short(state.good)} either; trying again at the next check`);
    } catch (e) {
      log(`couldn't follow ${branch} this time (${e.message}); trying again at the next check`);
    } finally {
      state.busy = false;
    }
  }

  async function close() {
    state.closed = true;
    await sys.close();
  }

  return { boot, tick, close, state };
}

// Run it: start the hub, check main every few seconds, and stop the hub on SIGINT, SIGTERM or SIGHUP.
export async function follow({ repo, dir, next, args, url, branch = 'main', every = 10_000, log }) {
  const sys = system({ repo, dir, next, args, url });
  const f = follower(sys, { branch, log });
  let timer;
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log(`${sig}: stopping the hub`);
    await f.close();
    log('stopped');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => stop(sig));
  log(`following ${branch} in ${repo}; the hub runs from ${dir}, and new commits are tested in ${next}`);
  try {
    await f.boot();
  } catch (e) {
    if (stopping) return;
    await sys.close();
    throw e;
  }
  timer = setInterval(() => f.tick(), every);
}
