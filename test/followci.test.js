import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { follower } from '../src/follow.js';
import { checkOn } from '../src/ghapp.js';

// A pretend world whose main moves, with CI's verdict per commit (ci: sha → answer) and a clock.
function world(ci) {
  const w = {
    main: 'aaaaaaa1', out: null, up: null, log: [], said: [], t: 0,
    now: () => w.t,
    head: () => w.main,
    checkout: (sha) => { w.out = sha; },
    backup: () => null, restore: () => null,
    test: async (sha) => { w.log.push(`test ${sha}`); return { ok: true }; },
    start: async () => { w.up = w.out; },
    alive: () => w.up != null,
    stop: async () => { w.up = null; },
    healthy: async () => true,
    redMain: async (sha, failed) => { w.log.push(`red ${sha} ${failed}`); return '#9 in nuworq'; },
    close: async () => { w.up = null; },
    ...(ci ? { ci: async (sha) => ci[sha] ?? null } : {}),
  };
  return w;
}
const run = async (w) => { const f = follower(w, { log: (l) => w.said.push(l) }); await f.boot(); return f; };

// A commit goes live only once CI's required check passed for it (#543).
describe("serve --follow goes by CI's test check", () => {
  test('passed: the hub moves on it, and the suite never runs here', async () => {
    const w = world({ aaaaaaa1: { state: 'passed' }, bbbbbbb2: { state: 'passed' } });
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'bbbbbbb2');
    assert.ok(!w.log.some((l) => l.startsWith('test')), 'no npm test on this machine');
    assert.ok(w.said.includes("bbbbbbb passed CI's test check; restarting the hub on it"));
  });

  test('pending: it waits, says so once, and moves when CI passes', async () => {
    const ci = { aaaaaaa1: { state: 'passed' }, bbbbbbb2: { state: 'pending' } };
    const w = world(ci);
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1', 'still on the old one');
    assert.equal(w.said.filter((l) => l.startsWith('main moved to bbbbbbb')).length, 1, 'said once, not every check');
    ci.bbbbbbb2 = { state: 'passed' };
    await f.tick();
    assert.equal(w.up, 'bbbbbbb2');
  });

  test('failed: that commit is skipped and said, and a later commit is still taken', async () => {
    const ci = { aaaaaaa1: { state: 'passed' }, bbbbbbb2: { state: 'failed', failed: "CI's test check: failure" }, ccccccc3: { state: 'passed' } };
    const w = world(ci);
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.ok(w.log.includes("red bbbbbbb2 CI's test check: failure"));
    assert.ok(w.said.some((l) => /bbbbbbb fails its tests \(CI's test check: failure\); staying on aaaaaaa/.test(l)));
    w.main = 'ccccccc3';
    await f.tick();
    assert.equal(w.up, 'ccccccc3');
  });

  test("a check that never shows up: after 30 minutes the suite runs here instead", async () => {
    const ci = { aaaaaaa1: { state: 'passed' }, bbbbbbb2: { state: 'pending', missing: true } };
    const w = world(ci);
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    w.t += 31 * 60_000;
    await f.tick();
    assert.ok(w.log.includes('test bbbbbbb2'));
    assert.equal(w.up, 'bbbbbbb2');
  });

  test('without GitHub: the suite runs here, as before, said once', async () => {
    const w = world(null);
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    assert.deepEqual(w.log.filter((l) => l.startsWith('test')), ['test aaaaaaa1', 'test bbbbbbb2']);
    assert.equal(w.said.filter((l) => /no GitHub App/.test(l)).length, 1);
    assert.equal(w.up, 'bbbbbbb2');
  });
});

describe("checkOn reads the check's latest run from GitHub", () => {
  // The hub's GitHub App, faked: mint gives a token, call answers check-runs.
  const app = (runs, status = 200) => {
    const asked = [];
    return {
      asked,
      mint: async (repo, permissions) => { asked.push({ repo, permissions }); return { token: 't' }; },
      call: async (method, path, body, token) => { asked.push({ method, path, token }); return { status, json: { check_runs: runs } }; },
    };
  };
  test('success, in progress, failure, none yet, and no verdict', async () => {
    assert.deepEqual(await checkOn(app([{ status: 'completed', conclusion: 'success' }]), 'github.com/acme/api', 'abc1234'), { state: 'passed' });
    assert.deepEqual(await checkOn(app([{ status: 'in_progress' }]), 'github.com/acme/api', 'abc1234'), { state: 'pending' });
    const failed = await checkOn(app([{ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/api/runs/1' }]), 'github.com/acme/api', 'abc1234');
    assert.deepEqual(failed, { state: 'failed', failed: "CI's test check: failure, https://github.com/acme/api/runs/1" });
    assert.deepEqual(await checkOn(app([]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true });
    assert.equal(await checkOn(app([{ status: 'completed', conclusion: 'skipped' }]), 'github.com/acme/api', 'abc1234'), null);
  });

  test('asks for the test check with a checks:read token for that repository', async () => {
    const a = app([{ status: 'completed', conclusion: 'success' }]);
    await checkOn(a, 'github.com/acme/api', 'abc1234');
    assert.deepEqual(a.asked[0], { repo: 'github.com/acme/api', permissions: { checks: 'read', metadata: 'read' } });
    assert.equal(a.asked[1].path, '/repos/acme/api/commits/abc1234/check-runs?check_name=test&filter=latest');
    assert.equal(a.asked[1].token, 't');
    await assert.rejects(checkOn(app([], 500), 'github.com/acme/api', 'abc1234'), /GitHub answered 500/);
    assert.equal(await checkOn(a, 'gitlab.com/acme/api', 'abc1234'), null, 'not a GitHub repository');
  });
});
