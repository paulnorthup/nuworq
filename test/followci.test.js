import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { follower, system } from '../src/follow.js';
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

  test("GitHub won't answer (no install, no checks:read): said once, then after 30 minutes the suite runs here", async () => {
    const w = world({ aaaaaaa1: { state: 'passed' } });
    const f = await run(w);
    w.ci = async () => { throw new Error('GitHub answered 403 about test on bbbbbbb'); };
    w.main = 'bbbbbbb2';
    await f.tick();
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1', 'no move at first');
    assert.deepEqual(w.said.filter((l) => /can't ask GitHub/.test(l)), ["can't ask GitHub about bbbbbbb (GitHub answered 403 about test on bbbbbbb); still waiting, and its tests run here after 30 minutes"]);
    w.t += 31 * 60_000;
    await f.tick();
    assert.ok(w.log.includes('test bbbbbbb2'));
    assert.ok(w.said.includes("still can't ask GitHub about bbbbbbb (GitHub answered 403 about test on bbbbbbb); running its tests here"));
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
  // The hub's GitHub App, faked: mint gives a token, call answers check-runs and each run's workflow run (#648). A run
  // is GitHub Actions', from CI's workflow on the asked commit, unless it says (workflow, on).
  const app = (runs, status = 200) => {
    const asked = [];
    const all = runs.map((r, i) => ({ app: { slug: 'github-actions' }, check_suite: { id: i + 1 }, ...r }));
    let sha = null;
    return {
      asked,
      mint: async (repo, permissions) => { asked.push({ repo, permissions }); return { token: 't' }; },
      call: async (method, path, body, token) => {
        asked.push({ method, path, token });
        const suite = path.match(/check_suite_id=(\d+)$/)?.[1];
        if (suite) {
          const c = all[Number(suite) - 1];
          return { status: 200, json: { workflow_runs: [{ path: c.workflow ?? '.github/workflows/test.yml', head_sha: c.on ?? sha }] } };
        }
        sha = path.match(/commits\/(\w+)\//)?.[1];
        return { status, json: { check_runs: all } };
      },
    };
  };
  test("a test check from a workflow on another branch doesn't count as CI's (#648)", async () => {
    // A workflow added on a worker's branch posts a passing "test" on main's commit: its run is on its branch's commit.
    const theirs = { status: 'completed', conclusion: 'success', workflow: '.github/workflows/sneaky.yml', on: 'feedbee1' };
    assert.deepEqual(await checkOn(app([theirs]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true });
    // Even named test.yml there, it ran on its own branch's commit.
    assert.deepEqual(await checkOn(app([{ ...theirs, workflow: '.github/workflows/test.yml' }]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true });
    // CI's own run on this commit decides, wherever it comes in the list.
    assert.deepEqual(await checkOn(app([theirs, { status: 'completed', conclusion: 'failure' }]), 'github.com/acme/api', 'abc1234'), { state: 'failed', failed: "CI's test check: failure" });
    // Without actions:read GitHub refuses the workflow lookup: no verdict here, so the hub runs the suite itself.
    const denied = app([{ status: 'completed', conclusion: 'success' }]);
    const call = denied.call;
    denied.call = async (m, p, b, t) => (/check_suite_id/.test(p) ? { status: 403, json: {} } : call(m, p, b, t));
    await assert.rejects(checkOn(denied, 'github.com/acme/api', 'abc1234'), /GitHub answered 403 about the workflow of test/);
  });
  test("a test check from another app doesn't count as CI's (#621)", async () => {
    const other = { app: { slug: 'mallory-checks' }, status: 'completed', conclusion: 'success' };
    assert.deepEqual(await checkOn(app([other]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true }, 'as if CI had said nothing yet');
    assert.deepEqual(await checkOn(app([other, { status: 'completed', conclusion: 'failure' }]), 'github.com/acme/api', 'abc1234'), { state: 'failed', failed: "CI's test check: failure" }, "GitHub Actions' run decides, whatever comes first");
    assert.deepEqual(await checkOn(app([{ app: null, status: 'completed', conclusion: 'success' }]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true }, 'a run that names no app counts for nothing');
  });
  test('success, in progress, failure, none yet, and no verdict', async () => {
    assert.deepEqual(await checkOn(app([{ status: 'completed', conclusion: 'success' }]), 'github.com/acme/api', 'abc1234'), { state: 'passed' });
    assert.deepEqual(await checkOn(app([{ status: 'in_progress' }]), 'github.com/acme/api', 'abc1234'), { state: 'pending' });
    const failed = await checkOn(app([{ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/api/runs/1' }]), 'github.com/acme/api', 'abc1234');
    assert.deepEqual(failed, { state: 'failed', failed: "CI's test check: failure, https://github.com/acme/api/runs/1" });
    assert.deepEqual(await checkOn(app([]), 'github.com/acme/api', 'abc1234'), { state: 'pending', missing: true });
    assert.equal(await checkOn(app([{ status: 'completed', conclusion: 'skipped' }]), 'github.com/acme/api', 'abc1234'), null);
    assert.equal(await checkOn(app([{ status: 'completed', conclusion: 'cancelled' }]), 'github.com/acme/api', 'abc1234'), null, 'cancelled is no verdict, not red main');
  });

  test('asks for the test check with a checks:read token for that repository', async () => {
    const a = app([{ status: 'completed', conclusion: 'success' }]);
    await checkOn(a, 'github.com/acme/api', 'abc1234');
    assert.deepEqual(a.asked[0], { repo: 'github.com/acme/api', permissions: { checks: 'read', actions: 'read', metadata: 'read' } });
    assert.equal(a.asked[1].path, '/repos/acme/api/commits/abc1234/check-runs?check_name=test&filter=latest');
    assert.equal(a.asked[1].token, 't');
    await assert.rejects(checkOn(app([], 500), 'github.com/acme/api', 'abc1234'), /GitHub answered 500/);
    assert.equal(await checkOn(a, 'gitlab.com/acme/api', 'abc1234'), null, 'not a GitHub repository');
  });
});

// The supervisor loads only node: modules (#546), so serve --follow hands it the app file's path, not a function:
// it asks GitHub through src/followhub.js, run as a child.
describe("the supervisor asks GitHub through src/followhub.js", () => {
  test('passed, failed and pending come back from a child that read the app file; no app setting, no ci', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // As GitHub sends them: each run names the app that posted it (#621).
    const gha = { app: { slug: 'github-actions' } };
    const runs = { aaaaaaa1: [{ ...gha, check_suite: { id: 1 }, status: 'completed', conclusion: 'success' }], bbbbbbb2: [{ ...gha, check_suite: { id: 2 }, status: 'completed', conclusion: 'failure' }], ccccccc3: [] };
    const suites = { 1: 'aaaaaaa1', 2: 'bbbbbbb2' }; // CI's workflow run behind each (#648)
    const asked = [];
    const gh = createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
      if (req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_t', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      const m = req.url.match(/^\/repos\/acme\/api\/commits\/(\w+)\/check-runs\?check_name=test&filter=latest$/);
      if (m) return json(200, { check_runs: runs[m[1]] ?? [] });
      const w = req.url.match(/^\/repos\/acme\/api\/actions\/runs\?check_suite_id=(\d+)$/);
      if (w) return json(200, { workflow_runs: [{ path: '.github/workflows/test.yml', head_sha: suites[w[1]] }] });
      json(404, { message: 'Not Found' });
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    try {
      const root = mkdtempSync(join(tmpdir(), 'followci-'));
      const repo = join(root, 'repo');
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/api.git']);
      const app = join(root, 'github-app.json');
      writeFileSync(app, JSON.stringify({ id: 1234, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), api: `http://127.0.0.1:${gh.address().port}` }));
      const sys = system({ repo, dir: join(root, 'hub-src'), url: 'http://127.0.0.1:1', ci: { app } });
      assert.deepEqual(await sys.ci('aaaaaaa1'), { state: 'passed' });
      assert.equal((await sys.ci('bbbbbbb2')).state, 'failed');
      assert.deepEqual(await sys.ci('ccccccc3'), { state: 'pending', missing: true });
      assert.ok(asked.includes('GET /repos/acme/api/commits/aaaaaaa1/check-runs?check_name=test&filter=latest'));
      writeFileSync(app, '{}');
      assert.equal(await sys.ci('aaaaaaa1'), null, 'an app file gone bad since: no verdict, so the suite runs here');
      assert.equal(system({ repo, dir: join(root, 'hub-src'), url: 'http://127.0.0.1:1' }).ci, null);
    } finally {
      gh.close();
    }
  });
});
