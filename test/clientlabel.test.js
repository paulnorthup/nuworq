import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { guide } from '../src/protocol.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// The command a worker would run (without --run), with a home of its own.
async function workerCmd(agent, { home, extra = [], vars = {} }) {
  const hub = new Hub();
  hub.tx(() => hub.project('lab', { create: true }));
  const server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_|^ANTHROPIC_CUSTOM_HEADERS$/.test(k))), HOME: home, ...vars };
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'lab', '--agent', agent, '--as', 'w-1', ...extra], { env, cwd: home });
    return stdout;
  } finally { server.close(); }
}
const freshHome = () => mkdtempSync(join(tmpdir(), 'nuworq-label-'));

describe('workers label their model traffic nuworq/<project>/<agent>', () => {
  test('claude: ANTHROPIC_CUSTOM_HEADERS carries x-client-name', async () => {
    const out = await workerCmd('claude', { home: freshHome() });
    assert.match(out, /ANTHROPIC_CUSTOM_HEADERS='x-client-name: nuworq\/lab\/w-1' \\\n\s+claude -p/);
  });

  test('opencode: the provider sends the header (ollama defined in full, others merged)', async () => {
    const config = (out) => JSON.parse(out.match(/OPENCODE_CONFIG_CONTENT='([^']+)'/)[1]);
    const ollama = config(await workerCmd('opencode', { home: freshHome(), extra: ['--model', 'ollama/qwen3:8b'] }));
    assert.deepEqual(ollama.provider.ollama.options.headers, { 'x-client-name': 'nuworq/lab/w-1' });
    const other = config(await workerCmd('opencode', { home: freshHome(), extra: ['--model', 'llmproxy/gpt-5'] }));
    assert.deepEqual(other.provider, { llmproxy: { options: { headers: { 'x-client-name': 'nuworq/lab/w-1' } } } });
  });

  test("codex: http_headers on the custom provider ~/.codex/config.toml uses; none for the built-in one", async () => {
    const home = freshHome();
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\nmodel_provider = "llm-proxy"\n\n[model_providers.llm-proxy]\nbase_url = "http://studio.local:8080/v1"\n');
    const out = await workerCmd('codex', { home });
    assert.match(out, /-c 'model_providers\.llm-proxy\.http_headers=\{"x-client-name"="nuworq\/lab\/w-1"\}'/);
    assert.doesNotMatch(await workerCmd('codex', { home: freshHome() }), /http_headers/, 'the built-in provider is left alone');
  });

  test('the guide tells hand-started agents how to set it', () => {
    assert.match(guide({ project: 'lab', url: 'http://x', via: 'mcp' }), /x-client-name: nuworq\/<project>\/<your agent name>[\s\S]*ANTHROPIC_CUSTOM_HEADERS/);
  });
});

describe('workers route through llm-proxy: opencode with --model proxy/<model>, claude and codex with --proxy', () => {
  const KEY = 'sk-secret-do-not-leak';
  const config = (out) => JSON.parse(out.match(/OPENCODE_CONFIG_CONTENT='([^']+)'/)[1]);
  const fails = (agent, opts) => workerCmd(agent, opts).then(() => assert.fail('expected the worker to refuse'), (e) => e);

  test('opencode: a "proxy" provider at <url>/v1, the key read from the environment, the label sent', async () => {
    const want = { npm: '@ai-sdk/openai-compatible', name: 'llm-proxy', options: { baseURL: 'http://studio.local:8080/v1', apiKey: '{env:NUWORQ_LLM_PROXY_KEY}', headers: { 'x-client-name': 'nuworq/lab/w-1' } }, models: { 'gpt-5': {} } };
    const vars = { NUWORQ_LLM_PROXY_KEY: KEY };
    const flag = await workerCmd('opencode', { home: freshHome(), vars, extra: ['--model', 'proxy/gpt-5', '--proxy', 'http://studio.local:8080/'] });
    assert.deepEqual(config(flag).provider, { proxy: want });
    assert.match(flag, /opencode run -m 'proxy\/gpt-5'/);
    assert.ok(!flag.includes(KEY), 'the key is in neither argv nor OPENCODE_CONFIG_CONTENT');
    const fromEnv = await workerCmd('opencode', { home: freshHome(), vars: { ...vars, NUWORQ_LLM_PROXY_URL: 'http://studio.local:8080/v1' }, extra: ['--model', 'proxy/gpt-5'] });
    assert.deepEqual(config(fromEnv).provider, { proxy: want }, 'NUWORQ_LLM_PROXY_URL works the same, /v1 or not');
  });

  // Provider routes take llm-proxy's owner token (NUWORQ_LLM_PROXY_TOKEN), never the hub's read-only key.
  const TOKEN = 'owner-secret-do-not-leak';
  const vars = { NUWORQ_LLM_PROXY_TOKEN: TOKEN, NUWORQ_LLM_PROXY_KEY: KEY, NUWORQ_LLM_PROXY_ACCESS_ID: 'id.access', NUWORQ_LLM_PROXY_ACCESS_SECRET: 'cf-secret-do-not-leak' };
  const leaks = (out) => [TOKEN, KEY, 'id.access', 'cf-secret-do-not-leak'].filter((s) => out.includes(s));

  test("claude: --proxy points Claude Code at llm-proxy's Anthropic route with the owner token, expanded by the shell", async () => {
    const out = await workerCmd('claude', { home: freshHome(), vars, extra: ['--proxy', 'http://studio.local:4100/'] });
    assert.match(out, /ANTHROPIC_BASE_URL='http:\/\/studio\.local:4100\/anthropic' ANTHROPIC_AUTH_TOKEN="\$NUWORQ_LLM_PROXY_TOKEN" \\\n\s+ANTHROPIC_CUSTOM_HEADERS='x-client-name: nuworq\/lab\/w-1' \\\n\s+claude -p/);
    assert.deepEqual(leaks(out), [], 'no secret is printed or in argv');
    assert.doesNotMatch(out, /CF-Access|NUWORQ_LLM_PROXY_KEY/, "workers use the LAN address: no Access token, and not the hub's read key");
    const assign = out.match(/(ANTHROPIC_BASE_URL=.*?) \\\n\s+ANTHROPIC_CUSTOM_HEADERS/s)[1];
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${assign}; export ANTHROPIC_AUTH_TOKEN; printf %s "$ANTHROPIC_AUTH_TOKEN"`], { env: { NUWORQ_LLM_PROXY_TOKEN: 't' } });
    assert.equal(stdout, 't', 'the shell hands Claude Code the token');
    const fromEnv = await workerCmd('claude', { home: freshHome(), vars: { NUWORQ_LLM_PROXY_URL: 'http://studio.local:4100/v1' }, extra: ['--proxy'] });
    assert.match(fromEnv, /ANTHROPIC_BASE_URL='http:\/\/studio\.local:4100\/anthropic'/, '--proxy alone takes NUWORQ_LLM_PROXY_URL');
    assert.doesNotMatch(await workerCmd('claude', { home: freshHome(), vars }), /ANTHROPIC_BASE_URL/, 'without --proxy nothing changes');
  });

  test("codex: --proxy gives Codex a provider at llm-proxy's OpenAI route (Responses), keyed by the owner token", async () => {
    const out = await workerCmd('codex', { home: freshHome(), vars, extra: ['--proxy', 'http://studio.local:4100'] });
    assert.ok(out.includes(`-c 'model_provider="llmproxy"'`), out);
    assert.ok(out.includes(`-c 'model_providers.llmproxy={name="llm-proxy",base_url="http://studio.local:4100/openai/v1",env_key="NUWORQ_LLM_PROXY_TOKEN",wire_api="responses",http_headers={"x-client-name"="nuworq/lab/w-1"}}'`), out);
    assert.deepEqual(leaks(out), []);
    assert.doesNotMatch(await workerCmd('codex', { home: freshHome(), vars }), /llmproxy/, 'without --proxy nothing changes');
  });

  test('opencode keeps its personal key on /v1, and no Access headers', async () => {
    const out = await workerCmd('opencode', { home: freshHome(), vars, extra: ['--model', 'proxy/gpt-5', '--proxy', 'https://llm.example.com'] });
    assert.deepEqual(config(out).provider.proxy.options.headers, { 'x-client-name': 'nuworq/lab/w-1' });
    assert.deepEqual(leaks(out), []);
  });

  test('a missing address, or a model the agent cannot take, says what is wrong', async () => {
    assert.match((await fails('opencode', { home: freshHome(), extra: ['--model', 'proxy/gpt-5'] })).stderr, /needs llm-proxy's address/);
    assert.match((await fails('opencode', { home: freshHome(), extra: ['--model', 'ollama/qwen3:8b', '--proxy', 'http://x:1'] })).stderr, /--proxy needs a proxy\/<model> model/);
    assert.match((await fails('claude', { home: freshHome(), extra: ['--proxy'] })).stderr, /--proxy needs llm-proxy's address/);
    assert.match((await fails('claude', { home: freshHome(), extra: ['--model', 'proxy/gpt-5', '--proxy', 'http://x:1'] })).stderr, /doesn't take a proxy\/<model> model/);
    const codex = await fails('codex', { home: freshHome(), extra: ['--proxy'] });
    assert.match(codex.stderr, /--proxy needs llm-proxy's address[\s\S]*LAN or tailnet[\s\S]*NUWORQ_LLM_PROXY_TOKEN/);
    assert.equal(codex.stdout, '', 'no command printed');
  });

  test("NUWORQ_LLM_PROXY_URL alone (set for serve) doesn't change other workers", async () => {
    const vars = { NUWORQ_LLM_PROXY_URL: 'http://studio.local:8080', NUWORQ_LLM_PROXY_KEY: KEY };
    assert.match(await workerCmd('claude', { home: freshHome(), vars }), /claude -p/);
    assert.deepEqual(config(await workerCmd('opencode', { home: freshHome(), vars, extra: ['--model', 'ollama/qwen3:8b'] })).provider.ollama.options.headers, { 'x-client-name': 'nuworq/lab/w-1' });
  });
});
