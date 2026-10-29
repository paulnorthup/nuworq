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

const feed = (agent, lines, opts) => { const t = tap(agent, opts); const shown = lines.map((l) => t.line(l)).filter((x) => x != null); return { shown, usage: t.usage() }; };

describe('usage from agent CLI output', () => {
  test('claude: the result event gives tokens (cached input included) and cost; the log keeps only the text', () => {
    const { shown, usage } = feed('claude', [...CLAUDE, 'a plain warning line']);
    assert.deepEqual(shown, ['Checking in.', 'a plain warning line']);
    assert.deepEqual(usage, { input_tokens: 44200, output_tokens: 2500, cost_usd: 0.4215, model: 'claude-opus-5-5' });
  });

  test('codex: turn.completed token counts add up; no cost is reported, so cost is unknown', () => {
    const { shown, usage } = feed('codex', CODEX, { model: 'gpt-5' });
    assert.deepEqual(shown, ['Working on #3.']);
    assert.deepEqual(usage, { input_tokens: 10000, output_tokens: 1000, cost_usd: null, model: 'gpt-5' });
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
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncurl -s -X POST -H 'content-type: application/json' -H "x-nuworq-agent: w" -d '{"item":"#1"}' "$HUB/api/p/run/agent/claim" > /dev/null\ncat ${JSON.stringify(join(dir, 'sample.jsonl'))}\n`, { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('run', { create: true }));
    hub.humanOp('run', 'settings', { path: dir });
    hub.humanOp('run', 'create', { title: 'Do it', acceptance: 'x' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const env = { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, HUB: url, NUWORQ_TOKEN: '' };
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
