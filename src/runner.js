// nuworq run: keep up to N headless workers on waiting work in the projects the human opted in.
// plan() decides, run() does the I/O; everything outside is injected so tests start no real agents.
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';

// The runner's own git (#736): a worker that exited is cleaned up with it, so a hung fetch (a stalled remote) can't
// keep it in running, and so its lease renewed, for ever. Each call is killed after GIT_MS. file: for tests.
export const GIT_MS = 2 * 60_000;
export const runnerGit = ({ timeout = GIT_MS, file = 'git' } = {}) => (args) => new Promise((ok, fail) => {
  execFile(file, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout, killSignal: 'SIGKILL' },
    (e, stdout, stderr) => (e ? fail(Object.assign(e, { stderr: stderr || e.stderr })) : ok(stdout)));
});

// What to launch now. routes: the hub's /api/route?runner=1 (value order, one entry per project, with
// how much is claimable and who holds work there). running: live workers this runner started.
// A worker that hasn't claimed anything yet still counts against its project's claimable work,
// so one waiting item never draws a herd. r.limit: the most agents working in that project at once, set on
// the hub (#174): everyone holding work there, and this runner's workers that haven't claimed yet, count.
// r.jobs (#793): its claimable items, most useful first, each with its own model; each worker started takes one no
// worker of this runner was started for yet (w.item), so workers started together don't all go to the top item.
export function plan(routes, running, { workers = 1, maxRuns = Infinity, launched = 0 } = {}) {
  let slots = Math.min(workers - running.length, maxRuns - launched);
  const out = [];
  for (const r of routes) {
    if (slots <= 0) break;
    const held = new Set(r.holders ?? []);
    const idle = running.filter((w) => w.project === r.project && !held.has(w.name));
    const room = r.limit == null ? Infinity : r.limit - held.size - idle.length;
    let n = Math.min(slots, (r.claimable ?? 1) - idle.length, room);
    if (r.jobs?.length) {
      const { jobs, models, why, ...entry } = r; // the top item's own: each job says its own
      for (const j of jobs) {
        if (n <= 0) break;
        // A raced trial (#348) has a slot per model: two workers on it, one per slot, each on the next model.
        const on = idle.filter((w) => w.item === j.item).length;
        const k = Math.min(n, (j.slots ?? 1) - on);
        for (let i = 0; i < k; i++) out.push({ ...entry, slots: undefined, ...j, model: j.models?.[on + i] ?? j.model });
        n -= Math.max(k, 0);
        slots -= Math.max(k, 0);
      }
      continue;
    }
    // A raced trial (#348) names a model per open slot: each worker started takes the next one.
    for (let i = 0; i < n; i++) out.push(r.models?.[idle.length + i] ? { ...r, model: r.models[idle.length + i] } : r);
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

// Whether the runner's own git may read a worker's worktree (#640): its .git file names a folder in
// <home>/.git/worktrees, whose commondir is "../.." and whose gitdir points back at this worktree's .git, as git
// worktree add made them. A worker may write the checkout's .git (to commit), so it could point another worker's
// folder elsewhere, and the runner's unsandboxed git would then read config from there and run as the person.
// home: the checkout; without it (a worktree of another project's), only the shape is checked.
export function worktreeTrusted(worktree, home = null) {
  try {
    const dotgit = join(worktree, '.git');
    const named = readFileSync(dotgit, 'utf8').match(/^gitdir: (.+)$/m)?.[1]?.trim();
    if (!named) return false;
    const admin = realpathSync(resolve(worktree, named));
    if (basename(dirname(admin)) !== 'worktrees') return false;
    if (readFileSync(join(admin, 'commondir'), 'utf8').trim() !== '../..') return false;
    if (home && realpathSync(resolve(admin, '../..')) !== realpathSync(join(home, '.git'))) return false;
    return realpathSync(resolve(admin, readFileSync(join(admin, 'gitdir'), 'utf8').trim())) === realpathSync(dotgit);
  } catch {
    return false;
  }
}
const CHANGED = 'its worktree pointers were changed';

// After a worker exits, its worktree goes (#172), unless something in it would be lost: uncommitted changes, or
// commits no branch holds. git(args) runs git and resolves to its output. Returns { kept, why? }.
export async function cleanWorktree(worktree, git) {
  if (!worktreeTrusted(worktree)) return { kept: true, why: CHANGED };
  if ((await git(['-C', worktree, 'status', '--porcelain'])).trim()) return { kept: true, why: 'it has uncommitted changes' };
  if (!(await git(['-C', worktree, 'for-each-ref', '--contains', 'HEAD', '--count=1', 'refs/heads', 'refs/remotes'])).trim()) {
    return { kept: true, why: 'it has commits that are on no branch' };
  }
  const common = (await git(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  await git(['--git-dir', common, 'worktree', 'remove', worktree]);
  return { kept: false };
}

// The branches and tags of the checkout a worker shares, as ref → sha (#618): its sandbox writes refs so it can
// commit in its worktree, so a prompt-injected worker could move any of them.
export async function refsOf(home, git) {
  const out = await git(['-C', home, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags']);
  return new Map(out.split('\n').filter(Boolean).map((l) => l.split(' ')));
}

// The branches checked out in the checkout's worktrees, the person's own included: ref → that worktree's path.
export async function checkedOut(home, git) {
  const held = new Map();
  let path = null;
  for (const l of (await git(['-C', home, 'worktree', 'list', '--porcelain'])).split('\n')) {
    if (l.startsWith('worktree ')) path = l.slice(9);
    else if (l.startsWith('branch ')) held.set(l.slice(7), path);
  }
  return held;
}

// After a worker exits (#618): every branch or tag of the shared checkout that moved or went while it ran goes back
// where it was, so the person (or an operator, or a sibling) never pushes what a worker put there. Left alone: the
// worker's own branch (own), a branch checked out in another live worker's worktree (live: its sibling moves it), and
// a branch now on a commit origin has (a pull; the caller fetches first, so origin's refs are origin's). A branch
// checked out in any other worktree, the person's checkout included, is never moved: under their files it would
// look like their commit vanished. It is reported instead (kept), to check by hand. Refs it made are named, not
// deleted. Returns { restored: [{ ref, from, to }], kept: [{ ref, from, to, path }], created: [ref] }.
export async function restoreRefs(home, before, git, { own = [], live = [] } = {}) {
  const after = await refsOf(home, git);
  const skip = new Set([...own, ...live].filter(Boolean).map((b) => (b.startsWith('refs/') ? b : `refs/heads/${b}`)));
  const held = await checkedOut(home, git);
  const restored = [], kept = [];
  for (const [ref, from] of before) {
    const to = after.get(ref) ?? null;
    if (to === from || skip.has(ref)) continue;
    if (to && ref.startsWith('refs/heads/') && (await git(['-C', home, 'branch', '-r', '--contains', to]).catch(() => '')).trim()) continue;
    if (to && held.has(ref)) { kept.push({ ref, from, to, path: held.get(ref) }); continue; }
    // Only from where it is now: one the person moves meanwhile is theirs.
    await git(['-C', home, 'update-ref', ref, from, ...(to ? [to] : [])]);
    restored.push({ ref, from, to });
  }
  const created = [...after.keys()].filter((ref) => !before.has(ref) && !skip.has(ref));
  return { restored, kept, created };
}
// One line a person can act on: what moved, where it went back to, and how to undo that.
export const restoredLine = (home, { ref, from, to }) => `${ref.replace(/^refs\/heads\//, '')} was ${to ? `moved to ${to.slice(0, 7)}` : 'deleted'} while the worker ran; it is back at ${from.slice(0, 7)}${to ? ` (if that move was yours: git -C ${home} update-ref ${ref} ${to})` : ''}`;
// A branch left where it is because a worktree has it checked out: what moved, to check.
export const keptLine = ({ ref, from, to, path }) => `${ref.replace(/^refs\/heads\//, '')} (checked out in ${path}) moved from ${from.slice(0, 7)} to ${to.slice(0, 7)} while the worker ran: check it (left as it is)`;

// The workers running now, and whose branches each one's exit leaves alone (#788): a sibling still running holds the
// branch it has checked out, and one that ran beside it and exited first held the branch it exited on. Workers start
// detached and make their branch later, so a branch is read as each one exits, never as it starts. git(args) runs git.
export function besideWorkers(git) {
  const ran = new Map(); // live worktree -> { home, gone: branches of same-checkout workers that exited while it ran }
  const headOf = async (worktree, home) => (worktreeTrusted(worktree, home)
    ? (await git(['-C', worktree, 'symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')).trim() : '');
  return {
    start(worktree, home) { ran.set(worktree, { home, gone: new Set() }); },
    // Its branch as it exits (from its own trusted worktree, else ''), and the branches its exit must spare.
    async exit(worktree) {
      const me = ran.get(worktree);
      if (!me) return { branch: '', spare: [] };
      const branch = await headOf(worktree, me.home);
      ran.delete(worktree);
      for (const o of ran.values()) if (branch && o.home === me.home) o.gone.add(branch);
      const live = await Promise.all([...ran.keys()].map((w) => headOf(w, me.home)));
      return { branch, spare: [...new Set([...live, ...me.gone])].filter(Boolean) };
    },
  };
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
      // No git of the runner's in a worktree whose pointers a worker changed (#640).
      if (!worktreeTrusted(t.path, home)) { out.kept.push({ what: name(t.path), why: CHANGED }); continue; }
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
    if (yes(await ask(`Staff ${here.name ?? here.slug}, the project of this clone, with nuworq run? Its workers can cost money. [y/N] `))) pick = here;
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

// The runner's caps (#761): each is off unless its flag sets it (#795, Paul in Q230: a subscription and an API key
// need different caps, so nuworq picks none). 0 turns a cap off.
export function runCaps(flags = {}) {
  const cap = (k) => {
    const v = flags[k];
    if (v === undefined || v === true) return Infinity;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || String(v).trim() === '') throw Object.assign(new Error(`--${k} expects a number ≥ 0, got "${v}"`), { hint: `e.g. --${k} ${k === 'max-minutes' ? 90 : 25}, or --${k} 0 for no cap` });
    return n === 0 ? Infinity : n;
  };
  if (flags.pays !== undefined && !PAYS[flags.pays]) throw Object.assign(new Error(`--pays expects api or subscription, got "${flags.pays}"`), { hint: 'nuworq connect writes it with the caps it chose; leave it out otherwise' });
  return { maxMinutes: cap('max-minutes'), maxUsd: cap('max-usd'), workerUsd: cap('worker-usd'), from: capsFrom(flags) };
}

// Where the caps came from (#776), for the runner's start line: connect's question (it writes --pays with them),
// flags typed, or none set (#795: there are no defaults).
const PAYS = { api: 'an API key', subscription: 'a subscription' };
export function capsFrom(flags = {}) {
  if (PAYS[flags.pays]) return `set by connect for ${PAYS[flags.pays]}`;
  return ['max-minutes', 'max-usd', 'worker-usd'].some((k) => flags[k] !== undefined) ? 'from its flags' : 'none set';
}

// The caps in force, in words: "each stops at 90m or $25; $20 in all (caps: from its flags)".
export function capsLine({ maxMinutes, maxUsd, workerUsd, from }) {
  if (maxMinutes === Infinity && maxUsd === Infinity && workerUsd === Infinity) return `no caps (${from}: nuworq connect sets them)`;
  const limits = [maxMinutes < Infinity && `${maxMinutes}m`, workerUsd < Infinity && `$${workerUsd}`].filter(Boolean);
  const each = limits.length ? `each stops at ${limits.join(' or ')}` : 'no worker cap';
  return `${each}${workerUsd === Infinity ? ', no dollar cap' : ''}${maxUsd < Infinity ? `; $${maxUsd} in all` : ''} (caps: ${from})`;
}

// Why a worker stopped (#754), sent with the signoff the runner makes for it, so the hand-back of what it held names
// the cause: { cause: 'timeout', minutes } (ran past --max-minutes), { cause: 'budget', usd } (spent past --worker-usd
// or a land job's cap), { cause: 'interrupted' } (Ctrl-C) or { cause: 'exited', code } (it ended on its own: a crash,
// a context or API error, or 0). headline: the signoff's one line on it.
export function stopHeadline(s) {
  if (s?.cause === 'timeout') return `Worker stopped: ran past ${s.minutes}m`;
  if (s?.cause === 'budget') return `Worker stopped: spent past its $${s.usd} cap`;
  if (s?.cause === 'interrupted') return 'Worker stopped: the runner was interrupted';
  return s?.code != null ? `Worker exited ${s.code}` : 'Worker exited';
}

// Workers in a row that fail, however long each ran (#764): an outage whose workers retry for a minute, or for
// twenty, is as stuck as one whose workers fail at once. Those under 15 s are said to fail within seconds.
const FAST_FAIL_MS = 15_000;
const FAILS = 3;
const ran = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);
// Clean exits this soon without claiming anything: the hub routed a worker to work it couldn't take.
const EMPTY_MS = 60_000;
const EMPTIES = 3;
const PAUSE_MS = 5 * 60_000;
const MAX_PAUSE_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
// The most a runner asks the hub to hold its wait for work (#542): under the 100 s Cloudflare gives an answer.
const WAIT_MAX_S = 90;

// routes({ jobs }): the hub's runner routes, each project's listing up to jobs of its items (#793). launch(route): starts a worker, returns { name, project, where, kill(signal),
// exited: Promise<code>, spent?(): dollars so far (#761), its CLI's own figure once it has said one; null: unpriced,
// cap?: the most it may spend (a land job's, #752), checked each round: past it, the worker is stopped }.
// launch throws an error with skip: true when this machine can't work on the route's project (no
// checkout of it here): that project is left to others for this round, said once, and isn't a failure.
// With pause: true too (its checkout couldn't be updated, e.g. git can't reach origin), the project is left
// alone for 5 minutes, then 10, up to 30, and said each time; the others go on.
// claimed(worker): whether the hub saw it take a job since it started (absent: assume it did).
// taken(worker): for one started for one job (worker.job, "#12") that claimed nothing, who took that item first, or
// null (#793). It lost a race: said, and not counted as finding nothing.
// onInterrupt(fn): register fn for Ctrl-C. The first stops launching and asks workers to stop; the next kills them.
// submitted(worker): whether it handed something in since it started (absent: assume it didn't); one that did,
// then exited non-zero, still worked, so it ends a failing streak rather than adding to it.
// maxUsd: stop launching once the workers' spend reaches it, counting what running ones have spent so far (#761);
// running workers finish. workerUsd: a worker whose spend so far passes it is stopped (SIGTERM, then SIGKILL), as
// one past maxMinutes is. w.spent() is read on every round: dollars so far, or null when its model is unpriced.
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
// worker.stopped says why it stopped (stopHeadline, #754).
// waitRoutes({ skip, seconds, signal }) (#542): routes(), but the hub holds the answer until work appears outside
// skip (projects this machine can't work on now), at most seconds. With nothing to start and room for a worker,
// the runner waits on it instead of sleeping, so a worker starts about a second after work appears. A hub that
// answers early with nothing new is an older one that ignores the wait: from then on the runner sleeps instead.
export async function run({
  routes, launch, claimed = async () => true, taken = async () => null, submitted = async () => false, took = async () => null, log = console.log, report = async () => {}, sweep, sweptAt = 0,
  updated = () => null, supervised = false, signoff = async () => {}, machine = () => ({}), maxWorkers, unstaffed = async () => null, waitRoutes,
  workers = 1, maxRuns = Infinity, maxMinutes = Infinity, maxUsd = Infinity, workerUsd = Infinity, pollSeconds = 30, untilIdle = false,
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
  let failing = []; // how long each worker of the failing streak ran, in ms
  let empties = [];
  let pausedUntil = 0;
  let pauseMs = PAUSE_MS;
  let stopping = false;
  let why = '';
  let wake = () => {};
  let hubDown = false;
  let deleted = false; // its workspace was deleted (#799)
  let idle = false;
  let toldUnstaffed = false;
  let moved = null; // "<from> → <to>": the installed package changed under this runner
  let longPoll = !!waitRoutes; // false once the hub turns out not to hold the answer
  let quiet = false; // nothing this round it could start, with room for a worker: wait on the hub for work
  let next = null; // routes the wait brought back, used as the next round's
  const cant = new Map(); // project → why this machine can't work on it, as last said
  const resting = new Map(); // project → { until, ms }: its checkout couldn't be updated, so it waits until then
  const stop = (reason) => { if (!stopping) { stopping = true; why = reason; } wake(); };
  // A worker's spend so far (#761), and everything spent: the exited workers' and the running ones' so far.
  const spendOf = (w) => Number(w.spent?.()) || 0;
  const total = () => spent + running.filter((w) => !w.gone).reduce((a, w) => a + spendOf(w), 0);
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
      running: running.length, workers: most, ...(auto ? { auto: true, holding } : {}), spent: total(), poll_seconds: pollSeconds,
      // Its live workers by name (#540): the hub renews the leases they hold, so none has to spend a turn on it.
      live: running.map((w) => w.name),
      // What each has spent so far (#761): the project's daily budget counts it before the worker exits.
      spending: running.filter((w) => !w.gone && spendOf(w) > 0).map((w) => ({ name: w.name, project: w.project, usd: spendOf(w) })),
      // When each started (#767): Needs you says when one runs past an hour.
      runs: running.filter((w) => !w.gone && w.started != null).map((w) => ({ name: w.name, project: w.project, since: w.started })),
      // Its per-worker cap (#782): the hub counts no worker's spend past it.
      ...(Number.isFinite(workerUsd) ? { worker_usd: workerUsd } : {}),
      skipping: [
        ...[...resting].filter(([, r]) => r.until > t).map(([project, r]) => ({ project, reason: cant.get(project) ?? "its checkout couldn't be updated", until: r.until })),
        ...[...cant].filter(([project]) => !(resting.get(project)?.until > t)).map(([project, reason]) => ({ project, reason })),
      ],
      paused: pausedUntil > t ? { until: pausedUntil, reason: pausedWhy } : null,
    };
  };
  // The hub's reply names any worker a person stopped from Needs you (#767): stopped as at its caps.
  const stopAsked = (res) => {
    for (const w of running.filter((x) => (res?.stop ?? []).includes(x.name) && !x.killedAt && !x.gone)) {
      log(`${w.name}: a person asked the hub to stop it; stopping it (its lease expires and the item returns to the queue)`);
      w.kill('SIGTERM');
      w.killedAt = now();
    }
  };
  const tell = (s) => Promise.resolve().then(() => report(s)).then(stopAsked).catch(() => {});
  const failedAfter = (ms) => {
    failing.push(ms);
    if (failing.length < FAILS) return;
    const how = failing.every((x) => x < FAST_FAIL_MS) ? 'within seconds' : `after ${failing.map(ran).join(', ')}`;
    failing = [];
    pause(`${FAILS} workers in a row failed ${how}`, 'Check the agent runs on its own (see its log).');
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
      const usd = w.gone ? 0 : spendOf(w);
      const over = w.killedAt ? null
        : t - w.started > maxMinutes * 60_000 ? `ran past ${maxMinutes}m`
          : usd >= workerUsd ? `spent $${usd.toFixed(2)}, past its $${workerUsd} cap` : null;
      if (over) {
        log(`${w.name} ${over}: stopping it (its lease expires and the item returns to the queue)`);
        w.kill('SIGTERM');
        w.killedAt = t;
        w.stopped = /^ran past/.test(over) ? { cause: 'timeout', minutes: maxMinutes } : { cause: 'budget', usd: workerUsd };
      } else if (!w.killedAt && w.cap && usd > w.cap) {
        // A land job's dollar cap (#752), for agents that report spend as they go; Claude stops itself there.
        log(`${w.name} spent past its $${w.cap} cap for a land job: stopping it (the item goes back as a land job)`);
        w.kill('SIGTERM');
        w.killedAt = t;
        w.stopped = { cause: 'budget', usd: w.cap };
      } else if (w.killedAt && t - w.killedAt > KILL_GRACE_MS) {
        w.kill('SIGKILL');
      }
    }
    // Running workers' spend counts too (#761): a long run stops new launches while it runs.
    if (!stopping && total() >= maxUsd) {
      const others = running.filter((w) => !w.gone).length;
      stop(`reached --max-usd ${maxUsd} ($${total().toFixed(2)} spent)${others ? `; letting ${others} running worker(s) finish` : ''}`);
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
    quiet = false;
    if (!stopping && t >= pausedUntil) {
      try {
        list = next ?? await routes({ jobs: most });
        if (hubDown) log('The hub is back.');
        hubDown = false;
      } catch (e) {
        // Its workspace was deleted (#799): nothing to come back to, so it stops rather than retry.
        if (e?.status === 410) {
          log(`${e.message}. ${e.hint ?? ''}`.trim());
          deleted = true;
          stop(e.message);
        } else if (!hubDown) log(`Can't reach the hub (${e.message}); retrying every ${pollSeconds}s.`);
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
            failedAfter(0);
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
          // The item it was started for (#793): plan() starts no other worker on it. A routed model or a land job
          // (#752) makes it that worker's one job.
          w.item ??= r.item;
          w.job ??= r.model || r.mode === 'land' ? r.item : null;
          log(`▶ ${w.name} → ${r.name ?? r.project}${r.model ? `: ${r.item} ${r.title} (${r.mode} on ${r.model})` : ''}${w.where ? `  ${w.where}` : ''}`);
          w.exited.then(async (code) => {
            const ms = now() - w.started;
            const secs = Math.round(ms / 1000);
            done.push({ name: w.name, project: w.project, code, secs });
            const said = w.spent?.();
            const usd = Number(said) || 0;
            spent += usd;
            w.gone = true; // its spend is in spent now; it stays in the list until the hub answers below
            log(`■ ${w.name} (${w.project}) exited ${code} after ${secs}s${said === null ? ', cost unpriced' : usd ? `, spent $${usd.toFixed(2)}` : ''}`);
            const others = running.filter((x) => !x.gone).length;
            if (total() >= maxUsd) stop(`reached --max-usd ${maxUsd} ($${total().toFixed(2)} spent)${others ? `; letting ${others} running worker(s) finish` : ''}`);
            w.stopped ??= interrupted ? { cause: 'interrupted' } : { cause: 'exited', code };
            // It counts as running until the hub answers, so no replacement starts meanwhile.
            await Promise.resolve().then(() => signoff(w)).catch(() => {});
            const failure = code !== 0 && !interrupted && !w.killedAt;
            const worked = failure && await Promise.resolve().then(() => submitted(w)).catch(() => false);
            if (failure && !worked) failedAfter(ms);
            else if (code === 0 || worked) failing = [];
            if (worked) pauseMs = PAUSE_MS; // it handed something in: the next streak pauses 5m again
            const empty = code === 0 && !interrupted && !w.killedAt && ms < EMPTY_MS && !(await claimed(w).catch(() => true));
            // Its one job taken first by another agent (#793): a lost race, not a project with nothing it can take.
            const by = empty && w.job ? await Promise.resolve().then(() => taken(w)).catch(() => null) : null;
            if (by) log(`${w.name}: ${w.job} was taken by ${by}`);
            else if (empty) foundNothing(w);
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
      quiet = !stopping && running.length < most && launched < maxRuns && !list.some((x) => !cant.has(x.project) && !(resting.get(x.project)?.until > t));
      if (waiting) idle = false;
      else if (!running.length && untilIdle) stop(elsewhere ? 'no work this machine can take is waiting' : 'no work is waiting in opted-in projects');
      else if (!running.length && !idle) {
        idle = true;
        log(`${elsewhere ? 'Nothing this machine can take is waiting' : 'Nothing is waiting in opted-in projects'}; ${longPoll ? 'starting a worker as soon as some is' : `checking every ${pollSeconds}s`}. Ctrl-C stops.`);
      }
    }
    if (!stopping && launched >= maxRuns && !running.length) stop(`reached --max-runs ${maxRuns}`);
    if (stopping && !running.length) break;
    if (!hubDown) await tell(state());
    next = null;
    const woken = new Promise((r) => { wake = r; });
    if (quiet && longPoll && !hubDown) {
      const t0 = now();
      const gone = new AbortController();
      const skip = list.filter((x) => cant.has(x.project) || resting.get(x.project)?.until > t0).map((x) => x.project);
      const seconds = Math.min(pollSeconds, WAIT_MAX_S);
      const asked = Promise.resolve().then(() => waitRoutes({ skip, seconds, signal: gone.signal, jobs: most })).then((l) => {
        if (gone.signal.aborted) return;
        next = l;
        // Back early with nothing it can start: a hub that ignores the wait. Sleep out the poll as before.
        if (now() - t0 < seconds * 500 && !l.some((x) => !skip.includes(x.project))) {
          longPoll = false;
          next = null;
          return sleep(pollSeconds * 1000 - (now() - t0));
        }
      }, () => (gone.signal.aborted ? null : sleep(pollSeconds * 1000 - (now() - t0)))); // unreachable: the next round's routes() says so
      await Promise.race([asked, woken]);
      gone.abort();
    } else await Promise.race([sleep(pollSeconds * 1000), woken]);
  }

  await tell({ ...state(), stopped: why });
  const failed = done.filter((d) => d.code !== 0).length;
  const each = done.map((d) => `${d.name}@${d.project}:${d.code}`).join(', ');
  log(`Done: ${why}. ${launched} launched, ${done.length - failed} exited cleanly, ${failed} failed${each ? ` (${each})` : ''}${spent || maxUsd !== Infinity ? `; $${spent.toFixed(2)} spent` : ''}.`);
  const restart = !!(supervised && moved && !interrupted);
  if (restart) log(`nuworq updated ${moved}: restarting onto it`);
  return { launched, done, why, spent, restart, deleted };
}
