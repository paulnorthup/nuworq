// Preconditions: an item that waits on an outside fact (an API answers, a page says a feature shipped)
// sits in the 'outside' stage until the hub sees the fact, then becomes ready. The hub checks on its sweep
// timer, never inside a request or a transaction: backing off per item (1m doubling to 1h) and asking any
// one host at most every 10s. Credentials are names; the value comes from NUWORQ_CRED_<NAME> on the hub's
// host and is never stored or shown.

import { UserError, SYSTEM } from './core.js'; // used only at call time, so the import cycle is harmless
import { envVar } from './names.js';
import { lookup } from 'node:dns/promises';

const str = (v) => (v == null ? '' : String(v).trim());
export const FIRST_RETRY = 60_000, MAX_RETRY = 3_600_000, PER_HOST = 10_000, CHECK_MS = 10_000;
const HINT = 'e.g. precondition: "https://api.example.com/v2/health" (answers 200), or { url, status: 200, contains: "v2", json_path: "features.export", equals: true, credential: "VENDOR" }. Last resort: { kind: "ask", question: "…" } asks the human. Pass {} or null to clear.';
const VERSION_HINT = 'e.g. { kind: "version", url: "https://api.example.com/version", json_path: "version", min: "2.1.0" } (without json_path, the first version in the body), or { kind: "release", repo: "acme/api", min: "v2.1.0" } (its latest GitHub release).';
// How long work may sit outside before the human hears about it, unless the project says otherwise.
export const WAIT_DAYS = 7;

// Forgiving: a URL string alone is a GET expecting 200. Returns null for none (clear), or the normalized object.
export function normPrecondition(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.startsWith('{')) { try { v = JSON.parse(s); } catch { throw new UserError('precondition must be a URL or an object', { hint: HINT }); } }
    else v = { url: s };
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new UserError('precondition must be a URL or an object', { hint: HINT });
  if (!Object.keys(v).length) return null;
  const kind = v.kind ?? 'http';
  // The last resort: no fact the hub can check, so a person says when, through the questions path.
  if (kind === 'ask') {
    if (!str(v.question)) throw new UserError('precondition.question is required for kind "ask"', { hint: 'e.g. { kind: "ask", question: "Has the vendor turned on the v2 export for us?" }' });
    return { kind, question: str(v.question).slice(0, 500) };
  }
  if (kind === 'release') return normRelease(v);
  if (kind !== 'http' && kind !== 'version') throw new UserError(`precondition kind "${kind}" isn't known`, { hint: `Use kind "http", "version", "release" or "ask". ${HINT}` });
  const out = { kind, url: normUrl(v.url) };
  if (kind === 'version') {
    out.min = normMin(v.min);
    if (str(v.json_path)) out.json_path = str(v.json_path);
  } else {
    const status = v.status == null || v.status === '' ? 200 : Number(v.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new UserError('precondition.status must be an HTTP status, e.g. 200', { hint: HINT });
    out.status = status;
    if (str(v.contains)) out.contains = str(v.contains);
    if (str(v.json_path)) {
      out.json_path = str(v.json_path);
      if (v.equals !== undefined) out.equals = v.equals;
    }
  }
  if (v.credential != null && v.credential !== '') {
    const name = str(v.credential).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) throw new UserError('precondition.credential is a name, not a secret', { hint: 'e.g. credential: "VENDOR": the hub sends the value of NUWORQ_CRED_VENDOR from its own environment.' });
    out.credential = name;
  }
  return out;
}

function normUrl(u) {
  let url;
  try { url = new URL(str(u)); } catch { throw new UserError('precondition.url must be an http(s) URL', { hint: HINT }); }
  if (!/^https?:$/.test(url.protocol)) throw new UserError('precondition.url must be an http(s) URL', { hint: HINT });
  if (url.username || url.password) throw new UserError("precondition.url can't carry credentials", { hint: 'Name a credential instead: credential: "VENDOR" sends the hub host\'s NUWORQ_CRED_VENDOR.' });
  return url.href;
}

function normMin(m) {
  if (!str(m)) throw new UserError('A version or release precondition needs min, the lowest version that will do', { hint: VERSION_HINT });
  if (!semver(str(m))) throw new UserError(`precondition.min "${str(m)}" isn't a semver version`, { hint: VERSION_HINT });
  return str(m);
}

// { kind: 'release', repo, min }: repo as owner/name, github.com/owner/name, or its URL.
function normRelease(v) {
  const m = str(v.repo).replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/(\.git|\/+)$/, '').match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new UserError('precondition.repo must be a GitHub repository, e.g. "acme/api"', { hint: VERSION_HINT });
  return { kind: 'release', repo: `${m[1]}/${m[2]}`, min: normMin(v.min) };
}

// Semver 2.0, with a leading v allowed: { core: [major, minor, patch], pre: [identifiers] }, or null.
// Build metadata (+…) is dropped: it never affects precedence.
const SEMVER = /v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?/;
export function semver(s) {
  const m = String(s ?? '').trim().match(new RegExp(`^${SEMVER.source}$`, 'i'));
  return m && { core: [m[1], m[2], m[3]].map(Number), pre: m[4] ? m[4].split('.') : [] };
}

// The first version in a text body ("nuworq 2.1.0 (build 7)" → "2.1.0"), or null.
export function firstVersion(text) {
  const m = String(text ?? '').match(new RegExp(`(?<![\\w.])${SEMVER.source}(?![\\w])`, 'i'));
  return m ? m[0].replace(/^v/i, '') : null;
}

// Semver precedence: < 0, 0 or > 0. Prereleases sort below their release; numeric identifiers below
// alphanumeric ones; a longer prerelease above its prefix (1.2.0-alpha < 1.2.0-alpha.1).
export function compareSemver(a, b) {
  const x = typeof a === 'string' ? semver(a) : a, y = typeof b === 'string' ? semver(b) : b;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// What it waits for, in words: "GET https://… answers 200, contains "v2"".
export function describe(pre) {
  if (pre.kind === 'ask') return `a person answers "${pre.question}"`;
  if (pre.kind === 'release') return `the latest release of ${pre.repo} is ${pre.min} or later`;
  if (pre.kind === 'version') return `${pre.url}${pre.json_path ? ` ${pre.json_path}` : ''} reports ${pre.min} or later`;
  return [`${pre.url} answers ${pre.status}`, pre.contains && `contains "${pre.contains}"`,
    pre.json_path && (pre.equals !== undefined ? `${pre.json_path} is ${JSON.stringify(pre.equals)}` : `has ${pre.json_path}`)].filter(Boolean).join(', ');
}

const dig = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[/^\d+$/.test(k) && Array.isArray(a) ? Number(k) : k]), o);

// Where a named credential may be sent: NUWORQ_CRED_<NAME>_HOSTS, a comma-separated list of host names
// (".vendor.com" also covers its subdomains). Unset: nowhere, so a credential is never sent by default.
export function credentialAllows(name, host, env = process.env) {
  const h = String(host).toLowerCase();
  return String(envVar(`CRED_${name}_HOSTS`, env) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((a) => (a.startsWith('.') ? h.endsWith(a) || h === a.slice(1) : h === a));
}

// Loopback, private, link-local (cloud metadata) and unique-local addresses.
export const privateAddress = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127|10|192\.168|169\.254)\.)/i.test(ip);

// One check: { ok, detail }. Never throws. shared: a hub with workspaces, whose tenants get neither the
// host's credentials nor its private network, and see whether a value matched, never the value.
// github: { api, token(repo) } for release checks; token resolves to an installation token or null (public API).
export async function check(pre, opts = {}) {
  if (pre.kind === 'release') return checkRelease(pre, opts);
  const got = await fetchUrl(pre, opts);
  if (!got.res) return got;
  const { res, body } = got;
  if (pre.kind === 'version') {
    if (res.status !== 200) return { ok: false, detail: `answered ${res.status}, not 200` };
    let found;
    if (pre.json_path) {
      let data;
      try { data = JSON.parse(body); } catch { return { ok: false, detail: 'answered 200, but not with JSON' }; }
      found = dig(data, pre.json_path);
      if (found == null) return { ok: false, detail: `${pre.json_path} is missing` };
      found = String(found).trim().replace(/^v/i, '');
    } else found = firstVersion(body);
    return versionResult(pre, `${pre.url} reports`, found, opts.shared);
  }
  if (res.status !== pre.status) return { ok: false, detail: `answered ${res.status}, not ${pre.status}` };
  if (pre.contains && !body.includes(pre.contains)) return { ok: false, detail: `answered ${res.status} without "${pre.contains}"` };
  if (pre.json_path) {
    let data;
    try { data = JSON.parse(body); } catch { return { ok: false, detail: `answered ${res.status}, but not with JSON` }; }
    const got = dig(data, pre.json_path);
    if (pre.equals !== undefined ? JSON.stringify(got) !== JSON.stringify(pre.equals) : got == null) {
      return { ok: false, detail: got === undefined ? `${pre.json_path} is missing` : opts.shared ? `${pre.json_path} doesn't match` : `${pre.json_path} is ${JSON.stringify(got).slice(0, 80)}` };
    }
  }
  return { ok: true, detail: describe(pre) };
}

// Whether a found version reaches min, naming both (a shared hub's tenants see only whether it did).
function versionResult(pre, said, found, shared) {
  const v = found && semver(found);
  if (!v) return { ok: false, detail: shared || !found ? `${said} no version` : `${said} "${String(found).slice(0, 40)}", which isn't a version` };
  if (compareSemver(v, pre.min) < 0) return { ok: false, detail: shared ? `${said} a version below ${pre.min}` : `${said} ${found}, below ${pre.min}` };
  return { ok: true, detail: shared ? `${said} ${pre.min} or later` : `${said} ${found}, at least ${pre.min}` };
}

// The latest GitHub release's tag, through the hub's GitHub App when it covers the repo, else the public API.
async function checkRelease(pre, { fetch: get = fetch, timeoutMs = CHECK_MS, github = {} } = {}) {
  const api = (github.api ?? 'https://api.github.com').replace(/\/+$/, '');
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'nuworq' };
  const token = await Promise.resolve(github.token?.(pre.repo)).catch(() => null);
  if (token) headers.authorization = `Bearer ${token}`;
  let res, data;
  try {
    res = await get(`${api}/repos/${pre.repo}/releases/latest`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    data = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, detail: `GitHub didn't answer (${e.cause?.code ?? e.name})` };
  }
  if (res.status === 404) return { ok: false, detail: `${pre.repo} has no releases yet, or GitHub can't see it` };
  if (res.status !== 200) return { ok: false, detail: `GitHub answered ${res.status} for ${pre.repo}'s latest release` };
  const tag = String(data?.tag_name ?? '').trim();
  return versionResult(pre, `${pre.repo}'s latest release is`, firstVersion(tag) ?? tag, false);
}

// GET the precondition's URL: { res, body }, or { ok: false, detail } when it can't be asked.
async function fetchUrl(pre, { fetch: get = fetch, env = process.env, timeoutMs = CHECK_MS, shared = false, resolve = lookup } = {}) {
  const headers = {};
  if (shared) {
    env = {};
    const host = new URL(pre.url).hostname.replace(/^\[|\]$/g, '');
    let ip;
    try { ({ address: ip } = await resolve(host)); } catch { return { ok: false, detail: `${host} doesn't resolve` }; }
    if (/^localhost$/i.test(host) || privateAddress(ip)) return { ok: false, detail: `${host} is a private address, which a shared hub doesn't check` };
  }
  if (pre.credential) {
    const value = envVar(`CRED_${pre.credential}`, env);
    if (!value) return { ok: false, detail: `NUWORQ_CRED_${pre.credential} isn't set on the hub's host` };
    // Agents choose the URL, so a credential goes only to the hosts the hub's host named for it.
    const host = new URL(pre.url).hostname;
    if (!credentialAllows(pre.credential, host, env)) {
      return { ok: false, detail: `NUWORQ_CRED_${pre.credential} isn't allowed for ${host}: the hub's host lists where it may go in NUWORQ_CRED_${pre.credential}_HOSTS` };
    }
    headers.authorization = /^(Bearer|Basic|token) /i.test(value) ? value : `Bearer ${value}`;
  }
  let res, body;
  try {
    // No redirects on a shared hub (one could lead to an address it just refused), nor with a credential
    // (one could carry it to a host it isn't allowed for).
    res = await get(pre.url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: shared || pre.credential ? 'manual' : 'follow' });
    body = await res.text();
  } catch (e) {
    return { ok: false, detail: `${new URL(pre.url).host} didn't answer (${e.cause?.code ?? e.name})` };
  }
  return { res, body };
}

// Check every waiting item that is due, at most one per host per PER_HOST. Resolves when this round's
// checks are done (the server doesn't wait for it; tests do).
export async function runChecks(hub, opts = {}) {
  const t = hub.now();
  const due = hub.q(`SELECT * FROM items WHERE stage = 'outside' AND precondition != '' AND next_check <= ? ORDER BY next_check`).all(t);
  const hosts = hub._checkedHosts ??= new Map(); // host → when it was last asked
  const busy = hub._checking ??= new Set(); // item ids with a check in flight
  const runs = [];
  for (const item of due) {
    if (busy.has(item.id)) continue;
    const pre = JSON.parse(item.precondition);
    if (pre.kind === 'ask') continue; // a person answers it, not the network
    const host = new URL(pre.kind === 'release' ? opts.github?.api ?? 'https://api.github.com' : pre.url).host;
    if (t - (hosts.get(host) ?? -Infinity) < PER_HOST) continue;
    hosts.set(host, t);
    busy.add(item.id);
    runs.push(check(pre, pre.kind === 'release' ? { ...opts, github: githubFor(hub, item, opts) } : opts).then((r) => settle(hub, item.id, item.precondition, r)).finally(() => busy.delete(item.id)));
  }
  await Promise.all(runs);
}

// GitHub for one item's release check. github.app (a GitHubApp) lends a read token for a repository it's
// installed on; a shared hub's app serves many organizations, so there it reads only the project's own repos.
function githubFor(hub, item, { github = {}, shared = false }) {
  const { app, ...rest } = github;
  if (!app) return rest;
  const own = shared ? hub.remotesOf(hub.q('SELECT * FROM projects WHERE id = ?').get(item.project_id)) : null;
  return {
    api: app.api, ...rest,
    token: async (repo) => {
      if (own && !own.includes(`github.com/${repo}`)) return null;
      return (await app.mint(`github.com/${repo}`, { metadata: 'read', contents: 'read' })).token;
    },
  };
}

function settle(hub, id, asked, r) {
  const item = hub.itemById(id);
  if (!item || item.stage !== 'outside' || item.precondition !== asked) return; // changed meanwhile
  const p = hub.q('SELECT * FROM projects WHERE id = ?').get(item.project_id);
  const t = hub.now();
  hub.tx(() => {
    if (!r.ok) {
      const fails = item.check_fails + 1;
      hub.patch(item, { last_check: JSON.stringify({ at: t, ok: false, detail: r.detail }), check_fails: fails, next_check: t + Math.min(FIRST_RETRY * 2 ** (fails - 1), MAX_RETRY) });
      return;
    }
    hub.patch(item, { last_check: JSON.stringify({ at: t, ok: true, detail: r.detail }), check_fails: 0 });
    hub.move(item, 'ready', SYSTEM);
    hub.event(p, { item, actor: SYSTEM, type: 'precondition_passed', headline: `#${item.seq}'s precondition passed: ${r.detail}; it's ready` });
  });
  hub.changed(p);
}
