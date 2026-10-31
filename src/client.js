// Talks to a running hub over HTTP. Shared by the CLI and the MCP server.
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify, normRemote } from './core.js';
import { mirrorSource } from './git.js';
import { envVar, dataDir, CONFIG_FILES } from './names.js';

export const DEFAULT_URL = 'http://127.0.0.1:4747';
// `nuworq serve` writes where it is listening, so clients find the hub without configuration.
export const HUB_FILE = join(dataDir(), 'hub.json');
// `nuworq connect <url>` writes the hub this machine works with, and its token (readable only by you).
export const CONNECT_FILE = join(dataDir(), 'connect.json');

// The nearest .nuworq.json (or older .trellis.json) walking up from dir, or null.
export function findConfig(dir = process.cwd()) {
  let d = resolve(dir);
  for (;;) {
    const f = CONFIG_FILES.map((name) => join(d, name)).find((file) => existsSync(file));
    if (f) {
      try { return { file: f, ...JSON.parse(readFileSync(f, 'utf8')) }; } catch { return { file: f }; }
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
};

// The repo's main checkout, even from inside one of its worktrees, so every worktree maps to the same project.
export function repoRoot(cwd = process.cwd()) {
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (common && basename(common) === '.git') return dirname(common);
  return git(cwd, 'rev-parse', '--show-toplevel') ?? resolve(cwd);
}

// The repo's origin remote, normalized (github.com/acme/api): the same on every machine and clone.
export function repoRemote(cwd = process.cwd()) {
  return normRemote(git(cwd, 'remote', 'get-url', 'origin') ?? '');
}

const folders = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

// This machine's checkout of a project the hub knows by its remotes (a hub on a server has no
// folder for it here). Looks in the repo cwd is in, then the folders beside that repo, then the
// folders inside each of roots (NUWORQ_REPOS, ':'-separated); one level, no deeper. Returns the
// repo's main checkout, never one of its worktrees. None: a HubError whose hint is the clone command.
export function checkoutOf(remotes, { cwd = process.cwd(), roots = envVar('REPOS') ?? '' } = {}) {
  const want = new Set(remotes.map(normRemote).filter(Boolean));
  const here = git(cwd, 'rev-parse', '--show-toplevel') ? repoRoot(cwd) : null;
  const beside = besideOf(cwd);
  const seen = new Set();
  for (const dir of [here, ...[beside, ...String(roots).split(delimiter)].filter(Boolean).flatMap(folders)]) {
    if (!dir || seen.has(dir) || !existsSync(join(dir, '.git'))) continue;
    seen.add(dir);
    if (want.has(repoRemote(dir))) return repoRoot(dir);
  }
  const remote = [...want][0] ?? '';
  throw Object.assign(new HubError(`No checkout of ${remote || 'its repository'} on this machine`, {
    hint: `git clone ${mirrorSource(remote) ?? remote} ${cloneDir(remote, { cwd, roots })}   (workers look in the repo they start in, the folders beside it, and the folders in NUWORQ_REPOS)`,
  }), { missing: remote });
}

// The folders beside the repo cwd is in (or cwd itself, outside one): where checkoutOf looks, and clones go.
export const besideOf = (cwd) => (git(cwd, 'rev-parse', '--show-toplevel') ? dirname(repoRoot(cwd)) : resolve(cwd));

// Where a clone of remote goes, so that checkoutOf finds it: in the first of NUWORQ_REPOS, else beside
// the repo cwd is in. Named after the repository.
export function cloneDir(remote, { cwd = process.cwd(), roots = envVar('REPOS') ?? '' } = {}) {
  const root = String(roots).split(delimiter).find(Boolean) ?? besideOf(cwd);
  return join(root, basename(String(remote)).replace(/\.git$/, '') || 'repo');
}

function discoveredUrl() {
  try { return JSON.parse(readFileSync(HUB_FILE, 'utf8')).url || null; } catch { return null; }
}

export function connected(file = CONNECT_FILE) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c?.url ? { url: String(c.url).replace(/\/+$/, ''), token: String(c.token ?? '') } : null;
  } catch {
    return null;
  }
}

// project is null unless someone named it (flag, env, or .nuworq.json): otherwise the hub decides,
// from the folder the agent is in, or by routing it to the work that matters most.
// The hub: flag, env, .nuworq.json, the connected hub, the one serving on this machine, the default.
// The token: flag, env, then the connected hub's, which is only ever sent to that hub.
export function resolveSettings({ url, project, token, cwd = process.cwd(), connectFile } = {}) {
  const config = findConfig(cwd);
  const conn = connected(connectFile);
  const hubUrl = (url || envVar('URL') || config?.url || conn?.url || discoveredUrl() || DEFAULT_URL).replace(/\/+$/, '');
  const named = project || envVar('PROJECT') || config?.project;
  return {
    url: hubUrl, project: named ? slugify(named) : null, root: repoRoot(cwd), remote: repoRemote(cwd),
    token: token ?? envVar('TOKEN') ?? (conn?.url === hubUrl ? conn.token : ''), config,
  };
}

export class HubError extends Error {
  constructor(message, { status = 0, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

// Connection failures worth another try: refused (nothing listening yet) or reset/closed (the old process went away).
const RETRY_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);
const RETRY_MS = 5000;

// opts: url, project, token, cwd, connectFile (see resolveSettings); retryMs: how long to retry a refused or dropped connection.
export function createClient(opts = {}) {
  const settings = resolveSettings(opts);
  // Each x-nuworq-* header goes out under its old x-trellis-* name too, so hubs not yet updated still understand.
  const named = (h) => Object.fromEntries(Object.entries(h).flatMap(([k, v]) => [[`x-nuworq-${k}`, v], [`x-trellis-${k}`, v]]));
  const headers = (extra = {}) => ({
    'content-type': 'application/json',
    ...named({ root: encodeURIComponent(settings.root), ...(settings.remote ? { remote: encodeURIComponent(settings.remote) } : {}), ...extra }),
    ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
  });

  // A hub restarting (e.g. serve --follow moving onto a new main) refuses or drops connections for a
  // moment. Those are retried for a few seconds, so a call made meanwhile just takes a little longer.
  // HTTP errors are answers, never retried.
  const retryMs = opts.retryMs ?? RETRY_MS;
  async function attempt(path, init) {
    const until = Date.now() + retryMs;
    for (let wait = 100; ; wait = Math.min(wait * 2, 1000)) {
      try {
        return await fetch(settings.url + path, init);
      } catch (e) {
        if (!RETRY_CODES.has(e?.cause?.code) || Date.now() + wait > until) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  // A hub that moved for good to a subdomain of itself (nuworq.com → app.nuworq.com) answers with a
  // permanent redirect. fetch would follow it but drop the token on the way, so every call would fail
  // as not logged in. Instead the client moves: it uses the new address from then on, saves it where
  // the old one was saved, and asks again there with the token. A token never follows any other redirect.
  async function send(path, init) {
    const res = await attempt(path, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    const to = movedTo(settings.url, path, res);
    if (!to) return attempt(path, init);
    moved(settings.url, to);
    settings.url = to;
    return attempt(path, init);
  }

  // Where the hub moved, or null: a 301/308 to a subdomain of the hub's host, over https (or the hub's own scheme).
  function movedTo(base, path, res) {
    if (res.status !== 301 && res.status !== 308) return null;
    let from, loc;
    try { from = new URL(base); loc = new URL(res.headers.get('location') ?? '', base + path); } catch { return null; }
    if (!loc.hostname.endsWith(`.${from.hostname}`) || (loc.protocol !== 'https:' && loc.protocol !== from.protocol)) return null;
    // The hub keeps the path it was asked for, so the new address is what comes before it (a /w/<workspace> stays).
    return loc.href.endsWith(path) ? loc.href.slice(0, -path.length) : loc.origin;
  }

  // Saves the new address in connect.json and .nuworq.json, wherever they named the old one. Best effort:
  // a file that can't be written leaves this process moved and the next one to find out for itself.
  function moved(from, to) {
    const file = opts.connectFile ?? CONNECT_FILE;
    try {
      const c = JSON.parse(readFileSync(file, 'utf8'));
      if (String(c?.url ?? '').replace(/\/+$/, '') === from) {
        // Written whole with mode 600 and moved into place, like `nuworq connect` does: it holds the token.
        const tmp = `${file}.${process.pid}`;
        rmSync(tmp, { force: true });
        writeFileSync(tmp, JSON.stringify({ ...c, url: to }, null, 2) + '\n', { mode: 0o600 });
        renameSync(tmp, file);
      }
    } catch {}
    const { file: cfg, ...config } = settings.config ?? {};
    if (cfg && String(config.url ?? '').replace(/\/+$/, '') === from) {
      try { writeFileSync(cfg, JSON.stringify({ ...config, url: to }, null, 2) + '\n'); } catch {}
    }
  }

  async function request(method, path, { body, agent } = {}) {
    let res;
    try {
      res = await send(path, {
        method,
        headers: headers(agent ? { agent } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HubError(`nuworq hub not reachable at ${settings.url}; start it with: nuworq serve`, {
        hint: 'Or point at another hub with --url / NUWORQ_URL.',
      });
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    if (!res.ok) {
      const d = typeof data === 'object' && data ? data : { error: String(data) };
      throw new HubError(d.error || `HTTP ${res.status}`, { status: res.status, hint: d.hint });
    }
    return data;
  }

  return {
    settings,
    call: (op, args = {}, { agent, project } = {}) => {
      const p = project || settings.project;
      return request('POST', p ? `/api/p/${encodeURIComponent(p)}/agent/${op}` : `/api/agent/${op}`, { body: args, agent });
    },
    // The project this folder belongs to, as far as the hub knows.
    where: () => request('GET', `/api/where?root=${encodeURIComponent(settings.root)}&remote=${encodeURIComponent(settings.remote)}`),
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, { body }),
  };
}
