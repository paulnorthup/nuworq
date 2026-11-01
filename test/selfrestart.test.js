// A runner moves onto a newly installed nuworq by itself (#456): between rounds it notices the package under it
// changed; as a service it lets its workers finish and exits 0 so launchd or systemd starts it on the new code;
// started by hand it only says so.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { run } from '../src/runner.js';
import { installed, differs } from '../src/update.js';
import { supervised, LABEL } from '../src/service.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const route = (project, claimable) => ({ project, name: project, item: '#1', title: 't', mode: 'work', claimable, holders: [] });
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Time moves only when the runner sleeps; workers exit when the test says.
function world(routes) {
  let t = 0;
  const workers = [];
  const lines = [];
  let change = null;
  return {
    workers, lines, update: (c) => { change = c; },
    opts: {
      routes: async () => routes,
      launch: async (r) => {
        let finish;
        const w = { name: `w${workers.length + 1}`, project: r.project, signals: [], exited: new Promise((res) => { finish = res; }) };
        w.finish = finish;
        w.kill = (sig) => w.signals.push(sig);
        workers.push(w);
        return w;
      },
      updated: () => change,
      log: (l) => lines.push(l),
      now: () => t,
      sleep: async (ms) => { t += ms; await new Promise((r) => setImmediate(r)); },
      pollSeconds: 1,
    },
  };
}

describe('run: moving onto a newly installed nuworq (#456)', () => {
  test('as a service, it waits for running workers, starts no new ones, then restarts', async () => {
    const w = world([route('a', 5)]);
    const p = run({ ...w.opts, workers: 2, supervised: true });
    while (w.workers.length < 2) await tick();
    w.update('0.4.0 (aaaaaaa) → 0.4.1 (bbbbbbb)');
    await tick(30);
    assert.ok(w.lines.some((l) => /restarting onto it once 2 running worker\(s\) finish/.test(l)), w.lines.join('\n'));
    w.workers[0].finish(0);
    await tick(30);
    assert.equal(w.workers.length, 2, 'no replacement starts while it waits');
    assert.deepEqual(w.workers.map((x) => x.signals), [[], []], 'it never stops a running worker');
    let settled = false;
    p.then(() => { settled = true; });
    await tick(30);
    assert.equal(settled, false, 'still waiting on the second worker');
    w.workers[1].finish(0);
    const res = await p;
    assert.equal(res.restart, true);
    assert.equal(w.lines.at(-1), 'nuworq updated 0.4.0 (aaaaaaa) → 0.4.1 (bbbbbbb): restarting onto it');
  });

  test('as a service with nothing running, it restarts at once', async () => {
    const w = world([]);
    w.update('a → b');
    const res = await run({ ...w.opts, supervised: true });
    assert.equal(res.restart, true);
    assert.equal(w.workers.length, 0);
  });

  test('started by hand, it says once that it runs old code, and keeps going', async () => {
    const w = world([route('a', 5)]);
    let interrupt;
    const p = run({ ...w.opts, workers: 1, onInterrupt: (fn) => { interrupt = fn; } });
    while (!w.workers.length) await tick();
    w.update('a → b');
    w.workers[0].finish(0);
    while (w.workers.length < 2) await tick();
    await tick(30);
    assert.equal(w.lines.filter((l) => /still runs the old code: restart it/.test(l)).length, 1, w.lines.join('\n'));
    interrupt();
    w.workers.forEach((x) => x.finish(0));
    const res = await p;
    assert.equal(res.restart, false);
    assert.equal(res.why, 'interrupted');
  });
});

describe('what is installed, and whether this is the service', () => {
  test('installed reads commit.txt and package.json; differs compares commits, else versions', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuworq-inst-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"version":"0.4.0"}');
    writeFileSync(join(root, 'src', 'commit.txt'), '$Format:%H %ct$\n');
    const checkout = installed(root);
    assert.deepEqual(checkout, { commit: null, version: '0.4.0', label: '0.4.0' });
    writeFileSync(join(root, 'src', 'commit.txt'), `${'a'.repeat(40)} 1793462965\n`);
    const a = installed(root);
    assert.equal(a.label, '0.4.0 (aaaaaaa)');
    writeFileSync(join(root, 'src', 'commit.txt'), `${'b'.repeat(40)} 1793462999\n`);
    assert.equal(differs(a, installed(root)), true, 'a new commit, same version');
    assert.equal(differs(a, a), false);
    assert.equal(differs(checkout, { commit: null, version: '0.4.1' }), true);
  });

  test('the service is known by its own marker or launchd\'s job label, not by systemd\'s INVOCATION_ID', () => {
    assert.equal(supervised({ NUWORQ_SERVICE: LABEL }), true);
    assert.equal(supervised({ XPC_SERVICE_NAME: LABEL }), true, 'a LaunchAgent installed before the marker');
    assert.equal(supervised({ XPC_SERVICE_NAME: 'application.com.apple.Terminal.123' }), false);
    assert.equal(supervised({ INVOCATION_ID: 'abc' }), false);
    assert.equal(supervised({}), false);
  });
});

describe('nuworq run, when its package is replaced on disk (#456)', () => {
  // A copy of the package, so the test can replace its commit.txt as an update would.
  async function runner(env) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-restart-')));
    const pkg = join(dir, 'pkg'), home = join(dir, 'home');
    for (const d of ['bin', 'src']) cpSync(join(REPO, d), join(pkg, d), { recursive: true });
    cpSync(join(REPO, 'package.json'), join(pkg, 'package.json'));
    writeFileSync(join(pkg, 'src', 'commit.txt'), `${'a'.repeat(40)} 1793462965\n`);
    mkdirSync(home);
    const server = createServer(new Hub());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, [join(pkg, 'bin', 'nuworq.js'), 'run', '--url', url, '--poll', '1'], {
      cwd: home,
      env: { ...process.env, HOME: home, NUWORQ_TOKEN: '', NUWORQ_AGENT_TOKEN: '', NUWORQ_NO_UPDATE: '1', NUWORQ_SERVICE: '', XPC_SERVICE_NAME: '', ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise((r) => child.on('exit', (code) => r(code)));
    const until = async (re) => { for (let i = 0; i < 300 && !re.test(out); i++) await tick(50); assert.match(out, re); };
    const update = () => writeFileSync(join(pkg, 'src', 'commit.txt'), `${'b'.repeat(40)} 1793462999\n`);
    return { child, exited, until, update, out: () => out, close: () => { child.kill('SIGKILL'); server.close(); } };
  }

  test('as the service, it exits 0 with nothing running, so the service starts it on the new code', async () => {
    const r = await runner({ NUWORQ_SERVICE: LABEL });
    try {
      await r.until(/Nothing is waiting/);
      r.update();
      assert.equal(await r.exited, 0, r.out());
      assert.match(r.out(), /nuworq updated \S+ \(aaaaaaa\) → \S+ \(bbbbbbb\): restarting onto it/);
    } finally { r.close(); }
  });

  test('started by hand, it only warns and keeps running', async () => {
    const r = await runner({});
    try {
      await r.until(/Nothing is waiting/);
      r.update();
      await r.until(/still runs the old code: restart it/);
      assert.equal(r.child.exitCode, null, 'still running');
    } finally { r.close(); }
  });
});
