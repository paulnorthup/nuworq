// Talks to a running hub over HTTP. Shared by the CLI and the MCP server.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify } from './core.js';

export const DEFAULT_URL = 'http://127.0.0.1:4747';

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

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

export function resolveSettings({ url, project, token, cwd = process.cwd() } = {}) {
  const config = findConfig(cwd);
  const hubUrl = (url || process.env.TRELLIS_URL || config?.url || DEFAULT_URL).replace(/\/+$/, '');
  const root = gitRoot(cwd);
  const raw = project || process.env.TRELLIS_PROJECT || config?.project || (root ? basename(root) : basename(cwd));
  return { url: hubUrl, project: slugify(raw), token: token ?? process.env.TRELLIS_TOKEN ?? '', config };
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
    call: (op, args = {}, { agent, project } = {}) =>
      request('POST', `/api/p/${encodeURIComponent(project || settings.project)}/agent/${op}`, { body: args, agent }),
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, { body }),
  };
}
