import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { follower, system, firstFailure } from '../src/follow.js';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

// A pretend world: main's head, which commits pass their tests or start healthy, and what happened.
// out: the commit in the hub's own worktree (checkout moves it); tests run elsewhere (test(sha)).
function world({ red = [], sick = [] } = {}) {
  const w = {
    main: 'aaaaaaa1', out: null, up: null, log: [], said: [],
    head: () => w.main,
    checkout: (sha) => { w.out = sha; w.log.push(`checkout ${sha}${w.up ? ' while the hub runs' : ''}`); },
    test: async (sha) => { w.log.push(`test ${sha}`); return red.includes(sha) ? { ok: false, failed: 'routing › picks work' } : { ok: true }; },
    start: async () => { w.up = w.out; w.log.push(`start ${w.out}`); },
    alive: () => w.up != null,
    stop: async () => { if (w.up) w.log.push(`stop ${w.up}`); w.up = null; },
    healthy: async () => !sick.includes(w.up),
    redMain: async (sha, failed, running) => { w.log.push(`red ${sha} ${failed} (running ${running})`); return '#9 in nuworq'; },
    close: async () => { w.log.push('close'); w.up = null; },
  };
  return w;
}
const follow = (w) => follower(w, { log: (l) => w.said.push(l) });
const count = (w, prefix) => w.log.filter((l) => l.startsWith(prefix)).length;

describe('the hub follows main', () => {
  test('when main moves and its tests pass, the hub restarts on it', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    assert.equal(w.up, 'aaaaaaa1');
    await f.tick();
    assert.equal(count(w, 'start'), 1, 'nothing moved, nothing restarts');
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'bbbbbbb2');
    assert.equal(f.state.good, 'bbbbbbb2');
    const at = (l) => w.log.indexOf(l);
    assert.ok(at('test bbbbbbb2') < at('stop aaaaaaa1'), 'tested while the old hub runs');
    assert.ok(at('stop aaaaaaa1') < at('checkout bbbbbbb2') && at('checkout bbbbbbb2') < at('start bbbbbbb2'),
      "the hub's worktree moves only once the old hub has stopped, right before the new one starts");
    assert.ok(!w.log.some((l) => l.endsWith('while the hub runs')), "the running hub's files never change under it");
    assert.ok(w.said.includes('hub moved to bbbbbbb'));
  });

  test('boot starts main and tests it; red at boot still files the fix (the hub runs it anyway)', async () => {
    const w = world({ red: ['aaaaaaa1', 'bbbbbbb2'] });
    const f = follow(w);
    await f.boot();
    assert.equal(w.up, 'aaaaaaa1', 'nothing better to run');
    assert.deepEqual(w.log.filter((l) => l.startsWith('red')), ['red aaaaaaa1 routing › picks work (running aaaaaaa1)']);
    assert.ok(w.said.includes('main at aaaaaaa fails its tests (routing › picks work); running it anyway: there is nothing older to run'));
    await f.tick();
    assert.equal(count(w, 'test aaaaaaa1'), 1, 'the running commit is not tested again');
    w.main = 'bbbbbbb2'; // still red: same streak
    await f.tick();
    assert.equal(count(w, 'red '), 1);
    assert.equal(w.up, 'aaaaaaa1');
    w.main = 'ccccccc3'; // green
    await f.tick();
    assert.equal(w.up, 'ccccccc3');
    assert.equal(f.state.red, false);
  });

  test('green at boot: tested once, nothing filed', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    assert.deepEqual(w.log, ['checkout aaaaaaa1', 'start aaaaaaa1', 'test aaaaaaa1']);
    assert.ok(w.said.includes('aaaaaaa passes its tests'));
  });

  test('red main: the hub stays put, and the fix goes to the front of the queue once per red streak', async () => {
    const w = world({ red: ['bbbbbbb2', 'ccccccc3', 'eeeeeee5'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.equal(w.out, 'aaaaaaa1', "the hub's worktree never moved");
    assert.equal(count(w, 'checkout'), 1, 'only the boot checkout');
    assert.equal(count(w, 'start'), 1, 'the hub was never restarted');
    assert.equal(count(w, 'test bbbbbbb2'), 1, 'a red commit is tested once');
    assert.ok(w.said.includes('main at bbbbbbb fails its tests (routing › picks work); staying on aaaaaaa'));
    w.main = 'ccccccc3'; // still red: same streak, nobody asked twice
    await f.tick();
    assert.deepEqual(w.log.filter((l) => l.startsWith('red')), ['red bbbbbbb2 routing › picks work (running aaaaaaa1)']);
    w.main = 'ddddddd4'; // the fix lands
    await f.tick();
    assert.equal(w.up, 'ddddddd4');
    assert.equal(f.state.red, false);
    w.main = 'eeeeeee5'; // a new red streak asks again
    await f.tick();
    assert.equal(count(w, 'red '), 2);
  });

  test('a new hub that does not come up healthy is rolled back to the last good commit', async () => {
    const w = world({ sick: ['bbbbbbb2'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.equal(w.out, 'aaaaaaa1');
    assert.equal(f.state.running, 'aaaaaaa1');
    await f.tick();
    assert.equal(w.log.filter((l) => l === 'start bbbbbbb2').length, 1, 'a commit that failed to start is not retried');
    w.main = 'ccccccc3';
    await f.tick();
    assert.equal(w.up, 'ccccccc3', 'the next commit gets a fresh try');
  });

  test("a commit that doesn't start is not a red streak: the next red commit still asks for a fix", async () => {
    const w = world({ sick: ['bbbbbbb2'], red: ['ccccccc3'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    w.main = 'ccccccc3';
    await f.tick();
    assert.deepEqual(w.log.filter((l) => l.startsWith('red')), ['red ccccccc3 routing › picks work (running aaaaaaa1)']);
  });

  test('if the fix could not be asked for, the next red commit asks again', async () => {
    const w = world({ red: ['bbbbbbb2', 'ccccccc3'] });
    let calls = 0;
    w.redMain = async () => { calls++; if (calls === 1) throw new Error('hub not reachable'); return '#3 in nuworq'; };
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    w.main = 'ccccccc3';
    await f.tick();
    assert.equal(calls, 2);
    assert.equal(f.state.red, true);
  });

  test('a hub that stops by itself is started again on the same commit', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    w.up = null; // it crashed
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.ok(w.said.some((l) => l.startsWith('the hub stopped by itself')));
  });

  test('closing stops the hub and nothing starts after it', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    await f.close();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, null);
    assert.equal(count(w, 'start bbbbbbb2'), 0);
  });
});

describe('reading npm test output', () => {
  test('names the first failing test with its suites (spec), or the test (TAP)', () => {
    const spec = `▶ routing\n  ✔ ok one (0.3ms)\n  ▶ picking\n    ✖ picks work (0.6ms)\n  ✖ picking (1ms)\n✖ routing (1.6ms)\n✖ top fail (0.8ms)\nℹ fail 2\n\n✖ failing tests:\n`;
    assert.equal(firstFailure(spec), 'routing › picking › picks work');
    assert.equal(firstFailure('✖ test/broken.test.js (12ms)\n'), 'test/broken.test.js');
    const tap = 'TAP version 13\n# Subtest: routing\n    # Subtest: picks work\n    not ok 2 - picks work\n      ---\nnot ok 1 - routing\n';
    assert.equal(firstFailure(tap), 'picks work');
    assert.equal(firstFailure('npm ERR! missing script: test'), null);
  });
});

describe('the real world, in a scratch repo', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-follow-')));
  const repo = join(dir, 'repo');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const saved = {};
  const suite = (sum) => `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('math', () => { test('adds', () => assert.equal(1 + 1, ${sum})); });\n`;
  let green, redSha;
  before(() => {
    for (const k of ['NUWORQ_TOKEN', 'TRELLIS_TOKEN', 'NUWORQ_PROJECT', 'TRELLIS_PROJECT']) { saved[k] = process.env[k]; delete process.env[k]; }
    // main: a green commit, then a red one.
    mkdirSync(join(repo, 'test'), { recursive: true });
    g('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
    writeFileSync(join(repo, 'test', 'math.test.js'), suite(2));
    g('add', '.');
    g('commit', '-q', '-m', 'green');
    green = g('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'test', 'math.test.js'), suite(3));
    g('commit', '-q', '-am', 'red');
    redSha = g('rev-parse', 'HEAD');
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    for (const wt of ['hub-src', 'hub-next']) try { g('worktree', 'remove', '--force', join(dir, wt)); } catch {}
  });

  test("candidates are tested in their own detached worktree; the hub's worktree stays put", async () => {
    const hubSrc = join(dir, 'hub-src');
    const hubNext = join(dir, 'hub-next');
    const sys = system({ repo, dir: hubSrc, next: hubNext, url: 'http://127.0.0.1:1' });
    assert.equal(sys.head('main'), redSha);
    assert.equal(sys.head('no-such-branch'), null);
    const at = (wt, ...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

    sys.checkout(green);
    assert.ok(existsSync(join(hubSrc, '.git')), 'a worktree of the repo');
    assert.equal(at(hubSrc, 'rev-parse', 'HEAD'), green);
    assert.throws(() => at(hubSrc, 'symbolic-ref', '-q', 'HEAD'), 'detached, on no branch');

    assert.deepEqual(await sys.test(redSha), { ok: false, failed: 'math › adds' });
    assert.equal(at(hubNext, 'rev-parse', 'HEAD'), redSha);
    assert.throws(() => at(hubNext, 'symbolic-ref', '-q', 'HEAD'), 'detached too');
    assert.equal(at(hubSrc, 'rev-parse', 'HEAD'), green, "testing never moves the hub's worktree");
    assert.deepEqual(await sys.test(green), { ok: true }, 'the test worktree is reused');
    assert.equal(at(hubNext, 'rev-parse', 'HEAD'), green);
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main', "the human's checkout is untouched");
  });

  test('red main becomes one item at priority now in the project that lives in the repo', async () => {
    const hub = new Hub();
    hub.tx(() => hub.project('fol', { create: true }));
    hub.humanOp('fol', 'settings', { path: repo });
    const server = createServer(hub);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const sys = system({ repo, dir: join(dir, 'hub-src'), url: `http://127.0.0.1:${server.address().port}` });
      const where = await sys.redMain('abcdef1234567890', 'math › adds', '1234567abcdef');
      assert.equal(where, '#1 in fol');
      const items = hub.q('SELECT title, priority, stage FROM items').all();
      assert.deepEqual(items.map((i) => ({ ...i })), [{ title: 'main fails its tests at abcdef1: math › adds', priority: 'now', stage: 'ready' }]);
    } finally {
      server.close();
    }
  });
});

describe('a server checkout follows GitHub', () => {
  test('head() fast-forwards main from its upstream, and leaves a checkout that is ahead alone', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pull-')));
    const g = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const commit = (cwd, file) => { writeFileSync(join(cwd, file), file); g(cwd, 'add', '.'); g(cwd, 'commit', '-q', '-m', file); return g(cwd, 'rev-parse', 'HEAD'); };
    mkdirSync(join(root, 'dev'));
    g(join(root, 'dev'), 'init', '-q', '-b', 'main');
    commit(join(root, 'dev'), 'a');
    g(root, 'clone', '-q', '--bare', join(root, 'dev'), 'hub.git');
    g(join(root, 'dev'), 'remote', 'add', 'origin', join(root, 'hub.git'));
    g(root, 'clone', '-q', join(root, 'hub.git'), 'server');
    const server = system({ repo: join(root, 'server'), dir: join(root, 'src'), fetchMs: 0 });

    const b = commit(join(root, 'dev'), 'b');
    g(join(root, 'dev'), 'push', '-q', 'origin', 'main');
    assert.equal(server.head('main'), b, 'the server pulled the new main');

    const local = commit(join(root, 'server'), 'landed-here');
    assert.equal(server.head('main'), local, 'a checkout ahead of its upstream keeps its own main');
  });
});
