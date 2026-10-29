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
const HINT = 'e.g. precondition: "https://api.example.com/v2/health" (answers 200), or { url, status: 200, contains: "v2", json_path: "features.export", equals: true, credential: "VENDOR" }. Pass {} or null to clear.';

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
  if (kind !== 'http') throw new UserError(`precondition kind "${kind}" isn't known`, { hint: `Use kind "http". ${HINT}` });
  let url;
  try { url = new URL(str(v.url)); } catch { throw new UserError('precondition.url must be an http(s) URL', { hint: HINT }); }
  if (!/^https?:$/.test(url.protocol)) throw new UserError('precondition.url must be an http(s) URL', { hint: HINT });
  if (url.username || url.password) throw new UserError("precondition.url can't carry credentials", { hint: 'Name a credential instead: credential: "VENDOR" sends the hub host\'s NUWORQ_CRED_VENDOR.' });
  const status = v.status == null || v.status === '' ? 200 : Number(v.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new UserError('precondition.status must be an HTTP status, e.g. 200', { hint: HINT });
  const out = { kind, url: url.href, status };
  if (str(v.contains)) out.contains = str(v.contains);
  if (str(v.json_path)) {
    out.json_path = str(v.json_path);
    if (v.equals !== undefined) out.equals = v.equals;
  }
  if (v.credential != null && v.credential !== '') {
    const name = str(v.credential).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,40}$/.test(name)) throw new UserError('precondition.credential is a name, not a secret', { hint: 'e.g. credential: "VENDOR": the hub sends the value of NUWORQ_CRED_VENDOR from its own environment.' });
    out.credential = name;
  }
  return out;
}

// What it waits for, in words: "GET https://… answers 200, contains "v2"".
export function describe(pre) {
  return [`${pre.url} answers ${pre.status}`, pre.contains && `contains "${pre.contains}"`,
    pre.json_path && (pre.equals !== undefined ? `${pre.json_path} is ${JSON.stringify(pre.equals)}` : `has ${pre.json_path}`)].filter(Boolean).join(', ');
}

const dig = (o, path) => path.split('.').reduce((a, k) => (a == null ? undefined : a[/^\d+$/.test(k) && Array.isArray(a) ? Number(k) : k]), o);

// Loopback, private, link-local (cloud metadata) and unique-local addresses.
export const privateAddress = (ip) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(127|10|192\.168|169\.254)\.)/i.test(ip);

// One check: { ok, detail }. Never throws. shared: a hub with workspaces, whose tenants get neither the
// host's credentials nor its private network, and see whether a value matched, never the value.
export async function check(pre, { fetch: get = fetch, env = process.env, timeoutMs = CHECK_MS, shared = false, resolve = lookup } = {}) {
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
    headers.authorization = /^(Bearer|Basic|token) /i.test(value) ? value : `Bearer ${value}`;
  }
  let res, body;
  try {
    // A shared hub doesn't follow redirects: one could lead to an address it just refused.
    res = await get(pre.url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: shared ? 'manual' : 'follow' });
    body = await res.text();
  } catch (e) {
    return { ok: false, detail: `${new URL(pre.url).host} didn't answer (${e.cause?.code ?? e.name})` };
  }
  if (res.status !== pre.status) return { ok: false, detail: `answered ${res.status}, not ${pre.status}` };
  if (pre.contains && !body.includes(pre.contains)) return { ok: false, detail: `answered ${res.status} without "${pre.contains}"` };
  if (pre.json_path) {
    let data;
    try { data = JSON.parse(body); } catch { return { ok: false, detail: `answered ${res.status}, but not with JSON` }; }
    const got = dig(data, pre.json_path);
    if (pre.equals !== undefined ? JSON.stringify(got) !== JSON.stringify(pre.equals) : got == null) {
      return { ok: false, detail: got === undefined ? `${pre.json_path} is missing` : shared ? `${pre.json_path} doesn't match` : `${pre.json_path} is ${JSON.stringify(got).slice(0, 80)}` };
    }
  }
  return { ok: true, detail: describe(pre) };
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
    const host = new URL(pre.url).host;
    if (t - (hosts.get(host) ?? -Infinity) < PER_HOST) continue;
    hosts.set(host, t);
    busy.add(item.id);
    runs.push(check(pre, opts).then((r) => settle(hub, item.id, item.precondition, r)).finally(() => busy.delete(item.id)));
  }
  await Promise.all(runs);
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
