import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub, normRemote } from '../src/core.js';
import { createServer } from '../src/server.js';
import { plan, run } from '../src/runner.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
// A worker's --settings, shell-quoted: a ' in its rules (#796) is written '\''.
const SETTINGS = /--settings '((?:[^']|'\\'')*)'/;
const settingsOf = (stdout) => JSON.parse(stdout.match(SETTINGS)[1].replaceAll("'\\''", "'"));

const route = (project, claimable, holders = []) => ({ project, name: project, item: '#1', title: 't', mode: 'work', claimable, holders });

describe('plan: which workers to start', () => {
  test('fills free slots, in value order, up to what is claimable', () => {
    assert.deepEqual(plan([route('a', 2), route('b', 5)], [], { workers: 3 }).map((r) => r.project), ['a', 'a', 'b']);
    assert.deepEqual(plan([route('a', 2)], [{ name: 'w1', project: 'b' }], { workers: 2 }).map((r) => r.project), ['a']);
  });

  test('no herd: workers that hold nothing yet count against the claimable work', () => {
    assert.equal(plan([route('a', 1)], [], { workers: 3 }).length, 1);
    assert.equal(plan([route('a', 1)], [{ name: 'w1', project: 'a' }], { workers: 3 }).length, 0);
    // once w1 holds an item, what is still claimable is free for others
    assert.equal(plan([route('a', 1, ['w1'])], [{ name: 'w1', project: 'a' }], { workers: 3 }).length, 1);
  });

  test('never more than --workers at once, nor more than --max-runs in total', () => {
    assert.equal(plan([route('a', 9)], [{ name: 'w', project: 'x' }, { name: 'v', project: 'x' }], { workers: 2 }).length, 0);
    assert.equal(plan([route('a', 9)], [], { workers: 5, maxRuns: 3, launched: 2 }).length, 1);
    assert.equal(plan([route('a', 9)], [], { workers: 5, maxRuns: 3, launched: 3 }).length, 0);
  });
});

describe('the hub routes the runner only to opted-in, unparked projects', () => {
  test('runner flag round-trips through settings, records an event, and filters routes', () => {
    const hub = new Hub({ clock: () => Date.UTC(2026, 9, 1, 9) });
    for (const s of ['on', 'off', 'parked']) {
      hub.tx(() => hub.project(s, { create: true }));
      hub.humanOp(s, 'create', { title: 'One', acceptance: 'x' });
      hub.humanOp(s, 'create', { title: 'Two', acceptance: 'x' });
    }
    hub.humanOp('on', 'settings', { runner: true });
    hub.humanOp('parked', 'settings', { runner: true, parked: true });
    assert.equal(hub.project('on').runner, 1);
    assert.equal(hub.project('off').runner, 0);
    assert.ok(hub.q("SELECT 1 FROM events WHERE type = 'runner'").get());

    const r = hub.route('', { runner: true });
    assert.deepEqual(r.map((x) => [x.project, x.claimable, x.holders]), [['on', 2, []]]);
    hub.agentOp('on', 'next', 'w1');
    assert.deepEqual(hub.route('', { runner: true }).map((x) => [x.claimable, x.holders]), [[1, ['w1']]]);
    assert.equal(hub.route().length, 2, 'ordinary routing still sees every unparked project');

    hub.humanOp('on', 'settings', { runner: false });
    assert.deepEqual(hub.route('', { runner: true }), []);
  });
});

describe('nuworq worker --agent opencode', () => {
  test('prints an opencode run with nuworq MCP and Ollama in the environment, nothing written to the repo', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-oc-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'f'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    const hub = new Hub();
    hub.tx(() => hub.project('oc', { create: true }));
    hub.humanOp('oc', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'oc', '--agent', 'opencode', '--can-read-keys', ...a], { env: { ...process.env, NUWORQ_TOKEN: '' } });
    try {
      const { stdout } = await cli('--model', 'ollama/qwen3:8b', '--as', 'oc-1');
      // Its own worktree, detached at main (reused if it exists); each item it claims gets a branch from the latest main.
      const add = stdout.match(/^\{ \[ -d '[^']*\.worktrees\/oc-1' \] \|\| git -C '[^']*' worktree add -q --detach '[^']*\.worktrees\/oc-1' 'main'; \}/m)?.[0];
      assert.ok(add, 'the worktree is added detached at main');
      execFileSync('/bin/sh', ['-c', add]);
      execFileSync('/bin/sh', ['-c', add]); // a second time: reused, not an error
      const wt = `${repo}.worktrees/oc-1`;
      const at = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      assert.equal(at('rev-parse', 'HEAD'), execFileSync('git', ['-C', repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim());
      assert.throws(() => at('symbolic-ref', '-q', 'HEAD'), 'detached: no branch until it claims an item');
      execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
      assert.match(stdout, /opencode run -m 'ollama\/qwen3:8b' '.*git switch -c <branch> main`, or `git switch <branch>` if it exists.*Never work in the main checkout.*' < \/dev\/null/);
      const config = JSON.parse(stdout.match(/OPENCODE_CONFIG_CONTENT='([^']*)'/)[1]);
      assert.deepEqual(config.mcp.nuworq.command, ['node', BIN, 'mcp']);
      assert.equal(config.mcp.nuworq.environment.NUWORQ_PROJECT, 'oc');
      assert.equal(config.mcp.nuworq.environment.NUWORQ_AGENT, 'oc-1');
      assert.ok(config.provider.ollama.models['qwen3:8b']);
      assert.equal(config.permission.bash['git push*'], 'deny');
      assert.deepEqual(readdirSync(repo).sort(), ['.git', 'f'], 'no config file left in the repo');

      await assert.rejects(cli(), (e) => /opencode needs a model/.test(e.stderr));
      // With somewhere to push, it isn't started (#472): opencode has no sandbox for its shell.
      g('remote', 'add', 'origin', 'https://github.com/acme/oc.git');
      await assert.rejects(cli('--model', 'ollama/qwen3:8b', '--as', 'oc-2'), (e) => /opencode workers aren't started for oc: it has a remote, and opencode has no sandbox/.test(e.stderr) && /--agent claude/.test(e.stderr));
    } finally {
      server.close();
    }
  });
});

describe('nuworq worker --agent pi', () => {
  test('prints a pi -p run whose config is a folder of its own (nuworq MCP, the model\'s provider), nothing in the repo', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pi-')));
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pi-home-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'f'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    const hub = new Hub();
    hub.tx(() => hub.project('pp', { create: true }));
    hub.humanOp('pp', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, HOME: home, NUWORQ_TOKEN: '', NUWORQ_LLM_PROXY_KEY: 'llmp_secret' };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'pp', '--agent', 'pi', '--can-read-keys', ...a], { env });
    try {
      const { stdout } = await cli('--model', 'ollama/qwen3:8b', '--as', 'pi-1');
      const dir = join(home, '.nuworq', 'pi', 'pi-1');
      const guard = fileURLToPath(new URL('../src/piguard.js', import.meta.url));
      assert.ok(stdout.includes(`PI_CODING_AGENT_DIR='${dir}' \\\n  pi -p --model 'ollama/qwen3:8b' --no-session --no-approve \\\n  --no-extensions -e builtin:mcp -e '${guard}' --no-skills --no-prompt-templates --no-themes \\\n  -- 'Work on`), stdout);
      assert.match(stdout, /git switch -c <branch> main`, or `git switch <branch>` if it exists.*Never work in the main checkout.*' < \/dev\/null/);
      assert.match(stdout, /pi has no sandbox, so it runs only on projects without a remote/);
      // Its folder holds only what nuworq wrote: no extensions, skills, sign-ins or AGENTS.md of the person's.
      assert.deepEqual(readdirSync(dir).sort(), ['mcp.json', 'models.json']);
      const mcp = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).mcpServers.nuworq;
      assert.deepEqual([mcp.command, mcp.args, mcp.exposure], ['node', [BIN, 'mcp'], 'direct']);
      assert.equal(mcp.env.NUWORQ_PROJECT, 'pp');
      assert.equal(mcp.env.NUWORQ_AGENT, 'pi-1');
      assert.equal(mcp.env.NUWORQ_MODEL, 'qwen3:8b');
      assert.equal(mcp.env.NUWORQ_CLIENT, 'pi', 'it checks in as pi, whatever client the model names');
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')).providers.ollama,
        { baseUrl: 'http://localhost:11434/v1', api: 'openai-completions', apiKey: 'ollama', headers: { 'x-client-name': 'nuworq/pp/pi-1' }, models: [{ id: 'qwen3:8b' }] });
      assert.deepEqual(readdirSync(repo).sort(), ['.git', 'f'], 'no config file left in the repo');

      // A built-in provider only gets the header; llm-proxy is a provider of its own, keyed from the environment.
      await cli('--model', 'anthropic/claude-sonnet-5-5', '--as', 'pi-2');
      assert.deepEqual(JSON.parse(readFileSync(join(home, '.nuworq', 'pi', 'pi-2', 'models.json'), 'utf8')).providers, { anthropic: { headers: { 'x-client-name': 'nuworq/pp/pi-2' } } });
      await cli('--model', 'proxy/gpt-5', '--proxy', 'http://studio.local:8080/', '--as', 'pi-3');
      const proxy = readFileSync(join(home, '.nuworq', 'pi', 'pi-3', 'models.json'), 'utf8');
      assert.deepEqual(JSON.parse(proxy).providers.proxy, { name: 'llm-proxy', baseUrl: 'http://studio.local:8080/v1', api: 'openai-completions', apiKey: '$NUWORQ_LLM_PROXY_KEY', headers: { 'x-client-name': 'nuworq/pp/pi-3' }, models: [{ id: 'gpt-5' }] });
      assert.ok(!proxy.includes('llmp_secret'), 'the key stays in the environment');

      await assert.rejects(cli(), (e) => /pi needs a model: --model <provider>\/<model>/.test(e.stderr));
      await assert.rejects(cli('--model', 'ollama/qwen3:8b', '--proxy', 'http://x:1'), (e) => /--proxy needs a proxy\/<model> model/.test(e.stderr));
      // With somewhere to push, it isn't started (#472): pi has no sandbox for its shell.
      g('remote', 'add', 'origin', 'https://github.com/acme/pp.git');
      await assert.rejects(cli('--model', 'ollama/qwen3:8b', '--as', 'pi-4'), (e) => /pi workers aren't started for pp: it has a remote, and pi has no sandbox/.test(e.stderr) && /--agent claude/.test(e.stderr));
    } finally {
      server.close();
    }
  });

  test("nuworq's pi extension blocks git push in pi's bash tool, and nothing else", async () => {
    const { default: guard, blocked } = await import('../src/piguard.js');
    let handler;
    guard({ on: (event, fn) => { assert.equal(event, 'tool_call'); handler = fn; } });
    for (const command of ['git push origin HEAD:main', 'git -C /x push', 'cd a && git push --force']) {
      assert.equal(handler({ toolName: 'bash', input: { command } })?.block, true, command);
    }
    for (const [toolName, command] of [['bash', 'git status'], ['bash', 'git commit -m "push the button"'], ['bash', 'npm test'], ['read', 'git push']]) {
      assert.equal(blocked(toolName, { command }), undefined, `${toolName}: ${command}`);
    }
  });
});

describe('nuworq worker --agent claude', () => {
  test('may land (rebase, fast-forward this one main checkout) but not push or run other git -C commands', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-land-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    const hub = new Hub();
    hub.tx(() => hub.project('land', { create: true }));
    hub.humanOp('land', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'land', '--agent', 'claude', '--as', 'c-1'],
        { env: { ...process.env, NUWORQ_TOKEN: '' } });
      const allow = stdout.match(/--allowedTools '([^']*)'/)[1].split(',');
      assert.ok(allow.includes('Bash(git rebase:*)'));
      assert.ok(allow.includes(`Bash(git -C ${repo} merge --ff-only:*)`));
      assert.ok(allow.includes('Bash(git switch:*)'), 'it makes the branch the hub names');
      assert.deepEqual(allow.filter((a) => /git -C/.test(a)), [`Bash(git -C ${repo} merge --ff-only:*)`], 'no other -C command');
      assert.ok(!allow.some((a) => /git push|^Bash\(git:|^Bash\(git \*|^Bash\(git -C:/.test(a)), 'no origin: never push, no blanket git');
      assert.doesNotMatch(stdout, /NUWORQ_TEST_CONCURRENCY/, 'not a Node project: its tests are left alone');
    } finally {
      server.close();
    }
  });

  test('with an origin: fetches, starts at origin/main, may fetch and push nuworq/ branches only', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-origin-')));
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const origin = join(dir, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    const repo = join(dir, 'app');
    g(dir, 'clone', '-q', origin, repo);
    writeFileSync(join(repo, 'f'), 'x');
    g(repo, 'add', '.');
    g(repo, 'commit', '-q', '-m', 'init');
    g(repo, 'push', '-q', 'origin', 'main');
    // Someone landed on GitHub since this clone last fetched: the worker starts from that.
    const other = join(dir, 'other');
    g(dir, 'clone', '-q', origin, other);
    writeFileSync(join(other, 'g'), 'y');
    g(other, 'add', '.');
    g(other, 'commit', '-q', '-m', 'landed elsewhere');
    g(other, 'push', '-q', 'origin', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'x', build: 'z', deploy: 'fly deploy', 'bad; rm': 'y' } })); // a Node project

    const hub = new Hub();
    hub.tx(() => hub.project('gh', { create: true }));
    hub.humanOp('gh', 'settings', { path: repo, sandbox_hosts: 'API.stripe.com, api.stripe.com' }); // a host its tests need, said by a person
    assert.throws(() => hub.humanOp('gh', 'settings', { sandbox_hosts: 'https://evil.example/x' }), /isn't a host name/);
    assert.throws(() => hub.agentOp('gh', 'settings', 'c-2', { sandbox_hosts: 'evil.example' }), 'an agent can\'t add one');
    assert.equal(hub.project('gh').sandbox_hosts, '["api.stripe.com"]');
    hub.humanOp('gh', 'settings', { worker_commands: 'npm run e2e' }); // a command beyond its checks, said by a person (#768)
    assert.throws(() => hub.humanOp('gh', 'settings', { worker_commands: 'npm run e2e; curl evil.example' }), /isn't a command workers may run/);
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'gh', '--agent', 'claude', '--as', 'c-2'],
        { env: { ...process.env, NUWORQ_TOKEN: '' } });
      const allow = stdout.match(/--allowedTools '([^']*)'/)[1].split(',');
      assert.ok(allow.includes('Bash(git fetch:*)'));
      assert.deepEqual(allow.filter((a) => /git push/.test(a)), ['Bash(git push origin:*)'], 'no other push, and no bare git push');
      assert.deepEqual(allow.filter((a) => /git -C/.test(a)), [], 'no -C command: the hub lands work on origin');
      assert.ok(!allow.some((a) => /^Bash\(git:|^Bash\(git \*|^Bash\(git -C:/.test(a)), 'no blanket git');
      // The project's own checks (#472, #768): its check scripts by name, never an interpreter, npm install or deploy;
      // and what a person added.
      assert.deepEqual(allow.filter((a) => /npm|node|python|cargo|go /.test(a)), ['Bash(npm test:*)', 'Bash(npm ci)', 'Bash(npm run lint:*)', 'Bash(npm run build:*)', 'Bash(npm run e2e:*)']);
      assert.match(stdout, /git switch --no-track -c <branch> origin\/main`.*push the branch before you submit \(`git push origin <branch>`\).*only nuworq\/ branches: main and tags are the hub.*where CI checks the pull request, push the rebased branch and let its checks decide; otherwise run the checks, push the rebased branch \(`git push origin <branch> --force-with-lease`\), then submit; the hub puts it on main/);
      assert.doesNotMatch(stdout, /<branch>:main/);
      // Its shell runs in Claude Code's sandbox, from --settings so no file in the repository loosens it.
      const { sandbox, permissions } = settingsOf(stdout);
      // Its file tools say the same (test/sandbox.test.js): edits only in its worktree, never the keys the sandbox hides.
      assert.ok(!allow.some((a) => /^(Read|Edit|Write|Glob|Grep)/.test(a)), 'no file tool in --allowedTools: --settings scopes them');
      const wt = `${repo}.worktrees/c-2`;
      assert.deepEqual(permissions.allow, ['Read', 'Glob', 'Grep', `Edit(/${wt}/**)`]);
      for (const r of ['Read(~/.ssh/**)', 'Read(~/.nuworq/**)', 'Edit(~/.ssh/**)', `Edit(/${join(repo, '.git', 'hooks')}/**)`, `Edit(/${join(wt, '.git')})`]) assert.ok(permissions.deny.includes(r), r);
      assert.deepEqual({ ...sandbox, network: undefined, filesystem: undefined }, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false, network: undefined, filesystem: undefined });
      assert.deepEqual(sandbox.network, { allowedDomains: [`127.0.0.1:${server.address().port}`, 'github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', 'api.stripe.com'], strictAllowlist: true, allowLocalBinding: true });
      // Its worktree (the working directory) and temp, and of the checkout's .git only what its commits need: never
      // hooks or config, which an unsandboxed git there would run (test/sandbox.test.js).
      assert.ok(sandbox.filesystem.allowWrite.includes(join(repo, '.git', 'objects')) && sandbox.filesystem.allowWrite.includes(join(repo, '.git', 'worktrees', 'c-2')));
      assert.ok(!sandbox.filesystem.allowWrite.includes(join(repo, '.git')), 'not all of .git');
      for (const p of ['hooks', 'config']) assert.ok(sandbox.filesystem.denyWrite.includes(join(repo, '.git', p)), p);
      assert.ok(sandbox.filesystem.denyWrite.includes(join(`${repo}.worktrees`, 'c-2', '.git')), "its worktree's own .git file");
      for (const p of ['~/.ssh', '~/.nuworq', '~/.aws', '~/.config/gh', '~/.git-credentials']) assert.ok(sandbox.filesystem.denyRead.includes(p), p);
      assert.match(stdout, /^export NODE_USE_ENV_PROXY=1(?= && \\\n)/m, "Node's fetch goes through the sandbox's proxy too");
      assert.match(stdout, /detached at origin\/main/);
      assert.match(stdout, /run only the tests that cover what you change\. For the whole suite, follow the hint `next` gives: where CI checks the pull request, CI runs it; otherwise run it once, just before you submit/);
      // The test command its allowlist has, so it doesn't reach for node --test and stall (#789).
      assert.match(stdout, /Run tests with `npm test` \(one test: `npm test -- test\/<file>\.test\.js`\), or `npm run e2e`: the runner/);
      assert.match(stdout, /sandbox allows these, not `node --test`, which stalls on approval/);
      // Its test runs take 2 files at a time (or what the operator set), for every process the agent starts.
      const cap = stdout.match(/^export NUWORQ_TEST_CONCURRENCY=\S+(?= && \\\n)/m)?.[0];
      assert.ok(cap && stdout.indexOf(cap) < stdout.indexOf('claude -p'), stdout);
      const val = (env) => execFileSync('/bin/sh', ['-c', `${cap} && echo $NUWORQ_TEST_CONCURRENCY`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim();
      assert.equal(val({}), '2');
      assert.equal(val({ NUWORQ_TEST_CONCURRENCY: '4' }), '4');
      assert.doesNotMatch(stdout, /NODE_OPTIONS/, 'Node refuses --test-concurrency there');

      const setup = stdout.match(/^git -C '[^']*' -c credential\.helper= -c credential\.https:\/\/github\.com\.helper= -c '(?:[^']|'\\'')*' -c \S+ fetch -q origin && \\\n\{ \[ -d '[^']*\.worktrees\/c-2' \] \|\| git -C '[^']*' worktree add -q --detach '[^']*\.worktrees\/c-2' 'origin\/main'; \}/m)?.[0];
      assert.ok(setup, 'fetch first, then the worktree detached at origin/main');
      // It holds no item yet, so over HTTPS the fetch gets the project's read-only token; the person's own helpers are reset.
      // Every value in the helper is quoted (#477): git runs it through sh.
      assert.match(setup, /-c credential\.helper= -c credential\.https:\/\/github\.com\.helper= -c 'credential\.https:\/\/github\.com\.helper=!NUWORQ_URL='\\''http:\/\/127\.0\.0\.1:\d+'\\'' node '\\''[^']+'\\'' git-credential --project '\\''gh'\\'' --as '\\''c-2'\\''' -c credential\.https:\/\/github\.com\.useHttpPath=true fetch/);
      execFileSync('/bin/sh', ['-c', setup.replace(/ \\\n/g, ' ')]);
      assert.equal(g(wt, 'rev-parse', 'HEAD'), g(origin, 'rev-parse', 'main'), 'at the latest main on GitHub');
      assert.notEqual(g(repo, 'rev-parse', 'main'), g(origin, 'rev-parse', 'main'), 'not the stale local main');
      g(repo, 'worktree', 'remove', '--force', wt);
    } finally {
      server.close();
    }
  });
});

describe('nuworq worker --browser', () => {
  test('only with --browser: a headless Chrome through Playwright MCP (local pages only), mcp__playwright allowed, and the browser tag', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-ui-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(join(repo, 'package.json'), '{}');
    mkdirSync(join(repo, 'bin'));
    writeFileSync(join(repo, 'bin', 'nuworq.js'), ''); // nuworq itself: it looks at the UI with demo data
    const hub = new Hub();
    hub.tx(() => hub.project('ui', { create: true }));
    hub.humanOp('ui', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // A plugin installed for this checkout, with an MCP server of its own (#360).
    const config = mkdtempSync(join(tmpdir(), 'nuworq-claude-'));
    mkdirSync(join(config, 'plugins'));
    writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'nuworq@nuworq': [{ scope: 'local', projectPath: repo }], 'other@market': [{ scope: 'user' }] } }));
    // A home of its own, with the pinned Playwright MCP server already installed (#626): no network, and never the real ~/.nuworq.
    const home = mkdtempSync(join(tmpdir(), 'nuworq-ui-home-'));
    const lock = readFileSync(new URL('../src/browser/package-lock.json', import.meta.url));
    const mcpCli = join(home, '.nuworq', 'browser', createHash('sha256').update(lock).digest('hex').slice(0, 16), 'node_modules', '@playwright', 'mcp', 'cli.js');
    mkdirSync(dirname(mcpCli), { recursive: true });
    writeFileSync(mcpCli, '');
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'ui', '--as', 'b-1', ...a],
      { env: { ...process.env, HOME: home, NUWORQ_TOKEN: '', CLAUDE_CONFIG_DIR: config } });
    const parts = ({ stdout }) => ({
      strict: /--mcp-config '[^']*' --strict-mcp-config /.test(stdout),
      settings: settingsOf(stdout),
      noSkills: new RegExp(`${SETTINGS.source} --disable-slash-commands `).test(stdout),
      servers: JSON.parse(stdout.match(/--mcp-config '([^']*)'/)[1]).mcpServers,
      allow: stdout.match(/--allowedTools '([^']*)'/)[1].split(','),
      deny: stdout.match(/--disallowedTools '([^']*)'/)?.[1],
      task: stdout.match(/claude -p '((?:[^']|'\\'')*)'/)[1],
    });
    try {
      const plain = parts(await cli('--agent', 'claude'));
      assert.deepEqual(Object.keys(plain.servers), ['nuworq']);
      assert.ok(plain.strict, 'only the runner\'s MCP servers, none of the person\'s own');
      assert.deepEqual(plain.settings.enabledPlugins, { 'nuworq@nuworq': false, 'other@market': false }, 'every installed plugin off');
      assert.equal(plain.settings.sandbox.enabled, true);
      assert.deepEqual(plain.settings.sandbox.filesystem.allowWrite, [repo], 'no origin: it lands by fast-forwarding this checkout, so it may write there');
      for (const p of ['hooks', 'config']) assert.ok(plain.settings.sandbox.filesystem.denyWrite.includes(join(repo, '.git', p)), `all but its .git/${p}`);
      assert.ok(plain.settings.permissions.allow.includes(`Edit(/${repo}/**)`) && plain.settings.permissions.deny.includes(`Edit(/${join(repo, '.git', 'hooks')}/**)`), 'its file tools likewise');
      assert.ok(!plain.allow.some((a) => /^Bash\(node/.test(a)), 'no node to run anything with');
      assert.ok(plain.noSkills, 'no skills either: ~/.claude/skills holds nuworq-operator, and it isn\'t a plugin (#368)');
      assert.ok(!plain.allow.includes('mcp__playwright'));
      assert.ok(!(plain.servers.nuworq.env.NUWORQ_HAS ?? '').split(',').includes('browser'));
      assert.doesNotMatch(plain.task, /mcp__playwright|375px|serve --demo/);
      assert.equal(plain.deny, undefined);

      const b = parts(await cli('--agent', 'claude', '--browser'));
      assert.deepEqual(b.servers.playwright, {
        command: 'node',
        args: [mcpCli, '--headless', '--browser', 'chrome', '--isolated',
          '--allowed-origins', 'http://127.0.0.1:*;http://localhost:*', '--output-dir', join(tmpdir(), 'nuworq-browser', 'b-1')],
      });
      assert.deepEqual(Object.keys(b.servers), ['nuworq', 'playwright']);
      assert.ok(b.strict);
      const demo = 'Bash(node bin/nuworq.js serve --demo --port 0)';
      assert.deepEqual(b.allow.filter((a) => a !== demo), [...plain.allow, 'mcp__playwright'], 'the same allowlist, plus the browser');
      assert.ok(b.allow.includes(demo), 'and the one command that serves the demo hub to look at');
      assert.equal(b.deny, 'mcp__playwright__browser_run_code_unsafe', 'except its tool that runs any code in the server process');
      assert.ok(b.servers.nuworq.env.NUWORQ_HAS.split(',').includes('browser'), 'it declares browser, as --has browser would');
      assert.match(b.task, /`node bin\/nuworq\.js serve --demo --port 0` in the background/);
      assert.match(b.task, /desktop width and at 375px wide \(browser_resize\), in light and in dark/);
      assert.match(b.task, /document\.documentElement\.dataset\.theme = "dark" with browser_evaluate/, 'dark is checked by forcing the theme (#484)');
      assert.doesNotMatch(b.task, /light only|browser_emulate_media/);
      assert.match(b.task, /describe in your evidence what you saw/);
      const own = parts(await cli('--agent', 'claude', '--browser', '--allow', 'Read'));
      assert.deepEqual(own.allow, ['Read', 'mcp__playwright'], '--allow keeps its list');
      assert.deepEqual(Object.keys(own.settings.permissions), ['deny'], 'and gets the file denies, not the file allows');
      assert.ok(own.settings.permissions.deny.includes('Read(~/.ssh/**)'));

      await assert.rejects(cli('--agent', 'codex', '--can-read-keys', '--browser'), (e) => e.stderr.includes('--browser is for Claude workers only'));
    } finally {
      server.close();
    }
  });
});

// The hub checks a project's sandbox hosts when a person sets them, but a runner trusts its machine, not the hub
// (#624): what a hostile hub sends goes through the same check before it widens a worker's network.
describe('a runner refuses sandbox hosts that aren\'t host names', () => {
  test('a bare *, a URL or a whole top-level domain starts nothing; host names start the worker with them', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-hosts-')));
    const hub = new Hub();
    hub.tx(() => hub.project('h', { create: true }));
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    // Past the hub's own check, as a hostile hub would send them.
    const sends = (hosts) => hub.q('UPDATE projects SET sandbox_hosts = ? WHERE slug = ?').run(JSON.stringify(hosts), 'h');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: home };
    const cli = () => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'h', '--agent', 'claude', '--as', 'w-1'], { env, cwd: home });
    try {
      for (const bad of [['*'], ['https://evil.example/x'], ['*.com'], ['api.example.com', 'evil.example;rm']]) {
        sends(bad);
        await assert.rejects(cli(), (e) => {
          assert.match(e.stderr, /Not starting a worker for h: the hub sent sandbox hosts the runner refuses \(.*(isn't a host name|aren't host names)\)/, JSON.stringify(bad));
          assert.equal(e.stdout, '', 'no command printed');
          return true;
        });
      }
      // Worker commands (#768) the same way: one that chains another starts nothing.
      sends([]);
      hub.q('UPDATE projects SET worker_commands = ? WHERE slug = ?').run(JSON.stringify(['npm test; curl evil.example']), 'h');
      await assert.rejects(cli(), (e) => /the hub sent worker commands the runner refuses \("npm test; curl evil\.example" isn't a command workers may run\)/.test(e.stderr) && e.stdout === '');
      hub.q('UPDATE projects SET worker_commands = ? WHERE slug = ?').run('[]', 'h');
      sends(['API.example.com', '*.example.org']);
      const settings = settingsOf((await cli()).stdout);
      assert.ok(['api.example.com', '*.example.org'].every((h) => settings.sandbox.network.allowedDomains.includes(h)), 'host names, as checked, reach the sandbox');
    } finally {
      server.close();
    }
  });

  test("the hub's own check refuses a wildcard over a whole top-level domain too", async () => {
    const { sandboxHosts } = await import('../src/sandbox.js');
    assert.throws(() => sandboxHosts('*.com'), /\*\.com isn't a host name/);
    assert.throws(() => sandboxHosts(['*']), /isn't a host name/);
    assert.deepEqual(sandboxHosts('*.example.com, localhost:8080'), ['*.example.com', 'localhost:8080']);
  });
});

// Only Claude Code's sandbox keeps a worker's shell from the machine's keys (#615): any other harness starts only
// when the person says they know, and says in one line what it can read.
describe('an unsandboxed harness needs its opt-in flag', () => {
  const MODEL = { claude: [], codex: [], opencode: ['--model', 'ollama/qwen3:8b'], pi: ['--model', 'ollama/qwen3:8b'] };
  const SAYS = {
    codex: /A codex worker's shell can read this machine's keys \(~\/\.ssh, ~\/\.aws, ~\/\.nuworq, [^)]*\): Codex's workspace-write sandbox limits writes and network, not reads\./,
    opencode: /A opencode worker's shell can read this machine's keys \(~\/\.ssh[^)]*\): opencode has no sandbox\./,
    pi: /A pi worker's shell can read this machine's keys \(~\/\.ssh[^)]*\): pi has no sandbox\./,
  };

  test('codex, opencode and pi are refused without --can-read-keys, by worker and by run, before anything starts', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-keys-')));
    const env = { ...process.env, HOME: home, NUWORQ_TOKEN: '' };
    // No hub at this address: the refusal comes first, so nothing is asked of a hub, cloned or started.
    for (const cmd of ['worker', 'run']) {
      for (const agent of ['codex', 'opencode', 'pi']) {
        await assert.rejects(promisify(execFile)(process.execPath, [BIN, cmd, '--url', 'http://127.0.0.1:9', '--agent', agent, ...MODEL[agent]], { env, cwd: home }), (e) => {
          assert.match(e.stderr, new RegExp(`${agent} workers can read this machine's keys, so they start only with --can-read-keys`), `${cmd} ${agent}`);
          assert.match(e.stderr, SAYS[agent], `${cmd} ${agent}: what it can read`);
          assert.match(e.stderr, /--agent claude/);
          assert.equal(e.stdout, '', 'nothing printed to run');
          return true;
        });
      }
    }
  });

  test('with --can-read-keys, the command says in one line what it can read; a Claude worker needs no flag', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-keys-')));
    const hub = new Hub();
    hub.tx(() => hub.project('k', { create: true }));
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: home };
    const cli = (agent, ...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'k', '--agent', agent, '--as', `${agent}-1`, ...MODEL[agent], ...a], { env, cwd: home });
    try {
      for (const agent of ['codex', 'opencode', 'pi']) {
        const { stdout } = await cli(agent, '--can-read-keys');
        assert.equal(stdout.split('\n').filter((l) => SAYS[agent].test(l)).length, 1, `${agent}: one line\n${stdout}`);
      }
      assert.doesNotMatch((await cli('claude')).stdout, /can read this machine's keys/);
    } finally {
      server.close();
    }
  });

  // Codex's workspace-write sandbox limits writes and network, not reads (#768): like opencode and pi, it works only
  // where there's nothing to push to, until Codex can deny reads.
  test('codex is refused for a project with a remote, by worker and by run; without one it starts as before', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-codex-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'ignore' });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'f'), 'x');
    g('add', '.');
    g('commit', '-q', '-m', 'init');
    const hub = new Hub();
    hub.tx(() => hub.project('cx', { create: true }));
    hub.humanOp('cx', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))), HOME: repo };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'cx', '--agent', 'codex', '--can-read-keys', '--as', 'cx-1', ...a], { env, cwd: repo });
    try {
      assert.match((await cli()).stdout, /codex exec.* -s workspace-write/, 'no remote: unchanged');
      g('remote', 'add', 'origin', 'https://github.com/acme/cx.git');
      await assert.rejects(cli(), (e) => {
        assert.match(e.stderr, /codex workers aren't started for cx: it has a remote, and Codex's sandbox doesn't keep its shell from this machine's keys/);
        assert.match(e.stderr, /limits writes and network, not reads\), so it works only on projects without an origin\. Use --agent claude/);
        assert.equal(e.stdout, '', 'no command printed');
        return true;
      });
    } finally {
      server.close();
    }
  });
});

describe('workers on a hub that requires login', () => {
  test('get the agent token, never the human one; --run refuses without one', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-tok-')));
    const bin = join(dir, 'bin');
    execFileSync('mkdir', [bin]);
    // What ps would show (its arguments), whether any token is in its environment, and the token files' modes.
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "ARGS: $*"\necho "ENV TOKENS: $(env | grep -c nwq_)"\nls -l "$HOME/.nuworq/tokens"\n', { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('lock', { create: true }));
    hub.humanOp('lock', 'settings', { path: dir });
    const server = createServer(hub, { auth: 'required' });
    const human = server.auth.createToken('me', 'human');
    const agent = server.auth.createToken('box', 'agent', { projects: ['lock'] });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const home = mkdtempSync(join(tmpdir(), 'nuworq-tok-home-'));
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: human, NUWORQ_AGENT_TOKEN: '' };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'lock', '--here', '--as', 'w', ...a], { env, cwd: dir });
    try {
      const printed = (await cli()).stdout;
      assert.match(printed, /"NUWORQ_TOKEN":"<agent-token>"/);
      assert.ok(!printed.includes(human));

      await assert.rejects(cli('--run'), (e) => /workers need their own agent token/.test(e.stderr) && /--agent-token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', human), (e) => /is a human token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', 'nwq_not-a-real-token-at-all'), (e) => /refused the agent token/.test(e.stderr));

      // The agent token reaches the MCP server through a 0600 file (#477): never in argv (what ps shows) or the
      // agent's environment, and the person's own token not at all.
      const ran = (await cli('--run', '--agent-token', agent)).stdout;
      const file = join(home, '.nuworq', 'tokens', 'w.token');
      assert.match(ran, new RegExp(`ARGS: .*"NUWORQ_TOKEN_FILE":"${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
      // Its git's credential helper reads that file inside the sandbox, which denies the rest of ~/.nuworq (#472).
      // Up to the next flag: its deny rules hold spaces (#625).
      const { sandbox } = JSON.parse(ran.match(/--settings (\{.*?\}) --disable-slash-commands/)[1]);
      assert.ok(sandbox.filesystem.denyRead.includes('~/.nuworq'));
      assert.deepEqual(sandbox.filesystem.allowRead, [file], 'its own token file, nothing else of ~/.nuworq');
      assert.doesNotMatch(ran, /ARGS: .*nwq_/, 'no token in its arguments');
      assert.match(ran, /^ENV TOKENS: 0$/m, 'no token in its environment, not even the person\'s');
      assert.match(ran, /^-rw-------@? .* w\.token$/m, 'a file only this user reads');
      assert.ok(!ran.includes(agent) && !ran.includes(human));
      assert.ok(!existsSync(file), 'gone once the worker is');
    } finally {
      server.close();
    }
  });

  test("a machine connected with an agent token gives its workers a runner token minted from it, kept for the next start (#656)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-rtok-')));
    const bin = join(dir, 'bin');
    execFileSync('mkdir', [bin]);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho ran\n', { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('lock', { create: true }));
    hub.humanOp('lock', 'settings', { path: dir });
    const server = createServer(hub, { auth: 'required' });
    server.auth.addPerson('pat', 'member');
    const device = server.auth.createToken('pat@box', 'agent', { mintedBy: 'pat' }); // what nuworq connect saved
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const home = mkdtempSync(join(tmpdir(), 'nuworq-rtok-home-'));
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: device, NUWORQ_AGENT_TOKEN: '', NUWORQ_AGENT_TOKEN_FILE: '' };
    const cli = () => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'lock', '--here', '--as', 'w', '--run'], { env, cwd: dir });
    const runners = () => server.auth.listTokens().filter((t) => t.runner && !t.revoked_at);
    try {
      assert.match((await cli()).stdout, /carry the runner token pat@box\.runner/);
      const kept = readFileSync(join(home, '.nuworq', 'tokens', 'runner.token'), 'utf8').trim();
      assert.deepEqual([server.auth.verifyToken(kept).runner, runners().length], ['pat@box', 1]);
      assert.doesNotMatch((await cli()).stdout, /carry the runner token/, 'the next start uses the kept one');
      assert.deepEqual(runners().map((t) => t.name), ['pat@box.runner'], 'and mints no other');
    } finally {
      server.close();
    }
  });
});

describe('a worker started --here', () => {
  test('works in this folder even when the hub has another one on record', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-here-')));
    const hub = new Hub();
    hub.tx(() => hub.project('moved', { create: true }));
    hub.humanOp('moved', 'settings', { path: join(dir, 'gone') });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'moved', '--as', 'w', ...a], { env: { ...process.env, HOME: dir }, cwd: dir });
    try {
      await assert.rejects(cli(), (e) => /doesn't exist on this machine/.test(e.stderr) && /--here/.test(e.stderr));
      assert.match((await cli('--here')).stdout, new RegExp(`cd '${dir}'`));
    } finally {
      server.close();
    }
  });
});

describe('a worker for a project the hub knows only by remote (a hub on a server)', () => {
  test("works in this machine's checkout of that repository, not the one it started in; a folder that exists still wins", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-byremote-')));
    const clone = (name, origin) => {
      execFileSync('git', ['init', '-q', '-b', 'main', join(dir, name)]);
      execFileSync('git', ['-C', join(dir, name), 'remote', 'add', 'origin', origin]);
      return join(dir, name);
    };
    const a = clone('a', 'git@github.com:acme/a.git'), b = clone('b', 'git@github.com:acme/b.git');
    const hub = new Hub();
    for (const [slug, remote] of [['bee', 'github.com/acme/b'], ['gone', 'github.com/acme/nope'], ['pinned', 'github.com/acme/pinned']]) {
      hub.tx(() => hub.project(slug, { create: true }));
      hub.humanOp(slug, 'remote', { add: remote });
    }
    hub.humanOp('pinned', 'settings', { path: a });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = (project) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', project, '--agent', 'claude', '--as', 'w'],
      { env: { ...process.env, HOME: dir, NUWORQ_TOKEN: '', NUWORQ_REPOS: '' }, cwd: a });
    try {
      const bee = (await cli('bee')).stdout;
      assert.ok(new RegExp(`^git -C '${b}' -c .* fetch -q origin && `, 'm').test(bee) && bee.includes(`cd '${b}.worktrees/w'`), bee);
      assert.ok(!bee.includes(`'${a}`), 'nothing in the repo it started in');
      await assert.rejects(cli('gone'), (e) => e.stderr.includes('No checkout of github.com/acme/nope on this machine')
        && e.stderr.includes(`git clone git@github.com:acme/nope.git ${join(dir, 'nope')}`));
      assert.ok((await cli('pinned')).stdout.includes(`cd '${a}.worktrees/w'`), "the project's folder, since it exists here");
    } finally {
      server.close();
    }
  });
});

describe('a worker for a project with no checkout on this machine', () => {
  // A bare repo plays the project's repository; the hub knows it only by that remote.
  function far() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-clone-')));
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
    const origin = join(dir, 'github', 'api.git');
    g('init', '-q', '--bare', '-b', 'main', origin);
    g('clone', '-q', origin, join(dir, 'seed'));
    writeFileSync(join(dir, 'seed', 'README'), 'api\n');
    g('-C', join(dir, 'seed'), 'add', '.');
    g('-C', join(dir, 'seed'), 'commit', '-q', '-m', 'init');
    g('-C', join(dir, 'seed'), 'push', '-q', 'origin', 'main');
    const repos = join(dir, 'repos'), home = join(dir, 'home'), bin = join(dir, 'bin');
    for (const d of [repos, home, bin]) mkdirSync(d);
    // The person chose repos as where this machine's workers may work (#477).
    mkdirSync(join(home, '.nuworq'));
    writeFileSync(join(home, '.nuworq', 'folders.json'), JSON.stringify({ folders: [repos] }));
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "WORKING IN $(pwd)"\n', { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('far', { create: true }));
    hub.humanOp('far', 'remote', { add: origin });
    hub.humanOp('far', 'settings', { runner: true });
    hub.humanOp('far', 'create', { title: 'Do it', acceptance: 'done' });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: '', NUWORQ_AGENT_TOKEN: '', NUWORQ_REPOS: repos };
    return { dir, origin, repos, home, hub, env };
  }

  test('worker clones it into NUWORQ_REPOS, says so once, and works in a worktree of the clone', async () => {
    const w = far();
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const cli = () => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'far', '--agent', 'claude', '--as', 'w'], { env: w.env, cwd: w.home });
    try {
      const first = (await cli()).stdout;
      const clone = join(w.repos, 'api');
      assert.ok(first.includes(`Cloned ${normRemote(w.origin)} into ${clone}`), first);
      assert.ok(first.includes(`cd '${clone}.worktrees/w'`), first);
      assert.equal(normRemote(execFileSync('git', ['-C', clone, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()), normRemote(w.origin));
      const again = (await cli()).stdout;
      assert.ok(!again.includes('Cloned'), 'the clone is found the second time');
      assert.ok(again.includes(`cd '${clone}.worktrees/w'`));
    } finally {
      server.close();
    }
  });

  test('run clones it and launches the worker in a worktree of the clone', async () => {
    const w = far();
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1'], { env: w.env, cwd: w.home });
      const clone = join(w.repos, 'api');
      assert.ok(stdout.includes(`Cloned ${normRemote(w.origin)} into ${clone}`), stdout);
      assert.ok(!/Skipping far/.test(stdout), stdout);
      const logs = join(w.home, '.nuworq', 'logs');
      const log = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
      assert.match(log, new RegExp(`WORKING IN ${clone}\\.worktrees/`), log);
    } finally {
      server.close();
    }
  });

  test('run --browser: work that needs a browser goes to its workers, and they get one', async () => {
    const w = far();
    w.hub.humanOp('far', 'update', { item: '#1', needs: ['browser'] });
    writeFileSync(join(w.dir, 'bin', 'claude'), '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\n', { mode: 0o755 });
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1', ...a], { env: w.env, cwd: w.home });
    const logs = join(w.home, '.nuworq', 'logs');
    // The Playwright MCP server as npm ci installed it from the shipped lockfile (#626), already here: no network.
    const lock = readFileSync(new URL('../src/browser/package-lock.json', import.meta.url));
    const cli = join(w.home, '.nuworq', 'browser', createHash('sha256').update(lock).digest('hex').slice(0, 16), 'node_modules', '@playwright', 'mcp', 'cli.js');
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, '');
    try {
      await run();
      assert.deepEqual(readdirSync(w.repos), [], 'without --browser, nothing here can take it');
      await run('--browser');
      const log = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
      assert.ok(log.includes(`"playwright":{"command":"node","args":[${JSON.stringify(cli)},"--headless"`), log);
      assert.doesNotMatch(log, /npx/, 'nothing fetched at start');
      assert.match(log, /^ARG mcp__nuworq,.*,mcp__playwright\nARG --disallowedTools\nARG mcp__playwright__browser_run_code_unsafe$/m);
    } finally {
      server.close();
    }
  });

  // #626: what a worker prints goes to its log with every provider and llm-proxy key masked, whatever stream it's on.
  test('worker logs hold no provider or proxy keys', async () => {
    const w = far();
    const KEYS = ['sk-ant-api03-Abc123def456ghi789', 'sk-proj-Zyx987wvu654tsr321', 'sk-proxy-0a1b2c3d4e5f6a7b', 'owner-token-shapeless-9f8e7d6c'];
    writeFileSync(join(w.dir, 'bin', 'claude'), `#!/bin/sh\necho "anthropic ${KEYS[0]} openai ${KEYS[1]}"\necho "Authorization: Bearer ${KEYS[2]}"\necho "x-proxy-token: ${KEYS[3]}" >&2\necho "the owner token was ${KEYS[3]}" >&2\necho "WORKER DONE"\n`, { mode: 0o755 });
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      // The runner's own environment holds the owner token, which has no shape of its own.
      await promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1'], { env: { ...w.env, NUWORQ_LLM_PROXY_TOKEN: KEYS[3] }, cwd: w.home });
      const logs = join(w.home, '.nuworq', 'logs');
      const log = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
      assert.match(log, /WORKER DONE/, 'the worker ran and its output is in the log');
      assert.deepEqual(KEYS.filter((k) => log.includes(k)), [], log);
      assert.match(log, /anthropic sk-\[redacted\] openai sk-\[redacted\]/);
      assert.match(log, /Authorization: Bearer \[redacted\]/);
      assert.match(log, /the owner token was \[redacted\]/);
    } finally {
      server.close();
    }
  });

  test('run starts each worker on the model its job calls for, for that one job, when the project routes models (#347)', async () => {
    const w = far();
    writeFileSync(join(w.dir, 'bin', 'claude'), '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\n', { mode: 0o755 });
    w.hub.humanOp('far', 'settings', { model_routing: true, model_tiers: { claude: ['claude-haiku-5-5', 'claude-opus-5-5'] } });
    w.hub.q("UPDATE items SET stage = 'landing', stage_since = 0 WHERE seq = 1").run(); // accepted work to land
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--max-runs', '1', '--until-idle', '--poll', '1', ...a], { env: w.env, cwd: w.home });
    const logs = join(w.home, '.nuworq', 'logs');
    const read = () => readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
    try {
      const { stdout } = await run('--model', 'claude-opus-5-5');
      assert.match(stdout, /#1 Do it \(land on claude-haiku-5-5\)/, stdout);
      const log = read();
      assert.match(log, /^ARG --model\nARG claude-haiku-5-5$/m, 'the cheapest tier, not the runner\'s --model');
      assert.match(log, /"NUWORQ_MODEL":"claude-haiku-5-5"/, 'and its MCP server checks in saying so');
      assert.match(log, /You were started on claude-haiku-5-5 for one job: land #1\. After checkin, claim #1, do that job, then sign off/);
      assert.doesNotMatch(log, /Keep going until next says/);
      // A land job (#752): a short brief and a dollar cap Claude stops itself at.
      assert.match(log, /^ARG --max-budget-usd\nARG 2$/m, 'capped at the default --land-usd');
      assert.match(log, /Follow the steps the claim gives you, and nothing more/);
      assert.doesNotMatch(log, /run only the tests that cover what you change/);

      w.hub.humanOp('far', 'settings', { model_routing: false });
      rmSync(logs, { recursive: true });
      await run('--land-usd', '0.5');
      assert.doesNotMatch(read(), /ARG --model/, "off, without --model: the agent's own default, as before");
      assert.match(read(), /You were started for one job: land #1\./, 'a land job is still one capped run of its own');
      assert.match(read(), /^ARG --max-budget-usd\nARG 0\.5$/m);

      // Any other job: only the per-worker cap (#761), none unless --worker-usd sets one (#795), and the worker keeps going.
      w.hub.q("UPDATE items SET stage = 'ready' WHERE seq = 1").run();
      rmSync(logs, { recursive: true });
      await run();
      assert.match(read(), /Keep going until next says/);
      assert.doesNotMatch(read(), /ARG --max-budget-usd/, 'no default per-worker cap (#795)');
      rmSync(logs, { recursive: true });
      await run('--worker-usd', '25');
      assert.match(read(), /^ARG --max-budget-usd\nARG 25$/m);
    } finally {
      server.close();
    }
  });

  test("run leaves a project whose checkout can't be updated for later, and never starts its agent", async () => {
    const w = far();
    execFileSync('git', ['clone', '-q', w.origin, join(w.repos, 'api')]);
    rmSync(w.origin, { recursive: true }); // origin can't be reached any more
    const server = createServer(w.hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'run', '--url', url, '--agent', 'claude', '--until-idle', '--poll', '1'], { env: w.env, cwd: w.home });
      const said = stdout.match(/^Skipping far for 5m: couldn't update its checkout: fatal: '[^']*' does not appear to be a git repository\n {2}log: (\S+)$/m);
      assert.ok(said, stdout);
      assert.match(readFileSync(said[1], 'utf8'), /does not appear to be a git repository/, "git's own words are in the log");
      assert.match(stdout, /Done: no work this machine can take is waiting\. 0 launched/);
      assert.doesNotMatch(stdout, /▶|failed within seconds/);
      assert.ok(!existsSync(join(w.repos, 'api.worktrees')), 'no worktree, no agent');
    } finally {
      server.close();
    }
  });

  test('a GitHub repo on a hub without an App is skipped with the clone command, as before', async () => {
    const w = far();
    const hub = new Hub();
    hub.tx(() => hub.project('gh', { create: true }));
    hub.humanOp('gh', 'remote', { add: 'github.com/acme/nowhere' });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      await assert.rejects(promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'gh', '--agent', 'claude', '--as', 'w'], { env: w.env, cwd: w.home }),
        (e) => e.stderr.includes('No checkout of github.com/acme/nowhere on this machine') && e.stderr.includes(`git clone git@github.com:acme/nowhere.git ${join(w.repos, 'nowhere')}`));
      assert.deepEqual(readdirSync(w.repos), [], 'nothing cloned');
    } finally {
      server.close();
    }
  });
});

// A fake world: time only moves when the runner sleeps; workers are promises we resolve by hand.
// end(): stops the loop and lets every worker go, so a failed assertion never leaves run() pending (#553).
function world(routesSeq) {
  let t = 0;
  const workers = [];
  const lines = [];
  let i = 0;
  let stop = null;
  return {
    workers, lines,
    end: () => { stop?.(); stop?.(); for (const x of workers) x.finish('ended'); },
    opts: {
      onInterrupt: (fn) => { stop = fn; },
      routes: async () => routesSeq[Math.min(i++, routesSeq.length - 1)],
      launch: async (r) => {
        let finish;
        const w = { name: `w${workers.length + 1}`, project: r.project, signals: [], exited: new Promise((res) => { finish = res; }) };
        w.finish = finish;
        w.kill = (sig) => w.signals.push(sig);
        workers.push(w);
        return w;
      },
      log: (l) => lines.push(l),
      now: () => t,
      sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1,
    },
  };
}

// The loop runs on real time as fast as the machine lets it, so wait for what it does, not a fixed few ms (#553).
async function until(cond, what, ms = 10_000) {
  for (const end = Date.now() + ms; !cond();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
// The test's body, ending the loop if it fails, so the file doesn't hang on a pending run().
async function checked(w, p, body) {
  try { await body(); } catch (e) { w.end(); await p.catch(() => {}); throw e; }
}

describe('run: the supervising loop', () => {
  test('with --until-idle: starts one worker for one item, waits for it, then exits when nothing is waiting', async () => {
    const w = world([[route('a', 1)], [route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 3, untilIdle: true });
    await checked(w, p, async () => {
      await until(() => w.workers.length, 'a worker');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(w.workers.length, 1, 'no herd while the first worker has not claimed');
    });
    w.workers[0].finish(0);
    const res = await p;
    assert.equal(res.launched, 1);
    assert.match(res.why, /no work is waiting/);
    assert.match(w.lines.at(-1), /1 launched, 1 exited cleanly, 0 failed \(w1@a:0\)/);
  });

  test('by default it waits for work instead of exiting, and starts a worker the moment work appears', async () => {
    const w = world([[], [], [], [route('a', 1)], [route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 1, maxRuns: 1 });
    await checked(w, p, () => until(() => w.workers.length, 'a worker once work appears'));
    assert.equal(w.lines.filter((l) => /Nothing is waiting/.test(l)).length, 1, 'says so once, not every poll');
    w.workers[0].finish(0);
    const res = await p;
    assert.match(res.why, /reached --max-runs 1/);
  });

  test('stops after --max-runs, and terminates workers that run past --max-minutes', async () => {
    const w = world([[route('a', 5)]]);
    const p = run({ ...w.opts, workers: 1, maxRuns: 1, maxMinutes: 1 });
    await checked(w, p, async () => {
      await until(() => w.workers[0]?.signals.length >= 2, 'SIGTERM, then SIGKILL');
      assert.equal(w.workers.length, 1);
      assert.deepEqual(w.workers[0].signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
    });
    w.workers[0].finish('SIGKILL');
    const res = await p;
    assert.match(res.why, /max-runs 1/);
  });

  test('Ctrl-C stops launching, asks workers to stop, then kills them on a second Ctrl-C', async () => {
    const w = world([[route('a', 5)]]);
    let interrupt;
    const p = run({ ...w.opts, workers: 2, onInterrupt: (fn) => { interrupt = fn; } });
    await until(() => w.workers.length >= 2, 'two workers').catch((e) => { interrupt(); interrupt(); w.end(); throw e; });
    assert.equal(w.workers.length, 2);
    interrupt();
    interrupt();
    assert.deepEqual(w.workers[0].signals, ['SIGTERM', 'SIGKILL']);
    w.workers.forEach((x) => x.finish(143));
    const res = await p;
    assert.equal(res.why, 'interrupted');
    assert.equal(res.launched, 2);
  });

  test('stops launching at --max-usd, lets running workers finish, and says what was spent', async () => {
    const w = world([[route('a', 5)]]);
    const p = run({ ...w.opts, workers: 2, maxUsd: 2.5 });
    await checked(w, p, async () => {
      await until(() => w.workers.length >= 2, 'two workers');
      w.workers[0].spent = () => 3.1;
      w.workers[0].finish(0);
      await until(() => w.lines.some((l) => /■ w1/.test(l)), "w1's exit");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(w.workers.length, 2, 'no new worker once the budget is spent');
      assert.deepEqual(w.workers[1].signals, [], 'the running worker is left to finish');
      assert.ok(w.lines.some((l) => /■ w1 \(a\) exited 0 after \d+s, spent \$3\.10/.test(l)));
    });
    w.workers[1].spent = () => null; // a CLI that reports no cost
    w.workers[1].finish(0);
    const res = await p;
    assert.match(res.why, /reached --max-usd 2\.5 \(\$3\.10 spent\); letting 1 running worker\(s\) finish/);
    assert.equal(res.spent, 3.1);
    assert.match(w.lines.at(-1), /2 launched, 2 exited cleanly, 0 failed .*; \$3\.10 spent\.$/);
  });

  test("stops a land job's worker once what it reports passes its cap (#752); others aren't capped", async () => {
    const w = world([[route('a', 5)]]);
    const launch = w.opts.launch;
    const p = run({ ...w.opts, workers: 2, launch: async (r) => Object.assign(await launch(r), { cap: r.cap }), maxRuns: 2 });
    await checked(w, p, async () => {
      await until(() => w.workers.length >= 2, 'two workers');
      w.workers[0].cap = 2;
      w.workers[0].spent = () => 1.5;
      w.workers[1].spent = () => 9;
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(w.workers[0].signals, [], 'under its cap');
      w.workers[0].spent = () => 2.4;
      await until(() => w.workers[0].signals.length, 'SIGTERM at the cap');
      assert.equal(w.workers[0].signals[0], 'SIGTERM');
      assert.deepEqual(w.workers[1].signals, [], 'no cap: left alone');
      assert.ok(w.lines.some((l) => /w1 spent past its \$2 cap for a land job: stopping it/.test(l)));
    });
    w.workers.forEach((x) => x.finish(0));
    await p;
  });

  test('reports when each worker started, and stops the one the hub names in its reply (#767)', async () => {
    const w = world([[route('a', 5)]]);
    const reports = [];
    let stop = [];
    const p = run({ ...w.opts, workers: 2, maxRuns: 2, report: async (s) => { reports.push(s); return { ok: true, stop }; } });
    await checked(w, p, async () => {
      await until(() => w.workers.length >= 2, 'two workers');
      await until(() => reports.some((r) => r.runs?.length === 2), 'their starts reported');
      assert.ok(reports.at(-1).runs.every((r) => r.project === 'a' && r.since >= 0));
      stop = ['w2'];
      await until(() => w.workers[1].signals.includes('SIGTERM'), 'SIGTERM for the one named');
      assert.deepEqual(w.workers[0].signals, [], 'the other runs on');
      assert.ok(w.lines.some((l) => /w2: a person asked the hub to stop it/.test(l)));
    });
    w.workers.forEach((x) => x.finish(0));
    await p;
  });

  // #761: a claude worker that streams assistant messages and never exits on its own.
  const opus = (id, input, output) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-4-5', content: [{ type: 'text', text: 'working' }], usage: { input_tokens: input, output_tokens: output } } });

  test('a runaway worker is stopped while it runs once its spend so far passes --worker-usd, and that spend counts toward --max-usd', async () => {
    const { tap } = await import('../src/usage.js');
    const w = world([[route('a', 5)]]);
    const reports = [];
    const p = run({ ...w.opts, workers: 1, workerUsd: 25, maxUsd: 20, report: async (s) => { reports.push(s); } });
    await checked(w, p, async () => {
      await until(() => w.workers.length, 'a worker');
      const t = tap('claude');
      w.workers[0].spent = () => t.usage()?.cost_usd ?? 0;
      t.line(opus('m1', 1_000_000, 100_000)); // $5 + $2.50
      t.line(opus('m1', 1_000_000, 100_000)); // the same message's next block: counted once
      await until(() => reports.some((r) => r.spending?.[0]?.usd === 7.5), 'its spend so far reported to the hub');
      assert.deepEqual(w.workers[0].signals, [], 'under both caps it runs on');
      t.line(opus('m2', 2_000_000, 400_000)); // + $10 + $10: $27.50 so far
      await until(() => w.workers[0].signals.includes('SIGTERM'), 'SIGTERM before it exits on its own');
      assert.ok(w.lines.some((l) => /w1 spent \$27\.50, past its \$25 cap: stopping it/.test(l)));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(w.workers.length, 1, 'no new worker once its spend so far passes --max-usd');
      // Killed before its `result`: its usage is the estimate, marked so, not $0.
      assert.deepEqual(t.usage(), { input_tokens: 3_000_000, output_tokens: 500_000, cost_usd: 27.5, model: 'claude-opus-4-5', estimated: true });
    });
    w.workers[0].finish('SIGTERM');
    const res = await p;
    assert.match(res.why, /reached --max-usd 20 \(\$27\.50 spent\)/);
    assert.equal(res.spent, 27.5);
  });

  test('without a budget, workers that report no spend change nothing', async () => {
    const w = world([[route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 1, untilIdle: true });
    await checked(w, p, () => until(() => w.workers.length, 'a worker'));
    w.workers[0].finish(0);
    const res = await p;
    assert.equal(res.spent, 0);
    assert.doesNotMatch(w.lines.at(-1), /spent/);
  });

  test("skips a project this machine has no checkout of: says so once, gives its slots to others, doesn't count it as a failure", async () => {
    const w = world([[route('far', 2), route('a', 1)], [route('far', 2), route('a', 1)], [route('far', 2)]]);
    const start = w.opts.launch;
    w.opts.launch = async (r) => {
      if (r.project === 'far') throw Object.assign(new Error('No checkout of github.com/acme/far on this machine'), { skip: true, hint: 'git clone git@github.com:acme/far.git /src/far' });
      return start(r);
    };
    const p = run({ ...w.opts, workers: 2, untilIdle: true });
    await checked(w, p, async () => {
      await until(() => w.workers.length, 'a worker');
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(w.workers.map((x) => x.project), ['a'], "far's slots went to a");
    });
    w.workers[0].finish(0);
    const res = await p;
    assert.equal(res.launched, 1);
    assert.match(res.why, /no work this machine can take is waiting/);
    assert.equal(w.lines.filter((l) => /^Skipping far: No checkout of github\.com\/acme\/far on this machine\n {2}git clone /.test(l)).length, 1, 'said once, with the clone command');
    assert.ok(!w.lines.some((l) => /Couldn't start|failed within seconds/.test(l)));
    assert.match(w.lines.at(-1), /1 launched, 1 exited cleanly, 0 failed/);
  });

  test("a project whose checkout can't be updated waits 5m, then 10m, while the others go on; it isn't a failure", async () => {
    const w = world([[route('far', 1), route('a', 1)]]);
    const start = w.opts.launch;
    const tried = [];
    w.opts.launch = async (r) => {
      if (r.project !== 'far') return start(r);
      tried.push(w.opts.now());
      throw Object.assign(new Error("couldn't update its checkout: fatal: could not read Username for 'https://github.com'"), { skip: true, pause: true, hint: 'log: /logs/w.log' });
    };
    let interrupt;
    const p = run({ ...w.opts, workers: 2, onInterrupt: (fn) => { interrupt = fn; } });
    for (let i = 0; i < 1e5 && tried.length < 2; i++) await new Promise((r) => setImmediate(r));
    interrupt();
    w.workers[0].finish(0);
    const res = await p;
    assert.deepEqual(w.workers.map((x) => x.project), ['a'], "far's slot went to a, and a kept going");
    assert.equal(res.launched, 1, 'skips are not launches');
    const skipped = w.lines.filter((l) => /^Skipping far/.test(l));
    assert.deepEqual(skipped, [
      "Skipping far for 5m: couldn't update its checkout: fatal: could not read Username for 'https://github.com'\n  log: /logs/w.log",
      "Skipping far for 10m: couldn't update its checkout: fatal: could not read Username for 'https://github.com'\n  log: /logs/w.log",
    ]);
    const gap = tried[1] - tried[0];
    assert.ok(gap >= 5 * 60_000 && gap < 5 * 60_000 + 2_000, `tried again after 5 minutes (gap ${gap}ms)`);
    assert.ok(!w.lines.some((l) => /Couldn't start|failed within seconds|^Paused/.test(l)));
  });

  test('pauses 5m after 3 workers in a row fail within seconds, then 10m on the next streak, instead of quitting', async () => {
    const w = world([[route('a', 5)]]);
    const at = [];
    w.opts.launch = async () => { at.push(w.opts.now()); throw new Error('claude: command not found'); };
    const res = await run({ ...w.opts, workers: 1, maxRuns: 6 });
    assert.match(res.why, /max-runs 6/);
    const paused = w.lines.filter((l) => /^Paused/.test(l));
    assert.equal(paused.length, 2);
    assert.match(paused[0], /^Paused 5m: 3 workers in a row failed within seconds\. Check the agent runs on its own \(see its log\)\.$/);
    assert.match(paused[1], /^Paused 10m: /, 'the next streak pauses longer');
    const gap = at[3] - at[2];
    assert.ok(gap >= 5 * 60_000 && gap < 5 * 60_000 + 10_000, `no 4th worker for 5 minutes, then it resumes (gap ${gap}ms)`);
  });

  test('a worker that worked resets the pause: the next streak waits 5m again', async () => {
    const w = world([[route('a', 5)]]);
    const codes = [1, 1, 1, 0, 1, 1, 1];
    const launch = w.opts.launch;
    w.opts.launch = async (r) => {
      const x = await launch(r);
      const code = codes[w.workers.length - 1];
      setImmediate(() => x.finish(code));
      return x;
    };
    w.opts.claimed = async () => true;
    await run({ ...w.opts, workers: 1, maxRuns: codes.length });
    assert.deepEqual(w.lines.filter((l) => /^Paused/.test(l)).map((l) => l.slice(0, 10)), ['Paused 5m:', 'Paused 5m:']);
  });

  test('with --until-idle, workers that keep failing within seconds stop run', async () => {
    const w = world([[route('a', 5)]]);
    w.opts.launch = async () => { throw new Error('claude: command not found'); };
    const res = await run({ ...w.opts, workers: 1, untilIdle: true });
    assert.match(res.why, /failed within seconds/);
    assert.equal(res.launched, 3);
  });

  // Workers that each exit with codes[n] once the runner's clock has moved ms past their start (#764): time only
  // moves when the runner sleeps, so a worker is let go from sleep.
  const slow = (ms, codes = () => 1) => {
    const w = world([[route('a', 50)]]);
    const launch = w.opts.launch;
    const sleep = w.opts.sleep;
    w.opts.launch = async (r) => Object.assign(await launch(r), { at: w.opts.now() });
    w.opts.sleep = async (d) => {
      await sleep(d);
      for (const x of w.workers) if (!x.gone && w.opts.now() - x.at >= ms) { x.gone = true; x.finish(codes(w.workers.indexOf(x))); }
    };
    w.reports = [];
    w.opts.report = async (s) => { w.reports.push(s); };
    return w;
  };

  test('pauses 5m, then 10m, after 3 workers in a row fail after a minute each, and tells the hub why', async () => {
    const w = slow(60_000);
    const res = await run({ ...w.opts, workers: 1, maxRuns: 6 });
    assert.match(res.why, /max-runs 6/);
    const paused = w.lines.filter((l) => /^Paused/.test(l));
    assert.deepEqual(paused, [
      'Paused 5m: 3 workers in a row failed after 1m, 1m, 1m. Check the agent runs on its own (see its log).',
      'Paused 10m: 3 workers in a row failed after 1m, 1m, 1m. Check the agent runs on its own (see its log).',
    ]);
    const gap = w.workers[3].at - w.workers[2].at;
    assert.ok(gap >= 5 * 60_000 + 60_000 && gap < 6 * 60_000 + 10_000, `no 4th worker until the 5m pause is over (gap ${gap}ms)`);
    const told = w.reports.find((s) => s.paused);
    assert.equal(told.paused.reason, '3 workers in a row failed after 1m, 1m, 1m', 'the hub hears of the pause and its reason');
  });

  test('workers that fail after 20 minutes each pause it too', async () => {
    const w = slow(20 * 60_000);
    await run({ ...w.opts, workers: 1, maxRuns: 3 });
    assert.deepEqual(w.lines.filter((l) => /^Paused/.test(l)), ['Paused 5m: 3 workers in a row failed after 20m, 20m, 20m. Check the agent runs on its own (see its log).']);
  });

  test('a slow worker that exits 0 resets the streak, and so does one that failed after submitting something', async () => {
    const clean = slow(60_000, (n) => (n === 2 ? 0 : 1));
    clean.opts.claimed = async () => true;
    await run({ ...clean.opts, workers: 1, maxRuns: 5 });
    assert.ok(!clean.lines.some((l) => /^Paused/.test(l)), 'w1 w2 fail, w3 exits 0, w4 w5 fail: never 3 in a row');

    const handed = slow(60_000);
    handed.opts.submitted = async (x) => x.name === 'w3';
    await run({ ...handed.opts, workers: 1, maxRuns: 5 });
    assert.ok(!handed.lines.some((l) => /^Paused/.test(l)), 'w3 exited 1 but submitted: never 3 in a row');
  });

  // Workers that exit cleanly the moment they start (well within a minute); claims says which took a job.
  const empty = (routesSeq, claims = () => false) => {
    const w = world(routesSeq);
    const launch = w.opts.launch;
    w.opts.launch = async (r) => {
      const x = Object.assign(await launch(r), { at: w.opts.now() });
      setImmediate(() => x.finish(0));
      return x;
    };
    w.opts.claimed = async (x) => claims(x);
    return w;
  };

  test('pauses 5m after 3 workers in a row find nothing to claim, then 10m on the next streak', async () => {
    const w = empty([[route('a', 5)]]);
    const res = await run({ ...w.opts, workers: 1, maxRuns: 6 });
    assert.match(res.why, /max-runs 6/);
    const paused = w.lines.filter((l) => /^Paused/.test(l));
    assert.equal(paused.length, 2);
    assert.match(paused[0], /^Paused 5m: 3 workers in a row found nothing to claim in a\./);
    assert.match(paused[1], /^Paused 10m: /, 'the next streak pauses longer');
    const gap = w.workers[3].at - w.workers[2].at;
    assert.ok(gap >= 5 * 60_000 && gap < 5 * 60_000 + 10_000, `no 4th worker for 5 minutes, then it resumes (gap ${gap}ms)`);
    assert.ok(w.workers[1].at - w.workers[0].at < 10_000, 'no pause before the streak');
  });

  test('a quick worker that claimed something resets the streak', async () => {
    const w = empty([[route('a', 5)]], (x) => x.name === 'w3');
    await run({ ...w.opts, workers: 1, maxRuns: 5 });
    assert.ok(!w.lines.some((l) => /^Paused/.test(l)), 'w1 w2 empty, w3 claimed, w4 w5 empty: never 3 in a row');
  });

  test('with --until-idle, the streak stops run instead', async () => {
    const w = empty([[route('a', 5)]]);
    const res = await run({ ...w.opts, workers: 1, untilIdle: true });
    assert.equal(res.why, '3 workers in a row found nothing to claim in a');
    assert.equal(res.launched, 3);
  });
});
