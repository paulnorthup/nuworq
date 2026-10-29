// Talks to a running hub over HTTP. Shared by the CLI and the MCP server.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { slugify, normRemote } from './core.js';

export const DEFAULT_URL = 'http://127.0.0.1:4747';
// `trellis serve` writes where it is listening, so clients find the hub without configuration.
export const HUB_FILE = join(homedir(), '.trellis', 'hub.json');

// The nearest .trellis.json walking up from dir, or null.
export function findConfig(dir = process.cwd()) {
  let d = resolve(dir);
  for (;;) {
    const f = join(d, '.trellis.json');
    if (existsSync(f)) {
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

// project is null unless someone named it (flag, env, or .trellis.json): otherwise the hub decides,
// from the folder the agent is in, or by routing it to the work that matters most.
export function resolveSettings({ url, project, token, cwd = process.cwd() } = {}) {
  const config = findConfig(cwd);
  const hubUrl = (url || process.env.TRELLIS_URL || config?.url || discoveredUrl() || DEFAULT_URL).replace(/\/+$/, '');
  const named = project || process.env.TRELLIS_PROJECT || config?.project;
  return { url: hubUrl, project: named ? slugify(named) : null, root: repoRoot(cwd), remote: repoRemote(cwd), token: token ?? process.env.TRELLIS_TOKEN ?? '', config };
}

export class HubError extends Error {
  constructor(message, { status = 0, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export function createClient(opts = {}) {
  const settings = resolveSettings(opts);
  const headers = (extra = {}) => ({
    'content-type': 'application/json',
    'x-trellis-root': encodeURIComponent(settings.root),
    ...(settings.remote ? { 'x-trellis-remote': encodeURIComponent(settings.remote) } : {}),
    ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
    ...extra,
  });

  async function request(method, path, { body, agent } = {}) {
    let res;
    try {
      res = await fetch(settings.url + path, {
        method,
        headers: headers(agent ? { 'x-trellis-agent': agent } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HubError(`Trellis hub not reachable at ${settings.url}; start it with: trellis serve`, {
        hint: 'Or point at another hub with --url / TRELLIS_URL.',
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
