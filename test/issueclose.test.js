import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Hub } from '../src/core.js';
import { GitHubApp } from '../src/ghapp.js';
import { takeIssue, closeLanded, PR_GRACE, RETRY_FIRST } from '../src/issues.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const issue = (number) => ({ number, title: `Issue ${number}`, body: '', state: 'open', labels: [], author_association: 'OWNER', html_url: `https://github.com/acme/api/issues/${number}` });

// GitHub's issues API for acme/api: each issue's state, and every call the hub makes (minting included, in
// requests). down: answer 500. locked: issues whose close GitHub refuses (403). limit: headers for one 429.
function github() {
  const state = { issues: new Map(), calls: [], requests: 0, down: false, locked: new Set(), limit: null };
  const server = http.createServer(async (req, res) => {
    const json = (status, b, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(b)); };
    let raw = '';
    for await (const c of req) raw += c;
    state.requests++;
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(200, { id: 42 });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') return json(201, { token: 'ghs_issues', expires_at: '2026-10-29T13:00:00Z' });
    const m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)(\/comments)?$/);
    if (!m || req.headers.authorization !== 'Bearer ghs_issues') return json(404, { message: 'Not Found' });
    const n = Number(m[1]);
    state.calls.push({ method: req.method, number: n, ...(m[2] ? { comment: JSON.parse(raw).body } : {}), ...(req.method === 'PATCH' ? { body: JSON.parse(raw) } : {}) });
    if (state.limit) { const h = state.limit; state.limit = null; return json(429, { message: 'API rate limit exceeded' }, h); }
    if (state.down) return json(500, { message: 'Server Error' });
    if (req.method === 'PATCH' && state.locked.has(n)) return json(403, { message: 'Issue is locked' });
    if (req.method === 'GET') return json(200, { number: n, state: state.issues.get(n) ?? 'open' });
    if (req.method === 'POST' && m[2]) return json(201, { id: 5000 + state.calls.length });
    if (req.method === 'PATCH') { state.issues.set(n, JSON.parse(raw).state); return json(200, { number: n, state: JSON.parse(raw).state }); }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('an issue-linked item closes its GitHub issue when it lands', () => {
  let gh, app, hub, repo, now, git, p;
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const item = (n) => hub.item(p, `#${n}`);
  const row = (n) => ({ ...hub.q('SELECT state, close_error, landed_comment FROM issues WHERE number = ?').get(n) });
  const changes = () => gh.state.calls.filter((c) => c.method !== 'GET');

  beforeEach(async () => {
    gh = github();
    app = new GitHubApp({ id: 1, key: PEM, api: `http://127.0.0.1:${await listen(gh.server)}`, now: () => now });
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-issueclose-')));
    git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'README'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    now = Date.UTC(2026, 9, 29, 9);
    hub = new Hub({ clock: () => now });
    hub.publicUrl = 'https://hub.test';
    hub.tx(() => hub.project('demo', { create: true }));
    hub.humanOp('demo', 'settings', { path: repo });
    p = hub.project('demo');
    hub.addRemote(p, 'github.com/acme/api', 'you');
  });
  afterEach(() => { gh.server.close(); gh.server.closeAllConnections(); });

  // Issue #7 comes in as #1; an agent builds it, a human accepts it, and the agent fast-forwards main.
  const landLocally = () => {
    hub.tx(() => takeIssue(hub, p, 'github.com/acme/api', issue(7)));
    hub.humanOp('demo', 'update', { item: '#1', acceptance: 'works', stage: 'ready' });
    op('a1', 'checkin');
    const job = op('a1', 'next');
    const wt = `${repo}.worktrees/a1`;
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
    git(wt, 'switch', '-q', '-c', job.branch, 'main');
    writeFileSync(join(wt, 'fix'), 'fix\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'fix');
    op('a1', 'submit', { item: '#1', headline: 'Fixed' });
    hub.humanOp('demo', 'accept', { item: '#1' });
    git(repo, 'merge', '-q', '--ff-only', job.branch);
    op('a1', 'next');
    op('a1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
    return git(repo, 'rev-parse', '--short', 'main');
  };

  test('local landing: the hub closes the issue with one comment naming the item and the commit on main', async () => {
    const head = landLocally();
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 1 });
    assert.deepEqual(changes().map((c) => c.method), ['POST', 'PATCH']);
    assert.equal(changes()[0].number, 7);
    assert.match(changes()[0].comment, /\[#1\]\(https:\/\/hub\.test\/#\/p\/demo\/1\)/);
    assert.ok(changes()[0].comment.includes(head), `${changes()[0].comment} names ${head}`);
    assert.deepEqual(changes()[1].body, { state: 'closed', state_reason: 'completed' });
    assert.equal(row(7).state, 'closed');
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'issue' AND headline LIKE 'Closed %#1 landed'`).get());

    gh.state.calls = [];
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, [], 'closed once: nothing more to do');
  });

  test('pull request landing: the body says "Fixes #7", and an issue GitHub already closed gets no second close or comment', async () => {
    hub.tx(() => takeIssue(hub, p, 'github.com/acme/api', issue(7)));
    let body = '';
    hub.github = { covers: () => true, async openPr(a) { body = a.body; return { number: 9, url: 'https://github.com/acme/api/pull/9', node_id: 'PR_9', head_ref: a.head }; }, async autoMerge() {} };
    hub.patch(item(1), { stage: 'landing', branch: 'nuworq/1-issue-7' });
    hub.openPr(p, item(1));
    await hub.prsSettled();
    assert.match(body, /^Fixes #7$/m);

    // GitHub merges it and closes #7 itself; the merge marks the item done.
    hub.q(`UPDATE prs SET state = 'merged' WHERE number = 9`).run();
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    gh.state.issues.set(7, 'closed');
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, [], 'GitHub gets its moment to close it after the merge');
    now += PR_GRACE;
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls.map((c) => c.method), ['GET'], 'it looked, and left it');
    assert.equal(row(7).state, 'closed');
  });

  test('an item linked to two issues (a merged duplicate) closes both', async () => {
    hub.tx(() => { takeIssue(hub, p, 'github.com/acme/api', issue(7)); takeIssue(hub, p, 'github.com/acme/api', issue(8)); });
    // Shaping found #8 the same as #7: its link moved to #7's item.
    hub.q('UPDATE issues SET item_id = ? WHERE number = 8').run(item(1).id);
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 2 });
    assert.deepEqual(changes().filter((c) => c.method === 'PATCH').map((c) => c.number), [7, 8]);
    assert.equal(changes().filter((c) => c.method === 'POST').length, 2, 'one comment each');
  });

  test('while GitHub fails the item stays done, the failure is on the record once, and a later sweep closes it once', async () => {
    gh.state.down = true;
    landLocally();
    await closeLanded(hub, p, app);
    await closeLanded(hub, p, app);
    assert.equal(item(1).stage, 'done');
    assert.equal(row(7).state, 'open');
    assert.match(row(7).close_error, /500/);
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'issue_close_failed'`).get().n, 1, 'said once, not every sweep');

    gh.state.down = false;
    gh.state.calls = [];
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 0 }, 'not yet: the first retry is a minute later');
    now += RETRY_FIRST;
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 1 });
    assert.deepEqual(changes().map((c) => c.method), ['POST', 'PATCH']);
    assert.deepEqual(row(7), { state: 'closed', close_error: '', landed_comment: row(7).landed_comment });
    gh.state.calls = [];
    await closeLanded(hub, p, app);
    assert.deepEqual(gh.state.calls, []);
  });

  test('a comment that went through is not posted again when the close fails', async () => {
    landLocally();
    const orig = gh.server.listeners('request')[0];
    gh.server.removeAllListeners('request');
    gh.server.on('request', (req, res) => (req.method === 'PATCH' ? (res.writeHead(502), res.end('{}')) : orig(req, res)));
    await closeLanded(hub, p, app);
    assert.equal(row(7).state, 'open');
    assert.ok(row(7).landed_comment);
    gh.server.removeAllListeners('request');
    gh.server.on('request', orig);
    gh.state.calls = [];
    now += RETRY_FIRST;
    await closeLanded(hub, p, app);
    assert.deepEqual(changes().map((c) => c.method), ['PATCH']);
  });

  // Issue #N comes in as an item that is done, ready to close.
  const doneIssue = (n) => {
    hub.tx(() => takeIssue(hub, p, 'github.com/acme/api', issue(n)));
    hub.humanOp('demo', 'update', { item: `#${hub.q('SELECT i.seq FROM issues s JOIN items i ON i.id = s.item_id WHERE s.number = ?').get(n).seq}`, stage: 'done' });
  };
  const tries = (n) => hub.q('SELECT close_tries FROM issues WHERE number = ?').get(n).close_tries;

  test("an issue GitHub won't close is tried less and less: at most a dozen times in an hour of sweeps, and a pass that tries nothing changes nothing", async () => {
    doneIssue(7);
    gh.state.locked.add(7);
    let changed = 0;
    const was = hub.changed.bind(hub);
    hub.changed = (...a) => { changed++; return was(...a); };
    let passes = 0, quiet = 0;
    for (const end = now + 3_600_000; now < end; now += 15_000) {
      const calls = gh.state.calls.length, before = changed;
      await closeLanded(hub, p, app);
      passes++;
      if (gh.state.calls.length === calls) { quiet++; assert.equal(changed, before, 'a pass that tried nothing changes nothing'); }
    }
    const closes = gh.state.calls.filter((c) => c.method === 'PATCH').length;
    assert.equal(passes, 240, 'every 15 s for an hour, as the server sweeps');
    assert.ok(closes <= 12, `${closes} tries in an hour`);
    assert.equal(closes, 6, 'at 0, 1, 3, 7, 15 and 31 minutes');
    assert.equal(quiet, passes - closes);
    assert.equal(tries(7), 6);
    assert.equal(gh.state.calls.filter((c) => c.method === 'POST').length, 1, 'the landed comment went once');
  });

  test('after a day of failures the hub stops trying that issue and says so once on the item', async () => {
    doneIssue(7);
    gh.state.locked.add(7);
    const start = now;
    for (const end = now + 26 * 3_600_000; now < end; now += 60_000) await closeLanded(hub, p, app);
    const said = hub.q(`SELECT headline, summary FROM events WHERE type = 'issue_close_failed' ORDER BY id`).all();
    assert.equal(said.length, 2, 'the first failure, and the giving up');
    assert.match(said[0].headline, /couldn't close .*after #1 landed: GitHub didn't close it \(403\)/);
    assert.match(said[1].headline, /stopped trying to close https:\/\/github\.com\/acme\/api\/issues\/7: it failed for a day/);
    assert.match(said[1].summary, /Close it on GitHub by hand/);
    const last = gh.state.calls.length;
    assert.ok(tries(7) <= 16, `${tries(7)} tries in a day`);
    now = start + 30 * 24 * 3_600_000;
    await closeLanded(hub, p, app);
    assert.equal(gh.state.calls.length, last, 'given up: no more calls, even a month later');
    assert.equal(item(1).stage, 'done');
    assert.equal(row(7).state, 'open');
  });

  test("a rate limit GitHub answers holds every call for the installation until it resets, and isn't held against the other issues", async () => {
    doneIssue(7);
    doneIssue(8);
    gh.state.limit = { 'retry-after': '120' };
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 0 });
    assert.deepEqual(gh.state.calls.map((c) => [c.method, c.number]), [['GET', 7]], "#7's look got the 429; #8 waited without a call");
    assert.deepEqual([tries(7), tries(8)], [1, 0]);

    const requests = gh.state.requests;
    now += RETRY_FIRST; // #7 is due again, but the limit runs another minute
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 0 });
    await assert.rejects(app.mint('github.com/acme/api'), (e) => e.status === 429 && e.rateLimited && /rate limit/.test(e.message));
    assert.equal(gh.state.requests, requests, 'nothing went to GitHub, not even for a token');
    assert.deepEqual([tries(7), tries(8)], [1, 0], 'waiting is not failing');

    now += 61_000;
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 2 });
    assert.deepEqual([row(7).state, row(8).state], ['closed', 'closed']);
  });

  test('items with no issue make no GitHub calls', async () => {
    hub.humanOp('demo', 'create', { title: 'Plain work', acceptance: 'x' });
    hub.humanOp('demo', 'update', { item: '#1', stage: 'done' });
    assert.deepEqual(await closeLanded(hub, p, app), { closed: 0 });
    assert.deepEqual(gh.state.calls, []);
  });
});
