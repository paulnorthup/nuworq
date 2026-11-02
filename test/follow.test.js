import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { follower, system, firstFailure, backups, findWorkspace, KEEP_BACKUPS, importGraph, RESTART_EXIT } from '../src/follow.js';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { Auth } from '../src/auth.js';
import { createServer } from '../src/server.js';

// A pretend world: main's head, which commits pass their tests or start healthy, and what happened.
// out: the commit in the hub's own worktree (checkout moves it); tests run elsewhere (test(sha)).
// full: backups fail (a full disk).
// unbootable: commits that pass their tests but don't boot on copies of the live data (#544).
function world({ red = [], sick = [], full = false, unbootable = [] } = {}) {
  const w = {
    main: 'aaaaaaa1', out: null, up: null, log: [], said: [],
    head: () => w.main,
    checkout: (sha) => { w.out = sha; w.log.push(`checkout ${sha}${w.up ? ' while the hub runs' : ''}`); },
    backup: (sha) => {
      w.log.push(`backup ${sha}${w.up ? ' while the hub runs' : ''}`);
      if (full) throw new Error('ENOSPC: no space left on device');
      return `backups/${sha}.db`;
    },
    restore: (sha) => { w.log.push(`restore ${sha}${w.up ? ' while the hub runs' : ''}`); return `backups/${sha}.db`; },
    test: async (sha) => { w.log.push(`test ${sha}`); return red.includes(sha) ? { ok: false, failed: 'routing › picks work' } : { ok: true }; },
    smoke: async (sha) => {
      w.log.push(`smoke ${sha}${w.up ? ` beside ${w.up}` : ''}`);
      return unbootable.includes(sha) ? { ok: false, failed: `it exited with code 1 at ${sha.slice(0, 7)}: Error: no such table: nope` } : { ok: true };
    },
    start: async () => { w.up = w.out; w.log.push(`start ${w.out}`); },
    alive: () => w.up != null,
    stop: async () => { if (w.up) w.log.push(`stop ${w.up}`); w.up = null; },
    healthy: async () => !w.wedged && !sick.includes(w.up),
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

  test('a commit that passed its tests boots on copies of the live data beside the running hub before it switches (#544)', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    const at = (l) => w.log.indexOf(l);
    assert.ok(at('test bbbbbbb2') < at('smoke bbbbbbb2 beside aaaaaaa1'), 'tested, then booted, while the old hub still runs');
    assert.ok(at('smoke bbbbbbb2 beside aaaaaaa1') < at('stop aaaaaaa1'));
    assert.equal(w.up, 'bbbbbbb2');
    assert.ok(w.said.includes('bbbbbbb boots on copies of the live data'));
    assert.equal(count(w, 'smoke aaaaaaa1'), 0, 'boot has nothing older to run, so it starts main without one');
  });

  test("one that doesn't boot on them never goes live: the hub runs on, the log names the commit and why, and it isn't tried again (#544)", async () => {
    const w = world({ unbootable: ['bbbbbbb2'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.equal(count(w, 'stop'), 0, 'the live hub was never stopped');
    assert.equal(count(w, 'backup'), 0);
    assert.equal(f.state.skip, 'bbbbbbb2');
    assert.ok(w.said.includes("bbbbbbb passes its tests but didn't boot on copies of the live data (it exited with code 1 at bbbbbbb: Error: no such table: nope); staying on aaaaaaa and not trying bbbbbbb again"));
    await f.tick();
    assert.equal(count(w, 'test bbbbbbb2'), 1, 'not tried again');
    w.main = 'ccccccc3';
    await f.tick();
    assert.equal(w.up, 'ccccccc3', 'the next commit goes live as usual');
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

  // Which files each move changes; the supervisor's own code among them is what importGraph finds in this repo.
  const root = join(import.meta.dirname, '..');
  const own = importGraph((f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null));
  const moves = (w, changes, { systemd = false } = {}) => {
    w.ownCode = (from, to) => (changes[`${from}..${to}`] ?? []).filter((f) => own.has(f));
    w.supervised = () => systemd;
    w.exit = (code) => w.log.push(`exit ${code}`);
    return w;
  };

  test("a move that changes the supervisor's own code: in a terminal, it says so once per commit", async () => {
    const w = moves(world(), { 'aaaaaaa1..bbbbbbb2': ['web/app.js', 'src/core.js'], 'bbbbbbb2..ccccccc3': ['src/follow.js', 'README.md'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.ok(!w.said.some((l) => /own code/.test(l)), 'web/app.js and src/core.js are the hub, not the supervisor');
    w.main = 'ccccccc3';
    await f.tick();
    await f.tick();
    assert.equal(w.up, 'ccccccc3', 'the hub still moves');
    assert.deepEqual(w.said.filter((l) => /own code/.test(l)), ["follow's own code changed at ccccccc (src/follow.js); restart serve --follow to run it"]);
    assert.ok(!w.log.some((l) => l.startsWith('exit')));
  });

  test('under systemd, a commit that changes the CLI restarts only the hub; one that changes follow.js restarts the supervisor (#546)', async () => {
    const w = moves(world(), { 'aaaaaaa1..bbbbbbb2': ['bin/nuworq.js', 'src/client.js', 'src/protocol.js', 'src/followhub.js'], 'bbbbbbb2..ccccccc3': ['src/follow.js'] }, { systemd: true });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'bbbbbbb2', 'the hub moved');
    assert.ok(!w.log.some((l) => l.startsWith('exit')) && !w.said.some((l) => /own code/.test(l)), 'the supervisor stays');
    w.main = 'ccccccc3';
    await f.tick();
    assert.deepEqual(w.log.slice(-3), ['start ccccccc3', 'close', `exit ${RESTART_EXIT}`], 'the hub stops first, then the supervisor exits');
    assert.ok(RESTART_EXIT !== 0, 'non-zero, so on-failure restarts it');
    assert.ok(w.said.includes("follow's own code changed at ccccccc (src/follow.js); stopping the hub so systemd restarts serve --follow on it"));
    await f.tick();
    assert.equal(count(w, 'exit'), 1, 'nothing more happens once closed');
  });

  test('a supervisor restarted on the commit it took starts the hub without testing it again (#546)', async () => {
    const w = world();
    let passed = null;
    Object.assign(w, { passed: () => passed, pass: (sha) => { passed = sha; } });
    await follow(w).boot();
    assert.equal(passed, 'aaaaaaa1');
    w.main = 'bbbbbbb2';
    const f = follow(w);
    await f.boot(); // as if restarted, main having moved meanwhile: tested
    assert.equal(count(w, 'test bbbbbbb2'), 1);
    assert.equal(passed, 'bbbbbbb2');
    const again = follow(w);
    await again.boot(); // restarted again on the same main
    assert.equal(count(w, 'test bbbbbbb2'), 1, 'not tested a second time');
    assert.equal(w.up, 'bbbbbbb2');
    assert.ok(w.said.includes('hub running at bbbbbbb; following main; bbbbbbb already passed its tests'));
  });

  test('a restarted supervisor starts on the last commit that passed, not untested main (#620)', async () => {
    const w = world({ red: ['ccccccc3'] });
    let passed = 'aaaaaaa1';
    const ancestors = { aaaaaaa1: ['bbbbbbb2', 'ccccccc3'], bbbbbbb2: ['ccccccc3'] }; // main moved past what passed
    Object.assign(w, { passed: () => passed, pass: (sha) => { passed = sha; }, isAncestor: (a, b) => a === b || !!ancestors[a]?.includes(b) });
    w.main = 'bbbbbbb2';
    const f = follow(w);
    await f.boot();
    assert.equal(w.up, 'aaaaaaa1', 'the hub runs the commit that passed, not main');
    assert.equal(count(w, 'test'), 0, 'nothing is tested at boot');
    assert.ok(w.said.includes('hub running at aaaaaaa, the last commit that passed; following main, which takes bbbbbbb once it passes'));
    await f.tick();
    assert.equal(w.up, 'bbbbbbb2', 'main goes live once it passes, as any move does');
    // Restarted again, main now red: it stays on what passed and stops the line, never running the red commit.
    w.main = 'ccccccc3';
    const again = follow(w);
    await again.boot();
    assert.equal(w.up, 'bbbbbbb2');
    await again.tick();
    assert.equal(w.up, 'bbbbbbb2', 'a red main never goes live');
    assert.equal(count(w, 'red ccccccc3'), 1, 'and its fix is asked for');
    // Main rewritten past it (not an ancestor any more): main as it is, tested, as before.
    passed = 'ddddddd4';
    const third = follow(w);
    await third.boot();
    assert.equal(w.up, 'ccccccc3');
  });

  test("the supervisor's own code is follow.js alone, and it imports only node: modules (#546)", () => {
    assert.deepEqual([...own], ['src/follow.js']);
    const text = readFileSync(join(root, 'src/follow.js'), 'utf8');
    const specs = [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] ?? m[2]);
    assert.ok(specs.length > 3, 'it found the imports');
    for (const s of specs) assert.match(s, /^node:/, s);
    assert.doesNotMatch(text, /\bimport\(\s*[^'"\s]/, 'no computed dynamic import either');
  });

  test("serve --follow hands over to src/follow.js run on its own, and the hub's code only runs in children", () => {
    const cli = readFileSync(join(root, 'bin/nuworq.js'), 'utf8');
    const body = cli.slice(cli.indexOf('async function serveFollow('), cli.indexOf('\n}\n', cli.indexOf('async function serveFollow(')));
    assert.match(body, /spawn\(process\.execPath, \[join\(ROOT, 'src', 'follow\.js'\)/);
    assert.doesNotMatch(body, /import\('\.\.\/src\//, 'the CLI imports none of the supervisor');
  });

  test('src/follow.js runs on its own: a repo it can\'t follow ends it with the reason and the hint, exit 1', () => {
    const data = mkdtempSync(join(tmpdir(), 'nuworq-followmain-'));
    const settings = { repo: data, store: null, dir: join(data, 'hub-src'), next: join(data, 'hub-next'), args: [], url: 'http://127.0.0.1:9', color: false, hint: 'It follows the main branch of x.' };
    let r;
    try {
      execFileSync(process.execPath, [join(root, 'src/follow.js'), JSON.stringify(settings)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { r = e; }
    assert.equal(r?.status, 1);
    assert.match(r.stdout, /^\[follow \d\d:\d\d:\d\d\] following main in /);
    assert.match(r.stderr, /^error: --follow couldn't start the hub: there is no main branch to follow\nhint: It follows the main branch of x\.\n$/);
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

  test('a hub that is up but stops answering is restarted after 3 failed checks in a row (#741)', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    w.wedged = true; // its event loop is stuck: the process lives on
    await f.tick();
    await f.tick();
    assert.equal(count(w, 'stop'), 0, 'two misses are not enough');
    assert.equal(w.up, 'aaaaaaa1');
    w.wedged = false;
    await f.tick();
    w.wedged = true;
    await f.tick();
    await f.tick();
    assert.equal(count(w, 'stop'), 0, 'a check that answers starts the count again');
    await f.tick();
    assert.deepEqual(w.log.slice(-3), ['stop aaaaaaa1', 'checkout aaaaaaa1', 'start aaaaaaa1']);
    assert.ok(w.said.includes('the hub stopped answering (3 health checks in a row); starting it again at aaaaaaa'));
  });

  test('a crash loop backs off (1, 2, 5 min…), says why for nuworq status, and the next healthy check clears it (#741)', async () => {
    const w = world();
    let t = 0;
    w.now = () => t;
    w.trouble = (why) => { w.troubleText = why; };
    const f = follow(w);
    await f.boot();
    const crash = async () => { w.up = null; t += 10_000; await f.tick(); };
    for (let i = 0; i < 3; i++) await crash();
    assert.equal(count(w, 'start'), 4, 'three restarts within 10 minutes');
    await crash();
    assert.equal(count(w, 'start'), 4, 'the fourth waits');
    assert.match(w.troubleText, /^the hub stopped by itself at aaaaaaa, after 3 restarts in 10 minutes; waiting 1 minute before the next \(\d\d:\d\d\)$/);
    t += 30_000;
    await f.tick();
    assert.equal(count(w, 'start'), 4, 'still waiting');
    t += 30_000;
    await f.tick();
    assert.equal(count(w, 'start'), 5, 'tried again once the minute is up');
    await crash();
    assert.equal(count(w, 'start'), 5);
    assert.match(w.troubleText, /waiting 2 minutes/);
    t += 120_000;
    await f.tick();
    assert.equal(count(w, 'start'), 6);
    await crash();
    assert.match(w.troubleText, /waiting 5 minutes/);
    t += 300_000;
    await f.tick();
    assert.equal(count(w, 'start'), 7);
    t += 10_000;
    await f.tick(); // it stays up and answers
    assert.equal(w.troubleText, null);
    assert.ok(w.said.includes('the hub answers again at aaaaaaa'));
  });

  test('a rollback whose old commit also does not answer is started again at the next tick (#741)', async () => {
    const w = world({ sick: ['bbbbbbb2'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    const checkout = w.checkout;
    w.checkout = (sha) => { if (sha === 'bbbbbbb2') w.wedged = true; checkout(sha); }; // the old commit won't answer either
    await f.tick();
    assert.ok(w.said.includes("the hub didn't answer at aaaaaaa either; trying again at the next check"));
    const starts = count(w, 'start aaaaaaa1');
    w.wedged = false;
    await f.tick();
    assert.equal(count(w, 'start aaaaaaa1'), starts + 1, 'not left as is');
    assert.ok(w.said.includes("the hub didn't answer after it started; starting it again at aaaaaaa"));
    assert.equal(f.state.retry, false);
  });

  test('nuworq status shows why serve --follow is backing off, even when the hub does not answer (#741)', () => {
    const data = mkdtempSync(join(tmpdir(), 'nuworq-trouble-'));
    writeFileSync(join(data, 'hub-src.trouble'), 'the hub stopped by itself at aaaaaaa, after 3 restarts in 10 minutes; waiting 1 minute before the next (12:00)\n');
    let r;
    try {
      r = execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'nuworq.js'), 'status', '--data-dir', data, '--url', 'http://127.0.0.1:9', '--project', 'x'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: data, NO_COLOR: '1' } });
    } catch (e) { r = e.stdout; }
    assert.match(r, /^! serve --follow: the hub stopped by itself at aaaaaaa, after 3 restarts/);
  });

  test('each move backs up the database first, with the hub stopped, tagged with the commit it leaves', async () => {
    const w = world();
    const f = follow(w);
    await f.boot();
    assert.equal(count(w, 'backup'), 0, 'boot moves nothing');
    w.main = 'bbbbbbb2';
    await f.tick();
    w.main = 'ccccccc3';
    await f.tick();
    assert.deepEqual(w.log.filter((l) => l.startsWith('backup')), ['backup aaaaaaa1', 'backup bbbbbbb2']);
    const at = (l) => w.log.indexOf(l);
    assert.ok(at('stop aaaaaaa1') < at('backup aaaaaaa1') && at('backup aaaaaaa1') < at('checkout bbbbbbb2'));
    assert.ok(!w.log.some((l) => l.endsWith('while the hub runs')));
    assert.equal(count(w, 'restore'), 0, 'healthy moves restore nothing');
  });

  test('a rollback puts back the database from before the move, before the old hub starts', async () => {
    const w = world({ sick: ['bbbbbbb2'] });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    const at = (l) => w.log.lastIndexOf(l);
    assert.ok(at('stop bbbbbbb2') < at('restore aaaaaaa1'), 'the sick hub is stopped first');
    assert.ok(at('restore aaaaaaa1') < at('checkout aaaaaaa1') && at('checkout aaaaaaa1') < at('start aaaaaaa1'));
    assert.ok(!w.log.some((l) => l.endsWith('while the hub runs')));
    assert.ok(w.said.includes('put the database back as it was at aaaaaaa, before bbbbbbb started'));
  });

  test("a backup that fails aborts the move: the old hub runs on, with one line saying why", async () => {
    const w = world({ full: true });
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.equal(w.out, 'aaaaaaa1', "the hub's worktree never moved");
    assert.equal(count(w, 'checkout bbbbbbb2'), 0);
    assert.equal(f.state.running, 'aaaaaaa1');
    const why = w.said.filter((l) => /couldn't back up/.test(l));
    assert.deepEqual(why, ["couldn't back up the database before moving (ENOSPC: no space left on device); staying on aaaaaaa and not trying bbbbbbb again; the next commit on main tries again"]);
    await f.tick();
    assert.equal(count(w, 'backup'), 1, 'not retried every check');
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

describe('database backups, on real files', () => {
  const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-backup-')));
  // A database the way the hub keeps one: WAL, with rows not yet checkpointed into the main file.
  const makeDb = (file, rows = ['one']) => {
    const d = new DatabaseSync(file);
    d.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)');
    for (const r of rows) d.prepare('INSERT INTO items (title) VALUES (?)').run(r);
    return d; // left open: the WAL stays
  };
  const columns = (file) => { const d = new DatabaseSync(file); try { return d.prepare('PRAGMA table_info(items)').all().map((c) => c.name); } finally { d.close(); } };
  const titles = (file) => { const d = new DatabaseSync(file); try { return d.prepare('SELECT title FROM items ORDER BY id').all().map((r) => r.title); } finally { d.close(); } };

  test('a backup holds what was in the WAL; restore undoes a migration', () => {
    const root = scratch();
    const db = join(root, 'nuworq.db');
    const open = makeDb(db, ['one', 'two']);
    assert.ok(existsSync(`${db}-wal`));
    const store = backups({ dir: join(root, 'backups'), db });
    assert.equal(store.backup('aaaaaaa1'), join(root, 'backups', 'aaaaaaa1.db'));
    open.close();
    assert.deepEqual(titles(join(root, 'backups', 'aaaaaaa1.db')), ['one', 'two']);
    const d = new DatabaseSync(db);
    d.exec("ALTER TABLE items ADD COLUMN repo TEXT NOT NULL DEFAULT ''; INSERT INTO items (title) VALUES ('three')");
    d.close();
    assert.ok(columns(db).includes('repo'));
    store.restore('aaaaaaa1');
    assert.deepEqual(columns(db), ['id', 'title']);
    assert.deepEqual(titles(db), ['one', 'two']);
    assert.ok(!existsSync(`${db}-wal`), "no WAL from the newer code is left to replay over the copy");
    assert.equal(store.restore('nope'), null, 'no copy, nothing restored');
  });

  test(`only the last ${KEEP_BACKUPS} are kept, oldest removed`, () => {
    const root = scratch();
    const db = join(root, 'nuworq.db');
    makeDb(db).close();
    const store = backups({ dir: join(root, 'backups'), db });
    const shas = Array.from({ length: KEEP_BACKUPS + 1 }, (_, i) => `${i}`.padStart(7, '0'));
    for (const s of shas) store.backup(s);
    const left = readdirSync(join(root, 'backups')).filter((f) => f.endsWith('.db')).sort();
    assert.equal(left.length, KEEP_BACKUPS);
    assert.ok(!left.includes(`${shas[0]}.db`), 'the oldest went');
    assert.ok(left.includes(`${shas.at(-1)}.db`));
  });

  test('with workspaces, every workspace file and the host directory are backed up and restored together', () => {
    const root = scratch();
    const ws = join(root, 'workspaces');
    mkdirSync(ws);
    makeDb(join(ws, 'acme.db'), ['a']).close();
    makeDb(join(ws, 'beta.db'), ['b']).close();
    makeDb(join(ws, 'directory.sqlite'), ['people']).close();
    const store = backups({ dir: join(root, 'backups'), workspaces: ws });
    store.backup('aaaaaaa1');
    assert.deepEqual(readdirSync(join(root, 'backups', 'aaaaaaa1')).sort(), ['acme.db', 'beta.db', 'directory.sqlite']);
    for (const f of ['acme.db', 'beta.db', 'directory.sqlite']) {
      const d = new DatabaseSync(join(ws, f));
      d.exec("ALTER TABLE items ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
      d.close();
    }
    writeFileSync(join(ws, 'directory.sqlite-wal'), 'from the newer code');
    store.restore('aaaaaaa1');
    assert.deepEqual(columns(join(ws, 'acme.db')), ['id', 'title']);
    assert.deepEqual(columns(join(ws, 'beta.db')), ['id', 'title']);
    assert.deepEqual(columns(join(ws, 'directory.sqlite')), ['id', 'title'], "the directory's migration is undone too");
    assert.ok(!existsSync(join(ws, 'directory.sqlite-wal')));
    assert.deepEqual(new Workspaces({ dir: ws }).list(), ['acme', 'beta'], 'the directory is still never a workspace');
  });

  test('a backup that fails leaves no copy behind that could pass for good', () => {
    const root = scratch();
    const db = join(root, 'nuworq.db');
    writeFileSync(db, 'not a database');
    const store = backups({ dir: join(root, 'backups'), db });
    assert.throws(() => store.backup('aaaaaaa1'));
    assert.deepEqual(readdirSync(join(root, 'backups')), []);
  });

  test('a candidate that migrates the database on startup and never answers is rolled back, and so is its migration', async () => {
    const root = scratch();
    const db = join(root, 'nuworq.db');
    makeDb(db).close();
    const w = world({ sick: ['bbbbbbb2'] });
    const store = backups({ dir: join(root, 'backups'), db });
    Object.assign(w, { backup: store.backup, restore: store.restore });
    const start = w.start;
    // bbbbbbb2's code adds a column as it starts, then never answers.
    w.start = async () => {
      await start();
      if (w.up === 'bbbbbbb2') { const d = new DatabaseSync(db); d.exec("ALTER TABLE items ADD COLUMN repo TEXT NOT NULL DEFAULT ''"); d.close(); }
    };
    const f = follow(w);
    await f.boot();
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.deepEqual(columns(db), ['id', 'title'], 'the column bbbbbbb2 added is gone');
    assert.ok(w.said.some((l) => l.startsWith('put the database back as it was at aaaaaaa')));
  });
});

describe('a smoke boot on copies of the live data, for real (#544)', () => {
  const ROOT = realpathSync(new URL('..', import.meta.url));
  // ROOT as it is checked out: smoke() checks out any other commit in next, and next is this checkout here.
  const HEAD = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-smokes-')));
  const smokes = () => readdirSync(tmpdir()).filter((f) => f.startsWith('nuworq-smoke-')).sort();
  const columns = (file) => { const d = new DatabaseSync(file); try { return d.prepare('PRAGMA table_info(items)').all().map((c) => c.name); } finally { d.close(); } };
  // HOME is somewhere new, so a smoke boot that wrote hub.json (pointing this machine's agents at it) would show.
  let home;
  const saved = process.env.HOME;
  before(() => { home = scratch(); process.env.HOME = home; });
  after(() => { process.env.HOME = saved; });

  test("nuworq's own serve --smoke boots on a copy of one hub's database, answers health, and leaves nothing behind", async () => {
    const root = scratch();
    const db = join(root, 'nuworq.db');
    const hub = new Hub({ file: db });
    hub.tx(() => hub.project('app', { create: true }));
    hub.humanOp('app', 'create', { title: 'Something to boot with', acceptance: 'x' });
    hub.db.close();
    const before = smokes();
    const sys = system({ repo: ROOT, dir: join(root, 'hub-src'), next: ROOT, url: 'http://127.0.0.1:1', store: backups({ dir: join(root, 'backups'), db }) });
    assert.deepEqual(await sys.smoke(HEAD), { ok: true });
    assert.deepEqual(smokes(), before, 'the copies are removed');
    assert.ok(!existsSync(join(home, '.nuworq', 'hub.json')), "a smoke boot doesn't tell this machine's agents about itself");
  });

  test('with workspaces, it opens every workspace, so each one migrates before health answers', async () => {
    const root = scratch();
    const ws = join(root, 'workspaces');
    const spaces = new Workspaces({ dir: ws });
    spaces.create('acme');
    spaces.create('beta');
    spaces.close();
    const sys = system({ repo: ROOT, dir: join(root, 'hub-src'), next: ROOT, url: 'http://127.0.0.1:1', store: backups({ dir: join(root, 'backups'), workspaces: ws }) });
    assert.deepEqual(await sys.smoke(HEAD), { ok: true });
    const broken = new DatabaseSync(join(ws, 'beta.db'));
    broken.exec('DROP TABLE items; CREATE VIEW items AS SELECT 1 AS id');
    broken.close();
    const r = await sys.smoke(HEAD);
    assert.equal(r.ok, false, "a workspace that can't open fails the boot, though nothing asked for it");
    assert.match(r.failed, new RegExp(`^it exited with code 1 at ${HEAD.slice(0, 7)}: \\w*Error: `));
  });

  test("in a repo, a commit whose migration fails on the live data doesn't boot, and names why; the live database is untouched", async () => {
    const root = scratch();
    const repo = join(root, 'repo');
    const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    mkdirSync(join(repo, 'bin'), { recursive: true });
    mkdirSync(join(repo, 'test'));
    g('init', '-q', '-b', 'main');
    // A hub that migrates its --db from migration.sql as it starts, then answers on --port.
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
    writeFileSync(join(repo, 'test', 'ok.test.js'), "import { test } from 'node:test';\ntest('ok', () => {});\n");
    writeFileSync(join(repo, 'bin', 'nuworq.js'), `import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import http from 'node:http';
const a = process.argv.slice(2), at = (f) => a[a.indexOf(f) + 1];
if (a[0] !== 'serve' || !a.includes('--smoke') || at('--host') !== '127.0.0.1') throw new Error('not a smoke boot: ' + a.join(' '));
if (Object.keys(process.env).some((k) => k.startsWith('NUWORQ_'))) throw new Error('the hub settings reached it');
new DatabaseSync(at('--db')).exec(readFileSync(new URL('../migration.sql', import.meta.url), 'utf8'));
http.createServer((req, res) => res.end('{"ok":true}')).listen(Number(at('--port')), '127.0.0.1');
`);
    writeFileSync(join(repo, 'migration.sql'), "ALTER TABLE items ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
    g('add', '.');
    g('commit', '-q', '-m', 'good');
    const good = g('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'migration.sql'), 'ALTER TABLE nope ADD COLUMN repo TEXT');
    g('commit', '-q', '-am', 'broken');
    const bad = g('rev-parse', 'HEAD');

    const db = join(root, 'nuworq.db');
    const live = new DatabaseSync(db);
    live.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)');
    const sys = system({ repo, dir: join(root, 'hub-src'), next: join(root, 'hub-next'), url: 'http://127.0.0.1:1', store: backups({ dir: join(root, 'backups'), db }) });
    process.env.NUWORQ_TOKEN_FOR_SMOKE_TEST = 'secret';
    try {
      const before = smokes();
      // No sys.test first: a commit CI passed (#543) reaches smoke() with nothing checked out for it yet.
      assert.deepEqual(await sys.smoke(good), { ok: true }, 'booted while the live database is open');
      assert.deepEqual(await sys.test(bad), { ok: true }, 'its tests pass: only real data shows it');
      const r = await sys.smoke(bad);
      assert.equal(r.ok, false);
      assert.equal(r.failed, `it exited with code 1 at ${bad.slice(0, 7)}: Error: no such table: nope`);
      assert.deepEqual(await sys.smoke(good), { ok: true }, 'it boots the commit asked for, not the one last tested');
      assert.deepEqual(smokes(), before, 'the copies are removed either way');
      assert.deepEqual(columns(db), ['id', 'title'], 'only the copies were migrated');
    } finally {
      delete process.env.NUWORQ_TOKEN_FOR_SMOKE_TEST;
      live.close();
      try { g('worktree', 'remove', '--force', join(root, 'hub-next')); } catch {}
    }
  });
});

describe('reading npm test output', () => {
  test('names the first failing test with its suites (spec), or the test (TAP)', () => {
    const spec = `▶ routing\n  ✔ ok one (0.3ms)\n  ▶ picking\n    ✖ picks work (0.6ms)\n  ✖ picking (1ms)\n✖ routing (1.6ms)\n✖ top fail (0.8ms)\nℹ fail 2\n\n✖ failing tests:\n`;
    assert.equal(firstFailure(spec), 'routing › picking › picks work');
    assert.equal(firstFailure('✖ test/broken.test.js (12ms)\n'), 'test/broken.test.js');
    const tap = 'TAP version 13\n# Subtest: routing\n    # Subtest: picks work\n    not ok 2 - picks work\n      ---\nnot ok 1 - routing\n';
    assert.equal(firstFailure(tap), 'routing › picks work', 'the same name as the spec reporter gives (#257: Node 22 pipes TAP)');
    assert.equal(firstFailure('TAP version 13\n# Subtest: test/broken.test.js\nnot ok 1 - test/broken.test.js\n'), 'test/broken.test.js');
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

  test('on a hub with workspaces, red main becomes the item in the workspace whose project has the repo (#561)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-redws-')));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);
    const spaces = new Workspaces({ dir: join(root, 'ws') });
    for (const name of ['acme', 'other']) {
      spaces.create(name);
      const h = spaces.get(name);
      h.tx(() => h.project('app', { create: true }));
    }
    // Only acme's project has this repository; other has a project of the same name for another one.
    const acme = spaces.get('acme');
    acme.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(acme.project('app').id, 'github.com/acme/app', 0);
    spaces.get('other').q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(spaces.get('other').project('app').id, 'github.com/other/app', 0);
    const token = new Auth(acme.db).createToken('follow', 'human');
    const server = createServer(spaces);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const saved = process.env.NUWORQ_TOKEN;
    try {
      assert.deepEqual(findWorkspace({ workspaces: join(root, 'ws'), repo, remote: 'github.com/acme/app' }), { workspace: 'acme', project: 'app' });
      const sys = (o = {}) => system({ repo, dir: join(root, 'hub-src'), url, workspaces: join(root, 'ws'), ...o });

      // No token: the workspace refuses, and the error says what to give serve --follow.
      delete process.env.NUWORQ_TOKEN;
      await assert.rejects(sys().redMain('abcdef1234567890', 'math › adds', '1234567abcdef'), /workspace acme refused it .*NUWORQ_TOKEN.*--workspace acme/);

      process.env.NUWORQ_TOKEN = token;
      assert.equal(await sys().redMain('abcdef1234567890', 'math › adds', '1234567abcdef'), '#1 in acme/app');
      assert.deepEqual(acme.q('SELECT title, priority, stage FROM items').all().map((i) => ({ ...i })), [{ title: 'main fails its tests at abcdef1: math › adds', priority: 'now', stage: 'ready' }]);
      assert.equal(spaces.get('other').q('SELECT COUNT(*) AS n FROM items').get().n, 0, 'the other workspace is untouched');

      // A workspace named that has no project for the repo: the error names the repo and how to configure it.
      await assert.rejects(sys({ workspace: 'other' }).redMain('abcdef1234567890', 'math › adds', '1234567abcdef'), /no project in workspace other for github\.com\/acme\/app\. Link the repository .* --workspace <name>/);
    } finally {
      if (saved === undefined) delete process.env.NUWORQ_TOKEN; else process.env.NUWORQ_TOKEN = saved;
      server.close();
      spaces.close();
    }
  });

  test("fix main files only in the workspace bound to the repo's installation (#614)", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-redbound-')));
    const spaces = new Workspaces({ dir: join(root, 'ws') });
    // "aaa" sorts first and links acme's public repository too; acme is the one its App installation is bound to.
    for (const name of ['aaa', 'acme']) {
      spaces.create(name);
      const h = spaces.get(name);
      h.tx(() => h.project('app', { create: true }));
      h.q('INSERT INTO project_remotes (project_id, remote, at) VALUES (?, ?, ?)').run(h.project('app').id, 'github.com/acme/app', 0);
    }
    try {
      const find = (o = {}) => findWorkspace({ workspaces: join(root, 'ws'), repo: join(root, 'repo'), remote: 'github.com/acme/app', ...o });
      assert.throws(() => find(), /2 workspaces have a project for github\.com\/acme\/app \(aaa, acme\) and none is bound .*--workspace <name>/, 'never the first by name');
      spaces.directory.bindInstallation(4242, 'acme');
      assert.deepEqual(find({ installation: 4242 }), { workspace: 'acme', project: 'app' }, 'the installation decides');
      assert.throws(() => find({ installation: 999 }), /none is bound/, 'an installation bound elsewhere decides nothing');
      assert.deepEqual(find({ workspace: 'aaa' }), { workspace: 'aaa', project: 'app' }, 'a workspace the host names stands');
    } finally {
      spaces.close();
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
