// nuworq serve --follow: keep the hub on the latest main that passes its tests.
// Agents land work by fast-forwarding main, and the hub is built that way too, so it moves onto new
// main commits by itself. The hub runs as a child process from its own git worktree (hub-src), detached
// at a commit, never from the human's checkout (which agents move). When main moves, the new commit is
// tested in a second worktree (hub-next), so the running hub's files never change under it. If the
// tests pass, the hub stops, hub-src moves to the commit, and the hub starts again; if the new hub
// doesn't answer, it goes back to the last good commit. Before the switch, a commit that passed boots on a
// side port against copies of the live databases (#544), so one that can't start on real data never goes
// live. If main fails its tests, the hub stays where it
// is and fixing main goes to the front of the queue: stop the line, not the hub. Before each move the
// database is copied aside, and a rollback puts the copy back: new code may migrate it on startup.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, copyFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const short = (sha) => String(sha).slice(0, 7);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STOP_GRACE_MS = 12_000; // past the hub's own 10 s drain (#545), so it's never cut short
const HEALTHY_MS = 15_000;
const MAX_HELD = 2000; // connections the front holds at once, as the hub's MAX_CONNECTIONS (#261); past it, new ones are dropped
const TEST_TIMEOUT_MS = 10 * 60_000;
const CI_WAIT_MS = 30 * 60_000; // a commit whose CI check never shows up is tested here after this (#543)
const SMOKE_MS = 60_000; // a smoke boot's migrations run on copies of all the live data
// A running hub is checked at every tick (#741): one that is up but doesn't answer CHECK_MS, MISSES checks in a row,
// is restarted. Past LOOP_RESTARTS restarts within LOOP_WINDOW_MS, the follower waits before the next, longer each time.
const CHECK_MS = 5_000;
const MISSES = 3;
const LOOP_RESTARTS = 3;
const LOOP_WINDOW_MS = 10 * 60_000;
export const BACKOFF_MS = [1, 2, 5, 10].map((m) => m * 60_000);
// A loopback port nothing listens on, for a smoke boot.
const freePort = () => new Promise((resolve, reject) => {
  const s = createNetServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
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
    // Copy the live database(s) under root, for a smoke boot (#544), while the hub runs: VACUUM INTO reads
    // a consistent snapshot. Returns { db } (root/nuworq.db) or { workspaces } (root/workspaces, every
    // workspace and the host directory), or null when there is nothing to copy yet.
    copyTo(root) {
      const files = live();
      if (!files.length) return null;
      if (!workspaces) {
        vacuum(files[0].file, join(root, 'nuworq.db'));
        return { db: join(root, 'nuworq.db') };
      }
      mkdirSync(join(root, 'workspaces'), { recursive: true });
      for (const f of files) vacuum(f.file, join(root, 'workspaces', f.name));
      return { workspaces: join(root, 'workspaces') };
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

// The supervisor's own code: what this process loaded, as opposed to the hub it runs as a child. The CLI
// hands serve --follow to this file run on its own (#546), and it imports only node: modules, so only a
// change to it restarts the supervisor. Whatever needs the hub's code (filing "fix main") runs as a child:
// src/followhub.js. read(path) gives a file's text at some commit, or null if it has none.
export const SELF_ROOTS = ['src/follow.js'];
const HELPER = 'src/followhub.js';
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

// The tests run without the hub's own NUWORQ_* settings, so they can't reach its database or
// the hub itself (and without NODE_TEST_CONTEXT, so they report normally even when this runs under node --test).
const testEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ_|NODE_TEST_CONTEXT$)/.test(k)));

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

// On a hub with workspaces (#561): which workspace has the project that lives in repo, read straight from the
// workspaces' databases (read-only). Matched by the repository's remote, or by its folder for a project that names
// one. workspace: only that one (serve --follow --workspace). { workspace, project }, or null when none has it.
// Several workspaces may link one repository (a paid one can link a public repo it doesn't own, #614): then it's the
// one the repository's GitHub App installation is bound to (installation: its id, from GitHub), and with none of
// theirs bound, it refuses, naming them, rather than pick one by its name.
export function findWorkspace({ workspaces, workspace = null, repo, remote = '', installation = null }) {
  if (!workspaces || !existsSync(workspaces)) return null;
  const names = workspace ? [String(workspace).toLowerCase()] : readdirSync(workspaces).filter((f) => f.endsWith('.db')).map((f) => f.slice(0, -3)).sort();
  const found = [];
  for (const name of names) {
    const file = join(workspaces, `${name}.db`);
    if (!existsSync(file)) continue;
    let d;
    try {
      d = new DatabaseSync(file, { readOnly: true });
      const p = d.prepare(`SELECT slug FROM projects WHERE archived_at = 0 AND ((? <> '' AND id IN (SELECT project_id FROM project_remotes WHERE remote = ?)) OR path = ?) ORDER BY id LIMIT 1`)
        .get(remote, remote, repo);
      if (p) found.push({ workspace: name, project: p.slug });
    } catch { /* not a workspace's database, or one from before projects had remotes */ } finally { d?.close(); }
  }
  if (found.length <= 1) return found[0] ?? null;
  const bound = installation != null ? boundTo(workspaces, installation) : null;
  const owner = found.find((f) => f.workspace === bound);
  if (owner) return owner;
  throw new Error(`${found.length} workspaces have a project for ${remote || repo} (${found.map((f) => f.workspace).join(', ')}) and none is bound to its GitHub App installation: name the one that owns it with serve --follow --workspace <name>`);
}

// The workspace a GitHub App installation is bound to, from the hub's directory (read-only), or null.
function boundTo(workspaces, id) {
  const file = join(workspaces, 'directory.sqlite');
  if (!existsSync(file)) return null;
  let d;
  try {
    d = new DatabaseSync(file, { readOnly: true });
    return d.prepare('SELECT workspace FROM installations WHERE id = ?').get(Number(id))?.workspace ?? null;
  } catch { return null; } finally { d?.close(); }
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
// ci: { app: the hub's github-app.json } when GitHub can say whether CI passed a commit (#543), else null: then the suite
// runs here. sys.ci(sha) asks src/followhub.js, which reads the app (or NUWORQ_GITHUB_APP_*) and calls checkOn.
// workspaces: the workspaces' folder when the hub serves them, and workspace the one to report a red main in.
// listen: { host, port }, the address the hub is served at, which the supervisor itself holds (#523): it accepts every
// connection and passes it to the newest hub that is ready, so a new hub starts beside the old one in alt (the other
// of the two worktrees the hub alternates between) and the port never closes. null: each hub listens itself, as before.
// It also falls back to that for a commit from before #523 (no src/handoff.js), on any platform.
export function system({ repo, dir, next = `${dir}-next`, alt = `${dir}-alt`, args = [], url, bin = 'bin/nuworq.js', cwd = process.cwd(), fetchMs = 30_000, store = null, ci = null, smokeMs = SMOKE_MS, workspaces = null, workspace = null, listen = null, log = () => {} }) {
  let child = null;
  let current = null; // the hub that serves, when it was started to hand over (see spawnHub)
  let front = null;
  const HANDOFF = 'src/handoff.js';
  const capable = (path) => !!listen && existsSync(join(path, HANDOFF));
  const capableAt = (sha) => { try { git(repo, 'cat-file', '-e', `${sha}:${HANDOFF}`); return !!listen; } catch { return false; } };
  // The port, held here: connections wait while no hub is ready (a restart, a rollback) and go to the newest one once
  // it is, so nothing is refused. They are paused until then, so no byte is read that the hub should read.
  const holdPort = async () => {
    if (front) return;
    const waiting = new Set();
    // Sent, the connection is the hub's: the descriptor was passed, so closing ours ends only our count of it (the
    // server waits for that count at close).
    const pass = (h, sock) => h.child.send({ type: 'conn' }, sock, () => sock.destroy());
    const s = createNetServer({ pauseOnConnect: true }, (sock) => {
      sock.on('error', () => {});
      const target = front?.target;
      if (target && target.child.connected) return pass(target, sock);
      waiting.add(sock);
      sock.once('close', () => waiting.delete(sock));
      setTimeout(() => sock.destroy(), HEALTHY_MS * 2).unref();
    });
    // Connections held while no hub is ready count against a cap of their own: the hub's (#261) isn't imported here.
    s.maxConnections = MAX_HELD;
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(listen.port, listen.host, resolve); })
      .catch((e) => { throw new Error(`can't hold ${listen.host}:${listen.port} (${e.message}): something else is using it`); });
    front = {
      server: s, target: null,
      set(h) { this.target = h; for (const sock of waiting) { waiting.delete(sock); if (!sock.destroyed) pass(h, sock); } },
      async close() { for (const sock of waiting) sock.destroy(); s.close(); await new Promise((r) => setImmediate(r)); },
    };
  };
  const releasePort = async () => { const f = front; front = null; await f?.close(); };
  // A hub started to hand over: its child process has an IPC channel (src/handoff.js is its side).
  const spawnHub = (path, sha) => {
    const h = { dir: path, sha, port: null, commit: null, ready: false, loops: false, exited: false };
    h.child = spawn(process.execPath, [join(path, bin), 'serve', ...args], {
      cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: true, env: { ...process.env, NUWORQ_HANDOFF: '1', NUWORQ_COMMIT: sha },
    });
    h.child.on('message', (m) => {
      if (m?.type === 'ready') Object.assign(h, { port: m.port, commit: m.commit, ready: true });
      else if (m?.type === 'loops') h.loops = !!m.on;
    });
    h.child.on('error', () => {});
    h.child.once('exit', (code, sig) => { h.exited = true; h.why = sig ? `it was stopped (${sig})` : `it exited with code ${code}`; });
    return h;
  };
  const waitFor = async (h, ok, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !closed && !h.exited && !ok()) await sleep(50);
    return ok();
  };
  // Whether h came up as the commit it was started on and answers on its private port.
  const readyHub = async (h, ms = HEALTHY_MS) => {
    if (!(await waitFor(h, () => h.ready, ms))) return { ok: false, failed: h.exited ? h.why : `it didn't come up within ${ms / 1000}s` };
    if (h.commit !== h.sha) return { ok: false, failed: `it runs ${short(h.commit)}, not ${short(h.sha)}` };
    return (await answers(`http://127.0.0.1:${h.port}`)) ? { ok: true } : { ok: false, failed: "it didn't answer /api/health" };
  };
  const retire = async (h) => {
    if (h.exited) return;
    if (h.child.connected) h.child.send({ type: 'drain' });
    else killGroup(h.child, 'SIGTERM');
    await new Promise((resolve) => {
      const kill = setTimeout(() => killGroup(h.child, 'SIGKILL'), STOP_GRACE_MS);
      const done = () => { clearTimeout(kill); resolve(); };
      if (h.exited) return done();
      h.child.once('exit', done);
    });
  };
  // h serves from now on, and runs the background loops, which the hub it replaces stopped first (old: null when
  // none runs): never two hubs running them.
  const promote = async (h, old = null) => {
    if (old && !old.exited && old.child.connected) {
      old.child.send({ type: 'quiet' });
      if (!(await waitFor(old, () => !old.loops, 5000))) { log(`the old hub didn't stop its background loops; stopping it`); await retire(old); }
    }
    h.child.send({ type: 'lead' });
    front.set(h);
    current = h;
    child = h.child;
  };
  let testing = null;
  let smoking = null;
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
  // One op of src/followhub.js, run as a short child with the code of the commit the hub runs, which passed (or,
  // for a commit from before #546, the one beside this file); this process loads none of the hub's code.
  const helper = async (op, input) => {
    const at = current?.dir ?? dir;
    const file = existsSync(join(at, HELPER)) ? join(at, HELPER) : join(import.meta.dirname, posix.basename(HELPER));
    const out = await new Promise((resolve, reject) => {
      let text = '';
      const p = spawn(process.execPath, [file, op, JSON.stringify(input)], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
      p.stdout.on('data', (d) => { text += d; });
      p.on('error', reject);
      p.on('close', () => resolve(text));
    });
    let r;
    try { r = JSON.parse(out); } catch { throw new Error(`${HELPER} answered ${JSON.stringify(out.trim().slice(0, 200))}`); }
    if (r?.error) throw new Error(r.error);
    return r;
  };
  return {
    // main as it is here, after taking whatever its upstream (GitHub) has that it doesn't: a server
    // checkout pulls; a checkout where agents land locally is usually ahead, and is left alone.
    head(branch) {
      pull(branch);
      try { return git(repo, 'rev-parse', '--verify', '-q', `${branch}^{commit}`); } catch { return null; }
    },
    // Whether a is b or an ancestor of it: whether main still has a.
    isAncestor(a, b) {
      try { git(repo, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; }
    },
    // CI's verdict on sha (checkOn in src/ghapp.js), or null when it ended without one.
    ci: ci && ((sha) => helper('ci', { repo, sha, app: ci.app })),
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
    // Boot sha, checked out in the candidates' worktree, on a free loopback port against copies of the live
    // database(s) (#544): its migrations meet real data before the switch, not after. `serve --smoke` starts
    // no pushes, sweeps or hub.json, and runs without the hub's NUWORQ_* settings, so the copy reaches nobody.
    // Stopped and its copies removed either way. { ok } or { ok: false, failed: why }.
    async smoke(sha) {
      if (!store) return { ok: true, skipped: 'no live data to boot on' };
      const root = mkdtempSync(join(tmpdir(), 'nuworq-smoke-'));
      let p = null, out = '';
      try {
        // Checked out here, not left to test(): a commit CI passed (#543) never ran test() on this machine.
        if (!existsSync(join(next, '.git')) || git(next, 'rev-parse', 'HEAD') !== sha) place(repo, next, sha);
        const copies = store.copyTo(root);
        if (!copies) return { ok: true, skipped: 'no live data to boot on' };
        const port = await freePort();
        const where = copies.db ? ['--db', copies.db] : ['--workspaces'];
        p = smoking = spawn(process.execPath, [join(next, bin), 'serve', '--smoke', '--host', '127.0.0.1', '--port', String(port), '--data-dir', root, ...where],
          { cwd: root, env: testEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { out += d; });
        const exited = new Promise((r) => p.once('exit', (code, sig) => r(sig ? `it was stopped (${sig})` : `it exited with code ${code}`)));
        const until = Date.now() + smokeMs;
        while (Date.now() < until && !closed) {
          if (p.exitCode != null || p.signalCode != null) {
            // Why, as it said: its last "Error: …" or "error: …" line (Node ends with its version), else its last line.
            const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^at /.test(l));
            const last = lines.findLast((l) => /^(\w*Error|error)\b/.test(l)) ?? lines.at(-1);
            return { ok: false, failed: `${await exited} at ${short(sha)}${last ? `: ${last}` : ''}` };
          }
          if (await answers(`http://127.0.0.1:${port}`)) return { ok: true };
          await sleep(250);
        }
        return { ok: false, failed: closed ? 'stopped' : `it didn't answer /api/health within ${smokeMs / 1000}s at ${short(sha)}` };
      } catch (e) {
        return { ok: false, failed: `couldn't boot it on copies of the live data (${e.message.split('\n')[0]})` };
      } finally {
        if (p) {
          if (p.exitCode == null && p.signalCode == null) {
            const gone = new Promise((r) => p.once('exit', r));
            killGroup(p, 'SIGTERM');
            const kill = setTimeout(() => killGroup(p, 'SIGKILL'), STOP_GRACE_MS);
            await gone;
            clearTimeout(kill);
          }
          if (smoking === p) smoking = null;
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    // Whether sha can go live beside the hub that serves, with no gap: both it and the running hub hand over (#523).
    canSwap: (sha) => !!current && !current.exited && capableAt(sha),
    // Start sha beside the running hub, in the worktree it doesn't use; once it is ready as sha, it gets the port's
    // connections, the old hub stops its background loops, the new one starts them, and the old one drains. The old
    // hub serves until then, and if the new one doesn't come up it serves on: { ok } or { ok: false, failed }.
    async swap(sha) {
      const old = current;
      const path = old.dir === dir ? alt : dir;
      try { place(repo, path, sha); } catch (e) { return { ok: false, failed: `couldn't check it out (${e.message.split('\n')[0]})` }; }
      const h = spawnHub(path, sha);
      const r = await readyHub(h);
      if (!r.ok || closed) {
        await retire(h);
        return r.ok ? { ok: false, failed: 'stopped' } : r;
      }
      await promote(h, old);
      await retire(old);
      return { ok: true };
    },
    async start() {
      if (capable(dir)) {
        await holdPort();
        front.target = null;
        if (closed) return;
        let sha;
        try { sha = git(dir, 'rev-parse', 'HEAD'); } catch { sha = null; }
        current = spawnHub(dir, sha);
        child = current.child;
        return;
      }
      await releasePort(); // a hub from before #523 listens itself
      current = null;
      if (await answers(url)) throw new Error(`something else already answers at ${url}; stop it or pick another --port`);
      if (closed) return;
      // Its own process group: Ctrl-C reaches the supervisor, which stops the hub in order.
      child = spawn(process.execPath, [join(dir, bin), 'serve', ...args], { cwd, stdio: 'inherit', detached: true });
    },
    alive: () => !!child && child.exitCode == null && child.signalCode == null,
    async stop() {
      const c = child;
      child = null;
      if (current?.child === c) {
        if (front?.target === current) front.target = null; // connections wait for the next hub
        current = null;
      }
      if (!c || c.exitCode != null || c.signalCode != null) return;
      await new Promise((resolve) => {
        const kill = setTimeout(() => c.kill('SIGKILL'), STOP_GRACE_MS);
        c.once('exit', () => { clearTimeout(kill); resolve(); });
        c.kill('SIGTERM');
      });
    },
    async healthy(ms = HEALTHY_MS) {
      if (current && !front?.target) {
        // Started to hand over: ready as its commit, then it serves.
        const h = current;
        const r = await readyHub(h, ms);
        if (!r.ok || closed || current !== h) return false;
        await promote(h);
        return true;
      }
      const until = Date.now() + ms;
      while (Date.now() < until && !closed) {
        if (!child || child.exitCode != null || child.signalCode != null) return false;
        if (await answers(url)) return true;
        await sleep(250);
      }
      return false;
    },
    // Main is red: one "fix main" item at priority now (src/followhub.js). Returns "#12 in nuworq", or null.
    // running: the commit the hub runs (the red one itself when the supervisor just started on it).
    // With workspaces (#561), it is filed in the workspace whose project lives in this repo (findWorkspace).
    async redMain(sha, failed, running) {
      return (await helper('red', { url, repo, sha, failed, running, workspaces, workspace, app: ci?.app ?? null })).where;
    },
    // The last commit that passed its tests, kept beside the hub's worktree, so a restarted supervisor
    // doesn't test the commit it already took again.
    passed() { try { return readFileSync(`${dir}.passed`, 'utf8').trim() || null; } catch { return null; } },
    pass(sha) { try { writeFileSync(`${dir}.passed`, `${sha}\n`); } catch { /* it only saves a test run */ } },
    // Why the hub keeps failing, beside its worktree, for `nuworq status` (#741): the hub's own push notifications
    // can't say it, since they run inside the hub. null removes it.
    trouble(why) {
      try {
        if (why) writeFileSync(`${dir}.trouble`, `${why}\n`);
        else rmSync(`${dir}.trouble`, { force: true });
      } catch { /* status just doesn't show it */ }
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
      if (smoking) killGroup(smoking, 'SIGTERM');
      await this.stop();
      await releasePort();
    },
  };
}

// The loop, apart from the real world (sys: see system()). boot() starts the hub on main and tests
// it; tick() checks once whether main moved and acts on it; close() stops the hub.
// state.skip: a commit not to try again (it failed its tests or didn't start).
// state.red: main is in a red streak and someone has been asked to fix it.
export function follower(sys, { branch = 'main', log = () => {} } = {}) {
  // state.retry: the hub was started but didn't answer, so the next tick starts it again (#741).
  // state.misses: health checks in a row the running hub didn't answer. state.restarts: when it was started again.
  // state.backoff: waiting until then before the next restart (a crash loop); state.backoffs: how many in a row.
  const state = { running: null, good: null, skip: null, red: false, busy: false, closed: false, retry: false, misses: 0, restarts: [], backoff: null, backoffs: 0 };

  // Start the hub again on the commit it runs (why: what went wrong). Past LOOP_RESTARTS within LOOP_WINDOW_MS,
  // it's a crash loop: wait BACKOFF_MS first, longer each time, and write why for `nuworq status` (sys.trouble).
  async function restart(why) {
    const t = now();
    if (state.backoff && t < state.backoff.until) return;
    state.restarts = state.restarts.filter((r) => t - r < LOOP_WINDOW_MS);
    if (!state.backoff && state.restarts.length >= LOOP_RESTARTS) {
      const ms = BACKOFF_MS[Math.min(state.backoffs, BACKOFF_MS.length - 1)];
      state.backoffs++;
      state.backoff = { until: t + ms };
      const reason = `${why} at ${short(state.running)}, after ${state.restarts.length} restarts in ${LOOP_WINDOW_MS / 60_000} minutes; waiting ${ms / 60_000} minute${ms === 60_000 ? '' : 's'} before the next (${new Date(t + ms).toTimeString().slice(0, 5)})`;
      log(reason);
      sys.trouble?.(reason);
      state.troubled = true;
      return;
    }
    if (!state.backoff) state.backoffs = 0;
    state.backoff = null;
    state.restarts.push(t);
    state.misses = 0;
    log(`${why}; starting it again at ${short(state.running)}`);
    await sys.stop();
    sys.checkout(state.running);
    await sys.start();
    state.retry = !(await sys.healthy());
    if (state.retry) log(`the hub didn't answer at ${short(state.running)}; trying again at the next check`);
  }

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

  // Whether sha may go live (#543): CI's required check, when GitHub can say (sys.ci), so this machine doesn't run
  // the suite again. { ok, by: 'CI' } once it passed, { ok: false, failed } once it failed, { pending } while it
  // runs. Without GitHub (no app, not a GitHub remote, said once), or a check that never shows up within
  // CI_WAIT_MS or ends without a verdict, the suite runs here as before. GitHub failing to answer (no install on
  // the repo, no checks:read, a revoked key) counts as a check that never showed up: said once, then the suite.
  // While GitHub can't say, the CI_WAIT_MS clock runs from the first commit waited on, not the newest (#690): a
  // main that moves every few minutes would otherwise never go live, and the newest commit is the one tested
  // anyway. blind: GitHub never answered with a run for the commit waited on (an error, or no check yet). Once it
  // did, CI is working, so the next commit's wait starts fresh: a head pushed a moment ago has no check yet.
  async function verdict(sha) {
    if (sys.ci) {
      let c;
      try { c = await sys.ci(sha); } catch (e) { c = { state: 'pending', missing: true, error: e.message.split('\n')[0] }; }
      if (state.waiting?.sha !== sha) state.waiting = { sha, since: state.waiting?.blind ? state.waiting.since : now(), blind: true };
      if (!c?.missing) state.waiting.blind = false;
      if (c?.error && !state.waiting.unasked) {
        state.waiting.unasked = true;
        const left = Math.max(1, Math.ceil((CI_WAIT_MS - (now() - state.waiting.since)) / 60_000));
        log(`can't ask GitHub about ${short(sha)} (${c.error}); still waiting, and its tests run here after ${left} minute${left === 1 ? '' : 's'}`);
      }
      if (c?.state === 'passed') return { ok: true, by: 'CI' };
      if (c?.state === 'failed') return { ok: false, failed: c.failed };
      if (c?.state === 'pending' && !(c.missing && now() - state.waiting.since > CI_WAIT_MS)) return { pending: true };
      log(c?.error ? `still can't ask GitHub about ${short(sha)} (${c.error}); running its tests here`
        : c ? `CI's test check never showed up for ${short(sha)}; running its tests here` : `CI's test check ended without a verdict on ${short(sha)}; running its tests here`);
    } else if (!state.local) {
      state.local = true;
      log("no GitHub App for this repository's remote, so each commit's tests run here");
    }
    return sys.test(sha);
  }
  const now = () => sys.now?.() ?? Date.now();

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

  // Start on the last commit that passed (#620), when main still has it and has moved past it since: a restart (its
  // own code changed, a reboot) never runs what CI hasn't passed, and tick() takes main through its verdict from
  // there. Else on main as it is (there is nothing better to run), tested like any other commit, so a supervisor
  // restarted in a red streak still stops the line.
  async function boot() {
    const head = sys.head(branch);
    if (!head) throw new Error(`there is no ${branch} branch to follow`);
    const last = sys.passed?.();
    const sha = last && last !== head && sys.isAncestor?.(last, head) ? last : head;
    sys.checkout(sha);
    await sys.start();
    if (!(await sys.healthy())) {
      await sys.stop();
      throw new Error(`the hub didn't answer at ${short(sha)} within ${HEALTHY_MS / 1000}s`);
    }
    Object.assign(state, { running: sha, good: sha });
    sys.trouble?.(null); // a crash loop the last supervisor reported is over: the hub answers
    if (sha !== head) return log(`hub running at ${short(sha)}, the last commit that passed; following ${branch}, which takes ${short(head)} once it passes`);
    // A supervisor restarted on the commit it had taken (its own code changed) doesn't test it again (#546).
    if (sys.passed?.() === sha) return log(`hub running at ${short(sha)}; following ${branch}; ${short(sha)} already passed its tests`);
    log(`hub running at ${short(sha)}; following ${branch}, testing ${short(sha)}`);
    state.busy = true;
    try {
      const t = await verdict(sha);
      if (state.closed) return;
      state.waiting = null;
      if (t.pending) log(`CI's test check on ${short(sha)} hasn't finished; the hub runs it meanwhile, as it would without one`);
      else if (t.ok) {
        sys.pass?.(sha);
        log(`${short(sha)} ${t.by === 'CI' ? "passed CI's test check" : 'passes its tests'}`);
      } else await red(sha, t.failed);
    } finally {
      state.busy = false;
    }
  }

  async function tick() {
    if (state.busy || state.closed || !state.running) return;
    state.busy = true;
    try {
      if (sys.alive && !sys.alive()) return await restart('the hub stopped by itself');
      if (state.retry) return await restart("the hub didn't answer after it started");
      // Up but not answering (a wedged event loop): restarted once it misses MISSES checks in a row (#741).
      if (!(await sys.healthy(CHECK_MS))) {
        if (state.closed) return;
        if (++state.misses < MISSES) return log(`the hub at ${short(state.running)} didn't answer its health check (${state.misses} of ${MISSES} before a restart)`);
        return await restart(`the hub stopped answering (${MISSES} health checks in a row)`);
      }
      state.misses = 0;
      if (state.troubled) {
        state.troubled = false;
        state.backoff = null;
        sys.trouble?.(null);
        log(`the hub answers again at ${short(state.running)}`);
      }
      const sha = sys.head(branch);
      if (!sha || sha === state.running || sha === state.skip) return;
      // Said once per commit, not on every check while CI runs.
      if (state.waiting?.sha !== sha) log(`${branch} moved to ${short(sha)}; ${sys.ci ? "waiting for CI's test check" : 'running its tests'}`);
      const t = await verdict(sha);
      if (state.closed || t.pending) return;
      state.waiting = null;
      if (!t.ok) return await red(sha, t.failed);
      const passed = t.by === 'CI' ? "passed CI's test check" : 'passes its tests';
      // Booted on copies of the live data first, while the hub runs on (#544): a migration that fails on real
      // data stops here, not after the switch.
      if (sys.smoke) {
        const s = await sys.smoke(sha);
        if (state.closed) return;
        if (!s.ok) {
          state.skip = sha;
          return log(`${short(sha)} ${passed} but didn't boot on copies of the live data (${s.failed}); staying on ${short(state.running)} and not trying ${short(sha)} again`);
        }
        if (!s.skipped) log(`${short(sha)} boots on copies of the live data`);
      }
      sys.pass?.(sha);
      const from = state.running;
      // With no gap (#523): started beside the running hub, which serves until the new one is ready as this commit.
      // The copy is taken while it runs (VACUUM INTO reads a consistent snapshot), as for a smoke boot.
      const beside = !!sys.canSwap?.(sha);
      log(`${short(sha)} ${passed}${state.red ? ` (${branch} is green again)` : ''}; ${beside ? `starting the hub on it beside ${short(from)}, which serves until it is ready` : 'restarting the hub on it'}`);
      state.red = false;
      if (beside) {
        try {
          sys.backup?.(from);
        } catch (e) {
          state.skip = sha;
          return log(`couldn't back up the database before moving (${e.message.split('\n')[0]}); staying on ${short(from)} and not trying ${short(sha)} again; the next commit on ${branch} tries again`);
        }
        const r = await sys.swap(sha);
        if (state.closed) return;
        if (!r.ok) {
          state.skip = sha;
          return log(`${short(sha)} didn't come up beside ${short(from)} (${r.failed}); ${short(from)} keeps serving, nothing was dropped, and ${short(sha)} isn't tried again`);
        }
        Object.assign(state, { running: sha, good: sha, skip: null });
        log(`hub moved to ${short(sha)} with no gap: ${short(from)} drained`);
        return await ownCodeMoved(from, sha);
      }
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
      state.retry = !(await sys.healthy());
      log(state.retry ? `the hub didn't answer at ${short(state.good)} either; trying again at the next check` : `hub back at ${short(state.good)}`);
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
export async function follow({ repo, dir, next, alt, args, url, listen = null, branch = 'main', every = 10_000, log, store = null, ci = null, workspaces = null, workspace = null }) {
  const sys = system({ repo, dir, next, alt, args, url, listen, log, store, ci, workspaces, workspace });
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

// `node src/follow.js <json>`: the supervisor on its own (#546). The CLI's serve --follow works out the
// settings and hands over: { repo, dir, next, args, url, store: backups() options or null, ci (see system()), color, hint }.
// It exits as the supervisor does (RESTART_EXIT when its own code changed under systemd).
if (import.meta.filename === process.argv[1]) {
  const { store, color, hint, ...opts } = JSON.parse(process.argv[2]);
  const stamp = () => `[follow ${new Date().toTimeString().slice(0, 8)}]`;
  try {
    await follow({ ...opts, store: store && backups(store), log: (line) => console.log(`${color ? `\x1b[2m${stamp()}\x1b[0m` : stamp()} ${line}`) });
  } catch (e) {
    console.error(`error: --follow couldn't start the hub: ${e.message}${hint ? `\nhint: ${hint}` : ''}`);
    process.exit(1);
  }
}
