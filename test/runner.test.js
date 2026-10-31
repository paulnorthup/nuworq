import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub, normRemote } from '../src/core.js';
import { createServer } from '../src/server.js';
import { plan, run } from '../src/runner.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

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
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'oc', '--agent', 'opencode', ...a], { env: { ...process.env, NUWORQ_TOKEN: '' } });
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
    } finally {
      server.close();
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
    writeFileSync(join(repo, 'package.json'), '{}'); // a Node project

    const hub = new Hub();
    hub.tx(() => hub.project('gh', { create: true }));
    hub.humanOp('gh', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'gh', '--agent', 'claude', '--as', 'c-2'],
        { env: { ...process.env, NUWORQ_TOKEN: '' } });
      const allow = stdout.match(/--allowedTools '([^']*)'/)[1].split(',');
      assert.ok(allow.includes('Bash(git fetch:*)'));
      assert.deepEqual(allow.filter((a) => /git push/.test(a)), ['Bash(git push origin:*)'], 'no other push, and no bare git push');
      assert.ok(allow.includes(`Bash(git -C ${repo} merge --ff-only:*)`), 'kept for a hub that lands in this checkout');
      assert.deepEqual(allow.filter((a) => /git -C/.test(a)), [`Bash(git -C ${repo} merge --ff-only:*)`], 'no other -C command');
      assert.ok(!allow.some((a) => /^Bash\(git:|^Bash\(git \*|^Bash\(git -C:/.test(a)), 'no blanket git');
      assert.match(stdout, /git switch -c <branch> origin\/main`.*push the branch before you submit \(`git push origin <branch>`\).*`git push origin <branch>:main`/);
      assert.match(stdout, /detached at origin\/main/);
      assert.match(stdout, /run only the tests that cover what you change; run the full test suite once, just before you submit/);
      // Its test runs take 2 files at a time (or what the operator set), for every process the agent starts.
      const cap = stdout.match(/^export NUWORQ_TEST_CONCURRENCY=\S+(?= && \\\n)/m)?.[0];
      assert.ok(cap && stdout.indexOf(cap) < stdout.indexOf('claude -p'), stdout);
      const val = (env) => execFileSync('/bin/sh', ['-c', `${cap} && echo $NUWORQ_TEST_CONCURRENCY`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).trim();
      assert.equal(val({}), '2');
      assert.equal(val({ NUWORQ_TEST_CONCURRENCY: '4' }), '4');
      assert.doesNotMatch(stdout, /NODE_OPTIONS/, 'Node refuses --test-concurrency there');

      const setup = stdout.match(/^git -C '[^']*' -c '[^']*' -c \S+ fetch -q origin && \\\n\{ \[ -d '[^']*\.worktrees\/c-2' \] \|\| git -C '[^']*' worktree add -q --detach '[^']*\.worktrees\/c-2' 'origin\/main'; \}/m)?.[0];
      assert.ok(setup, 'fetch first, then the worktree detached at origin/main');
      // It holds no item yet, so over HTTPS the fetch gets the project's read-only token, not the item one.
      assert.match(setup, /-c 'credential\.https:\/\/github\.com\.helper=!NUWORQ_URL=http:\/\/127\.0\.0\.1:\d+ node "[^"]+" git-credential --project gh --as c-2' -c credential\.https:\/\/github\.com\.useHttpPath=true fetch/);
      execFileSync('/bin/sh', ['-c', setup.replace(/ \\\n/g, ' ')]);
      const wt = `${repo}.worktrees/c-2`;
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
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${server.address().port}`, '--project', 'ui', '--as', 'b-1', ...a],
      { env: { ...process.env, NUWORQ_TOKEN: '', CLAUDE_CONFIG_DIR: config } });
    const parts = ({ stdout }) => ({
      strict: /--mcp-config '[^']*' --strict-mcp-config /.test(stdout),
      settings: JSON.parse(stdout.match(/--settings '([^']*)'/)[1]),
      noSkills: /--settings '[^']*' --disable-slash-commands /.test(stdout),
      servers: JSON.parse(stdout.match(/--mcp-config '([^']*)'/)[1]).mcpServers,
      allow: stdout.match(/--allowedTools '([^']*)'/)[1].split(','),
      deny: stdout.match(/--disallowedTools '([^']*)'/)?.[1],
      task: stdout.match(/claude -p '((?:[^']|'\\'')*)'/)[1],
    });
    try {
      const plain = parts(await cli('--agent', 'claude'));
      assert.deepEqual(Object.keys(plain.servers), ['nuworq']);
      assert.ok(plain.strict, 'only the runner\'s MCP servers, none of the person\'s own');
      assert.deepEqual(plain.settings, { enabledPlugins: { 'nuworq@nuworq': false, 'other@market': false } }, 'every installed plugin off');
      assert.ok(plain.noSkills, 'no skills either: ~/.claude/skills holds nuworq-operator, and it isn\'t a plugin (#368)');
      assert.ok(!plain.allow.includes('mcp__playwright'));
      assert.ok(!(plain.servers.nuworq.env.NUWORQ_HAS ?? '').split(',').includes('browser'));
      assert.doesNotMatch(plain.task, /mcp__playwright|375px|serve --demo/);
      assert.equal(plain.deny, undefined);

      const b = parts(await cli('--agent', 'claude', '--browser'));
      assert.deepEqual(b.servers.playwright, {
        command: 'npx',
        args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--browser', 'chrome', '--isolated',
          '--allowed-origins', 'http://127.0.0.1:*;http://localhost:*', '--output-dir', join(tmpdir(), 'nuworq-browser', 'b-1')],
      });
      assert.deepEqual(Object.keys(b.servers), ['nuworq', 'playwright']);
      assert.ok(b.strict);
      assert.deepEqual(b.allow, [...plain.allow, 'mcp__playwright'], 'the same allowlist, plus the browser');
      assert.equal(b.deny, 'mcp__playwright__browser_run_code_unsafe', 'except its tool that runs any code in the server process');
      assert.ok(b.servers.nuworq.env.NUWORQ_HAS.split(',').includes('browser'), 'it declares browser, as --has browser would');
      assert.match(b.task, /`node bin\/nuworq\.js serve --demo --port 0` in the background/);
      assert.match(b.task, /desktop width and at 375px wide \(browser_resize\); the app is light only/);
      assert.doesNotMatch(b.task, /dark mode \(|browser_emulate_media/, 'no dark-mode screenshots (#156)');
      assert.match(b.task, /describe in your evidence what you saw/);
      assert.deepEqual(parts(await cli('--agent', 'claude', '--browser', '--allow', 'Read')).allow, ['Read', 'mcp__playwright'], '--allow keeps its list');

      await assert.rejects(cli('--agent', 'codex', '--browser'), (e) => e.stderr.includes('--browser is for Claude workers only'));
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
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "ARGS: $*"\n', { mode: 0o755 });
    const hub = new Hub();
    hub.tx(() => hub.project('lock', { create: true }));
    hub.humanOp('lock', 'settings', { path: dir });
    const server = createServer(hub, { auth: 'required' });
    const human = server.auth.createToken('me', 'human');
    const agent = server.auth.createToken('box', 'agent', { projects: ['lock'] });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NUWORQ_TOKEN: human, NUWORQ_AGENT_TOKEN: '' };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'lock', '--here', '--as', 'w', ...a], { env, cwd: dir });
    try {
      const printed = (await cli()).stdout;
      assert.match(printed, /"NUWORQ_TOKEN":"<agent-token>"/);
      assert.ok(!printed.includes(human));

      await assert.rejects(cli('--run'), (e) => /workers need their own agent token/.test(e.stderr) && /--agent-token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', human), (e) => /is a human token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', 'nwq_not-a-real-token-at-all'), (e) => /refused the agent token/.test(e.stderr));

      const ran = (await cli('--run', '--agent-token', agent)).stdout;
      assert.match(ran, /ARGS: .*"NUWORQ_TOKEN":"nwq_/);
      assert.ok(ran.includes(agent) && !ran.includes(human), 'the agent gets the agent token only');
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
    try {
      await run();
      assert.deepEqual(readdirSync(w.repos), [], 'without --browser, nothing here can take it');
      await run('--browser');
      const log = readdirSync(logs).map((f) => readFileSync(join(logs, f), 'utf8')).join('');
      assert.match(log, /^ARG \{"mcpServers":.*"playwright":\{"command":"npx","args":\["-y","@playwright\/mcp@0\.0\.83","--headless"/m, log);
      assert.match(log, /^ARG mcp__nuworq,.*,mcp__playwright\nARG --disallowedTools\nARG mcp__playwright__browser_run_code_unsafe$/m);
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
function world(routesSeq) {
  let t = 0;
  const workers = [];
  const lines = [];
  let i = 0;
  return {
    workers, lines,
    opts: {
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

describe('run: the supervising loop', () => {
  test('with --until-idle: starts one worker for one item, waits for it, then exits when nothing is waiting', async () => {
    const w = world([[route('a', 1)], [route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 3, untilIdle: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.workers.length, 1, 'no herd while the first worker has not claimed');
    w.workers[0].finish(0);
    const res = await p;
    assert.equal(res.launched, 1);
    assert.match(res.why, /no work is waiting/);
    assert.match(w.lines.at(-1), /1 launched, 1 exited cleanly, 0 failed \(w1@a:0\)/);
  });

  test('by default it waits for work instead of exiting, and starts a worker the moment work appears', async () => {
    const w = world([[], [], [], [route('a', 1)], [route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 1, maxRuns: 1 });
    while (!w.workers.length) await new Promise((r) => setTimeout(r, 5));
    assert.equal(w.lines.filter((l) => /Nothing is waiting/.test(l)).length, 1, 'says so once, not every poll');
    w.workers[0].finish(0);
    const res = await p;
    assert.match(res.why, /reached --max-runs 1/);
  });

  test('stops after --max-runs, and terminates workers that run past --max-minutes', async () => {
    const w = world([[route('a', 5)]]);
    const p = run({ ...w.opts, workers: 1, maxRuns: 1, maxMinutes: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.workers.length, 1);
    assert.deepEqual(w.workers[0].signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
    w.workers[0].finish('SIGKILL');
    const res = await p;
    assert.match(res.why, /max-runs 1/);
  });

  test('Ctrl-C stops launching, asks workers to stop, then kills them on a second Ctrl-C', async () => {
    const w = world([[route('a', 5)]]);
    let interrupt;
    const p = run({ ...w.opts, workers: 2, onInterrupt: (fn) => { interrupt = fn; } });
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.workers.length, 2);
    w.workers[0].spent = () => 3.1;
    w.workers[0].finish(0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.workers.length, 2, 'no new worker once the budget is spent');
    assert.deepEqual(w.workers[1].signals, [], 'the running worker is left to finish');
    assert.ok(w.lines.some((l) => /■ w1 \(a\) exited 0 after \d+s, spent \$3\.10/.test(l)));
    w.workers[1].spent = () => null; // a CLI that reports no cost
    w.workers[1].finish(0);
    const res = await p;
    assert.match(res.why, /reached --max-usd 2\.5 \(\$3\.10 spent\); letting 1 running worker\(s\) finish/);
    assert.equal(res.spent, 3.1);
    assert.match(w.lines.at(-1), /2 launched, 2 exited cleanly, 0 failed .*; \$3\.10 spent\.$/);
  });

  test('without a budget, workers that report no spend change nothing', async () => {
    const w = world([[route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 1, untilIdle: true });
    await new Promise((r) => setTimeout(r, 20));
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
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(w.workers.map((x) => x.project), ['a'], "far's slots went to a");
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
