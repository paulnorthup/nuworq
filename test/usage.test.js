import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { itemView, view } from '../src/insight.js';
import { tools } from '../src/protocol.js';
import { tap, split, normUsage } from '../src/usage.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// Recorded output shapes: claude -p --output-format stream-json --verbose, codex exec --json, opencode run --format json.
const CLAUDE = [
  { type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's1', tools: [] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking in.' }, { type: 'tool_use', name: 'mcp__nuworq__checkin', input: {} }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: '{}' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 3, result: 'Done.', total_cost_usd: 0.4215,
    usage: { input_tokens: 1200, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 2500 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 1200, outputTokens: 2500, costUSD: 0.4215 } } },
].map((e) => JSON.stringify(e));
const CODEX = [
  { type: 'thread.started', thread_id: 't1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Working on #3.' } },
  { type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 4000, output_tokens: 700 } },
  { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 300 } },
].map((e) => JSON.stringify(e));
const OPENCODE = [
  { type: 'text', part: { type: 'text', text: 'On it.' } },
  { type: 'step_finish', part: { type: 'step-finish', tokens: { input: 5000, output: 400, reasoning: 100, cache: { read: 0, write: 0 } }, cost: 0 } },
].map((e) => JSON.stringify(e));
// pi -p --mode json (1.4.0): a session header, then events; each assistant message_end carries that call's usage.
const piUsage = (input, output, cacheRead, total) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const PI = [
  { type: 'session', version: 3, id: 'u1', timestamp: '2026-11-01T10:00:00.000Z', cwd: '/r' },
  { type: 'agent_start' },
  { type: 'message_end', message: { role: 'user', content: 'Work on demo', timestamp: 1 } },
  { type: 'message_update', usage: piUsage(10, 1, 0, 0), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Check' } },
  { type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Checking in.' }, { type: 'toolCall', id: 'c1', name: 'checkin', arguments: {} }], usage: piUsage(3000, 200, 1000, 0.012), stopReason: 'toolUse' } },
  { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'checkin', result: { content: [] }, isError: false },
  { type: 'message_end', message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }], usage: piUsage(4000, 300, 3000, 0.02), stopReason: 'stop' } },
  { type: 'agent_end', messages: [], willRetry: false },
].map((e) => JSON.stringify(e));

const CLAUDE_INIT_SONNET = { type: 'system', subtype: 'init', model: 'claude-sonnet-4-5', session_id: 's2', tools: [] };
const feed = (agent, lines, opts) => { const t = tap(agent, opts); const shown = lines.map((l) => t.line(l)).filter((x) => x != null); return { shown, usage: t.usage() }; };

describe('usage from agent CLI output', () => {
  test('claude: the result event gives tokens (cached input included) and cost; the log keeps only the text', () => {
    const { shown, usage } = feed('claude', [...CLAUDE, 'a plain warning line']);
    assert.deepEqual(shown, ['Checking in.', 'a plain warning line']);
    assert.deepEqual(usage, { input_tokens: 44200, output_tokens: 2500, cost_usd: 0.4215, model: 'claude-opus-5-5' });
  });

  test('codex: turn.completed token counts add up, priced from the model table (#761); a model not in it is unpriced, not $0', () => {
    const { shown, usage } = feed('codex', CODEX, { model: 'gpt-5' });
    assert.deepEqual(shown, ['Working on #3.']);
    // 6000 uncached × $1.25 + 4000 cached × $0.125 + 1000 out × $10, per million.
    assert.deepEqual({ ...usage, cost_usd: Math.round(usage.cost_usd * 1e6) / 1e6 }, { input_tokens: 10000, output_tokens: 1000, cost_usd: 0.018, model: 'gpt-5' });
    assert.deepEqual(feed('codex', CODEX, { model: 'some-new-model' }).usage, { input_tokens: 10000, output_tokens: 1000, cost_usd: null, model: 'some-new-model' });
    assert.equal(feed('codex', CODEX).usage.cost_usd, null, 'no model named: unpriced');
  });

  test('claude: spend so far from each assistant message while it runs; a run killed before its result keeps the estimate, marked so (#761)', () => {
    const msg = (id, u, block = 'x') => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-4-5', content: [{ type: 'text', text: block }], usage: u } });
    const t = tap('claude');
    t.line(JSON.stringify(CLAUDE_INIT_SONNET));
    t.line(msg('m1', { input_tokens: 1000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 2000 }));
    t.line(msg('m1', { input_tokens: 1000, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 0, output_tokens: 2000 }, 'y'));
    t.line(msg('m2', { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 1000 }));
    // $3/M in, $15/M out: 1500 in + 100k written × 1.25 + 100k read × 0.1, 3000 out.
    const want = (1500 * 3 + 100_000 * 3.75 + 100_000 * 0.3 + 3000 * 15) / 1e6;
    assert.ok(Math.abs(t.spent() - want) < 1e-9, `${t.spent()} ≈ ${want}`);
    const u = t.usage();
    assert.deepEqual({ ...u, cost_usd: undefined }, { input_tokens: 201_500, output_tokens: 3000, cost_usd: undefined, model: 'claude-sonnet-4-5', estimated: true });
    // Its result replaces the estimate with what the CLI said.
    t.line(JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1500, cache_creation_input_tokens: 100_000, cache_read_input_tokens: 100_000, output_tokens: 3000 } }));
    assert.deepEqual(t.usage(), { input_tokens: 201_500, output_tokens: 3000, cost_usd: 0.5, model: 'claude-sonnet-4-5' });
    assert.equal(t.spent(), 0.5);
  });

  test('an estimated run is recorded as an estimate, not as the CLI\'s figure (#761)', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('p', { create: true }));
    hub.agentOp('p', 'checkin', 'w1');
    hub.agentOp('p', 'usage', 'w1', { usage: { input_tokens: 10, output_tokens: 5, cost_usd: 1.25, model: 'claude-opus-4-5', estimated: true } });
    const row = hub.q('SELECT source, cost_usd FROM usage WHERE agent = ?').get('w1');
    assert.deepEqual({ ...row }, { source: 'estimate', cost_usd: 1.25 });
  });

  test('opencode on a local model: tokens, and cost unknown rather than $0', () => {
    const { usage } = feed('opencode', OPENCODE, { model: 'ollama/qwen3:8b' });
    assert.deepEqual(usage, { input_tokens: 5000, output_tokens: 500, cost_usd: null, model: 'qwen3:8b' });
    assert.equal(feed('claude', ['not json']).usage, null, 'no usage seen: nothing to record');
  });

  test('opencode through llm-proxy: tokens, cost left to the hub to measure', () => {
    const { usage } = feed('opencode', OPENCODE, { model: 'proxy/gpt-5' });
    assert.deepEqual(usage, { input_tokens: 5000, output_tokens: 500, cost_usd: null, model: 'gpt-5' });
  });

  test('pi: assistant message_end usage adds up (cached input included) with its cost; the log keeps only the text', () => {
    const { shown, usage } = feed('pi', PI);
    assert.deepEqual(shown, ['Checking in.', 'Done.']);
    assert.equal(usage.input_tokens, 11000);
    assert.equal(usage.output_tokens, 500);
    assert.ok(Math.abs(usage.cost_usd - 0.032) < 1e-9);
    assert.equal(usage.model, 'anthropic/claude-sonnet-5-5', 'named from the messages when the runner gave none');
    // On a local model pi prices it at $0: cost unknown, as for opencode.
    assert.deepEqual(feed('pi', PI, { model: 'ollama/qwen3:8b' }).usage, { input_tokens: 11000, output_tokens: 500, cost_usd: null, model: 'qwen3:8b' });
  });

  test('split keeps the totals exact', () => {
    const parts = split({ input_tokens: 1001, output_tokens: 10, cost_usd: 1, model: 'm' }, [1, 2]);
    assert.equal(parts[0].input_tokens + parts[1].input_tokens, 1001);
    assert.equal(parts[0].output_tokens + parts[1].output_tokens, 10);
    assert.ok(Math.abs(parts[0].cost_usd + parts[1].cost_usd - 1) < 1e-9);
    assert.equal(parts[1].input_tokens, 667);
    assert.equal(normUsage({ inputTokens: '5', outputTokens: 2 }).input_tokens, 5, 'forgiving about names and strings');
  });
});

describe('agent-reported usage', () => {
  test('progress, submit and handoff take usage in every schema', () => {
    for (const format of ['mcp', 'openai', 'anthropic']) {
      for (const t of tools(format)) {
        const name = t.name ?? t.function.name;
        const props = (t.inputSchema ?? t.input_schema ?? t.function?.parameters).properties;
        assert.equal(!!props.usage, ['progress', 'submit', 'handoff'].includes(name), `${format} ${name}`);
      }
    }
  });

  test('is stored with source "agent" and shown per agent and model with totals', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('u', { create: true }));
    hub.humanOp('u', 'create', { title: 'Build it', acceptance: 'x' });
    hub.agentOp('u', 'checkin', 'cl', { model: 'claude-opus-5-5' });
    hub.agentOp('u', 'claim', 'cl', { item: '#1' });
    hub.agentOp('u', 'progress', 'cl', { item: '#1', usage: { input_tokens: 1000, output_tokens: 100, cost_usd: 0.1 } });
    hub.agentOp('u', 'handoff', 'cl', { item: '#1', headline: 'out of context', usage: { input_tokens: 500, output_tokens: 50, cost_usd: 0.05 } });
    hub.agentOp('u', 'claim', 'local', { item: '#1' });
    assert.throws(() => hub.agentOp('u', 'submit', 'local', { item: '#1', headline: 'Done', usage: { input_tokens: -1 } }), /usage.input_tokens must be a number/);
    assert.equal(hub.item(hub.project('u'), '#1').stage, 'active', 'a bad usage changes nothing');
    hub.agentOp('u', 'submit', 'local', { item: '#1', headline: 'Done', usage: { input_tokens: 4000, output_tokens: 400, model: 'qwen3:8b' } });

    const u = itemView(hub, 'u', '#1').usage;
    assert.deepEqual(u.rows.map((r) => [r.agent, r.model, r.source, r.input_tokens, r.output_tokens, r.cost_usd?.toFixed(2) ?? null]), [
      ['cl', 'claude-opus-5-5', 'agent', 1500, 150, '0.15'],
      ['local', 'qwen3:8b', 'agent', 4000, 400, null],
    ]);
    assert.equal(u.total.input_tokens, 5500);
    assert.equal(u.total.cost_usd.toFixed(2), '0.15', 'the known costs, summed');
  });
});

describe("a worker's usage, posted after it exits", () => {
  test("doesn't bring a signed-off worker back online; the usage is still recorded", () => {
    let t = Date.UTC(2026, 9, 29, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const op = (name, args = {}) => hub.agentOp('demo', name, 'w1', args);
    op('checkin', { model: 'claude-opus-5-5' });
    op('next');
    op('submit', { item: '#1', headline: 'Done' });
    op('signoff', { headline: 'Leaving' });
    const before = { ...hub.q("SELECT signed_off, last_seen FROM agents WHERE name = 'w1'").get() };
    t += 60_000;
    op('usage', { usage: { input_tokens: 100, output_tokens: 20, cost_usd: 0.01 } });
    assert.deepEqual({ ...hub.q("SELECT signed_off, last_seen FROM agents WHERE name = 'w1'").get() }, before, 'still signed off, last seen at its signoff');
    assert.equal(before.signed_off, 1);
    assert.equal(hub.q("SELECT COUNT(*) AS n FROM usage WHERE agent = 'w1' AND source = 'runner'").get().n, 1);
  });
});

describe('cost in Flow', () => {
  test('median and total per finished item by model, tokens for unpriced models, and total spend', () => {
    const hub = new Hub();
    hub.tx(() => hub.project('c', { create: true }));
    assert.equal(view(hub, 'c').flow.cost, null, 'nothing recorded: nothing shown');
    const finish = (title, agent, usage) => {
      const { item } = hub.humanOp('c', 'create', { title, acceptance: 'x' });
      hub.agentOp('c', 'claim', agent, { item });
      hub.agentOp('c', 'submit', agent, { item, headline: 'Done', usage });
      hub.humanOp('c', 'accept', { item });
      return item;
    };
    finish('A', 'cl', { input_tokens: 1000, output_tokens: 100, cost_usd: 1, model: 'claude-opus-5-5' });
    finish('B', 'cl', { input_tokens: 1000, output_tokens: 100, cost_usd: 3, model: 'claude-opus-5-5' });
    finish('C', 'cl', { input_tokens: 1000, output_tokens: 100, cost_usd: 2, model: 'claude-opus-5-5' });
    finish('D', 'local', { input_tokens: 9000, output_tokens: 1000, model: 'qwen3:8b' });
    // Unfinished work counts toward spend, not toward cost per finished item.
    const { item } = hub.humanOp('c', 'create', { title: 'E', acceptance: 'x' });
    hub.agentOp('c', 'claim', 'cl', { item });
    hub.agentOp('c', 'progress', 'cl', { item, usage: { input_tokens: 10, output_tokens: 1, cost_usd: 0.5, model: 'claude-opus-5-5' } });

    const cost = view(hub, 'c').flow.cost;
    assert.deepEqual(cost.by_model, [
      { model: 'claude-opus-5-5', items: 3, median_usd: 2, total_usd: 6, median_tokens: 1100, total_tokens: 3300 },
      { model: 'qwen3:8b', items: 1, median_usd: null, total_usd: null, median_tokens: 10000, total_tokens: 10000 },
    ]);
    assert.equal(cost.spend_usd, 6.5);
  });
});

describe('runner capture', () => {
  test('worker --run reads claude\'s JSON output and records usage against the item the worker held', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-usage-')));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'sample.jsonl'), CLAUDE.join('\n') + '\n');
    // The fake agent claims #1 as the worker would, then prints the recorded output.
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncurl -s -X POST -H 'content-type: application/json' -H "x-nuworq-agent: w" -d '{"item":"#1"}' "$(cat ${JSON.stringify(join(dir, 'hub'))})/api/p/run/agent/claim" > /dev/null\ncat ${JSON.stringify(join(dir, 'sample.jsonl'))}\n`, { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('run', { create: true }));
    hub.humanOp('run', 'settings', { path: dir });
    hub.humanOp('run', 'create', { title: 'Do it', acceptance: 'x' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    // The hub's address in a file: a worker's environment carries only what it needs (#616).
    writeFileSync(join(dir, 'hub'), url);
    try {
      const env = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: '' };
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'run', '--here', '--as', 'w', '--run'], { env, cwd: dir });
      assert.match(stdout, /Checking in\./);
      assert.ok(!stdout.includes('"type":"result"'), 'the JSON stays out of what a person reads');
      const u = itemView(hub, 'run', '#1').usage;
      assert.deepEqual(u.rows.map((r) => [r.agent, r.model, r.source, r.input_tokens, r.output_tokens, r.cost_usd]), [['w', 'claude-opus-5-5', 'runner', 44200, 2500, 0.4215]]);
    } finally {
      server.close();
    }
  });
});
