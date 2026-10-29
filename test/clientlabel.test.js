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

describe('workers route through llm-proxy with --model proxy/<model>', () => {
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

  test('claude and codex are refused before anything starts, naming the Chat Completions limit', async () => {
    for (const agent of ['claude', 'codex']) {
      const e = await fails(agent, { home: freshHome(), extra: ['--proxy', 'http://studio.local:8080'] });
      assert.notEqual(e.code, 0);
      assert.match(e.stderr, /can't go through llm-proxy[\s\S]*Chat Completions only/);
      assert.equal(e.stdout, '', 'no command printed');
    }
  });

  test('proxy/<model> without an address, or --proxy without proxy/<model>, says what is missing', async () => {
    assert.match((await fails('opencode', { home: freshHome(), extra: ['--model', 'proxy/gpt-5'] })).stderr, /needs llm-proxy's address/);
    assert.match((await fails('opencode', { home: freshHome(), extra: ['--model', 'ollama/qwen3:8b', '--proxy', 'http://x:1'] })).stderr, /--proxy needs a proxy\/<model> model/);
  });

  test("NUWORQ_LLM_PROXY_URL alone (set for serve) doesn't change other workers", async () => {
    const vars = { NUWORQ_LLM_PROXY_URL: 'http://studio.local:8080', NUWORQ_LLM_PROXY_KEY: KEY };
    assert.match(await workerCmd('claude', { home: freshHome(), vars }), /claude -p/);
    assert.deepEqual(config(await workerCmd('opencode', { home: freshHome(), vars, extra: ['--model', 'ollama/qwen3:8b'] })).provider.ollama.options.headers, { 'x-client-name': 'nuworq/lab/w-1' });
  });
});
