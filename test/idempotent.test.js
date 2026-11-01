import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { Hub } from '../src/core.js';
import { createServer as hubServer } from '../src/server.js';
import { createClient } from '../src/client.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const PAGE = '<html><body>Bad gateway</body></html>';

// A proxy in front of the hub that answers its first write with a 502 page. reached: whether that write got to
// the hub first (Cloudflare's 520/524: the hub applied it, the answer was lost) or not (a deploy gap).
function proxy(target, { reached }) {
  let failed = false;
  const tries = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    tries.push(req.headers['idempotency-key']);
    const forward = () => fetch(`${target}${req.url}`, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'content-length')), body: req.method === 'GET' ? undefined : raw });
    const gateway = () => { res.statusCode = 502; res.setHeader('content-type', 'text/html'); res.end(PAGE); };
    if (req.method === 'POST' && !failed) {
      failed = true;
      if (reached) await (await forward()).text();
      return gateway();
    }
    const r = await forward();
    res.statusCode = r.status;
    for (const k of ['content-type', 'x-nuworq-replay']) if (r.headers.get(k)) res.setHeader(k, r.headers.get(k));
    res.end(await r.text());
  });
  return { server, tries };
}

async function setup(reached) {
  const hub = new Hub();
  hub.tx(() => hub.project('p', { create: true }));
  const hs = hubServer(hub);
  const p = proxy(`http://127.0.0.1:${await listen(hs)}`, { reached });
  const url = `http://127.0.0.1:${await listen(p.server)}`;
  const close = () => { for (const s of [hs, p.server]) { s.close(); s.closeAllConnections(); } };
  return { hub, url, tries: p.tries, close, items: () => hub.q('SELECT title FROM items').all().map((i) => i.title) };
}

// Agents' writes can be retried safely (#524).
describe('a write retried through a 502 is applied once', () => {
  for (const reached of [true, false]) {
    test(`its first try ${reached ? 'reached the hub before the 502' : 'never reached the hub'}`, async () => {
      const s = await setup(reached);
      try {
        const c = createClient({ url: s.url, token: '', cwd: tmpdir(), project: 'p', retryMs: 5000 });
        const out = await c.call('propose', { title: 'Retry me' }, { agent: 'claude-a' });
        assert.equal(out.ok, true);
        assert.deepEqual(s.items(), ['Retry me'], 'applied once');
        assert.equal(s.tries.length, 2);
        assert.equal(new Set(s.tries).size, 1, 'the retry carried the same key');
        // The same key again (e.g. a later retry) gets the first answer, and still applies nothing.
        const again = await (await fetch(`${s.url}/api/p/p/agent/propose`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nuworq-agent': 'claude-a', 'idempotency-key': s.tries[0] }, body: '{"title":"Retry me"}' })).json();
        assert.deepEqual(again, out);
        assert.deepEqual(s.items(), ['Retry me']);
      } finally { s.close(); }
    });
  }

  test('a connection dropped while the write is still applying: the retry waits as pending, then gets its answer, applied once', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    const { item } = hub.agentOp('p', 'propose', 'b1', { title: 'Slow', acceptance: 'works' });
    hub.agentOp('p', 'claim', 'b1', { item });
    // submit fetches the mirror first (hub.prefetch): held open here until the test lets it go.
    let release;
    const held = new Promise((r) => { release = r; });
    hub.prefetch = () => held;
    const hs = hubServer(hub);
    const port = await listen(hs);
    const headers = { 'content-type': 'application/json', 'x-nuworq-agent': 'b1', 'idempotency-key': 'slow-1' };
    const body = JSON.stringify({ item, headline: 'Built' });
    try {
      // The first try: sent, then its connection dropped mid-write, as a proxy giving up does.
      await new Promise((done) => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/api/p/p/agent/submit', headers }, () => {});
        req.on('error', () => done());
        req.end(body, () => setTimeout(() => { req.destroy(); done(); }, 50));
      });
      await new Promise((r) => setTimeout(r, 50));
      const retry = await fetch(`http://127.0.0.1:${port}/api/p/p/agent/submit`, { method: 'POST', headers, body });
      assert.equal(retry.status, 409);
      assert.equal(retry.headers.get('x-nuworq-replay'), 'pending');
      await retry.text();
      release();
      await new Promise((r) => setTimeout(r, 50));
      const again = await fetch(`http://127.0.0.1:${port}/api/p/p/agent/submit`, { method: 'POST', headers, body });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).ok, true, "the first try's answer");
      assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'submitted'`).get().n, 1, 'applied once');
    } finally { hs.close(); hs.closeAllConnections(); }
  });

  test("a key is the caller's own: another agent's call with the same key is its own write", async () => {
    const s = await setup(false);
    try {
      const post = (agent) => fetch(`${s.url}/api/p/p/agent/propose`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nuworq-agent': agent, 'idempotency-key': 'k1' }, body: JSON.stringify({ title: `From ${agent}` }) });
      await (await post('warm-up')).text(); // the proxy's one 502
      await (await post('claude-a')).json();
      await (await post('claude-b')).json();
      await (await post('claude-a')).json();
      assert.deepEqual(s.items().sort(), ['From claude-a', 'From claude-b']);
    } finally { s.close(); }
  });
});
