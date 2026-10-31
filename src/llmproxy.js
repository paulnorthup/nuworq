// Usage measured by llm-proxy, for agents whose traffic goes through it. llm-proxy saw every request,
// so its numbers beat what an agent or its CLI reported (src/usage.js): when it has any for an agent on
// an item, they stand in for that agent's reported rows in totals and in Flow.
//
// Only through llm-proxy's documented HTTP API (the standing decision): GET /_/api/requests?client=&from=&to=
// with Authorization: Bearer <key> → { requests: [{ at, model, prompt_tokens, completion_tokens,
// cached_tokens, cost_usd|null, duration_ms, error|null, cold_load }], next? }. Agents label their traffic
// x-client-name: nuworq/<project>/<agent>. 401, 403 and 404 mean the read API isn't there for this key
// (yet): the hub keeps the reported numbers, says why once, and asks again on the next submit or landing,
// so it switches on by itself when llm-proxy gains the API.

import { envVar } from './names.js';
import { SYSTEM } from './core.js'; // used only at call time, so the import cycle is harmless

export class Unavailable extends Error {}

// NUWORQ_LLM_PROXY_URL (e.g. http://studio.local:8080) and NUWORQ_LLM_PROXY_KEY. null when unset.
// Behind Cloudflare Access (llm-proxy's public hostname), also NUWORQ_LLM_PROXY_ACCESS_ID and _SECRET:
// a service token, sent as CF-Access-Client-Id / CF-Access-Client-Secret.
export function proxyFromEnv(env = process.env) {
  const val = (k) => String(envVar(k, env) ?? '').trim();
  const url = val('LLM_PROXY_URL').replace(/\/+$/, '');
  return url ? proxyClient({ url, key: val('LLM_PROXY_KEY'), access: accessFromEnv(env) }) : null;
}

// The Cloudflare Access service token for llm-proxy's public hostname, or null when either half is unset.
export function accessFromEnv(env = process.env) {
  const id = String(envVar('LLM_PROXY_ACCESS_ID', env) ?? '').trim();
  const secret = String(envVar('LLM_PROXY_ACCESS_SECRET', env) ?? '').trim();
  return id && secret ? { id, secret } : null;
}

export function proxyClient({ url, key = '', access = null, fetch: get = fetch, timeoutMs = 10_000 }) {
  const headers = {
    ...(key ? { authorization: `Bearer ${key}` } : {}),
    ...(access ? { 'cf-access-client-id': access.id, 'cf-access-client-secret': access.secret } : {}),
  };
  return {
    url,
    // Every request one client made in [from, to] (ms), following `next` across pages.
    async requests({ client, from, to }) {
      const out = [];
      let cursor = '';
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({ client, from: String(from), to: String(to), ...(cursor ? { cursor } : {}) });
        let res;
        try {
          res = await get(`${url}/_/api/requests?${q}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        } catch (e) {
          throw new Unavailable(`llm-proxy at ${url} is unreachable (${e.cause?.code ?? e.name ?? e.message})`);
        }
        // Cloudflare Access sends a request without a valid service token to its login page.
        if (res.status >= 300 && res.status < 400) {
          throw new Unavailable(`llm-proxy at ${url} redirected to a login (${res.status}): ${access ? 'Cloudflare Access refused the service token' : 'set NUWORQ_LLM_PROXY_ACCESS_ID and NUWORQ_LLM_PROXY_ACCESS_SECRET to a Cloudflare Access service token'}`);
        }
        if ([401, 403].includes(res.status)) throw new Unavailable(`llm-proxy refused the key (${res.status}): it needs a key that may read request history`);
        if (res.status === 404) throw new Unavailable(`llm-proxy at ${url} has no request history API yet (404)`);
        if (!res.ok) throw new Unavailable(`llm-proxy answered ${res.status}`);
        const body = await res.json().catch(() => null);
        if (!Array.isArray(body?.requests)) throw new Unavailable('llm-proxy answered without a requests list');
        out.push(...body.requests);
        if (!body.next) return out;
        cursor = String(body.next);
      }
      return out;
    },
  };
}

export const clientName = (p, agent) => `nuworq/${p.slug}/${agent}`;

// When each agent held the item: from its claim (or shaping, or landing) to its submit, handoff or
// landing, or to when its lease lapsed. A window still open ends at `end`.
const STARTS = new Set(['claimed', 'shaping', 'landing']);
const ENDS = new Set(['submitted', 'handoff', 'landed', 'shaped', 'pushed']);
export function leaseWindows(events, end) {
  const open = new Map();
  const out = [];
  const close = (agent, at) => {
    if (!open.has(agent)) return;
    out.push({ agent, from: open.get(agent), to: at });
    open.delete(agent);
  };
  for (const e of events) {
    if (STARTS.has(e.type)) { if (!open.has(e.actor)) open.set(e.actor, e.at); }
    else if (ENDS.has(e.type)) close(e.actor, e.at);
    else if (e.type === 'lease_expired') close(JSON.parse(e.data || '{}').agent, e.at);
  }
  for (const agent of [...open.keys()]) close(agent, end);
  return out.sort((a, b) => a.from - b.from);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Sum requests per agent and model. Cost stays null while any request's cost is unknown (a local model).
export function sum(perAgent) {
  const rows = new Map();
  for (const [agent, reqs] of perAgent) {
    for (const r of reqs) {
      const model = String(r.model ?? '').slice(0, 100);
      const k = `${agent}\0${model}`;
      const row = rows.get(k) ?? rows.set(k, { agent, model, input_tokens: 0, output_tokens: 0, cost_usd: 0, priced: true, duration_ms: 0, requests: 0, failures: 0, cold_loads: 0 }).get(k);
      row.input_tokens += num(r.prompt_tokens);
      row.output_tokens += num(r.completion_tokens);
      if (r.cost_usd == null) row.priced = false; else row.cost_usd += num(r.cost_usd);
      row.duration_ms += num(r.duration_ms);
      row.requests += 1;
      if (r.error) row.failures += 1;
      if (r.cold_load) row.cold_loads += 1;
    }
  }
  return [...rows.values()].map(({ priced, ...r }) => ({ ...r, cost_usd: priced ? r.cost_usd : null }));
}

// Ask llm-proxy what the item's lease windows cost and store it as the item's measured usage, replacing
// what an earlier measurement stored. Unavailable: nothing changes, and the project hears why once.
export async function measure(hub, itemId) {
  const proxy = hub.llmProxy;
  const item = hub.itemById(itemId);
  if (!proxy || !item) return;
  const p = hub.q('SELECT * FROM projects WHERE id = ?').get(item.project_id);
  const events = hub.q('SELECT actor, type, data, at FROM events WHERE item_id = ? ORDER BY at, id').all(item.id);
  const windows = leaseWindows(events, item.stage === 'done' ? item.stage_since : hub.now());
  if (!windows.length) return;
  const perAgent = new Map();
  try {
    for (const w of windows) {
      const reqs = await proxy.requests({ client: clientName(p, w.agent), from: w.from, to: w.to });
      const inside = reqs.filter((r) => r.at == null || (r.at >= w.from && r.at <= w.to));
      perAgent.set(w.agent, [...(perAgent.get(w.agent) ?? []), ...inside]);
    }
  } catch (e) {
    if (!(e instanceof Unavailable)) throw e;
    hub.tx(() => proxyState(hub, p, e.message));
    return;
  }
  const rows = sum(perAgent);
  hub.tx(() => {
    hub.q(`DELETE FROM usage WHERE item_id = ? AND source = 'llm-proxy'`).run(item.id);
    for (const r of rows) {
      hub.q(`INSERT INTO usage (project_id, item_id, agent, model, input_tokens, output_tokens, cost_usd, source, at, duration_ms, requests, failures, cold_loads, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'llm-proxy', ?, ?, ?, ?, ?, ?)`)
        .run(p.id, item.id, r.agent, r.model, r.input_tokens, r.output_tokens, r.cost_usd, hub.now(), r.duration_ms, r.requests, r.failures, r.cold_loads, hub.roleOf(p, r.agent));
    }
    proxyState(hub, p, '');
  });
  hub.changed(p);
}

// Say it once when llm-proxy stops (or starts) answering, not on every item: the project's last word on
// it is in its events, so a restart doesn't repeat it.
function proxyState(hub, p, reason) {
  const last = hub.q(`SELECT data FROM events WHERE project_id = ? AND type = 'llm-proxy' ORDER BY at DESC, id DESC LIMIT 1`).get(p.id);
  const was = last ? JSON.parse(last.data || '{}').reason ?? '' : '';
  if (last ? was === reason : !reason) return;
  hub.event(p, reason
    ? { actor: SYSTEM, type: 'llm-proxy', headline: `Usage from llm-proxy is off: ${reason}`, summary: 'Items keep the usage agents and runners reported. The hub asks again on the next submit or landing.', data: { reason } }
    : { actor: SYSTEM, type: 'llm-proxy', headline: 'Usage now comes from llm-proxy where agents went through it', data: { reason: '' } });
  hub.changed(p);
}
