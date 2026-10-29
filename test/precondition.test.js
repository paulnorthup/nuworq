import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemView, view } from '../src/insight.js';
import { tools } from '../src/protocol.js';
import { normPrecondition, check, runChecks, privateAddress } from '../src/precondition.js';

const MIN = 60_000;

// A vendor API the work waits on: answers with `state` (status, body); `hang` never answers. Counts requests.
async function vendor() {
  const state = { status: 503, body: 'not yet', hang: false, hits: 0, auth: [] };
  const server = http.createServer((req, res) => {
    state.hits++;
    state.auth.push(req.headers.authorization ?? null);
    if (state.hang) return;
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(typeof state.body === 'string' ? state.body : JSON.stringify(state.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => { server.closeAllConnections(); server.close(); } };
}

function setup() {
  let t = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => t });
  hub.tx(() => hub.project('w', { create: true }));
  hub.humanOp('w', 'settings', { autonomy: 'full' });
  return { hub, advance: (ms) => (t += ms), item: (n) => hub.item(hub.project('w'), `#${n}`) };
}

describe('preconditions: work that waits on an outside fact', () => {
  test('forgiving input: a URL alone, names for credentials, never secrets', () => {
    assert.deepEqual(normPrecondition('https://api.example.com/v2'), { kind: 'http', url: 'https://api.example.com/v2', status: 200 });
    assert.deepEqual(normPrecondition({ url: 'https://x.test/f', json_path: 'a.b', equals: true, credential: 'vendor' }),
      { kind: 'http', url: 'https://x.test/f', status: 200, json_path: 'a.b', equals: true, credential: 'VENDOR' });
    assert.equal(normPrecondition({}), null, '{} clears');
    assert.equal(normPrecondition(null), null);
    assert.throws(() => normPrecondition('ftp://x.test'), /http\(s\) URL/);
    assert.throws(() => normPrecondition('https://user:pw@x.test'), /can't carry credentials/);
    assert.throws(() => normPrecondition({ url: 'https://x.test', credential: 'Bearer abc.def' }), /a name, not a secret/);
    const { hub } = setup();
    assert.throws(() => hub.agentOp('w', 'propose', 'a', { title: 'T', precondition: { url: 'https://x.test', contains: 'ghp_' + 'a'.repeat(36) } }), /GitHub token/);
  });

  test('held out of next while the fake fails; ready, with an event saying what passed, once it answers', async () => {
    const v = await vendor();
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'shaper', { title: 'Use the v2 export', acceptance: 'x', precondition: { url: `${v.url}/v2/features`, json_path: 'export', equals: true } });
      assert.equal(item(1).stage, 'outside');
      assert.notEqual(hub.agentOp('w', 'next', 'builder').item, '#1');
      assert.throws(() => hub.agentOp('w', 'claim', 'builder', { item: '#1' }), /waits on something outside this hub: .*\/v2\/features answers 200, export is true \(not checked yet\)/);

      await runChecks(hub);
      assert.equal(item(1).stage, 'outside');
      const ctx = hub.agentOp('w', 'look', 'builder', { item: '#1' });
      assert.equal(ctx.precondition.met, false);
      assert.match(ctx.precondition.last_check.detail, /answered 503, not 200/);

      v.state.status = 200; v.state.body = { export: false };
      advance(MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'outside');
      assert.match(hub.agentOp('w', 'look', 'builder', { item: '#1' }).precondition.last_check.detail, /export is false/);

      v.state.body = { export: true };
      advance(2 * MIN);
      await runChecks(hub);
      assert.equal(item(1).stage, 'ready');
      const passed = hub.q(`SELECT headline FROM events WHERE type = 'precondition_passed'`).get();
      assert.match(passed.headline, /#1's precondition passed: http:\/\/127\.0\.0\.1:\d+\/v2\/features answers 200, export is true; it's ready/);
      assert.equal(hub.agentOp('w', 'next', 'builder').item, '#1');

      // Time spent outside is external: in the item's court totals and in flow.
      assert.equal(itemView(hub, 'w', '#1').court_ms.external, 3 * MIN);
      assert.ok(view(hub, 'w').flow.court.ms.external >= 3 * MIN);
      assert.ok(view(hub, 'w').flow.court.external > 0);
    } finally { v.close(); }
  });

  test('backoff doubles from 1m to a 1h cap; one host is asked at most every 10s', async () => {
    const v = await vendor();
    try {
      const { hub, advance, item } = setup();
      hub.agentOp('w', 'propose', 'a', { title: 'A', acceptance: 'x', precondition: `${v.url}/a` });
      const gaps = [];
      for (let k = 0; k < 8; k++) {
        await runChecks(hub);
        const it = item(1);
        gaps.push((it.next_check - hub.now()) / MIN);
        advance(it.next_check - hub.now());
      }
      assert.deepEqual(gaps, [1, 2, 4, 8, 16, 32, 60, 60]);

      // Two items on one host, both due: one check now, the other no sooner than 10s later.
      hub.agentOp('w', 'propose', 'a', { title: 'B', acceptance: 'x', precondition: `${v.url}/b` });
      hub.agentOp('w', 'propose', 'a', { title: 'C', acceptance: 'x', precondition: `${v.url}/c` });
      advance(61 * MIN); // past the 10s since the last /a check, and A is due again too
      const hits = v.state.hits;
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 1, 'one request to the host');
      advance(5_000);
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 1, 'still within 10s');
      advance(5_000);
      await runChecks(hub);
      assert.equal(v.state.hits - hits, 2);
    } finally { v.close(); }
  });

  test('a check that hangs keeps no request waiting', async () => {
    const v = await vendor();
    v.state.hang = true;
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'Hangs', acceptance: 'x', precondition: `${v.url}/slow` });
    const server = createServer(hub, { sweepMs: 3_600_000 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const pending = runChecks(hub, { timeoutMs: 1_500 });
      await new Promise((r) => setTimeout(r, 50)); // the check is in flight
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/p/w/view`);
      assert.equal(res.status, 200);
      assert.ok(performance.now() - t0 < 300, `answered in ${Math.round(performance.now() - t0)}ms`);
      await pending;
      assert.match(JSON.parse(item(1).last_check).detail, /didn't answer/);
    } finally { server.close(); v.close(); }
  });

  test('agents set, see and clear it through propose/refine and the item context', async () => {
    for (const format of ['mcp', 'openai', 'anthropic']) {
      for (const t of tools(format)) {
        const name = t.name ?? t.function.name;
        const props = (t.inputSchema ?? t.input_schema ?? t.function?.parameters).properties;
        assert.equal(!!props.precondition, ['propose', 'refine'].includes(name), `${format} ${name}`);
      }
    }
    const { hub, item } = setup();
    hub.agentOp('w', 'propose', 'a', { title: 'Later', acceptance: 'x' });
    assert.equal(item(1).stage, 'ready');
    const r = hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: 'https://vendor.test/v2' });
    assert.match(JSON.stringify(r), /waits on: https:\/\/vendor\.test\/v2 answers 200/);
    assert.equal(item(1).stage, 'outside');
    const job = hub.agentOp('w', 'look', 'a', { item: '#1' });
    assert.equal(job.precondition.waits_for, 'https://vendor.test/v2 answers 200');
    assert.equal(job.precondition.last_check, null);
    hub.agentOp('w', 'refine', 'a', { item: '#1', precondition: {} });
    assert.equal(item(1).stage, 'ready');
    assert.equal(hub.agentOp('w', 'look', 'a', { item: '#1' }).precondition, undefined);
  });

  test('credentials come from the hub host by name; a shared hub lends neither them nor its private network', async () => {
    const v = await vendor();
    try {
      v.state.status = 200;
      const pre = normPrecondition({ url: `${v.url}/x`, credential: 'VENDOR' });
      assert.deepEqual(await check(pre, { env: {} }), { ok: false, detail: "NUWORQ_CRED_VENDOR isn't set on the hub's host" });
      assert.equal((await check(pre, { env: { NUWORQ_CRED_VENDOR: 'k1' } })).ok, true);
      assert.equal(v.state.auth.at(-1), 'Bearer k1');
      assert.match((await check(pre, { shared: true })).detail, /private address/);
      assert.match((await check(normPrecondition('https://vendor.test/x'), { shared: true, resolve: async () => ({ address: '169.254.169.254' }) })).detail, /private address/);
      for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1']) assert.ok(privateAddress(ip), ip);
      for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!privateAddress(ip), ip);
    } finally { v.close(); }
  });
});
