// nuworq serve --follow: keep the hub on the latest main that passes its tests.
// Agents land work by fast-forwarding main, and the hub is built that way too, so it moves onto new
// main commits by itself. The hub runs as a child process from its own git worktree (hub-src), detached
// at a commit, never from the human's checkout (which agents move). When main moves, the new commit is
// tested in a second worktree (hub-next), so the running hub's files never change under it. If the
// tests pass, the hub stops, hub-src moves to the commit, and the hub starts again; if the new hub
// doesn't answer, it goes back to the last good commit. If main fails its tests, the hub stays where it
// is and fixing main goes to the front of the queue: stop the line, not the hub. Before each move the
// database is copied aside, and a rollback puts the copy back: new code may migrate it on startup.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const short = (sha) => String(sha).slice(0, 7);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP_GRACE_MS = 5000;
const HEALTHY_MS = 15_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
export const KEEP_BACKUPS = 10;
const DIRECTORY_FILE = 'directory.sqlite'; // the workspaces host directory (src/workspaces.js)

// Copies of the hub's database, one per move, named after the commit moved away from: dir/<sha>.db for
// one database (db), or dir/<sha>/<name>.db for every workspace file in workspaces. Taken only while the
// hub is stopped, with VACUUM INTO, so what sits in the WAL is in the copy and no copy is torn. A copy is
// written aside and renamed into place, so a failed one (disk full) never passes for a good one. The
// order file lists them oldest first; past KEEP_BACKUPS the oldest go.
export function backups({ dir, db = null, workspaces = null, keep = KEEP_BACKUPS }) {
  const orderFile = join(dir, 'order');
  const order = () => { try { return readFileSync(orderFile, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const target = (sha) => join(dir, workspaces ? sha : `${sha}.db`);
  // The live files now, by name: a workspace created since the last move is in the next copy, and so is
  // the host directory (people, sessions, memberships), which isn't a .db so it's never taken for a workspace.
  const copied = (f) => f.endsWith('.db') || f === DIRECTORY_FILE;
  const live = () => workspaces
    ? (existsSync(workspaces) ? readdirSync(workspaces).filter(copied).map((f) => ({ name: f, file: join(workspaces, f) })) : [])
    : existsSync(db) ? [{ name: 'db', file: db }] : [];
  const vacuum = (from, to) => {
    const d = new DatabaseSync(from);
    try { d.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`); } finally { d.close(); }
  };
  return {
    // Copy the database(s) as they are now; returns where, or null when there is nothing to copy yet.
    backup(sha) {
      const files = live();
      if (!files.length) return null;
      mkdirSync(dir, { recursive: true });
      const out = target(sha), tmp = `${out}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      try {
        if (workspaces) {
          mkdirSync(tmp);
          for (const f of files) vacuum(f.file, join(tmp, f.name));
        } else {
          vacuum(files[0].file, tmp);
        }
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
      }
      rmSync(out, { recursive: true, force: true });
      renameSync(tmp, out);
      const kept = [...order().filter((s) => s !== sha), sha];
      for (const old of kept.splice(0, Math.max(0, kept.length - keep))) rmSync(target(old), { recursive: true, force: true });
      writeFileSync(orderFile, kept.join('\n') + '\n');
      return out;
    },
    // Put the copy taken when leaving sha back, with the hub stopped; null when there is none. A
    // workspace the copy doesn't have (created since) is left as it is.
    restore(sha) {
      const src = target(sha);
      if (!existsSync(src)) return null;
      const pairs = workspaces
        ? readdirSync(src).filter(copied).map((f) => [join(src, f), join(workspaces, f)])
        : [[src, db]];
      for (const [from, to] of pairs) {
        copyFileSync(from, `${to}.restore`);
        for (const x of ['-wal', '-shm']) rmSync(`${to}${x}`, { force: true });
        renameSync(`${to}.restore`, to);
      }
      return src;
    },
  };
}

// A removed workspace's copies go with it (#479): dir/<sha>/<name>.db in every copy kept in dir, so its data
// (its GitHub secret, channel URLs, people's emails) outlives it nowhere, and a rollback can't bring it back.
// Returns how many copies held it.
export function forgetWorkspace(dir, name) {
  if (!dir || !existsSync(dir)) return 0;
  let n = 0;
  for (const sha of readdirSync(dir)) {
    const file = join(dir, sha, `${name}.db`);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    n++;
  }
  return n;
}

// Exit code when the supervisor's own code changed under systemd: non-zero, so Restart=on-failure
// brings it back on the new code (EX_TEMPFAIL).
export const RESTART_EXIT = 75;

// The supervisor's own code: what this process loaded, as opposed to the hub it runs as a child.
// Static imports only, from the CLI and this file: the CLI's dynamic imports (server, insight, …)
// load in the child. read(path) gives a file's text at some commit, or null if it has none.
export const SELF_ROOTS = ['bin/nuworq.js', 'src/follow.js'];
export function importGraph(read, roots = SELF_ROOTS) {
  const seen = new Set();
  const todo = [...roots];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    const text = read(file);
    if (text == null) continue;
    seen.add(file);
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"](\.\.?\/[^'"]+)['"]/gm)) {
      todo.push(posix.normalize(posix.join(posix.dirname(file), m[1])));
    }
  }
  return seen;
}

// The tests run without the hub's own NUWORQ_* / TRELLIS_* settings, so they can't reach its database or
// the hub itself (and without NODE_TEST_CONTEXT, so they report normally even when this runs under node --test).
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ_|TRELLIS_|NODE_TEST_CONTEXT$)/.test(k)));

// The first failing test in `npm test` output, "suite › test" either way: from node --test's spec reporter,
// or from TAP (what Node 22 prints when its output is piped), whose suites are the "# Subtest:" lines above it
// at a smaller indent. null if none is named.
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
  const k = lines.findIndex((l) => /^\s*not ok \d+ - /.test(l));
  if (k < 0) return null;
  const path = [lines[k].match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/)[1]];
  let indent = lines[k].search(/\S/);
  for (let i = k - 1; i >= 0 && indent > 0; i--) {
    const m = lines[i].match(/^(\s*)# Subtest: (.+)$/);
    if (m && m[1].length < indent) { path.unshift(m[2]); indent = m[1].length; }
  }
  return path.join(' › ');
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
// store: where the database is copied before each move (see backups()); null: no copies (--demo).
export function system({ repo, dir, next = `${dir}-next`, args = [], url, bin = 'bin/nuworq.js', cwd = process.cwd(), fetchMs = 30_000, store = null }) {
  let child = null;
  let testing = null;
  let fetched = 0;
  const pull = (branch) => {
    if (Date.now() - fetched < fetchMs) return;
    fetched = Date.now();
    try {
      const up = git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`);
      git(repo, 'fetch', '-q', up.split('/')[0]);
      // Only a fast-forward, and only when this checkout has main out: never a merge, never lose work.
      if (git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === branch && git(repo, 'rev-parse', branch) !== git(repo, 'rev-parse', up)) {
        git(repo, 'merge', '-q', '--ff-only', up);
      }
    } catch { /* no upstream, offline, or diverged: follow the local branch as it is */ }
  };
  let closed = false;
  const killGroup = (p, sig) => { try { process.kill(-p.pid, sig); } catch {} };
  return {
    // main as it is here, after taking whatever its upstream (GitHub) has that it doesn't: a server
    // checkout pulls; a checkout where agents land locally is usually ahead, and is left alone.
    head(branch) {
      pull(branch);
      try { return git(repo, 'rev-parse', '--verify', '-q', `${branch}^{commit}`); } catch { return null; }
    },
    // Move the hub's own worktree: only while the hub is stopped, right before it starts.
    checkout: (sha) => place(repo, dir, sha),
    // Copy the database aside before leaving sha, and put it back on a rollback: only while stopped.
    backup: (sha) => store?.backup(sha) ?? null,
    restore: (sha) => store?.restore(sha) ?? null,
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
    // Files of the supervisor's own code that differ between two commits (either side's import graph).
    ownCode(from, to) {
      const changed = git(repo, 'diff', '--name-only', from, to).split('\n').filter(Boolean);
      const at = (sha) => (file) => { try { return git(repo, 'show', `${sha}:${file}`); } catch { return null; } };
      const own = new Set([...importGraph(at(from)), ...importGraph(at(to))]);
      return changed.filter((f) => own.has(f));
    },
    // Under systemd (it sets INVOCATION_ID), which restarts the supervisor when it exits non-zero.
    supervised: () => !!process.env.INVOCATION_ID,
    exit: (code) => process.exit(code),
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

  // The hub moved, but this process still runs the code it started with. If the move changed that code,
  // under systemd: stop the hub, then exit so systemd starts the new supervisor (from the checkout the
  // move updated). In a terminal: say so, once per commit.
  async function ownCodeMoved(from, to) {
    let files;
    try {
      files = sys.ownCode?.(from, to) ?? [];
    } catch (e) {
      return log(`couldn't tell whether follow's own code changed at ${short(to)} (${e.message.split('\n')[0]})`);
    }
    if (!files.length) return;
    const what = `follow's own code changed at ${short(to)} (${files.join(', ')})`;
    if (sys.supervised?.()) {
      log(`${what}; stopping the hub so systemd restarts serve --follow on it`);
      await close();
      return sys.exit(RESTART_EXIT);
    }
    if (state.told === to) return;
    state.told = to;
    log(`${what}; restart serve --follow to run it`);
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
      const from = state.running;
      await sys.stop();
      // No copy, no move: the old hub starts again as it was, and this commit waits for the next one.
      try {
        sys.backup?.(from);
      } catch (e) {
        state.skip = sha;
        log(`couldn't back up the database before moving (${e.message.split('\n')[0]}); staying on ${short(from)} and not trying ${short(sha)} again; the next commit on ${branch} tries again`);
        await sys.start();
        return;
      }
      sys.checkout(sha);
      await sys.start();
      if (await sys.healthy()) {
        const was = state.running;
        Object.assign(state, { running: sha, good: sha, skip: null });
        log(`hub moved to ${short(sha)}`);
        return await ownCodeMoved(was, sha);
      }
      if (state.closed) return;
      log(`the hub didn't answer at ${short(sha)} within ${HEALTHY_MS / 1000}s; going back to ${short(state.good)} and not trying ${short(sha)} again`);
      state.skip = sha;
      await sys.stop();
      // The new code may have migrated the database as it started: back to the copy from before the move.
      try {
        if (sys.restore?.(from)) log(`put the database back as it was at ${short(from)}, before ${short(sha)} started`);
      } catch (e) {
        log(`couldn't put the database back as it was at ${short(from)} (${e.message.split('\n')[0]}); ${short(state.good)} starts on it as ${short(sha)} left it`);
      }
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
export async function follow({ repo, dir, next, args, url, branch = 'main', every = 10_000, log, store = null }) {
  const sys = system({ repo, dir, next, args, url, store });
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
