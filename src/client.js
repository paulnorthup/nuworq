// Talks to a running hub over HTTP. Shared by the CLI and the MCP server.
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { slugify, normRemote } from './text.js';
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
// The token: flag, env, a file the env names (NUWORQ_TOKEN_FILE: how a runner's workers get theirs, #477), then
// the connected hub's, which is only ever sent to that hub.
export function resolveSettings({ url, project, token, cwd = process.cwd(), connectFile } = {}) {
  const config = findConfig(cwd);
  const conn = connected(connectFile);
  const hubUrl = (url || envVar('URL') || config?.url || conn?.url || discoveredUrl() || DEFAULT_URL).replace(/\/+$/, '');
  const named = project || envVar('PROJECT') || config?.project;
  const fromFile = () => { const f = envVar('TOKEN_FILE'); try { return f ? readFileSync(f, 'utf8').trim() || null : null; } catch { return null; } };
  return {
    url: hubUrl, project: named ? slugify(named) : null, root: repoRoot(cwd), remote: repoRemote(cwd),
    token: token ?? envVar('TOKEN') ?? fromFile() ?? (conn?.url === hubUrl ? conn.token : ''), config,
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
// A proxy in front of a restarting hub (Cloudflare's tunnel) answers these with a page of its own:
// 520-524 are Cloudflare's for an origin it can't reach, 530 for a tunnel with no connector.
export const GATEWAY = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Agent calls that only read, safe to send again (`next` too, when it doesn't claim).
const READS = new Set(['checkin', 'look']);
// A hub on this machine is back in a moment; one behind a proxy takes up to a minute (serve --follow on a VM).
const RETRY_MS = 5000;
const RESTART_MS = 60_000;
// An operator's wait: the hub answers within WAIT_MS (src/wait.js) unless asked for longer; past that plus the
// grace, nothing is coming on that request.
const WAIT_MS = 90_000;
const WAIT_GRACE_MS = 30_000;
const LOOPBACK_HOST = /^(localhost|127(\.\d+){3}|\[::1\])$/i;
const sameSite = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
const isJson = (res) => /json/i.test(res.headers.get('content-type') ?? '');
const isPage = (res, text) => /html/i.test(res.headers.get('content-type') ?? '') || /^\s*</.test(text);
// Never more than this much of a body the hub didn't write goes into an error.
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// opts: url, project, token, cwd, connectFile (see resolveSettings); retryMs: how long to retry a refused or
// dropped connection, or a proxy's 502/503/504. session: this process's session keys (src/session.js), sent
// as x-nuworq-session so an operator's listener finds the session it serves (#335). onProtocol(hash): called with
// each answer's x-nuworq-protocol (#541).
export function createClient(opts = {}) {
  const settings = resolveSettings(opts);
  // What the saved connection said when last read: `nuworq connect` may change it while this client lives.
  const saved = (s) => `${s.url} ${s.token}`;
  let seen = saved(settings);
  // Each x-nuworq-* header goes out under its old x-trellis-* name too, so hubs not yet updated still understand.
  const named = (h) => Object.fromEntries(Object.entries(h).flatMap(([k, v]) => [[`x-nuworq-${k}`, v], [`x-trellis-${k}`, v]]));
  // The cursor of the last reply this session got (#539): the hub counts as sent only what it names.
  let cursor = '';
  const headers = (extra = {}) => ({
    'content-type': 'application/json',
    ...named({ root: encodeURIComponent(settings.root), ...(settings.remote ? { remote: encodeURIComponent(settings.remote) } : {}), ...(opts.session?.length ? { session: opts.session.join(',') } : {}), ...(opts.session?.length && cursor ? { cursor } : {}), ...extra }),
    ...(settings.token ? { authorization: `Bearer ${settings.token}` } : {}),
  });

  // A hub restarting (e.g. serve --follow moving onto a new main) refuses or drops connections, and the
  // proxy in front of it answers 502/503/504 with a page of its own. Those are retried with backoff (a few
  // seconds on this machine, about a minute elsewhere), so a call made meanwhile just takes longer.
  // The hub's own answers (JSON), errors included, are never retried. Redirects come back unfollowed.
  // A proxy's answer is retried for a read, and for a write that carries an idempotency key (#524): it may have
  // reached the hub before the proxy gave up (Cloudflare's 520 and 524 come after the hub got it), and the hub
  // answers the same key with the first answer instead of applying it twice. A key the hub is still applying
  // (409, x-nuworq-replay: pending) is waited out the same way.
  async function send(path, init, { read = false, key = '' } = {}) {
    const until = Date.now() + (opts.retryMs ?? (LOOPBACK_HOST.test(new URL(settings.url).hostname) ? RETRY_MS : RESTART_MS));
    for (let wait = 100; ; wait = Math.min(wait * 2, 5000)) {
      let res;
      try {
        res = await fetch(settings.url + path, { ...init(), redirect: 'manual' });
      } catch (e) {
        if (!RETRY_CODES.has(e?.cause?.code) || Date.now() + wait > until) throw e;
      }
      if (res) {
        const pending = key && res.status === 409 && res.headers.get('x-nuworq-replay') === 'pending';
        if (!pending && (!(read || key) || !GATEWAY.has(res.status) || isJson(res))) return res;
        if (Date.now() + wait > until) return res;
        await res.body?.cancel();
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // Where a redirect sends the hub's calls, when that is still this hub: the address `nuworq connect`
  // saved, or one on the same site (nuworq.com → app.nuworq.com) whose /api/health says it is that hub.
  // Asked without the token, which goes only to an address that passes. fetch would follow a redirect
  // itself but drop the token on the way, so every call would fail as not logged in.
  async function movedTo(res, path) {
    const to = new URL(res.headers.get('location'), settings.url + path).href;
    // The hub keeps the path it was asked for, so the new address is what comes before it (a /w/<workspace> stays).
    const base = to.endsWith(path) ? to.slice(0, -path.length).replace(/\/+$/, '') : null;
    if (!base) return { to };
    // Never from https down to plain http: the token, and the health check vouching for the address, would cross in the clear.
    if (new URL(base).protocol !== 'https:' && new URL(base).protocol !== new URL(settings.url).protocol) return { to };
    if (new URL(base).origin === new URL(settings.url).origin || connected(opts.connectFile)?.url === base) return { to, base };
    if (!sameSite(new URL(base).hostname, new URL(settings.url).hostname)) return { to };
    try {
      const r = await fetch(`${base}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const h = r.ok && isJson(r) ? await r.json() : null;
      return h?.name === 'nuworq' && String(h.url ?? '').replace(/\/+$/, '') === base ? { to, base } : { to };
    } catch {
      return { to };
    }
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

  // deadline: ms the whole answer may take; past it the call fails like a dropped connection (status 0).
  // signal: the caller stopped waiting for it (a runner's wait for work, #542).
  async function once(method, path, { body, agent, read = method === 'GET', deadline, key = '', signal } = {}, hops = 0) {
    let res;
    try {
      res = await send(path, () => ({
        method,
        headers: { ...headers(agent ? { agent } : {}), ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(deadline || signal ? { signal: AbortSignal.any([deadline && AbortSignal.timeout(deadline), signal].filter(Boolean)) } : {}),
      }), { read, key });
    } catch (e) {
      throw new HubError(`nuworq hub not reachable at ${settings.url}; start it with: nuworq serve`, {
        hint: 'Or point at another hub with --url / NUWORQ_URL.',
      });
    }
    if (REDIRECTS.has(res.status) && res.headers.has('location')) {
      await res.body?.cancel();
      const { to, base } = await movedTo(res, path);
      if (!base || hops >= 3) {
        const there = to.endsWith(path) ? to.slice(0, -path.length).replace(/\/+$/, '') : null;
        throw new HubError(base ? `${settings.url} keeps redirecting this call` : `${settings.url} sent this call on to ${new URL(to).origin}, which isn't this hub's address; the token was not sent there`, {
          status: res.status,
          hint: !base && there ? `If the hub moved there, connect to it: nuworq connect ${there}` : 'Check the hub URL (--url, NUWORQ_URL, .nuworq.json or nuworq connect).',
        });
      }
      // The hub moved: this client works with it at its new address from now on, and so does the next
      // process, wherever the old address was saved.
      if (base !== settings.url) moved(settings.url, base);
      settings.url = base;
      // What the saved connection says now: an address given outright (--url, NUWORQ_URL) still names the old
      // one, and must not send a failing call back there in a loop.
      seen = saved(resolveSettings(opts));
      return once(method, path, { body, agent, read, deadline, key, signal }, hops + 1);
    }
    // Which protocol the hub serves (#541): whoever asked hears it, to refetch the tools when it changes.
    const protocol = res.headers.get('x-nuworq-protocol');
    if (protocol) opts.onProtocol?.(protocol);
    let text;
    try {
      text = await res.text();
    } catch {
      throw new HubError(`nuworq hub at ${settings.url} stopped answering midway`, { hint: 'Try again in a minute.' });
    }
    const host = new URL(settings.url).host;
    if (GATEWAY.has(res.status) && !isJson(res)) {
      throw new HubError(`nuworq hub at ${settings.url} is restarting or unreachable (HTTP ${res.status} from ${host})`, {
        status: res.status,
        hint: read ? 'Try again in a minute. If it lasts, whoever runs the hub should check that it is up.'
          : 'It may have reached the hub anyway: in a minute, look before sending it again.',
      });
    }
    // A page (HTML), whatever its status, is never the hub's answer: something else stands in front of it.
    if (!isJson(res) && isPage(res, text)) {
      throw new HubError(`${host} answered with a web page (HTTP ${res.status}), not the nuworq hub's answer`, {
        status: res.status, hint: 'Try again in a minute. If it lasts, check the hub URL (--url, NUWORQ_URL, .nuworq.json or nuworq connect).',
      });
    }
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
    if (!res.ok) {
      const d = typeof data === 'object' && data ? data : { error: clip(String(data)), hint: 'Try again in a minute.' };
      throw new HubError(d.error || `HTTP ${res.status} from ${host}`, { status: res.status, hint: d.hint });
    }
    // Received: the next call says so. The agent itself never needs it.
    if (data && typeof data === 'object' && typeof data.cursor === 'string') { cursor = data.cursor; delete data.cursor; }
    return data;
  }

  // A call that can't get through (no hub, the wrong token, a redirect it may not follow) tries once more
  // if the saved connection changed since it was last read: a session started before `nuworq connect`
  // pointed somewhere new reaches the new address without a restart.
  async function request(method, path, args = {}) {
    // One key per logical write (#524), the same on every try, redirect and reconnect of it.
    if (method !== 'GET' && !(args.read ?? false) && !args.key) args = { ...args, key: randomUUID() };
    for (;;) {
      try {
        return await once(method, path, args);
      } catch (e) {
        if (!(e instanceof HubError) || ![0, 401, 403, ...REDIRECTS, ...GATEWAY].includes(e.status)) throw e;
        const fresh = resolveSettings(opts);
        if (saved(fresh) === seen) throw e;
        seen = saved(fresh);
        Object.assign(settings, fresh);
      }
    }
  }

  return {
    settings,
    call: (op, args = {}, { agent, project } = {}) => {
      const p = project || settings.project;
      const read = READS.has(op) || (op === 'next' && args.claim === false);
      return request('POST', p ? `/api/p/${encodeURIComponent(p)}/agent/${op}` : `/api/agent/${op}`, { body: args, agent, read });
    },
    // The project this folder belongs to, as far as the hub knows.
    where: () => request('GET', `/api/where?root=${encodeURIComponent(settings.root)}&remote=${encodeURIComponent(settings.remote)}`),
    // An operator waiting for something to do (#283): resolves when the hub has it, or empty after a while.
    // The named project, else the hub picks this folder's (all: every project the token reaches).
    // An answer that hasn't come well after the hub's own wait ends (#406: a request left hanging on a hub
    // that restarted) fails like a dropped connection, so `nuworq wait --follow` asks again with the same since.
    wait: ({ since = 0, timeout, all = false, grace = WAIT_GRACE_MS } = {}, { agent } = {}) =>
      request('GET', `/api/wait?for=operator&since=${since}${timeout ? `&timeout=${timeout}` : ''}${
        settings.project ? `&project=${encodeURIComponent(settings.project)}` : all ? '&all=1' : ''}`, { agent, deadline: (timeout ? timeout * 1000 : WAIT_MS) + grace }),
    get: (path, { deadline, signal } = {}) => request('GET', path, { deadline, signal }),
    post: (path, body) => request('POST', path, { body }),
  };
}
