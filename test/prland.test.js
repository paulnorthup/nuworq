import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { Hub, normRemote } from '../src/core.js';
import { receive, prSeen } from '../src/github.js';
import { tagsSettled } from '../src/releases.js';
import { GitHubApp, prClient } from '../src/ghapp.js';

const SECRET = 'webhook-secret';

// Accepted remote work lands through a pull request the hub opens (#63). A bare repo plays GitHub's
// repository; a fake client plays GitHub's API and records what the hub asked it to do.
function world({ fail = null, autoFail = null } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-prland-')));
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(root, 'github', 'acme', 'api.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const clone = (name) => { const dir = join(root, name); git(root, 'clone', '-q', origin, dir); return dir; };
  const seed = clone('seed');
  writeFileSync(join(seed, 'README'), 'api\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'main');

  const calls = { opened: [], auto: [] };
  const github = {
    covers: () => true,
    async openPr(args) {
      if (fail) throw new Error(fail);
      calls.opened.push(args);
      const number = 100 + calls.opened.length;
      return { number, url: `https://github.com/acme/api/pull/${number}`, node_id: `PR_${number}`, head_ref: args.head, head_sha: 'abc1234def' };
    },
    async autoMerge(args) {
      if (autoFail) throw new Error(autoFail);
      calls.auto.push(args);
    },
  };
  let t = Date.UTC(2026, 9, 29, 9);
  const hub = new Hub({ clock: () => t, repos: join(root, 'hub', 'repos') });
  hub.github = github;
  hub.publicUrl = 'https://hub.test';
  hub.tx(() => hub.project('demo', { create: true }));
  hub.humanOp('demo', 'remote', { add: origin });
  hub.humanOp('demo', 'settings', { github_secret: SECRET });
  const op = (agent, name, args = {}) => hub.agentOp('demo', name, agent, args);
  const item = (n) => hub.item(hub.project('demo'), `#${n}`);
  const events = (n, type) => hub.q('SELECT * FROM events WHERE item_id = ? AND type = ? ORDER BY id').all(item(n).id, type);

  // An agent builds #n on its branch and submits it; push: whether the branch reaches origin first.
  const build = (agent, { push = true, model = 'claude-opus-5-5' } = {}) => {
    op(agent, 'checkin', { model });
    const j = op(agent, 'next');
    const dir = clone(`work-${agent}-${j.item.slice(1)}`);
    git(dir, 'switch', '-q', '-c', j.branch, 'origin/main');
    writeFileSync(join(dir, `${agent}.txt`), 'work\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `work by ${agent}`);
    if (push) git(dir, 'push', '-q', 'origin', j.branch);
    op(agent, 'submit', { item: j.item, headline: 'Built it', evidence: [{ label: 'npm test: 12 passed' }, { label: 'commit abc1234', url: 'https://example.test/c' }] });
    return { ...j, dir };
  };

  // GitHub's pull_request webhook, signed with the project's secret.
  const hook = (number, { merged = false, state = 'closed', head = '', sha = 'abc1234def', action = 'closed' } = {}) => {
    const raw = Buffer.from(JSON.stringify({
      action, repository: { full_name: normRemote(origin) },
      pull_request: { number, title: 'x', state, merged, html_url: `https://github.com/acme/api/pull/${number}`, head: { ref: head, sha }, base: { ref: 'main' }, merge_commit_sha: 'fff0000' },
    }));
    return receive(hub, 'demo', { event: 'pull_request', raw, signature: 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') });
  };
  return { hub, git, op, item, events, build, hook, calls, advance: (ms) => (t += ms) };
}

describe('accepted remote work lands through a pull request the hub opens', () => {
  test('accept opens exactly one PR with auto-merge (squash); it waits in landing, not as a land job', async () => {
    const w = world();
    w.hub.humanOp('demo', 'settings', { autonomy: 'full' });
    w.hub.humanOp('demo', 'create', { title: 'Api endpoint', summary: 'Adds GET /things.', acceptance: 'x' });
    // It came in from issue 42, linked the way intake links it (src/issues.js takeIssue).
    const p = w.hub.project('demo');
    w.hub.q(`INSERT INTO issues (project_id, repo, number, item_id, state, url, title, updated_at) VALUES (?, ?, 42, ?, 'open', '', 'Api endpoint', 0)`)
      .run(p.id, w.hub.repoOf(p), w.item(1).id);
    const j = w.build('a1');
    w.op('r1', 'checkin');
    assert.equal(w.op('r1', 'next').mode, 'review');
    w.op('r1', 'review', { item: '#1', verdict: 'accept', headline: 'Looks right' });
    assert.equal(w.item(1).stage, 'landing');
    assert.equal(w.item(1).holder, 'github', 'held while the PR is being opened');
    await w.hub.prsSettled();

    assert.equal(w.calls.opened.length, 1);
    const pr = w.calls.opened[0];
    assert.equal(pr.title, 'Api endpoint');
    assert.equal(pr.head, j.branch);
    assert.equal(pr.base, 'main');
    assert.match(pr.body, /https:\/\/hub\.test\/#\/p\/demo\/1/);
    assert.match(pr.body, /Built by a1 \(claude-opus-5-5\), reviewed by r1\./);
    assert.match(pr.body, /- npm test: 12 passed\n- commit abc1234 \(https:\/\/example\.test\/c\)/);
    assert.match(pr.body, /Fixes #42$/);
    // Pinned to the head the review accepted (#605): GitHub's expectedHeadOid.
    assert.deepEqual(w.calls.auto, [{ repo: w.hub.repoOf(w.hub.project('demo'), w.item(1)), number: 101, id: 'PR_101', sha: w.git(j.dir, 'rev-parse', 'HEAD') }]);

    const it = w.item(1);
    assert.equal(it.stage, 'landing');
    assert.equal(it.holder, null);
    const row = w.hub.q('SELECT * FROM prs WHERE item_id = ?').get(it.id);
    assert.equal(row.state, 'open');
    assert.equal(row.number, 101);
    assert.match(w.events(1, 'pr')[0].headline, /Opened PR #101 for #1; GitHub squash-merges it when its checks pass/);

    // Not handed out to land while the PR is open, to its builder or to anyone after the grace period.
    w.advance(10 * 60_000);
    assert.notEqual(w.op('a1', 'next').mode, 'land');
    assert.notEqual(w.op('a2', 'next').mode, 'land');
  });

  test('items not from an issue say no "Fixes"', async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.doesNotMatch(w.calls.opened[0].body, /Fixes/);
  });

  test('the merged webhook marks it done with one landed event; a retried webhook changes nothing', async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const j = w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    // GitHub tells the hub it opened the PR: already linked, so nothing new on the record.
    w.hook(101, { state: 'open', action: 'opened', head: j.branch });
    assert.equal(w.events(1, 'pr').length, 1);

    const r = w.hook(101, { merged: true, head: j.branch });
    assert.equal(r.state, 'merged');
    assert.equal(w.item(1).stage, 'done');
    const landed = w.events(1, 'landed');
    assert.equal(landed.length, 1);
    assert.match(landed[0].headline, /GitHub merged PR #101: #1 is on main/);
    assert.equal(JSON.parse(landed[0].data).pr, 101);

    w.hook(101, { merged: true, head: j.branch });
    assert.equal(w.events(1, 'landed').length, 1, 'a retried webhook does not log twice');
    assert.equal(w.item(1).stage, 'done');
  });

  test('a PR closed without merging returns the item to ready with a note', async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const j = w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    w.hook(101, { merged: false, head: j.branch });
    const it = w.item(1);
    assert.equal(it.stage, 'ready');
    assert.match(JSON.parse(it.handoff).headline, /PR #101 was closed without merging/);
    assert.equal(w.events(1, 'sent_back').length, 1);
    w.hook(101, { merged: false, head: j.branch });
    assert.equal(w.events(1, 'sent_back').length, 1, 'retried: no second note');
    assert.equal(w.item(1).stage, 'ready');
  });

  // #686: a landing PR GitHub closes unmerged because the branch, after the land rebase, is main. Done when main
  // already has the change the review accepted; sent back when it doesn't, though the PR's head looks the same.
  // how: 'squash', the change reached main inside a squash with more in it (another item's), before the review;
  // 'commit', the reviewed commit itself reached main after the review; 'reset', a rebase gone wrong reset the branch to main, and
  // the accepted change never got there.
  const closedEmpty = async ({ how = 'squash', release = false } = {}) => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: release ? 'Release v0.7.0' : 'Thing', acceptance: 'x' });
    if (release) w.hub.q('UPDATE items SET release = 1 WHERE seq = 1').run();
    const j = w.build('a1');
    const reviewed = w.git(j.dir, 'rev-parse', 'HEAD');
    if (how === 'squash') {
      w.git(j.dir, 'switch', '-q', '--detach', 'origin/main');
      writeFileSync(join(j.dir, 'a1.txt'), 'work\n');
      writeFileSync(join(j.dir, 'more.txt'), 'more\n');
      w.git(j.dir, 'add', '.');
      w.git(j.dir, 'commit', '-q', '-m', 'a squash holding it');
      w.git(j.dir, 'push', '-q', 'origin', 'HEAD:main');
      w.git(j.dir, 'switch', '-q', j.branch);
    }
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.item(1).stage, 'landing');
    assert.equal(w.item(1).reviewed_sha, reviewed);
    if (how === 'commit') w.git(j.dir, 'push', '-q', 'origin', 'HEAD:main'); // someone put it on main by hand
    // The lander's rebase: it drops the commit main already has, or (reset) throws the work away.
    w.git(j.dir, 'fetch', '-q', 'origin');
    if (how === 'reset') w.git(j.dir, 'reset', '-q', '--hard', 'origin/main');
    else w.git(j.dir, 'rebase', '-q', 'origin/main');
    const head = w.git(j.dir, 'rev-parse', 'HEAD');
    assert.equal(head, w.git(j.dir, 'rev-parse', 'origin/main'), 'the branch is main: GitHub closes the PR, no diff');
    w.git(j.dir, 'push', '-q', '--force', 'origin', j.branch);
    await w.hub.prefetch('demo', { item: '#1' }); // the mirror as its periodic fetch leaves it
    const close = () => w.hook(101, { merged: false, head: j.branch, sha: head });
    const seen = () => w.hub.tx(() => prSeen(w.hub, w.hub.project('demo'), w.hub.q('SELECT * FROM prs WHERE item_id = ?').get(w.item(1).id), { state: 'closed', head_sha: head }));
    return { ...w, j, head, reviewed, close, seen };
  };

  test('a PR GitHub closes because main already has the reviewed change marks the item done, not sent back (#686)', async () => {
    for (const how of ['squash', 'commit']) {
      const w = await closedEmpty({ how });
      w.close();
      const it = w.item(1);
      assert.equal(it.stage, 'done', how);
      assert.equal(it.holder, null);
      assert.equal(w.events(1, 'sent_back').length, 0);
      const landed = w.events(1, 'landed');
      assert.equal(landed.length, 1);
      assert.equal(landed[0].headline, "PR #101 closed with nothing to merge: main already holds the change #1's review accepted, so it is done");
      assert.equal(JSON.parse(landed[0].data).held, true);
      assert.equal(JSON.parse(landed[0].data).reviewed, w.reviewed);
      w.close();
      assert.equal(w.events(1, 'landed').length, 1, 'retried: nothing more');
    }
  });

  test('a PR closed empty because the branch was reset to main, losing the reviewed change, is still sent back (#686)', async () => {
    const w = await closedEmpty({ how: 'reset' });
    w.close();
    assert.equal(w.item(1).stage, 'ready');
    assert.match(JSON.parse(w.item(1).handoff).headline, /PR #101 was closed without merging/);
    assert.equal(w.events(1, 'landed').length, 0);
  });

  test('with no reviewed head on record, a PR closed empty is sent back as before (#686)', async () => {
    const w = await closedEmpty({ how: 'squash' });
    w.hub.q(`UPDATE items SET reviewed_sha = '' WHERE seq = 1`).run();
    w.close();
    assert.equal(w.item(1).stage, 'ready');
    assert.equal(w.events(1, 'landed').length, 0);
  });

  test("the hub's own look finding the PR closed agrees: the reviewed change on main is done, otherwise a land job (#686)", async () => {
    for (const how of ['squash', 'commit', 'reset']) {
      const w = await closedEmpty({ how });
      const held = how !== 'reset';
      assert.equal(w.seen(), true);
      assert.equal(w.hub.q('SELECT state FROM prs WHERE item_id = ?').get(w.item(1).id).state, 'closed');
      assert.equal(w.item(1).stage, held ? 'done' : 'landing', how);
      assert.equal(w.events(1, 'landed').length, held ? 1 : 0);
      if (!held) assert.match(w.events(1, 'pr').at(-1).headline, /PR #101 was closed without merging; #1 is a land job again/);
    }
  });

  test('a release held on main this way is tagged: on its reviewed commit, or on the main that holds its change (#686)', async () => {
    for (const how of ['commit', 'squash']) {
      const w = await closedEmpty({ how, release: true });
      const tags = [];
      w.hub.github.tag = async (args) => { tags.push(args); };
      w.close();
      assert.equal(w.item(1).stage, 'done');
      await tagsSettled(w.hub);
      assert.deepEqual(tags.map((t) => [t.tag, t.sha]), [['v0.7.0', how === 'commit' ? w.reviewed : w.head]]);
    }
  });

  test('accepting again while its PR is open opens no second PR', async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    // Back in verifying and accepted again, with the PR still open on GitHub.
    w.hub.tx(() => w.hub.move(w.item(1), 'verifying', 'you'));
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 1);
    assert.equal(w.item(1).holder, null);
    assert.equal(w.hub.q('SELECT COUNT(*) AS n FROM prs WHERE item_id = ?').get(w.item(1).id).n, 1);
  });

  test("branch not on origin yet: the land job's hint is just the push; what was pushed is reviewed, then the hub opens the PR", async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const j = w.build('a1', { push: false });
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 0, 'nothing to open a PR from yet');
    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, new RegExp(`^Push it: git push origin ${j.branch} \\(the hub can't see it on origin yet\\)\\. Then submit #1: it is reviewed as pushed, then the hub opens a pull request`));
    assert.doesNotMatch(land.hint, /rebase|push origin \S+:main/);
    w.git(j.dir, 'push', '-q', 'origin', j.branch);
    // The hub never saw the head the review accepted (#605): what was pushed is reviewed before any PR merges it.
    const s = w.op('a1', 'submit', { item: '#1', headline: 'Pushed' });
    assert.match(s.hint, /is on origin now, but the hub never saw the head #1's review accepted, so it is verifying again/);
    assert.equal(w.item(1).stage, 'verifying');
    assert.equal(w.calls.opened.length, 0, 'no PR for unreviewed code');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 1);
    assert.equal(w.item(1).stage, 'landing');
    assert.equal(w.item(1).holder, null);
    assert.equal(w.calls.auto[0].sha, w.git(j.dir, 'rev-parse', 'HEAD'), 'auto-merge pinned to the head reviewed this time');
  });

  test("the hub stopped while opening the PR: the land job says submit (the hub opens it), never push to main", async () => {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    const j = w.build('a1');
    const openPr = w.hub.github.openPr;
    w.hub.github.openPr = () => new Promise(() => {}); // GitHub never answers, then the hub restarts
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await new Promise((r) => setImmediate(r));
    w.hub._opening.clear();
    w.hub.github.openPr = openPr;
    w.advance(3 * 60_000); // the hub's hold on it lapses
    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, new RegExp(`${j.branch} is on origin but has no pull request yet\\. Submit #1: the hub opens one`));
    assert.doesNotMatch(land.hint, /push origin \S+:main/);
    w.op('a1', 'submit', { item: '#1', headline: 'Submitted' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 1, 'opened on submit');
    assert.equal(w.item(1).stage, 'landing');
  });

  test("GitHub refusing the PR goes on the record and it becomes an ordinary land job", async () => {
    const w = world({ fail: 'GitHub didn\'t open the pull request (403: Resource not accessible by integration)' });
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.match(w.events(1, 'pr_failed')[0].headline, /couldn't open a pull request for #1: GitHub didn't open/);
    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /couldn't open a pull request for it \(see its history\), so land it by hand/);
    assert.match(land.hint, /git rebase origin\/main/);
    const failed = land.history.find((e) => e.type === 'pr_failed');
    assert.match(failed?.headline ?? '', /403: Resource not accessible by integration/, 'the history the hint points to says why');
  });

  test('the App not installed on the repository: no doomed PR, a hand landing that says why, and PRs again once it is', async () => {
    const w = world();
    let installed = false;
    w.hub.github.readToken = async () => {
      if (!installed) throw new Error("The nuworq GitHub App isn't installed on acme/api (or was uninstalled), so the hub can't give out tokens for it");
      return { token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() };
    };
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    await Promise.all([...w.hub._mirrorTokens.values()].map((m) => m.pending));
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 0, 'no PR to fail');
    assert.equal(w.events(1, 'pr_failed').length, 0);
    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /lands by hand: the hub can't open a pull request because the nuworq GitHub App isn't installed on acme\/api/);
    assert.match(land.hint, /git push origin \S+:main/);

    // Installed: the next mint succeeds, and the same land job goes through a PR after all. (The fixture's
    // repository is a local path, so the mirror keeps fetching it directly rather than over the App's HTTPS.)
    installed = true;
    const p = w.hub.project('demo');
    const remote = w.hub.repoOf(p, w.item(1));
    await w.hub.mintMirrorToken(remote);
    assert.equal(w.hub.appTrouble(p, w.item(1)), null);
    w.hub._mirrorTokens.delete(remote);
    delete w.hub.github.readToken;
    assert.match(w.hub.landHint(p, w.item(1)), /has no pull request yet\. Submit #1: the hub opens one/);
    w.op('a1', 'submit', { item: '#1', headline: 'Submitted' });
    await w.hub.prsSettled();
    assert.equal(w.calls.opened.length, 1);
  });

  test('auto-merge refused: the PR is still opened and linked, and the record says to merge it on GitHub', async () => {
    const w = world({ autoFail: 'Pull request Auto merge is not allowed for this repository' });
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    const e = w.events(1, 'pr')[0];
    assert.equal(e.headline, 'Opened PR #101 for #1');
    assert.match(e.summary, /Auto-merge couldn't be turned on \(Pull request Auto merge is not allowed.*\): merge it on GitHub/);
    assert.equal(w.hub.q('SELECT state FROM prs WHERE item_id = ?').get(w.item(1).id).state, 'open');
  });

  test("prClient opens the PR with the app's one-repo token, reuses one already open, and asks for squash auto-merge", async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const seen = [];
    let exists = false;
    const api = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      if (req.url === '/repos/acme/api/installation') return json(200, { id: 7 });
      if (req.url === '/app/installations/7/access_tokens') return json(201, { token: 'ghs_one', expires_at: '2026-10-29T13:00:00Z' });
      if (req.method === 'POST' && req.url === '/repos/acme/api/pulls') {
        return exists ? json(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:nuworq/1-x.' }] })
          : json(201, { number: 5, html_url: 'https://github.com/acme/api/pull/5', node_id: 'PR_5', head: { ref: 'nuworq/1-x', sha: 'aaa' } });
      }
      if (req.method === 'GET' && req.url.startsWith('/repos/acme/api/pulls?')) return json(200, [{ number: 4, html_url: 'u4', node_id: 'PR_4', head: { ref: 'nuworq/1-x', sha: 'bbb' } }]);
      if (req.url === '/graphql') return json(200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
      // The merge, pinned to a head (#605): GitHub answers 409 when the PR's head is another.
      if (req.method === 'PUT' && req.url === '/repos/acme/api/pulls/5/merge') {
        return JSON.parse(raw).sha === 'aaa' ? json(200, { merged: true, sha: 'm1' }) : json(409, { message: 'Head branch was modified. Review and try the merge again.' });
      }
      json(404, { message: 'Not Found' });
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    try {
      const gh = prClient(new GitHubApp({ id: 1, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), api: `http://127.0.0.1:${api.address().port}` }));
      assert.equal(gh.covers('github.com/acme/api'), true);
      assert.equal(gh.covers('/srv/git/api.git'), false);
      const args = { repo: 'github.com/acme/api', head: 'nuworq/1-x', base: 'main', title: 'X', body: 'b' };
      assert.deepEqual(await gh.openPr(args), { number: 5, url: 'https://github.com/acme/api/pull/5', node_id: 'PR_5', head_ref: 'nuworq/1-x', head_sha: 'aaa' });
      const open = seen.find((s) => s.url === '/repos/acme/api/pulls');
      assert.equal(open.auth, 'Bearer ghs_one', 'as the installation, on that one repository');
      assert.deepEqual(open.body, { title: 'X', head: 'nuworq/1-x', base: 'main', body: 'b' });
      assert.deepEqual(seen.find((s) => s.url.endsWith('/access_tokens')).body.repositories, ['api']);
      exists = true;
      assert.equal((await gh.openPr(args)).number, 4, 'already open for the branch: that one');
      assert.match(seen.at(-1).url, /state=open&head=acme%3Anuworq%2F1-x/);
      await gh.autoMerge({ repo: 'github.com/acme/api', number: 5, id: 'PR_5' });
      const gql = seen.at(-1);
      assert.equal(gql.url, '/graphql');
      assert.match(gql.body.query, /enablePullRequestAutoMerge\(input: \{ pullRequestId: \$id, mergeMethod: SQUASH \}\)/);
      assert.deepEqual(gql.body.variables, { id: 'PR_5' });
      // Pinned to the reviewed head (#605): auto-merge with expectedHeadOid, the squash-merge with sha.
      await gh.autoMerge({ repo: 'github.com/acme/api', number: 5, id: 'PR_5', sha: 'aaa' });
      assert.match(seen.at(-1).body.query, /enablePullRequestAutoMerge\(input: \{ pullRequestId: \$id, mergeMethod: SQUASH, expectedHeadOid: \$sha \}\)/);
      assert.deepEqual(seen.at(-1).body.variables, { id: 'PR_5', sha: 'aaa' });
      assert.deepEqual(await gh.merge({ repo: 'github.com/acme/api', number: 5, head: 'aaa' }), { sha: 'm1' });
      assert.deepEqual(seen.at(-1).body, { merge_method: 'squash', sha: 'aaa' });
      await assert.rejects(gh.merge({ repo: 'github.com/acme/api', number: 5, head: 'ccc' }), (e) => e.moved === true && /isn't the reviewed ccc/.test(e.message));
      await gh.disableAutoMerge({ repo: 'github.com/acme/api', id: 'PR_5' });
      assert.match(seen.at(-1).body.query, /disablePullRequestAutoMerge\(input: \{ pullRequestId: \$id \}\)/);
    } finally {
      api.close();
    }
  });

  test('without a GitHub client, remote landing is unchanged', async () => {
    const w = world();
    w.hub.github = null;
    w.hub.humanOp('demo', 'create', { title: 'Thing', acceptance: 'x' });
    w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(w.item(1).holder, null);
    const land = w.op('a1', 'next');
    assert.equal(land.mode, 'land');
    assert.match(land.hint, /git push origin nuworq\/1-thing:main/);
  });
});

// Landing merges only what the review accepted (#605): its head as the hub saw it at acceptance, or that change
// rebased. GitHub, here, answers pull() with the branch as the bare repo has it, and refuses a merge pinned to another head.
describe('landing merges only the reviewed head', () => {
  // #1 built, accepted with its PR open; GitHub's view of the PR follows the branch on origin.
  async function accepted({ auto = true } = {}) {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Api endpoint', acceptance: 'x' });
    const j = w.build('a1');
    const reviewed = w.git(j.dir, 'rev-parse', 'HEAD');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    const head = () => w.git(j.dir, 'ls-remote', 'origin', `refs/heads/${j.branch}`).split('\t')[0];
    Object.assign(w.calls, { merged: [], off: [] });
    const state = { auto };
    Object.assign(w.hub.github, {
      async pull() { return { state: 'open', mergeable_state: 'clean', auto_merge: state.auto, base: 'main', sha: '', head_sha: head(), node_id: 'PR_101' }; },
      async merge({ head: pinned }) {
        w.calls.merged.push(pinned);
        if (pinned !== head()) throw Object.assign(new Error('its head moved'), { moved: true });
        return { sha: 'fff0000' };
      },
      async disableAutoMerge(args) { w.calls.off.push(args); state.auto = false; },
    });
    // Main moves on, apart from #1's file.
    const other = w.git(j.dir, 'rev-parse', '--show-toplevel').replace(/work-[^/]+$/, 'seed');
    w.git(other, 'pull', '-q', 'origin', 'main');
    writeFileSync(join(other, 'OTHER'), 'x\n');
    w.git(other, 'add', '.');
    w.git(other, 'commit', '-q', '-m', 'other work');
    w.git(other, 'push', '-q', 'origin', 'main');
    return { ...w, j, reviewed, head, state };
  }
  const pass = async (w) => { w.advance(60_000); await w.hub.mergeReady(); await w.hub.prsSettled(); };

  test('acceptance records the head it accepted; the merge is pinned to it', async () => {
    const w = await accepted({ auto: false });
    assert.equal(w.item(1).reviewed_sha, w.reviewed);
    assert.equal(w.calls.auto[0].sha, w.reviewed, 'auto-merge pinned (expectedHeadOid)');
    await pass(w);
    assert.deepEqual(w.calls.merged, [w.reviewed], 'squash-merge pinned (sha)');
    assert.equal(w.item(1).stage, 'done');
  });

  test('a commit pushed after acceptance sends it back to review, with auto-merge off, and nothing merges', async () => {
    const w = await accepted();
    writeFileSync(join(w.j.dir, 'backdoor.js'), 'evil()\n');
    w.git(w.j.dir, 'add', '.');
    w.git(w.j.dir, 'commit', '-q', '-m', 'one more thing');
    w.git(w.j.dir, 'push', '-q', 'origin', w.j.branch);
    await pass(w);
    assert.equal(w.item(1).stage, 'verifying');
    assert.deepEqual(w.calls.off, [{ repo: w.hub.repoOf(w.hub.project('demo'), w.item(1)), id: 'PR_101' }], 'auto-merge off on its PR');
    assert.deepEqual(w.calls.merged, [], 'nothing merged');
    const back = w.events(1, 'rebased').at(-1);
    assert.match(back.headline, new RegExp(`changed after #1 was accepted \\(${w.reviewed.slice(0, 7)} → ${w.head().slice(0, 7)}\\): it goes back to review`));
    // Its next acceptance pins the new head.
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    assert.equal(w.item(1).reviewed_sha, w.head());
  });

  test('a merge GitHub refuses because the head moved goes back to review too', async () => {
    const w = await accepted({ auto: false });
    // The hub's look at the PR saw the reviewed head; by the merge, it had moved.
    const pull = w.hub.github.pull;
    w.hub.github.pull = async (a) => ({ ...await pull(a), head_sha: w.reviewed });
    writeFileSync(join(w.j.dir, 'late.js'), 'late()\n');
    w.git(w.j.dir, 'add', '.');
    w.git(w.j.dir, 'commit', '-q', '-m', 'late');
    w.git(w.j.dir, 'push', '-q', 'origin', w.j.branch);
    await pass(w);
    assert.deepEqual(w.calls.merged, [w.reviewed]);
    assert.equal(w.item(1).stage, 'verifying');
  });

  test('the same change rebased onto a newer main still lands, pinned to the rebased head', async () => {
    const w = await accepted({ auto: false });
    w.git(w.j.dir, 'fetch', '-q', 'origin');
    w.git(w.j.dir, 'rebase', '-q', 'origin/main');
    w.git(w.j.dir, 'push', '-q', '--force', 'origin', w.j.branch);
    const rebased = w.head();
    assert.notEqual(rebased, w.reviewed);
    await pass(w);
    assert.equal(w.item(1).stage, 'done');
    assert.deepEqual(w.calls.merged, [rebased]);
    assert.match(w.events(1, 'head_rebased')[0].headline, /the same change #1's review accepted, so it still lands/);
  });

  test('a rebase that slips in a change is not the same change', async () => {
    const w = await accepted();
    w.git(w.j.dir, 'fetch', '-q', 'origin');
    w.git(w.j.dir, 'rebase', '-q', 'origin/main');
    writeFileSync(join(w.j.dir, 'a1.txt'), 'work, and a little more\n');
    w.git(w.j.dir, 'commit', '-q', '-a', '--amend', '--no-edit');
    w.git(w.j.dir, 'push', '-q', '--force', 'origin', w.j.branch);
    await pass(w);
    assert.equal(w.item(1).stage, 'verifying');
    assert.equal(w.calls.off.length, 1);
  });

  test('a push the hub passes on to an accepted branch is checked at once', async () => {
    const w = await accepted();
    writeFileSync(join(w.j.dir, 'more.js'), 'more()\n');
    w.git(w.j.dir, 'add', '.');
    w.git(w.j.dir, 'commit', '-q', '-m', 'more');
    w.git(w.j.dir, 'push', '-q', 'origin', w.j.branch);
    // What src/server.js does once GitHub took a push to the branch of a landing item.
    await w.hub.headMoved(w.hub.project('demo'), w.item(1).id);
    await w.hub.prsSettled();
    assert.equal(w.item(1).stage, 'verifying');
    assert.equal(w.calls.off.length, 1, 'auto-merge off before GitHub merges it');
  });
});

describe("a landing PR's failed check is noticed without its webhook (#743)", () => {
  // #1 accepted, its PR open and waiting on checks; no check webhook ever arrives. GitHub's check runs: runs.
  async function waiting(runs) {
    const w = world();
    w.hub.humanOp('demo', 'create', { title: 'Api endpoint', acceptance: 'x' });
    const j = w.build('a1');
    w.hub.humanOp('demo', 'accept', { item: '#1' });
    await w.hub.prsSettled();
    const head = w.git(j.dir, 'rev-parse', 'HEAD');
    const reads = [];
    Object.assign(w.hub.github, {
      async pull() { return { state: 'open', mergeable_state: 'blocked', auto_merge: true, base: 'main', sha: '', head_sha: head, node_id: 'PR_101' }; },
      async checkRuns(args) { reads.push(args); return runs; },
    });
    const pass = async (ms = 60_000) => { w.advance(ms); await w.hub.mergeReady(); await w.hub.prsSettled(); };
    return { ...w, head, reads, pass };
  }

  test('a required check that failed on GitHub sends it back naming the check, within two passes after 30 minutes', async () => {
    const w = await waiting([
      { name: 'lint', conclusion: 'success', url: 'https://github.com/acme/api/runs/1' },
      { name: 'test', conclusion: 'failure', url: 'https://github.com/acme/api/runs/2' },
    ]);
    await w.pass(28 * 60_000);
    assert.equal(w.item(1).stage, 'landing', 'before 30 minutes its webhooks still have their chance');
    assert.equal(w.reads.length, 0);
    await w.pass();
    await w.pass();
    assert.equal(w.item(1).stage, 'ready', 'back to its builder');
    assert.deepEqual(w.reads.map((r) => r.sha), [w.head]);
    const back = w.events(1, 'sent_back').at(-1);
    assert.match(back.headline, /^test failed on PR #101; #1 goes back to a1/);
    assert.match(back.summary, /test: failure \(https:\/\/github\.com\/acme\/api\/runs\/2\)/);
    assert.match(w.events(1, 'ci').at(-1).headline, /CI failed on PR #101: test/);
    assert.equal(JSON.parse(w.item(1).handoff).kind, 'sent_back');
  });

  test("its checks are read at most once every 10 minutes, and passing ones change nothing", async () => {
    const w = await waiting([{ name: 'test', conclusion: 'success', url: '' }, { name: 'e2e', conclusion: null }]);
    await w.pass(30 * 60_000);
    assert.equal(w.reads.length, 1);
    for (let i = 0; i < 9; i++) await w.pass();
    assert.equal(w.reads.length, 1, 'not again within 10 minutes');
    await w.pass();
    assert.equal(w.reads.length, 2);
    assert.equal(w.item(1).stage, 'landing');
    assert.equal(w.events(1, 'sent_back').length, 0);
  });

  test('a check webhook that did arrive is not repeated on the record', async () => {
    const w = await waiting([{ name: 'test', conclusion: 'success', url: '' }]);
    w.hub.q('UPDATE prs SET head_sha = ?').run(w.head); // as GitHub's pull_request webhook has it
    const raw = Buffer.from(JSON.stringify({ action: 'completed', check_run: { head_sha: w.head, name: 'test', conclusion: 'success' } }));
    receive(w.hub, 'demo', { event: 'check_run', raw, signature: 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') });
    assert.equal(w.events(1, 'ci').length, 1);
    await w.pass(30 * 60_000);
    assert.equal(w.reads.length, 1);
    assert.equal(w.events(1, 'ci').length, 1, 'read again under the head GitHub has, still passing: said once');
  });
});
