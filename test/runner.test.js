import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
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

      const setup = stdout.match(/^git -C '[^']*' fetch -q origin && \\\n\{ \[ -d '[^']*\.worktrees\/c-2' \] \|\| git -C '[^']*' worktree add -q --detach '[^']*\.worktrees\/c-2' 'origin\/main'; \}/m)?.[0];
      assert.ok(setup, 'fetch first, then the worktree detached at origin/main');
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

  test('gives up after workers keep failing within seconds', async () => {
    const w = world([[route('a', 5)]]);
    w.opts.launch = async () => { throw new Error('claude: command not found'); };
    const res = await run({ ...w.opts, workers: 1 });
    assert.match(res.why, /failed within seconds/);
    assert.equal(res.launched, 3);
  });
});
