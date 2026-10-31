import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Hub } from '../src/core.js';
import { itemView, view } from '../src/insight.js';
import { proxyClient, proxyFromEnv, leaseWindows } from '../src/llmproxy.js';

// A fake llm-proxy built from the contract nuworq reads (src/llmproxy.js): GET /_/api/requests?client=&from=&to=
// with a bearer key, pages of 2 linked by `next`. mode: 'ok' | 'missing' (no read API: 404) | 'refused' (403).
// access: { id, secret } puts it behind a fake Cloudflare Access, which sends anyone without them to a login.
async function fakeProxy(byClient, { key = 'k', access = null } = {}) {
  const state = { mode: 'ok', calls: 0 };
  const server = createServer((req, res) => {
    state.calls++;
    const u = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (access && (req.headers['cf-access-client-id'] !== access.id || req.headers['cf-access-client-secret'] !== access.secret)) {
      res.writeHead(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' });
      return res.end();
    }
    if (u.pathname !== '/_/api/requests' || state.mode === 'missing') return send(404, { error: 'not_found' });
    if (state.mode === 'refused' || req.headers.authorization !== `Bearer ${key}`) return send(403, { error: 'forbidden' });
    const from = Number(u.searchParams.get('from')), to = Number(u.searchParams.get('to'));
    const all = (byClient[u.searchParams.get('client')] ?? []).filter((r) => r.at >= from && r.at <= to);
    const start = Number(u.searchParams.get('cursor') || 0);
    send(200, { requests: all.slice(start, start + 2), ...(start + 2 < all.length ? { next: String(start + 2) } : {}) });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => server.close() };
}

const req = (at, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, extra = {}) =>
  ({ at, model, prompt_tokens, completion_tokens, cached_tokens: 0, cost_usd, duration_ms, error: null, cold_load: false, ...extra });

function setup() {
  let t = 1_000_000;
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('px', { create: true }));
  return { hub, at: (ms) => { t = ms; }, now: () => t };
}

describe('usage from llm-proxy', () => {
  test('lease windows: claim to submit or handoff, a lapsed lease, landing', () => {
    const ev = (type, actor, at, data = {}) => ({ type, actor, at, data: JSON.stringify(data) });
    assert.deepEqual(leaseWindows([
      ev('claimed', 'a', 10), ev('progress', 'a', 20), ev('handoff', 'a', 30),
      ev('claimed', 'b', 40), ev('lease_expired', 'nuworq', 50, { agent: 'b' }),
      ev('claimed', 'a', 60), ev('submitted', 'a', 70),
      ev('landing', 'c', 80),
    ], 99), [
      { agent: 'a', from: 10, to: 30 }, { agent: 'b', from: 40, to: 50 }, { agent: 'a', from: 60, to: 70 }, { agent: 'c', from: 80, to: 99 },
    ]);
  });

  test('an item shows what the fake measured for each agent over its lease windows, superseding what was reported', async () => {
    const { hub, at } = setup();
    const fake = await fakeProxy({
      'nuworq/px/cl': [
        req(1_500, 'claude-opus-5-5', 999, 999, 9, 9), // before the claim: another item's
        req(2_500, 'claude-opus-5-5', 1000, 100, 0.25, 4000),
        req(2_600, 'claude-opus-5-5', 2000, 200, 0.5, 6000, { error: 'overloaded' }),
      ],
      'nuworq/px/local': [
        req(5_500, 'qwen3:8b', 3000, 300, null, 20000, { cold_load: true }),
        req(5_600, 'qwen3:8b', 1000, 100, null, 10000),
        req(5_700, 'qwen3:8b', 1000, 100, null, 10000),
      ],
    });
    try {
      hub.llmProxy = proxyClient({ url: fake.url, key: 'k' });
      at(1_000); hub.humanOp('px', 'create', { title: 'Build it', acceptance: 'x' });
      at(2_000); hub.agentOp('px', 'claim', 'cl', { item: '#1' });
      at(3_000); hub.agentOp('px', 'handoff', 'cl', { item: '#1', headline: 'out of context', usage: { input_tokens: 5, output_tokens: 5, cost_usd: 0.01, model: 'claude-opus-5-5' } });
      at(5_000); hub.agentOp('px', 'claim', 'local', { item: '#1' });
      at(6_000); hub.agentOp('px', 'submit', 'local', { item: '#1', headline: 'Done' });
      await hub.measured();

      const u = itemView(hub, 'px', '#1').usage;
      assert.deepEqual(u.rows.map((r) => [r.agent, r.model, r.source, r.input_tokens, r.output_tokens, r.cost_usd, r.duration_ms ?? null, r.failures ?? null, r.cold_loads ?? null, !!r.superseded]), [
        ['cl', 'claude-opus-5-5', 'agent', 5, 5, 0.01, null, null, null, true],
        ['cl', 'claude-opus-5-5', 'llm-proxy', 3000, 300, 0.75, 10000, 1, 0, false],
        ['local', 'qwen3:8b', 'llm-proxy', 5000, 500, null, 40000, 0, 1, false],
      ]);
      assert.deepEqual(u.total, { input_tokens: 8000, output_tokens: 800, cost_usd: 0.75, duration_ms: 50000, requests: 5, failures: 1, cold_loads: 1 });

      // Landing asks again and replaces the measurement: nothing counts twice.
      at(7_000); hub.humanOp('px', 'accept', { item: '#1' });
      await hub.measured();
      assert.equal(hub.item(hub.project('px'), '#1').stage, 'done');
      assert.deepEqual(itemView(hub, 'px', '#1').usage.total.input_tokens, 8000);
      assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'llm-proxy'`).get().n, 0, 'it worked from the start: nothing to say');

      // Flow's cost per model uses the measured numbers.
      const cost = view(hub, 'px').flow.cost;
      assert.deepEqual(cost.by_model.map((m) => [m.model, m.total_usd, m.total_tokens]), [['claude-opus-5-5', 0.75, 3300], ['qwen3:8b', null, 5500]]);
      assert.equal(cost.spend_usd, 0.75);
    } finally {
      fake.close();
    }
  });

  test('absent, unreachable or without the read API: reported numbers stay, the reason shows once, and it switches on when the API appears', async () => {
    const { hub, at } = setup();
    const finish = async (title, agent, t) => {
      at(t); const { item } = hub.humanOp('px', 'create', { title, acceptance: 'x' });
      at(t + 100); hub.agentOp('px', 'claim', agent, { item });
      at(t + 200); hub.agentOp('px', 'submit', agent, { item, headline: 'Done', usage: { input_tokens: 10, output_tokens: 1, cost_usd: 0.1, model: 'm' } });
      await hub.measured();
      return itemView(hub, 'px', item).usage;
    };
    const notes = () => hub.q(`SELECT headline FROM events WHERE type = 'llm-proxy' ORDER BY id`).all().map((e) => e.headline);

    // Not configured.
    assert.equal(proxyFromEnv({}), null);
    assert.deepEqual((await finish('A', 'a', 1_000)).rows.map((r) => r.source), ['agent']);
    assert.deepEqual(notes(), []);

    // Unreachable.
    const closed = await fakeProxy({});
    closed.close();
    hub.llmProxy = proxyFromEnv({ NUWORQ_LLM_PROXY_URL: closed.url + '/', NUWORQ_LLM_PROXY_KEY: 'k' });
    assert.equal(hub.llmProxy.url, closed.url);
    assert.deepEqual((await finish('B', 'b', 2_000)).total.input_tokens, 10);
    await finish('C', 'c', 3_000);
    assert.equal(notes().length, 1, 'said once, not per item');
    assert.match(notes()[0], /llm-proxy is off: llm-proxy at .* is unreachable/);

    // Reachable, but no read API yet; then a key that may not read; then it appears, with no restart.
    const fake = await fakeProxy({ 'nuworq/px/e': [req(5_150, 'm', 700, 70, 0.07, 1500)] });
    try {
      hub.llmProxy = proxyClient({ url: fake.url, key: 'k' });
      fake.state.mode = 'missing';
      assert.equal((await finish('D', 'd', 4_000)).total.input_tokens, 10);
      assert.match(notes().at(-1), /no request history API yet \(404\)/);
      fake.state.mode = 'refused';
      await finish('D2', 'd', 4_500);
      assert.match(notes().at(-1), /refused the key \(403\)/);
      fake.state.mode = 'ok';
      const u = await finish('E', 'e', 5_000);
      assert.deepEqual(u.total, { input_tokens: 700, output_tokens: 70, cost_usd: 0.07, duration_ms: 1500, requests: 1, failures: 0, cold_loads: 0 });
      assert.match(notes().at(-1), /now comes from llm-proxy/);
      assert.equal(notes().length, 4);
    } finally {
      fake.close();
    }
  });

  test('behind Cloudflare Access: the service token from the environment goes with every request', async () => {
    const access = { id: 'abc.access', secret: 'shh' };
    const fake = await fakeProxy({ 'nuworq/px/a': [req(10, 'claude-opus-5-5', 100, 10, 0.01, 500)] }, { access });
    try {
      const env = { NUWORQ_LLM_PROXY_URL: fake.url, NUWORQ_LLM_PROXY_KEY: 'k' };
      const reqs = await proxyFromEnv({ ...env, NUWORQ_LLM_PROXY_ACCESS_ID: access.id, NUWORQ_LLM_PROXY_ACCESS_SECRET: access.secret }).requests({ client: 'nuworq/px/a', from: 0, to: 100 });
      assert.equal(reqs.length, 1);
      // Without it (or with half of it), Access answers with its login page, and the hub says what to set.
      for (const extra of [{}, { NUWORQ_LLM_PROXY_ACCESS_ID: access.id }]) {
        await assert.rejects(proxyFromEnv({ ...env, ...extra }).requests({ client: 'nuworq/px/a', from: 0, to: 100 }), /redirected to a login \(302\): set NUWORQ_LLM_PROXY_ACCESS_ID and NUWORQ_LLM_PROXY_ACCESS_SECRET/);
      }
      await assert.rejects(proxyClient({ url: fake.url, key: 'k', access: { id: access.id, secret: 'wrong' } }).requests({ client: 'nuworq/px/a', from: 0, to: 100 }), /Cloudflare Access refused the service token/);
    } finally {
      fake.close();
    }
  });
});
