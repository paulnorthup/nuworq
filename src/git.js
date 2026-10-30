// What git says about a submission: the worker's branch, its commits, and whether commits named in
// the evidence exist. Shells out to git with short timeouts; any failure means "no git facts".
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MAX_COMMITS = 20;
const HASH = /\b[0-9a-f]{7,40}\b/g;

function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
const exists = (repo, ref) => git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null;

// Hash-looking words that claim a commit: in evidence labels when they mix digits and letters (so
// "1234567" or "acceded" aren't mistaken for one), and in prose only right after "commit".
export function claimedHashes({ evidence = [], headline = '', summary = '' }) {
  const out = new Set();
  const mixed = (h) => /\d/.test(h) && /[a-f]/.test(h);
  for (const e of evidence) for (const h of `${e.label ?? ''} ${e.url ?? ''}`.match(HASH) ?? []) if (mixed(h)) out.add(h);
  for (const m of `${headline}\n${summary}`.matchAll(/\bcommit(?:ted)?(?: as| at)?:?\s+`?([0-9a-f]{7,40})\b/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

// A checkout (with .git in it), or a bare repository such as the hub's mirrors. A plain folder
// inside some other repository doesn't count.
export const isRepo = (repo) => !!repo && existsSync(repo) && (existsSync(join(repo, '.git'))
  ? git(repo, 'rev-parse', '--git-dir') !== null
  : git(repo, 'rev-parse', '--git-dir') === '.');
export const baseOf = (repo) => ['main', 'master'].find((b) => exists(repo, b)) ?? null;
export const branchExists = exists;
export const headOf = (repo, ref) => git(repo, 'rev-parse', '--short', ref);
// The URL the checkout's origin points at, as configured; null when it has none.
export const originOf = (repo) => git(repo, 'remote', 'get-url', 'origin');
// Does `into` already contain every commit of `ref`?
export const contains = (repo, into, ref) => git(repo, 'merge-base', '--is-ancestor', ref, into) !== null;
const count = (repo, range) => Number(git(repo, 'rev-list', '--count', range) ?? 0);

// Each item is built on its own branch, cut from the latest main, so it can land on its own.
export function itemBranch(item) {
  const words = String(item.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const short = words.length > 40 ? words.slice(0, 40).replace(/-[^-]*$/, '') : words;
  return `nuworq/${item.seq}-${short || 'work'}`;
}

// repo: the project's main checkout. agent: the submitter. own: the item's branch, if it has one.
// Returns null when there is no repo to ask.
export function gitFacts(repo, agent, claim, own = '') {
  if (!isRepo(repo)) return null;
  const base = baseOf(repo);
  const text = [claim.headline, claim.summary, ...(claim.evidence ?? []).map((e) => e.label)].join(' ');
  // The item's own branch first; then worker branches, nuworq/<agent> (or trellis/<agent> from before the rename).
  const named = text.match(/\b(?:nuworq|trellis)\/[\w.@-]+/)?.[0];
  const branch = [own, `nuworq/${agent}`, `trellis/${agent}`, named].find((b) => b && exists(repo, b)) ?? null;
  const commits = branch && base
    ? (git(repo, 'log', '--format=%h%x09%s', '-n', String(MAX_COMMITS), `${base}..${branch}`) ?? '')
      .split('\n').filter(Boolean).map((l) => { const [hash, ...s] = l.split('\t'); return { hash, subject: s.join('\t') }; })
    : [];
  const behind = branch && base ? count(repo, `${branch}..${base}`) : 0;
  const missing = claimedHashes(claim).filter((h) => !exists(repo, h));
  return { branch, base, commits, behind, missing };
}

// One line for the human, or null when git has nothing to worry about.
export function gitWarning(g) {
  if (!g) return null;
  if (g.unpushed) return `${g.unpushed} isn't on origin yet; push it (git push origin ${g.unpushed}) so reviewers anywhere can see it`;
  if (g.missing.length) return `Evidence names commit ${g.missing.join(', ')}, which isn't in the repo`;
  if (g.branch && g.base && !g.commits.length) return `No commits on ${g.branch} ahead of ${g.base}`;
  if (g.behind) return `${g.branch} is ${g.behind} commit(s) behind ${g.base}; rebase onto ${g.base} so the review sees what will land`;
  return null;
}

// ── the hub's own mirror ──────────────────────────────────────────────────
// When the hub has no checkout of a project on its machine (it runs on a server, agents elsewhere),
// it keeps a bare mirror of the project's repository and asks that instead: <dir>/github.com/acme/api.git.
// In a mirror, branches are plain local refs (main, nuworq/12-x), so every question above works on it.

const FETCH_EVERY = 10_000; // heartbeats ask often; the remote is asked at most this often unless it must be
const CLONE_MS = 120_000, FETCH_MS = 30_000;
const fetched = new Map(); // mirror path → { at, error }: shared by every hub in this process

// Where to fetch from. github.com (and any host/owner/repo) over SSH, so a read-only deploy key is
// enough; a path (a repository on this machine) as it is. null for anything else.
export function mirrorSource(remote) {
  const r = String(remote ?? '');
  if (r.startsWith('/')) return r.split('/').some((s) => s === '..') ? null : r;
  const [host, ...rest] = r.split('/');
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(host) || rest.length < 2 || !rest.every((s) => /^[\w.-]+$/.test(s) && !/^\.+$/.test(s))) return null;
  return `git@${host}:${rest.join('/')}.git`;
}

export function mirrorPath(dir, remote) {
  const parts = String(remote ?? '').split('/').filter(Boolean);
  if (!parts.length || parts.some((s) => /^\.+$/.test(s))) return null;
  return `${join(dir, ...parts)}.git`;
}

// A deploy key opens one repository, so a hub that mirrors several keeps one key per repository:
// a private key file at <keys>/<host>/<owner>/<repo> (keys: the hub's <data dir>/keys). The ssh
// command that uses only that key, or null: no such file (the hub's default key is used), or a
// remote that isn't host/owner/repo (a path, or one with "..").
export function sshCommandFor(keys, remote) {
  const r = String(remote ?? '');
  if (!keys || r.startsWith('/') || !mirrorSource(r)) return null;
  const key = join(keys, ...r.split('/'));
  try {
    if (!statSync(key).isFile()) return null;
  } catch {
    return null;
  }
  return `ssh -i '${key.replace(/'/g, `'\\''`)}' -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10`;
}

// An installation token for git over HTTPS, as an extra header on requests under url only. It reaches
// git through the environment (GIT_CONFIG_*, after any the hub already has): never argv, where ps
// shows it, and never a config file. Environment variables for execFileSync.
export function tokenEnv(url, token, env = process.env) {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${url}.extraheader`,
    [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

// How git is run to fetch: no prompts (a hub has nobody to answer them), bounded in time. ssh: the
// repository's own key (sshCommandFor); a GIT_SSH_COMMAND or GIT_SSH set for the hub still wins.
// extra: more environment (tokenEnv). own: only ssh may be used, whatever the hub's environment says
// (a hosted hub never lends its own identity).
function fetchOpts(timeout, ssh, extra, own = false) {
  const quiet = own ? { GIT_SSH_COMMAND: ssh ?? 'false', GIT_SSH: '' }
    : process.env.GIT_SSH_COMMAND || process.env.GIT_SSH ? {}
    : ssh ? { GIT_SSH_COMMAND: ssh }
    : git('.', 'config', '--get', 'core.sshCommand') ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' };
  return { timeout, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...quiet, ...extra } };
}
const failure = (e, stderr) => String(stderr ?? '').trim().split('\n').filter(Boolean).pop() || (e.killed || e.signal ? 'timed out' : e.message);

// Git over the network, asynchronously: a slow or unreachable remote never holds up the event loop, so
// every other request, stream and sweep carries on while it runs. Resolves null, or the last line git
// said about the failure.
const netGit = (args, timeout, ssh = null, extra = {}, own = false) => new Promise((resolve) => {
  execFile('git', args, fetchOpts(timeout, ssh, extra, own), (e, _out, stderr) => resolve(e ? failure(e, stderr) : null));
});

// A repository on this machine (a path remote) is read from disk, not the network: fetched in place.
function diskGit(args, timeout) {
  try {
    execFileSync('git', args, fetchOpts(timeout, null, {}));
    return null;
  } catch (e) {
    return failure(e, e.stderr);
  }
}

// Fetch remote's mirror at the next ask, however recently it was fetched (the hub just got a way in).
export const refetch = (dir, remote) => fetched.delete(mirrorPath(dir, remote));

const inflight = new Map(); // mirror path → its fetch or clone under way
const refsOf = (path) => git(path, 'for-each-ref', '--format=%(objectname) %(refname)');

// What fetching remote's mirror takes: the git arguments (clone it, or fetch it from where it is reached
// now) and how. keys: where per-repository deploy keys live (see sshCommandFor). https: { url, token }:
// from url (no credentials in it) with a GitHub App installation token (tokenEnv); the mirror keeps url
// as its remote, never the token.
// hosted: a workspace on a shared hub reaches only what it was granted: no path on the hub's disk, and
// over SSH only with its own deploy key, never the hub's identity.
function fetchPlan(dir, remote, { keys = null, https = null, hosted = false } = {}) {
  const path = mirrorPath(dir, remote), source = mirrorSource(remote);
  if (!path || !source) return { error: `${remote} isn't a repository address the hub can fetch` };
  if (hosted && source.startsWith('/')) return { error: `${remote} is a path on the hub's machine, which a workspace on a shared hub can't read` };
  const ssh = https ? null : sshCommandFor(keys, remote) || null;
  if (hosted && !https && !ssh) return { error: `this workspace has no access to ${remote} yet: install the nuworq GitHub App for it, or add a deploy key` };
  const env = https ? tokenEnv(https.url, https.token) : {};
  const from = https?.url ?? source;
  const disk = !https && source.startsWith('/');
  if (isRepo(path)) {
    // A mirror cloned one way (SSH) and fetched another (the app's HTTPS) is fetched from where it is reached now.
    const elsewhere = originOf(path) === from ? [] : ['--', from, '+refs/*:refs/*'];
    return { path, disk, ssh, env, own: hosted, timeout: FETCH_MS, args: ['-C', path, 'fetch', '-q', '--prune', ...elsewhere] };
  }
  return { path, disk, ssh, env, own: hosted, timeout: CLONE_MS, clone: true, args: ['clone', '-q', '--mirror', '--', from, path] };
}

function begin(plan) {
  // A clone cut short leaves a folder that isn't a repository yet: start again.
  if (plan.clone) {
    rmSync(plan.path, { recursive: true, force: true });
    mkdirSync(dirname(plan.path), { recursive: true });
  }
  return { before: refsOf(plan.path), was: fetched.get(plan.path)?.error ?? null };
}
function settle(plan, { before, was }, error) {
  fetched.set(plan.path, { at: Date.now(), error });
  // changed: what the hub would say from this mirror may differ now (new refs, or it started or stopped failing).
  return { ...(error ? { error } : { path: plan.path }), changed: refsOf(plan.path) !== before || (error ?? null) !== was };
}

// Fetch (or clone) remote's mirror now: { path } or { error }, with changed. One at a time per mirror: a
// second ask joins the one under way. For decisions that need the newest state (accept, submit): the
// server awaits this before running them, outside any transaction.
export function fetchMirror(dir, remote, opts = {}) {
  const plan = fetchPlan(dir, remote, opts);
  if (plan.error) return Promise.resolve({ error: plan.error });
  if (inflight.has(plan.path)) return inflight.get(plan.path);
  const run = (async () => {
    const start = begin(plan);
    const error = plan.disk ? diskGit(plan.args, plan.timeout) : await netGit(plan.args, plan.timeout, plan.ssh, plan.env, plan.own);
    return settle(plan, start, error);
  })().finally(() => inflight.delete(plan.path));
  inflight.set(plan.path, run);
  return run;
}

// The mirror of remote under dir, as it is: { path }, or { error } (pending: true while the first clone
// is under way). Never waits on the network. When the mirror is older than FETCH_EVERY, a fetch starts in
// the background, and onFetched() is called when it finished and changed something. A repository on this
// machine (a path) is fetched in place first, as reading a disk is: fresh fetches it however recent it is.
export function mirror(dir, remote, { fresh = false, keys = null, https = null, hosted = false, onFetched = null } = {}) {
  const plan = fetchPlan(dir, remote, { keys, https, hosted });
  if (plan.error) return { error: plan.error };
  const last = fetched.get(plan.path);
  const due = !last || Date.now() - last.at >= FETCH_EVERY;
  if (plan.disk) {
    if (!due && !fresh) return last.error ? { error: last.error } : { path: plan.path };
    const r = settle(plan, begin(plan), diskGit(plan.args, plan.timeout));
    return r.error ? { error: r.error } : { path: plan.path };
  }
  if (due && !inflight.has(plan.path)) {
    fetchMirror(dir, remote, { keys, https, hosted }).then((r) => { if (r.changed) onFetched?.(); }, () => {});
  }
  if (last?.error) return { error: last.error };
  return isRepo(plan.path) ? { path: plan.path } : { error: `${remote} is still being cloned`, pending: true };
}
