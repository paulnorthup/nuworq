import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 60 * 60 * 1000;

// The outcomes API (#108), as docs/API.md documents it.
describe('GET /api/p/<project>/outcomes', () => {
  let t = Date.UTC(2026, 9, 1, 9), hub, server, url, tokens;
  before(async () => {
    hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.tx(() => hub.project('other', { create: true }));
    const human = (op, args) => hub.humanOp('demo', op, args);
    const agent = (name, op, args = {}) => hub.agentOp('demo', op, name, args);
    // Time passes while an agent works: heartbeats keep its 20-minute lease.
    const work = (name, item, ms) => { for (let left = ms; left > 0; left -= 10 * 60_000) { t += Math.min(left, 10 * 60_000); agent(name, 'progress', { item }); } };

    // An old item, finished before the window.
    human('create', { title: 'Old', acceptance: 'x' });
    agent('opus', 'checkin', { model: 'claude-opus-5-5' });
    agent('opus', 'next');
    agent('opus', 'submit', { item: '#1', headline: 'Done' });
    human('accept', { item: '#1' });
    t += 40 * 24 * HOUR;

    // #2 on opus: sent back once, then landed after 3 hours, with usage.
    human('create', { title: 'Two', acceptance: 'x' });
    agent('opus', 'next');
    work('opus', '#2', HOUR);
    agent('opus', 'submit', { item: '#2', headline: 'Done', usage: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.5 } });
    human('sendback', { item: '#2', note: 'not yet' });
    agent('opus', 'next');
    work('opus', '#2', 2 * HOUR);
    agent('opus', 'submit', { item: '#2', headline: 'Done now' });
    human('accept', { item: '#2' });

    // #3 on qwen: stalled once (its lease lapsed), then landed after 5 hours; a local model, so no price.
    human('create', { title: 'Three', acceptance: 'x' });
    agent('qwen', 'checkin', { model: 'qwen3:8b' });
    agent('qwen', 'next');
    t += HOUR; // past the 20-minute lease
    hub.sweep();
    agent('qwen', 'next');
    work('qwen', '#3', 4 * HOUR);
    agent('qwen', 'submit', { item: '#3', headline: 'Done', usage: { input_tokens: 5000, output_tokens: 500 } });
    human('accept', { item: '#3' });

    // #4 dropped without being worked on.
    human('create', { title: 'Four', acceptance: 'x' });
    human('update', { item: '#4', stage: 'dropped' });

    server = createServer(hub, { auth: 'required' });
    url = `http://127.0.0.1:${await listen(server)}`;
    tokens = {
      human: server.auth.createToken('paul', 'human'),
      inScope: server.auth.createToken('proxy', 'agent', { projects: ['demo'] }),
      outScope: server.auth.createToken('elsewhere', 'agent', { projects: ['other'] }),
    };
  });
  after(() => { server.close(); server.closeAllConnections(); });
  const get = async (path, token) => {
    const r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
  };

  test('per finished item and per model, as documented', async () => {
    const { status, body } = await get('/api/p/demo/outcomes', tokens.human);
    assert.equal(status, 200);
    assert.equal(body.version, 1);
    assert.equal(body.project, 'demo');
    assert.equal(body.until - body.since, 30 * 24 * HOUR, 'the last 30 days by default');
    assert.deepEqual(body.items.map((i) => [i.item, i.outcome, i.sent_back, i.stalls, i.implementer, i.model, i.cycle_ms]), [
      ['#2', 'landed', 1, 0, 'opus', 'claude-opus-5-5', 3 * HOUR],
      ['#3', 'landed', 0, 1, 'qwen', 'qwen3:8b', 5 * HOUR],
      ['#4', 'dropped', 0, 0, null, null, null],
    ], 'the item finished 40 days ago is outside the window');
    const two = body.items[0];
    assert.deepEqual(Object.keys(two).sort(), ['attempts', 'cycle_ms', 'done_at', 'escaped', 'fixed_by', 'implementer', 'item', 'model', 'outcome', 'overturned', 'repo', 'reviewer', 'reviewer_model', 'sent_back', 'size', 'stalls', 'title', 'usage']);
    assert.deepEqual(two.usage, [{ agent: 'opus', model: 'claude-opus-5-5', source: 'agent', input_tokens: 1000, output_tokens: 100, cost_usd: 0.5 }]);
    assert.deepEqual(body.by_model, [
      { model: 'claude-opus-5-5', landed: 1, dropped: 0, sent_back: 1, stalls: 0, escapes: 0, median_cycle_ms: 3 * HOUR, input_tokens: 1000, output_tokens: 100, cost_usd: 0.5 },
      { model: 'qwen3:8b', landed: 1, dropped: 0, sent_back: 0, stalls: 1, escapes: 0, median_cycle_ms: 5 * HOUR, input_tokens: 5000, output_tokens: 500, cost_usd: null },
      { model: null, landed: 0, dropped: 1, sent_back: 0, stalls: 0, escapes: 0, median_cycle_ms: null, input_tokens: 0, output_tokens: 0, cost_usd: null },
    ]);
  });

  test('since/until choose the window', async () => {
    const { body } = await get(`/api/p/demo/outcomes?since=0&until=${Date.UTC(2026, 9, 2)}`, tokens.human);
    assert.deepEqual(body.items.map((i) => i.item), ['#1']);
  });

  test("an agent token reads its own project's outcomes, not another's", async () => {
    assert.equal((await get('/api/p/demo/outcomes', tokens.inScope)).status, 200);
    const out = await get('/api/p/demo/outcomes', tokens.outScope);
    assert.equal(out.status, 403);
    assert.ok(out.body.hint);
  });
});
