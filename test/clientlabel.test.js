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
import { workerEnv, harnessKeys, namedEnv, CLAUDE_SCRUBS } from '../src/runtrust.js';
import { serviceEnv } from '../src/service.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// The command a worker would run (without --run), with a home of its own.
async function workerCmd(agent, { home, extra = [], vars = {} }) {
  const hub = new Hub();
  hub.tx(() => hub.project('lab', { create: true }));
  const server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_|^ANTHROPIC_CUSTOM_HEADERS$/.test(k))), HOME: home, ...vars };
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'lab', '--agent', agent, '--as', 'w-1', ...(agent === 'claude' ? [] : ['--can-read-keys']), ...extra], { env, cwd: home });
    return stdout;
  } finally { server.close(); }
}
const freshHome = () => mkdtempSync(join(tmpdir(), 'nuworq-label-'));

describe('workers label their model traffic nuworq/<project>/<agent>', () => {
  test('claude: ANTHROPIC_CUSTOM_HEADERS carries x-client-name', async () => {
    const out = await workerCmd('claude', { home: freshHome() });
    assert.match(out, /ANTHROPIC_CUSTOM_HEADERS="\$\{ANTHROPIC_CUSTOM_HEADERS:\+\$ANTHROPIC_CUSTOM_HEADERS\n\}"'x-client-name: nuworq\/lab\/w-1' \\\n\s+claude -p/);
  });

  // The runner's headers may carry llm-proxy's x-proxy-token: the shell expands them, so they're never in argv or printed (#493).
  test("claude: the runner's own headers reach Claude Code without their values in the command", async () => {
    const home = freshHome();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf %s "$ANTHROPIC_CUSTOM_HEADERS"\n', { mode: 0o755 });
    const out = await workerCmd('claude', { home, vars: { ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-token: secret' } });
    assert.ok(!out.includes('secret'), out);
    const start = out.match(/^cd '[\s\S]*?--allowedTools '[^']*'$/m)[0];
    const run = (env) => promisify(execFile)('/bin/sh', ['-c', start], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env } }).then((r) => r.stdout);
    assert.equal(await run({ ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-token: secret' }), 'x-proxy-token: secret\nx-client-name: nuworq/lab/w-1');
    assert.equal(await run({}), 'x-client-name: nuworq/lab/w-1', 'without the runner\'s headers, only the label');
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
    assert.match(out, /export ANTHROPIC_BASE_URL='http:\/\/studio\.local:4100\/anthropic' ANTHROPIC_AUTH_TOKEN="\$NUWORQ_LLM_PROXY_TOKEN" && \\\nunset NUWORQ_LLM_PROXY_TOKEN && \\\nCLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 ANTHROPIC_CUSTOM_HEADERS="[^"]*"'x-client-name: nuworq\/lab\/w-1' \\\n\s+claude -p/);
    assert.deepEqual(leaks(out), [], 'no secret is printed or in argv');
    assert.doesNotMatch(out, /CF-Access|NUWORQ_LLM_PROXY_KEY/, "workers use the LAN address: no Access token, and not the hub's read key");
    const assign = out.match(/(export ANTHROPIC_BASE_URL=.*?unset NUWORQ_LLM_PROXY_TOKEN)/s)[1];
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', `${assign} && printf %s "$ANTHROPIC_AUTH_TOKEN:\${NUWORQ_LLM_PROXY_TOKEN-gone}"`], { env: { NUWORQ_LLM_PROXY_TOKEN: 't' } });
    assert.equal(stdout, 't:gone', 'the shell hands Claude Code the token, under the one name it scrubs');
    const fromEnv = await workerCmd('claude', { home: freshHome(), vars: { NUWORQ_LLM_PROXY_URL: 'http://studio.local:4100/v1' }, extra: ['--proxy'] });
    assert.match(fromEnv, /ANTHROPIC_BASE_URL='http:\/\/studio\.local:4100\/anthropic'/, '--proxy alone takes NUWORQ_LLM_PROXY_URL');
    const direct = await workerCmd('claude', { home: freshHome(), vars });
    assert.doesNotMatch(direct, /ANTHROPIC_BASE_URL/, 'without --proxy nothing changes');
    // #678: tool definitions load when first used, as said on the line (a runner started with it set keeps its value);
    // through llm-proxy Claude Code's own default (off) stands.
    assert.match(direct, /ENABLE_TOOL_SEARCH="\$\{ENABLE_TOOL_SEARCH:-true\}" CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1/);
    assert.doesNotMatch(out, /ENABLE_TOOL_SEARCH/);
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

  test('claude and codex refuse a public llm-proxy hostname: provider routes need the LAN or tailnet address', async () => {
    for (const agent of ['claude', 'codex']) {
      const e = await fails(agent, { home: freshHome(), vars, extra: ['--proxy', 'https://llm.example.com'] });
      assert.match(e.stderr, /https:\/\/llm\.example\.com is a public address[\s\S]*LAN or tailnet address/, agent);
      assert.equal(e.stdout, '', 'no command printed');
      const fromEnv = await fails(agent, { home: freshHome(), vars: { ...vars, NUWORQ_LLM_PROXY_URL: 'https://llm.example.com/v1' }, extra: ['--proxy'] });
      assert.match(fromEnv.stderr, /is a public address/, `${agent}: NUWORQ_LLM_PROXY_URL is checked the same way`);
    }
    for (const url of ['http://studio:4100', 'http://studio.local:4100', 'http://studio.tail1234.ts.net:4100', 'http://100.101.5.6:4100', 'http://192.168.1.20:4100', 'http://10.0.0.5:4100', 'http://127.0.0.1:4100', 'http://[::1]:4100', 'http://[fd7a:115c::1]:4100']) {
      assert.match(await workerCmd('codex', { home: freshHome(), vars, extra: ['--proxy', url] }), /model_provider="llmproxy"/, url);
    }
    for (const url of ['http://8.8.8.8:4100', 'http://100.200.1.1:4100', 'http://172.32.0.1:4100']) {
      assert.match((await fails('claude', { home: freshHome(), vars, extra: ['--proxy', url] })).stderr, /is a public address/, url);
    }
  });

  test("NUWORQ_LLM_PROXY_URL alone (set for serve) doesn't change other workers", async () => {
    const vars = { NUWORQ_LLM_PROXY_URL: 'http://studio.local:8080', NUWORQ_LLM_PROXY_KEY: KEY };
    assert.match(await workerCmd('claude', { home: freshHome(), vars }), /claude -p/);
    assert.deepEqual(config(await workerCmd('opencode', { home: freshHome(), vars, extra: ['--model', 'ollama/qwen3:8b'] })).provider.ollama.options.headers, { 'x-client-name': 'nuworq/lab/w-1' });
  });
});

// A worker's agent starts on an allowlisted environment, and its harness keeps its own model key from its shell (#616).
describe("a worker's shell sees no credential variables", () => {
  const SECRETS = {
    AWS_ACCESS_KEY_ID: 'AKIA-do-not-leak', AWS_SECRET_ACCESS_KEY: 'aws-do-not-leak', OPENAI_API_KEY: 'sk-openai-do-not-leak', ANTHROPIC_API_KEY: 'sk-ant-do-not-leak',
    NUWORQ_LLM_PROXY_TOKEN: 'owner-do-not-leak', NUWORQ_LLM_PROXY_KEY: 'proxy-key-do-not-leak', NUWORQ_LLM_PROXY_ACCESS_SECRET: 'cf-do-not-leak',
    NUWORQ_TOKEN: 'nwq_human12345', NUWORQ_TOKEN_FILE: '/home/me/.nuworq/runner.token', GITHUB_TOKEN: 'gh-do-not-leak', NPM_TOKEN: 'npm-do-not-leak',
    STRIPE_SECRET_KEY: 'stripe-do-not-leak', SSH_AUTH_SOCK: '/tmp/agent.sock', ANTHROPIC_CUSTOM_HEADERS: 'x-proxy-token: hdr-do-not-leak',
  };
  const credential = (k) => /KEY|TOKEN|SECRET|PASS|SSH_AUTH|CUSTOM_HEADERS/.test(k);
  // The environment its shell gets, from the command a worker runs, started the way a runner starts it.
  async function shellEnv(agent, fake, { opts = {}, extra = [] } = {}) {
    const home = freshHome();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, agent), fake, { mode: 0o755 });
    const out = await workerCmd(agent, { home, extra });
    const start = out.match(agent === 'claude' ? /^cd '[\s\S]*?--allowedTools '[^']*'$/m : /^cd '[\s\S]*?sign off\.'$/m)[0];
    const { secret, config } = harnessKeys(agent, opts);
    const env = workerEnv([...secret, ...config], { PATH: `${bin}:/usr/bin:/bin`, HOME: home, LANG: 'en_US.UTF-8', ...SECRETS, NUWORQ_LLM_PROXY_URL: 'http://studio.local:4100' });
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', start], { env });
    const [harness, ...lines] = stdout.trim().split('\n');
    return { harness, shell: Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) };
  }
  const clean = (shell) => {
    assert.deepEqual(Object.keys(shell).filter(credential), [], 'no credential by name');
    assert.deepEqual(Object.values(SECRETS).filter((v) => Object.values(shell).some((x) => x.includes(v))), [], 'no credential by value');
    assert.ok(shell.PATH && shell.HOME && shell.LANG, 'what a shell needs is there');
  };

  test('claude: only what Claude Code reaches its model with, which it scrubs from its shell', async () => {
    // Claude Code with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1: its Bash tool starts without those names.
    const fake = `#!/bin/sh\n[ "$CLAUDE_CODE_SUBPROCESS_ENV_SCRUB" = 1 ] || { echo 'not scrubbed'; exit 1; }\nprintf 'harness:%s\\n' "$ANTHROPIC_AUTH_TOKEN"\nexec env ${CLAUDE_SCRUBS.map((k) => `-u ${k}`).join(' ')} env\n`;
    const proxied = await shellEnv('claude', fake, { opts: { proxy: true }, extra: ['--proxy', 'http://studio.local:4100'] });
    assert.equal(proxied.harness, 'harness:owner-do-not-leak', "Claude Code gets llm-proxy's owner token");
    clean(proxied.shell);
    clean((await shellEnv('claude', fake)).shell);
  });

  test("codex: its key reaches Codex, and its shell policy leaves it out", async () => {
    // Codex's shell: its environment minus shell_environment_policy.exclude, whatever its default excludes are.
    const fake = `#!/bin/sh\nex=''; ok=''\nfor a; do case "$a" in shell_environment_policy.exclude=*) ex=$(printf %s "\${a#*=}" | tr -d '[]"' | tr , ' ');; shell_environment_policy.ignore_default_excludes=false) ok=1;; esac; done\n[ -n "$ok" ] || { echo 'default excludes off'; exit 1; }\nprintf 'harness:%s\\n' "$NUWORQ_LLM_PROXY_TOKEN"\nexec env $(for k in $ex; do printf -- '-u %s ' "$k"; done) env\n`;
    const proxied = await shellEnv('codex', fake, { opts: { proxy: true }, extra: ['--proxy', 'http://studio.local:4100'] });
    assert.equal(proxied.harness, 'harness:owner-do-not-leak', "Codex gets llm-proxy's owner token");
    clean(proxied.shell);
    clean((await shellEnv('codex', fake)).shell);
  });

  test('opencode and pi (no sandbox, #615): their one model key, and no other credential', () => {
    const keys = (agent, model) => { const { secret, config } = harnessKeys(agent, { model }); return [...secret, ...config]; };
    const creds = (env) => Object.keys(env).filter(credential);
    assert.deepEqual(creds(workerEnv(keys('pi', 'anthropic/claude-sonnet-5-5'), SECRETS)), ['ANTHROPIC_API_KEY']);
    assert.deepEqual(creds(workerEnv(keys('opencode', 'proxy/gpt-5'), SECRETS)), ['NUWORQ_LLM_PROXY_KEY']);
    assert.deepEqual(creds(workerEnv(keys('pi', 'ollama/qwen3:8b'), SECRETS)), []);
  });

  // The XDG dirs are exactly where credentials pile up (#891): a person's non-default config or data dir would
  // move that pile outside the sandbox's ~/.config and ~/.local/share denies, so neither reaches the worker.
  // The cache and cargo homes joined them (#899): a non-default dir moves huggingface's token out of ~/.cache
  // and cargo's credentials out of ~/.cargo.
  test("the person's XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME and CARGO_HOME don't reach the worker (#891, #899)", () => {
    const env = workerEnv([], { PATH: '/usr/bin:/bin', HOME: '/home/me', XDG_CONFIG_HOME: '/home/me/xdg-config', XDG_DATA_HOME: '/home/me/xdg-data', XDG_CACHE_HOME: '/home/me/xdg-cache', CARGO_HOME: '/home/me/cargo-home' });
    assert.equal(env.XDG_CONFIG_HOME, undefined);
    assert.equal(env.XDG_DATA_HOME, undefined);
    assert.equal(env.XDG_CACHE_HOME, undefined);
    assert.equal(env.CARGO_HOME, undefined);
  });

  // The allowlist's addition point: a project whose build reads DOCKER_HOST or VIRTUAL_ENV names them.
  test('a worker gets a variable the person named, and still no credential variables', async () => {
    const PROJECT = { DOCKER_HOST: 'unix:///run/docker.sock', VIRTUAL_ENV: '/home/me/app/.venv', DATABASE_URL_TEST: 'postgres://localhost/test', JAVA_OPTS: '-Xmx2g' };
    const all = { PATH: '/usr/bin:/bin', HOME: '/home/me', ...SECRETS, ...PROJECT };
    const named = namedEnv(['DOCKER_HOST,VIRTUAL_ENV', 'JAVA_OPTS']);
    const { secret, config } = harnessKeys('claude');
    const env = workerEnv([...secret, ...config, ...named], all);
    assert.deepEqual([env.DOCKER_HOST, env.VIRTUAL_ENV, env.JAVA_OPTS], [PROJECT.DOCKER_HOST, PROJECT.VIRTUAL_ENV, PROJECT.JAVA_OPTS]);
    assert.equal(env.DATABASE_URL_TEST, undefined, 'only what was named');
    assert.deepEqual(Object.keys(env).filter((k) => credential(k) && !CLAUDE_SCRUBS.includes(k)), [], "no credential but the ones Claude Code scrubs from its shell");
    // A name that looks like a secret takes --env-secret, so passing one is a choice; and only names, never values.
    assert.throws(() => namedEnv('AWS_SECRET_ACCESS_KEY'), (e) => /looks like a secret, so --env doesn't pass it/.test(e.message) && /--env-secret AWS_SECRET_ACCESS_KEY/.test(e.hint));
    assert.throws(() => namedEnv('NPM_TOKEN,DOCKER_HOST'), /NPM_TOKEN looks like a secret/);
    assert.throws(() => namedEnv('DOCKER_HOST=tcp://x'), /--env takes variable names, not "DOCKER_HOST=tcp:\/\/x"/);
    assert.deepEqual(namedEnv(undefined, 'NPM_TOKEN'), ['NPM_TOKEN'], '--env-secret passes it');
    assert.equal(workerEnv(namedEnv(undefined, 'NPM_TOKEN'), all).NPM_TOKEN, SECRETS.NPM_TOKEN);
    assert.equal(workerEnv(namedEnv(undefined, 'NUWORQ_TOKEN'), all).NUWORQ_TOKEN, undefined, "a nuworq token's value never goes, named or not");
    // An installed runner keeps the named values in its service, and only those.
    const svc = serviceEnv(all, { names: named });
    assert.deepEqual(Object.keys(svc).filter((k) => k in PROJECT), ['DOCKER_HOST', 'JAVA_OPTS', 'VIRTUAL_ENV']);
  });

  test('the CLI refuses an --env name it won\'t pass, before anything starts, and --env-secret with --install', async () => {
    const home = freshHome();
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, ...a], { env: { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: 'http://127.0.0.1:9' } }).catch((e) => e);
    for (const cmd of ['run', 'worker']) {
      const r = await cli(cmd, '--env', 'GITHUB_TOKEN');
      assert.notEqual(r.code ?? 0, 0, cmd);
      assert.match(r.stderr, /GITHUB_TOKEN looks like a secret, so --env doesn't pass it/, cmd);
    }
    const r = await cli('run', '--install', '--env-secret', 'NPM_TOKEN');
    assert.match(r.stderr, /--env-secret isn't kept by an installed runner/);
  });
});
