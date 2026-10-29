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

const BIN = fileURLToPath(new URL('../bin/trellis.js', import.meta.url));

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

describe('trellis worker --agent opencode', () => {
  test('prints an opencode run with Trellis MCP and Ollama in the environment, nothing written to the repo', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-oc-')));
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
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'oc', '--agent', 'opencode', ...a], { env: { ...process.env, TRELLIS_TOKEN: '' } });
    try {
      const { stdout } = await cli('--model', 'ollama/qwen3:8b', '--as', 'oc-1');
      assert.match(stdout, /git -C '.*' worktree add -q -b 'trellis\/oc-1'/);
      assert.match(stdout, /opencode run -m 'ollama\/qwen3:8b' '.*trellis\/oc-1.*' < \/dev\/null/);
      const config = JSON.parse(stdout.match(/OPENCODE_CONFIG_CONTENT='([^']*)'/)[1]);
      assert.deepEqual(config.mcp.trellis.command, ['node', BIN, 'mcp']);
      assert.equal(config.mcp.trellis.environment.TRELLIS_PROJECT, 'oc');
      assert.equal(config.mcp.trellis.environment.TRELLIS_AGENT, 'oc-1');
      assert.ok(config.provider.ollama.models['qwen3:8b']);
      assert.equal(config.permission.bash['git push*'], 'deny');
      assert.deepEqual(readdirSync(repo).sort(), ['.git', 'f'], 'no config file left in the repo');

      await assert.rejects(cli(), (e) => /opencode needs a model/.test(e.stderr));
    } finally {
      server.close();
    }
  });
});

describe('workers on a hub that requires login', () => {
  test('get the agent token, never the human one; --run refuses without one', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trellis-tok-')));
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
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRELLIS_TOKEN: human, TRELLIS_AGENT_TOKEN: '' };
    const cli = (...a) => promisify(execFile)(process.execPath, [BIN, 'worker', '--url', url, '--project', 'lock', '--here', '--as', 'w', ...a], { env, cwd: dir });
    try {
      const printed = (await cli()).stdout;
      assert.match(printed, /"TRELLIS_TOKEN":"<agent-token>"/);
      assert.ok(!printed.includes(human));

      await assert.rejects(cli('--run'), (e) => /workers need their own agent token/.test(e.stderr) && /--agent-token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', human), (e) => /is a human token/.test(e.stderr));
      await assert.rejects(cli('--run', '--agent-token', 'trl_not-a-real-token-at-all'), (e) => /refused the agent token/.test(e.stderr));

      const ran = (await cli('--run', '--agent-token', agent)).stdout;
      assert.match(ran, /ARGS: .*"TRELLIS_TOKEN":"trl_/);
      assert.ok(ran.includes(agent) && !ran.includes(human), 'the agent gets the agent token only');
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
  test('starts one worker for one item, waits for it, then exits when nothing is waiting', async () => {
    const w = world([[route('a', 1)], [route('a', 1)], []]);
    const p = run({ ...w.opts, workers: 3 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(w.workers.length, 1, 'no herd while the first worker has not claimed');
    w.workers[0].finish(0);
    const res = await p;
    assert.equal(res.launched, 1);
    assert.match(res.why, /no work is waiting/);
    assert.match(w.lines.at(-1), /1 launched, 1 exited cleanly, 0 failed \(w1@a:0\)/);
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
