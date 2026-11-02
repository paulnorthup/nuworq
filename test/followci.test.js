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

  test("a busy main while GitHub won't answer: the 30 minutes run from the first commit, and the newest goes live (#690)", async () => {
    const w = world({ aaaaaaa1: { state: 'passed' } });
    const f = await run(w);
    w.ci = async () => { throw new Error('GitHub answered 422'); };
    const shas = ['bbbbbbb2', 'ccccccc3', 'ddddddd4', 'eeeeeee5', 'fffffff6', 'ggggggg7', 'hhhhhhh8'];
    for (const [i, sha] of shas.entries()) {
      w.t = i * 5 * 60_000;
      w.main = sha;
      await f.tick();
      assert.equal(w.up, 'aaaaaaa1', `no move ${i * 5} minutes in`);
    }
    assert.ok(w.said.includes("can't ask GitHub about ggggggg (GitHub answered 422); still waiting, and its tests run here after 5 minutes"));
    w.t = 31 * 60_000;
    await f.tick();
    assert.deepEqual(w.log.filter((l) => l.startsWith('test')), ['test hhhhhhh8'], 'the suite runs once, on the newest');
    assert.equal(w.up, 'hhhhhhh8');
  });

  test('a real pending run on a newer commit still waits for its verdict, however long the wait (#690)', async () => {
    const ci = { aaaaaaa1: { state: 'passed' }, bbbbbbb2: { state: 'pending', missing: true }, ccccccc3: { state: 'pending' } };
    const w = world(ci);
    const f = await run(w);
    w.main = 'bbbbbbb2';
    await f.tick();
    w.t = 20 * 60_000;
    w.main = 'ccccccc3';
    await f.tick();
    w.t = 45 * 60_000;
    await f.tick();
    assert.equal(w.up, 'aaaaaaa1');
    assert.ok(!w.log.some((l) => l.startsWith('test')), 'no suite here while CI runs');
    ci.ccccccc3 = { state: 'passed' };
    await f.tick();
    assert.equal(w.up, 'ccccccc3');
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

describe("checkOn reads CI's test job from GitHub", () => {
  // GitHub, faked as the hub's App sees it. posted: check runs on the commit, as any app or workflow can post them
  // through the API, into any suite on it (CI's own included). runs: workflow runs, newest first, each with the jobs
  // its workflow made; a run is test.yml's, pushed to main on abc1234, unless it says otherwise.
  const SHA = 'abc1234';
  const ciRun = (test, over = {}) => ({ path: '.github/workflows/test.yml', head_sha: SHA, event: 'push', head_branch: 'main', status: test?.status === 'completed' ? 'completed' : 'in_progress',
    jobs: [{ name: 'node (24)', status: 'completed', conclusion: 'success' }, ...(test ? [{ name: 'test', ...test }] : [])], ...over });
  const app = (runs, { posted = [], status = 200 } = {}) => {
    const asked = [];
    const all = runs.map((r, i) => ({ id: 900 + i, ...r }));
    return {
      asked,
      mint: async (repo, permissions) => { asked.push({ repo, permissions }); return { token: 't' }; },
      call: async (method, path, body, token) => {
        asked.push({ method, path, token });
        if (status !== 200) return { status, json: {} };
        const w = path.match(/\/actions\/workflows\/([^/]+)\/runs\?head_sha=(\w+)/);
        if (w) return { status: 200, json: { workflow_runs: all.filter((r) => r.path === `.github/workflows/${w[1]}` && r.head_sha === w[2]).map(({ jobs, ...r }) => r) } };
        const j = path.match(/\/actions\/runs\/(\d+)\/jobs/);
        if (j) return { status: 200, json: { jobs: all.find((r) => r.id === Number(j[1]))?.jobs ?? [] } };
        if (/\/check-runs/.test(path)) return { status: 200, json: { check_runs: posted } };
        return { status: 404, json: {} };
      },
    };
  };
  test("a test check from a workflow on another branch doesn't count as CI's (#648)", async () => {
    // A workflow on a worker's branch posts a passing "test" check run on main's commit with GITHUB_TOKEN. It lands
    // in CI's own suite there, next to CI's failing test job, and is the newest "test" on the commit.
    const forged = { name: 'test', app: { slug: 'github-actions' }, check_suite: { id: 900 }, status: 'completed', conclusion: 'success' };
    const a = app([ciRun({ status: 'completed', conclusion: 'failure' })], { posted: [forged] });
    assert.deepEqual(await checkOn(a, 'github.com/acme/api', SHA), { state: 'failed', failed: "CI's test check: failure" }, "CI's job decides");
    assert.ok(!a.asked.some((x) => /check-runs/.test(x.path ?? '')), 'posted check runs are never read');
    // Instead of CI's job: CI hasn't run here, or its run has no test job yet, so nothing has passed.
    assert.deepEqual(await checkOn(app([], { posted: [forged] }), 'github.com/acme/api', SHA), { state: 'pending', missing: true });
    assert.deepEqual(await checkOn(app([ciRun(null)], { posted: [forged] }), 'github.com/acme/api', SHA), { state: 'pending' });
    assert.deepEqual(await checkOn(app([ciRun(null, { status: 'completed' })], { posted: [forged] }), 'github.com/acme/api', SHA), { state: 'pending', missing: true });
    // Another workflow's job named test, or test.yml run on another branch or for a pull request into another branch
    // (whose merge commit can carry that branch's test.yml), on this commit: not CI's.
    const pass = { status: 'completed', conclusion: 'success' };
    for (const over of [{ path: '.github/workflows/sneaky.yml' }, { head_branch: 'nuworq/1-x' }, { event: 'workflow_run' },
      { event: 'pull_request', head_branch: 'nuworq/1-x', pull_requests: [{ base: { ref: 'nuworq/2-y' } }] }]) {
      assert.deepEqual(await checkOn(app([ciRun(pass, over)]), 'github.com/acme/api', SHA), { state: 'pending', missing: true }, JSON.stringify(over));
    }
    assert.deepEqual(await checkOn(app([ciRun(pass, { event: 'pull_request', head_branch: 'nuworq/1-x', pull_requests: [{ base: { ref: 'main' } }] })]), 'github.com/acme/api', SHA), { state: 'passed' }, 'a pull request into main is CI');
    // The newest of CI's runs decides: a rerun that's still going is pending, whatever an older one said.
    assert.deepEqual(await checkOn(app([ciRun({ status: 'in_progress' }), ciRun(pass)]), 'github.com/acme/api', SHA), { state: 'pending' });
    // Without actions:read GitHub refuses: no verdict here, so the hub runs the suite itself.
    await assert.rejects(checkOn(app([ciRun(pass)], { status: 403 }), 'github.com/acme/api', SHA), /GitHub answered 403 about CI's runs/);
  });
  test("a test check from another app doesn't count as CI's (#621)", async () => {
    const other = { name: 'test', app: { slug: 'mallory-checks' }, status: 'completed', conclusion: 'success' };
    assert.deepEqual(await checkOn(app([], { posted: [other] }), 'github.com/acme/api', SHA), { state: 'pending', missing: true }, 'as if CI had said nothing yet');
    assert.deepEqual(await checkOn(app([ciRun({ status: 'completed', conclusion: 'failure' })], { posted: [other] }), 'github.com/acme/api', SHA), { state: 'failed', failed: "CI's test check: failure" }, "CI's job decides");
  });
  test('success, in progress, failure, none yet, and no verdict', async () => {
    const on = async (test) => checkOn(app([ciRun(test)]), 'github.com/acme/api', SHA);
    assert.deepEqual(await on({ status: 'completed', conclusion: 'success' }), { state: 'passed' });
    assert.deepEqual(await on({ status: 'in_progress' }), { state: 'pending' });
    assert.deepEqual(await on({ status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/api/runs/1' }), { state: 'failed', failed: "CI's test check: failure, https://github.com/acme/api/runs/1" });
    assert.deepEqual(await checkOn(app([]), 'github.com/acme/api', SHA), { state: 'pending', missing: true });
    assert.equal(await on({ status: 'completed', conclusion: 'skipped' }), null);
    assert.equal(await on({ status: 'completed', conclusion: 'cancelled' }), null, 'cancelled is no verdict, not red main');
  });

  test("asks for CI's runs on that commit, then their jobs, with an actions:read token for that repository", async () => {
    const a = app([ciRun({ status: 'completed', conclusion: 'success' })]);
    await checkOn(a, 'github.com/acme/api', SHA);
    assert.deepEqual(a.asked[0], { repo: 'github.com/acme/api', permissions: { actions: 'read', metadata: 'read' } });
    assert.equal(a.asked[1].path, '/repos/acme/api/actions/workflows/test.yml/runs?head_sha=abc1234&per_page=20');
    assert.equal(a.asked[2].path, '/repos/acme/api/actions/runs/900/jobs?per_page=100');
    assert.ok(a.asked.slice(1).every((x) => x.token === 't'));
    await assert.rejects(checkOn(app([], { status: 500 }), 'github.com/acme/api', SHA), /GitHub answered 500/);
    assert.equal(await checkOn(a, 'gitlab.com/acme/api', SHA), null, 'not a GitHub repository');
  });
});

// The supervisor loads only node: modules (#546), so serve --follow hands it the app file's path, not a function:
// it asks GitHub through src/followhub.js, run as a child.
describe("the supervisor asks GitHub through src/followhub.js", () => {
  test('passed, failed and pending come back from a child that read the app file; no app setting, no ci', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    // As GitHub sends them: CI's workflow run on each commit, pushed to main, and its test job (#648).
    const runs = { aaaaaaa1: { id: 1, conclusion: 'success' }, bbbbbbb2: { id: 2, conclusion: 'failure' } };
    const asked = [];
    const gh = createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
      if (req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_t', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      const m = req.url.match(/^\/repos\/acme\/api\/actions\/workflows\/test\.yml\/runs\?head_sha=(\w+)&per_page=20$/);
      if (m) return json(200, { workflow_runs: runs[m[1]] ? [{ id: runs[m[1]].id, path: '.github/workflows/test.yml', head_sha: m[1], event: 'push', head_branch: 'main', status: 'completed' }] : [] });
      const j = req.url.match(/^\/repos\/acme\/api\/actions\/runs\/(\d+)\/jobs\?per_page=100$/);
      if (j) return json(200, { jobs: [{ name: 'test', status: 'completed', conclusion: Object.values(runs).find((r) => r.id === Number(j[1]))?.conclusion }] });
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
      assert.ok(asked.includes('GET /repos/acme/api/actions/workflows/test.yml/runs?head_sha=aaaaaaa1&per_page=20'));
      writeFileSync(app, '{}');
      assert.equal(await sys.ci('aaaaaaa1'), null, 'an app file gone bad since: no verdict, so the suite runs here');
      assert.equal(system({ repo, dir: join(root, 'hub-src'), url: 'http://127.0.0.1:1' }).ci, null);
    } finally {
      gh.close();
    }
  });
});
