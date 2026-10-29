// Talks to a running hub over HTTP. Shared by the CLI and the MCP server.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify, normRemote } from './core.js';
import { envVar, dataDir, CONFIG_FILES } from './names.js';

export const DEFAULT_URL = 'http://127.0.0.1:4747';
// `nuworq serve` writes where it is listening, so clients find the hub without configuration.
export const HUB_FILE = join(dataDir(), 'hub.json');

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

function discoveredUrl() {
  try { return JSON.parse(readFileSync(HUB_FILE, 'utf8')).url || null; } catch { return null; }
}

// project is null unless someone named it (flag, env, or .nuworq.json): otherwise the hub decides,
// from the folder the agent is in, or by routing it to the work that matters most.
export function resolveSettings({ url, project, token, cwd = process.cwd() } = {}) {
  const config = findConfig(cwd);
  const hubUrl = (url || envVar('URL') || config?.url || discoveredUrl() || DEFAULT_URL).replace(/\/+$/, '');
  const named = project || envVar('PROJECT') || config?.project;
  return { url: hubUrl, project: named ? slugify(named) : null, root: repoRoot(cwd), remote: repoRemote(cwd), token: token ?? envVar('TOKEN') ?? '', config };
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

// opts: url, project, token, cwd (see resolveSettings); retryMs: how long to retry a refused or dropped connection.
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
  async function send(path, init) {
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
