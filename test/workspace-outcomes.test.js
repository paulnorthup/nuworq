import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { takeaway } from '../src/outcomes.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;

// Outcomes across a workspace (#237): every project over 14d/90d/all against the period before, by model and
// agent, with one takeaway. docs/API.md documents it.
describe('GET /api/outcomes', () => {
  let t = Date.UTC(2026, 8, 1, 9), hub, server, url, tokens;
  before(async () => {
    hub = new Hub({ clock: () => t });
    for (const p of ['web', 'api', 'empty']) hub.tx(() => hub.project(p, { create: true }));
    // One item, created, built by agent on model over hours (heartbeats keep its lease), and accepted.
    const land = (p, agent, model, hours, usage) => {
      const it = hub.humanOp(p, 'create', { title: `${agent} ${t}`, acceptance: 'x' });
      hub.agentOp(p, 'checkin', agent, { model });
      const got = hub.agentOp(p, 'next', agent, {});
      for (let left = hours * HOUR; left > 0; left -= 10 * 60_000) { t += Math.min(left, 10 * 60_000); hub.agentOp(p, 'progress', agent, { item: got.item }); }
      hub.agentOp(p, 'submit', agent, { item: got.item, headline: 'Done', ...(usage ? { usage } : {}) });
      hub.humanOp(p, 'accept', { item: got.item });
      return it;
    };
    // The period before: web lands 4.
    for (let k = 0; k < 4; k++) land('web', 'opus-a', 'claude-opus-5-5', 1, { input_tokens: 10, output_tokens: 1, cost_usd: 1 });
    t += 20 * DAY;
    // This period: web lands 1, on a local model (no price); api lands 3 on opus at $1 and 3 on gpt at $3.
    land('web', 'qwen-a', 'qwen3:8b', 2, { input_tokens: 10, output_tokens: 1 });
    for (let k = 0; k < 3; k++) land('api', 'opus-b', 'claude-opus-5-5', 2, { input_tokens: 10, output_tokens: 1, cost_usd: 1 });
    for (let k = 0; k < 3; k++) land('api', 'gpt-a', 'gpt-5', 4, { input_tokens: 10, output_tokens: 1, cost_usd: 3 });
    server = createServer(hub, { auth: 'required' });
    url = `http://127.0.0.1:${await listen(server)}`;
    tokens = { human: server.auth.createToken('remy', 'human'), api: server.auth.createToken('dash', 'agent', { projects: ['api'] }) };
  });
  after(() => { server.close(); server.closeAllConnections(); });
  const get = async (path, token = tokens.human) => {
    const r = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
  };

  test('14d: one row per project with the period before beside it, and one takeaway', async () => {
    const { status, body } = await get('/api/outcomes');
    assert.equal(status, 200);
    assert.equal(body.period, '14d');
    assert.equal(body.until - body.since, 14 * DAY);
    const rows = Object.fromEntries(body.projects.map((p) => [p.project, p]));
    assert.deepEqual(Object.keys(rows).sort(), ['api', 'empty', 'web']);
    assert.deepEqual(Object.keys(rows.api).sort(), ['cost_per_landed', 'cost_usd', 'escapes', 'human_actions', 'landed', 'median_cycle_ms', 'median_wait_ms', 'name', 'previous', 'project'].sort());
    assert.equal(rows.api.landed, 6);
    assert.equal(rows.api.cost_usd, 12);
    assert.equal(rows.api.cost_per_landed, 2);
    assert.equal(rows.api.median_cycle_ms, 4 * HOUR);
    assert.equal(rows.api.human_actions, 6, 'an accept each');
    assert.equal(rows.api.previous.landed, 0);
    // A local model's usage has no price: the project's cost is unknown, not 0.
    assert.deepEqual([rows.web.landed, rows.web.cost_usd, rows.web.cost_per_landed, rows.web.previous.landed, rows.web.previous.cost_usd], [1, null, null, 4, 4]);
    // A project that landed nothing.
    assert.deepEqual([rows.empty.landed, rows.empty.median_cycle_ms, rows.empty.cost_usd, rows.empty.escapes, rows.empty.previous.landed], [0, null, null, 0, 0]);
    // Models and agents across the workspace.
    const model = Object.fromEntries(body.by_model.map((m) => [m.model, m]));
    assert.deepEqual([model['claude-opus-5-5'].landed, model['claude-opus-5-5'].cost_per_landed, model['gpt-5'].cost_per_landed, model['gpt-5'].escape_rate, model['qwen3:8b'].cost_per_landed], [3, 1, 3, 0, null]);
    assert.deepEqual(body.by_agent.map((a) => [a.agent, a.model, a.landed]).sort(), [['gpt-a', 'gpt-5', 3], ['opus-b', 'claude-opus-5-5', 3], ['qwen-a', 'qwen3:8b', 1]]);
    assert.equal(body.summary.landed, 7);
    assert.equal(body.takeaway, 'claude-opus-5-5 lands for $1.00 an item vs $3.00 for gpt-5, with as few escapes: prefer it.');
  });

  test('90d and all take in the earlier work; all has no period before', async () => {
    const ninety = (await get('/api/outcomes?period=90d')).body;
    assert.equal(ninety.projects.find((p) => p.project === 'web').landed, 5);
    const all = (await get('/api/outcomes?period=all')).body;
    assert.equal(all.since, 0);
    assert.ok(all.projects.every((p) => p.previous === null));
    assert.equal(all.summary.landed, 11);
    const bad = await get('/api/outcomes?period=1y');
    assert.equal(bad.status, 400);
    assert.match(bad.body.hint, /14d, 90d, all/);
  });

  test("an agent token reads only its projects'", async () => {
    const { status, body } = await get('/api/outcomes', tokens.api);
    assert.equal(status, 200);
    assert.deepEqual(body.projects.map((p) => p.project), ['api']);
    assert.ok(!body.by_agent.some((a) => a.agent === 'qwen-a'));
  });
});

describe('the takeaway names one decision, or nothing', () => {
  const base = { landed: 6, median_cycle_ms: 4 * HOUR, median_wait_ms: null, escape_rate: 0 };
  test('too little landed: nothing', () => {
    assert.equal(takeaway({ summary: { ...base, landed: 2, median_wait_ms: 10 * HOUR }, projects: [], by_model: [] }), null);
    assert.equal(takeaway({ summary: base, projects: [], by_model: [] }), null, 'enough data, nothing to decide');
  });
  test("the owner is the wait; then escapes; then a project that slowed", () => {
    assert.match(takeaway({ summary: { ...base, median_wait_ms: 6 * HOUR }, projects: [], by_model: [] }), /^Your answers are the wait: median 6h against 4h per item/);
    assert.match(takeaway({ summary: { ...base, escape_rate: 0.33 }, projects: [], by_model: [] }), /^33% of landed work needed a fix later/);
    const projects = [{ name: 'Web', landed: 1, previous: { landed: 8 } }, { name: 'Api', landed: 5, previous: { landed: 6 } }];
    assert.equal(takeaway({ summary: base, projects, by_model: [] }), 'Web landed 1 vs 8 the period before: give it more agents or see what holds it.');
  });
  test('a cheaper model that escapes much more is not recommended', () => {
    const by_model = [
      { model: 'cheap', landed: 4, cost_per_landed: 0.5, escape_rate: 0.5 },
      { model: 'dear', landed: 4, cost_per_landed: 2, escape_rate: 0 },
    ];
    assert.equal(takeaway({ summary: base, projects: [], by_model }), null);
  });
});
