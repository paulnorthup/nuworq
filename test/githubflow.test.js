import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';
import { tokenEnv } from '../src/git.js';
import { WORK_PERMISSIONS, CLONE_PERMISSIONS, APP_EVENTS, manifest } from '../src/ghapp.js';

// A project on GitHub from end to end (#46), against a fake GitHub (no network): install the app on a
// repository with two open issues, and nothing else. They come in as proposals; an agent shapes one and
// builds it with nothing but the per-claim token the hub mints; accepting it opens a pull request with
// "Fixes #N" and auto-merge; GitHub merges it, closes the issue, and its webhook (the app's, not a
// project's) marks the item done.

const WHS = 'app-webhook-secret';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sign = (raw, secret = WHS) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const gitArgs = (cwd, args) => ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...args];
const git = (cwd, args) => execFileSync('git', gitArgs(cwd, args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// Git over HTTP to the fake GitHub, which runs in this process: never synchronously, or nobody answers it.
const netGit = (cwd, args, env) => new Promise((resolve, reject) => {
  execFile('git', gitArgs(cwd, args), { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, timeout: 30_000 }, (e, out, err) => (e ? reject(new Error(`${e.message}\n${err}`)) : resolve(out.trim())));
});

// GitHub: the app's REST API (JWT for installations and tokens, installation tokens for the rest), and
// acme/api's repository over smart HTTP (git http-backend), open only to tokens it minted. It closes the
// issues a merged PR's body says it fixes, as GitHub does.
function github(root) {
  const bare = join(root, 'acme', 'api.git');
  mkdirSync(bare, { recursive: true });
  git(bare, ['init', '-q', '--bare', '-b', 'main']);
  git(bare, ['config', 'http.receivepack', 'true']);  const issue = (number) => ({ number, title: `Issue ${number}`, body: `Body of ${number}`, state: 'open', labels: [], user: { login: 'reporter' }, author_association: 'OWNER', html_url: `https://github.com/acme/api/issues/${number}` });
  const state = {
    issues: new Map([[11, issue(11)], [12, issue(12)]]),
    mints: new Map(), // token → { repositories, permissions }
    comments: [], prs: new Map(), gitAuth: [], closedBy: new Map(),
  };
  const json = (res, status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };

  const gitHttp = (req, res, raw) => {
    const u = new URL(req.url, 'http://x');
    const env = {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token',
      REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '', CONTENT_LENGTH: String(raw.length),
      HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
    };
    const cgi = spawn('git', ['http-backend'], { env });
    const out = [];
    cgi.stdout.on('data', (c) => out.push(c));
    cgi.on('close', () => {
      const buf = Buffer.concat(out);
      const at = buf.indexOf('\r\n\r\n');
      const headers = {};
      let status = 200;
      for (const line of buf.subarray(0, at).toString().split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10);
        else headers[k] = v.join(':').trim();
      }
      res.writeHead(status, headers);
      res.end(buf.subarray(at + 4));
    });
    cgi.stdin.end(raw);
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = () => JSON.parse(raw.toString() || '{}');
    const auth = String(req.headers.authorization ?? '');
    let m;

    // The repository: git sends the token as basic auth (x-access-token), as GitHub expects.
    if (req.url.startsWith('/acme/api.git/')) {
      const basic = auth.match(/^basic (.+)$/i)?.[1];
      const [user, token] = basic ? Buffer.from(basic, 'base64').toString().split(':') : [];
      if (user !== 'x-access-token' || !state.mints.has(token)) { res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' }); return res.end(); }
      const push = req.url.includes('git-receive-pack');
      state.gitAuth.push({ token, push });
      if (push && state.mints.get(token).permissions.contents !== 'write') { res.writeHead(403); return res.end(); }
      return gitHttp(req, res, raw);
    }

    const token = auth.replace(/^Bearer /, '');
    if (state.mints.has(token)) {
      if (req.method === 'GET' && (m = req.url.match(/^\/repos\/acme\/api\/issues\?state=open&per_page=100&page=(\d+)$/))) {
        return json(res, 200, m[1] === '1' ? [...state.issues.values()].filter((i) => i.state === 'open') : []);
      }
      if (req.method === 'POST' && (m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)\/comments$/))) {
        state.comments.push({ number: Number(m[1]), body: body().body });
        return json(res, 201, { id: 1000 + state.comments.length });
      }
      if ((m = req.url.match(/^\/repos\/acme\/api\/issues\/(\d+)$/))) {
        const i = state.issues.get(Number(m[1]));
        if (req.method === 'PATCH') Object.assign(i, body());
        return json(res, 200, i);
      }
      if (req.method === 'POST' && req.url === '/repos/acme/api/pulls') {
        const b = body(), number = 101 + state.prs.size;
        const sha = git(bare, ['rev-parse', `refs/heads/${b.head}`]);
        const pr = { number, state: 'open', merged: false, mergeable_state: 'blocked', auto_merge: null, merge_commit_sha: null, title: b.title, body: b.body,
          html_url: `https://github.com/acme/api/pull/${number}`, node_id: `PR_${number}`, head: { ref: b.head, sha }, base: { ref: b.base } };
        state.prs.set(number, pr);
        return json(res, 201, pr);
      }
      if (req.method === 'POST' && req.url === '/graphql') {
        const pr = [...state.prs.values()].find((x) => x.node_id === body().variables.id);
        pr.auto_merge = { merge_method: 'squash' };
        return json(res, 200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
      }
      if (req.method === 'GET' && (m = req.url.match(/^\/repos\/acme\/api\/pulls\/(\d+)$/))) return json(res, 200, state.prs.get(Number(m[1])));
      return json(res, 404, { message: 'Not Found' });
    }

    // The app itself, by its JWT.
    const [h, p, sig] = token.split('.');
    if (!sig || !createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'))) return json(res, 401, { message: 'Bad credentials' });
    if (req.method === 'GET' && req.url === '/app') return json(res, 200, { slug: 'nuworq-test' });
    if (req.method === 'GET' && req.url === '/repos/acme/api/installation') return json(res, 200, { id: 42, account: { login: 'acme' } });
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
      const t = `ghs_${state.mints.size + 1}`;
      state.mints.set(t, body());
      return json(res, 201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    json(res, 404, { message: 'Not Found' });
  });

  // GitHub's auto-merge, once the checks pass: squash the branch onto main, close what the body fixes.
  const merge = (number) => {
    const pr = state.prs.get(number);
    const work = join(root, `merge-${number}`);
    git(root, ['clone', '-q', bare, work]);
    git(work, ['merge', '-q', '--squash', `origin/${pr.head.ref}`]);
    git(work, ['commit', '-q', '-m', `${pr.title} (#${number})`]);
    git(work, ['push', '-q', 'origin', 'main']);
    Object.assign(pr, { state: 'closed', merged: true, merge_commit_sha: git(work, ['rev-parse', 'HEAD']) });
    for (const [, n] of String(pr.body).matchAll(/^Fixes #(\d+)$/gm)) {
      state.issues.get(Number(n)).state = 'closed';
      state.closedBy.set(Number(n), number);
    }
    return pr;
  };
  return { server, state, bare, merge };
}

describe('a project lives on GitHub: install the app, and issues become work that lands and closes them', () => {
  let root, gh, hub, server, base, stub;
  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-ghflow-')));
    gh = github(join(root, 'github'));
    // The repository has a first commit, as any project does.
    const seed = join(root, 'seed');
    git(root, ['clone', '-q', gh.bare, seed]);
    writeFileSync(join(seed, 'README'), 'api\n');
    git(seed, ['add', '.']);
    git(seed, ['commit', '-q', '-m', 'init']);
    git(seed, ['push', '-q', 'origin', 'main']);
    stub = `http://127.0.0.1:${await listen(gh.server)}`;
    hub = new Hub({ repos: join(root, 'hub', 'repos') });
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
    hub.humanOp('api', 'settings', { autonomy: 'full' });
    server = createServer(hub, { githubApp: { id: 1, key: PEM, slug: 'nuworq-test', webhook_secret: WHS }, github: { api: stub, web: stub }, sweepMs: 3600_000 });
    base = `http://127.0.0.1:${await listen(server)}`;
  });
  afterEach(() => { for (const s of [server, gh.server]) { s.close(); s.closeAllConnections(); } });

  const post = async (path, payload, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    return { status: r.status, body: await r.json() };
  };
  const op = async (agent, name, args = {}) => {
    const r = await post(`/api/p/api/agent/${name}`, args, { 'x-nuworq-agent': agent });
    assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const deliver = (event, payload, secret = WHS) => {
    const raw = JSON.stringify({ installation: { id: 42 }, ...payload });
    return fetch(`${base}/api/hooks/github-app`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(raw, secret) }, body: raw })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
  };
  const item = (n) => hub.item(hub.project('api'), `#${n}`);

  test('two open issues → two proposals → shaped, built with a per-claim token, PR with "Fixes", merged webhook → done, issue closed', async () => {
    assert.equal(hub.project('api').github_secret, '', 'no project webhook secret: the app is the only setup');

    // 1. GitHub tells the hub the app was installed on acme/api: both open issues come in, linked, with one comment each.
    const installed = await deliver('installation', { action: 'created', repositories: [{ full_name: 'acme/api' }] });
    assert.equal(installed.status, 200, JSON.stringify(installed.body));
    assert.deepEqual(installed.body.projects.map((x) => [x.project, x.github]), [['api', { issues: 2, commented: 2 }]]);
    const linked = hub.q('SELECT number, item_id FROM issues ORDER BY number').all().map((r) => [r.number, hub.itemById(r.item_id).seq]);
    assert.deepEqual(linked, [[11, 1], [12, 2]]);
    assert.deepEqual([item(1).stage, item(2).stage], ['proposed', 'proposed']);
    assert.deepEqual(gh.state.comments.map((c) => c.number), [11, 12]);

    // 2. An agent shapes #1: acceptance criteria make it ready.
    await op('a1', 'checkin', { model: 'claude-opus-5-5' });
    const shape = await op('a1', 'next');
    assert.equal(shape.mode, 'shape');
    await op('a1', 'refine', { item: shape.item, acceptance: 'GET /things answers 200 with a list' });
    await op('a1', 'submit', { item: shape.item, headline: 'Shaped' });
    const n = Number(shape.item.slice(1));
    assert.equal(item(n).stage, 'ready');
    const issueNo = hub.q('SELECT number FROM issues WHERE item_id = ?').get(item(n).id).number;

    // 3. It builds it. Its only GitHub credential is the hub's per-claim token, for this one repository and an hour.
    let job = await op('a1', 'next');
    while (job.mode === 'shape') { await op('a1', 'refine', { item: job.item, acceptance: 'x' }); await op('a1', 'submit', { item: job.item, headline: 'Shaped' }); job = await op('a1', 'next'); }
    assert.equal(job.mode, 'work');
    assert.equal(job.item, `#${n}`);
    // Its token only reads (#472): it fetches from GitHub with it, and pushes through the hub.
    const cred = await post('/api/agent/credential', {}, { 'x-nuworq-agent': 'a1' });
    assert.equal(cred.status, 200, JSON.stringify(cred.body));
    assert.equal(cred.body.repo, 'github.com/acme/api');
    assert.ok(Date.parse(cred.body.expires_at) - Date.now() <= 3600_000, 'an hour at most');
    assert.deepEqual(gh.state.mints.get(cred.body.password), { repositories: ['api'], permissions: CLONE_PERMISSIONS });
    const url = `${stub}/acme/api.git`;
    const asWorker = tokenEnv(url, cred.body.password, {});
    const wt = join(root, 'worker');
    await netGit(root, ['clone', '-q', url, wt], asWorker);
    git(wt, ['switch', '-q', '-c', job.branch, 'origin/main']);
    writeFileSync(join(wt, 'things.js'), 'export const things = [];\n');
    git(wt, ['add', '.']);
    git(wt, ['commit', '-q', '-m', 'GET /things']);
    await assert.rejects(netGit(wt, ['push', '-q', 'origin', job.branch], asWorker), /403/, "GitHub refuses the worker's own token a push");
    // Through the hub, as the worker's git does (pushInsteadOf): name and agent token as basic auth.
    const via = `${base.replace('//', '//a1:none@')}/api/git/github.com/acme/api.git`;
    git(wt, ['remote', 'set-url', '--push', 'origin', via]);
    await netGit(wt, ['push', '-q', 'origin', job.branch], asWorker);
    assert.equal(git(gh.bare, ['rev-parse', job.branch]), git(wt, ['rev-parse', 'HEAD']), 'the branch is on GitHub');
    // main, a tag, another branch or a deletion never gets past the hub, and git says why.
    const before = git(gh.bare, ['rev-parse', 'main']);
    for (const [refspec, why] of [[`${job.branch}:main`, /workers never push main/], ['HEAD:refs/tags/v9', /only refs\/heads\/nuworq\/\*/], ['HEAD:refs/heads/other', /only refs\/heads\/nuworq\/\*/], [`:${job.branch}`, /never delete branches/]]) {
      await assert.rejects(netGit(wt, ['push', 'origin', refspec], asWorker), (e) => why.test(e.message) && /remote rejected/.test(e.message), refspec);
    }
    assert.equal(git(gh.bare, ['rev-parse', 'main']), before, 'main is untouched');
    assert.equal(git(gh.bare, ['tag', '--list']), '', 'no tag');
    assert.equal(git(gh.bare, ['rev-parse', job.branch]), git(wt, ['rev-parse', 'HEAD']), 'nor is the branch deleted');
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'push_refused'`).get().n, 4, 'each refusal is on the record');
    // Not the repository of the item it holds, or no name: refused before anything reaches GitHub.
    const other = await fetch(`${base}/api/git/github.com/acme/web.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from('a1:none').toString('base64')}` } });
    assert.equal(other.status, 403);
    assert.match(await other.text(), /lands in github\.com\/acme\/api, not github\.com\/acme\/web/);
    const anon = await fetch(`${base}/api/git/github.com/acme/api.git/info/refs?service=git-receive-pack`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Basic/);
    const idle = await fetch(`${base}/api/git/github.com/acme/api.git/info/refs?service=git-receive-pack`, { headers: { authorization: `Basic ${Buffer.from('a9:none').toString('base64')}` } });
    assert.equal(idle.status, 403, 'an agent holding nothing pushes nothing');
    await op('a1', 'submit', { item: job.item, headline: 'GET /things', evidence: [{ label: 'npm test: 3 passed' }] });
    assert.equal(item(n).stage, 'verifying');

    // 4. Accepting it opens one PR with "Fixes #<issue>" and auto-merge on; the item waits in landing.
    const accepted = await post('/api/p/api/human/accept', { item: job.item });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    await hub.prsSettled();
    assert.equal(gh.state.prs.size, 1);
    const pr = gh.state.prs.get(101);
    assert.equal(pr.head.ref, job.branch);
    assert.match(pr.body, new RegExp(`^Fixes #${issueNo}$`, 'm'));
    assert.deepEqual(pr.auto_merge, { merge_method: 'squash' });
    assert.equal(item(n).stage, 'landing');

    // 5. Checks pass and GitHub merges it, closing the issue; the app's pull_request webhook marks the item done.
    const merged = gh.merge(101);
    assert.equal(gh.state.issues.get(issueNo).state, 'closed');
    assert.equal(gh.state.closedBy.get(issueNo), 101);
    const hook = await deliver('pull_request', {
      action: 'closed', repository: { full_name: 'acme/api' },
      pull_request: { number: 101, title: merged.title, state: 'closed', merged: true, html_url: merged.html_url, head: merged.head, base: { ref: 'main' }, merge_commit_sha: merged.merge_commit_sha },
    });
    assert.equal(hook.status, 200, JSON.stringify(hook.body));
    assert.equal(hook.body.projects[0].state, 'merged');
    assert.equal(item(n).stage, 'done');
    assert.match(hub.q(`SELECT headline FROM events WHERE item_id = ? AND type = 'landed'`).get(item(n).id).headline, /GitHub merged PR #101/);
    // GitHub's issues webhook for the close changes nothing more: the item is done.
    await deliver('issues', { action: 'closed', issue: { ...gh.state.issues.get(issueNo) }, repository: { full_name: 'acme/api' } });
    assert.equal(item(n).stage, 'done');
    assert.equal(hub.q('SELECT state FROM issues WHERE number = ?').get(issueNo).state, 'closed');
    assert.equal(gh.state.issues.get(n === 1 ? 12 : 11).state, 'open', 'the other issue is untouched');

    // 6. No long-lived credential on the agent's side, and none that writes: every push that reached the repository
    // came from the hub, with a token minted for this one repository with work permissions; the rest only read.
    const pushes = gh.state.gitAuth.filter((a) => a.push && a.token !== cred.body.password);
    assert.ok(pushes.length >= 1);
    for (const a of pushes) assert.deepEqual(gh.state.mints.get(a.token), { repositories: ['api'], permissions: WORK_PERMISSIONS });
    const claimTokens = hub.q(`SELECT data FROM events WHERE type = 'credential'`).all().map((e) => JSON.parse(e.data));
    assert.deepEqual(claimTokens.map((d) => [d.agent, d.item, d.repo, d.write]), [['a1', n, 'github.com/acme/api', false], ['a1', n, 'github.com/acme/api', true]]);
    for (const a of gh.state.gitAuth.filter((x) => !pushes.includes(x))) assert.deepEqual(gh.state.mints.get(a.token).permissions, CLONE_PERMISSIONS);
  });

  // #605: holding one item never rewrites another's branch, accepted or not, fast-forward or forced.
  test("the hub passes on a push only to the held item's branch", async () => {
    for (const title of ['One', 'Two']) await post('/api/p/api/human/create', { title, acceptance: 'x' });
    const url = `${stub}/acme/api.git`;
    const via = (agent) => `${base.replace('//', `//${agent}:none@`)}/api/git/github.com/acme/api.git`;
    // An agent claims an item, commits on its branch and pushes it through the hub.
    const claimAndPush = async (agent) => {
      await op(agent, 'checkin', { model: 'claude-opus-5-5' });
      const job = await op(agent, 'next');
      assert.equal(job.mode, 'work');
      const cred = await post('/api/agent/credential', {}, { 'x-nuworq-agent': agent });
      const env = tokenEnv(url, cred.body.password, {});
      const wt = join(root, agent);
      await netGit(root, ['clone', '-q', url, wt], env);
      git(wt, ['switch', '-q', '-c', job.branch, 'origin/main']);
      writeFileSync(join(wt, `${agent}.txt`), `${agent}\n`);
      git(wt, ['add', '.']);
      git(wt, ['commit', '-q', '-m', `work by ${agent}`]);
      git(wt, ['remote', 'set-url', '--push', 'origin', via(agent)]);
      await netGit(wt, ['push', '-q', 'origin', job.branch], env);
      return { job, wt, env };
    };
    const two = await claimAndPush('a2');
    const one = await claimAndPush('a1');
    assert.notEqual(one.job.branch, two.job.branch);
    const theirs = git(gh.bare, ['rev-parse', two.job.branch]);
    // a1 tries to put a commit on a2's branch: a fast-forward on top of it, and its own commit, forced.
    await netGit(one.wt, ['fetch', '-q', 'origin', two.job.branch], one.env);
    git(one.wt, ['switch', '-q', '-c', 'on-top', 'FETCH_HEAD']);
    writeFileSync(join(one.wt, 'extra.txt'), 'slipped in\n');
    git(one.wt, ['add', '.']);
    git(one.wt, ['commit', '-q', '-m', 'slipped in']);
    for (const args of [['push', 'origin', `on-top:refs/heads/${two.job.branch}`], ['push', '--force', 'origin', `${one.job.branch}:refs/heads/${two.job.branch}`]]) {
      await assert.rejects(netGit(one.wt, args, one.env), (e) => new RegExp(`only the branch of the item they hold: ${one.job.branch}`).test(e.message) && /remote rejected/.test(e.message), args.join(' '));
    }
    assert.equal(git(gh.bare, ['rev-parse', two.job.branch]), theirs, "a2's branch is untouched");
    assert.equal(git(gh.bare, ['rev-parse', one.job.branch]), git(one.wt, ['rev-parse', one.job.branch]), 'its own branch went through');
    const refused = hub.q(`SELECT data FROM events WHERE type = 'push_refused'`).all().map((e) => JSON.parse(e.data));
    assert.deepEqual(refused.map((d) => [d.agent, d.refs]), [['a1', [`refs/heads/${two.job.branch}`]], ['a1', [`refs/heads/${two.job.branch}`]]], 'each refusal on the record');
  });

  test('a delivery not signed with the app\'s secret changes nothing; ping answers; an unknown repository reaches no project', async () => {
    const forged = await deliver('issues', { action: 'opened', issue: { number: 5, title: 'x', state: 'open', html_url: 'u' }, repository: { full_name: 'acme/api' } }, 'wrong');
    assert.equal(forged.status, 401);
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM items').get().n, 0);
    assert.deepEqual((await deliver('ping', { zen: 'hi' })).body, { ok: true, pong: true, projects: [] });
    const elsewhere = await deliver('issues', { action: 'opened', issue: { number: 5, title: 'x', state: 'open', html_url: 'u' }, repository: { full_name: 'acme/other' } });
    assert.deepEqual(elsewhere.body, { ok: true, projects: [] });
    assert.equal(hub.q('SELECT COUNT(*) AS n FROM items').get().n, 0);
  });
});

describe('app webhooks on a shared hub, and the manifest', () => {
  test('a delivery reaches only the organization its installation is bound to; an unbound one reaches nobody', async () => {
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ghflow-ws-')) });
    for (const ws of ['alpha', 'bravo']) {
      spaces.create(ws);
      const h = spaces.get(ws);
      h.tx(() => h.project('api', { create: true }));
      h.addRemote(h.project('api'), 'github.com/acme/api', 'you');
    }
    spaces.directory.bindInstallation(42, 'alpha');
    const server = createServer(spaces, { githubApp: { id: 1, key: PEM, webhook_secret: WHS, api: 'http://127.0.0.1:9' }, sweepMs: 3600_000 });
    const url = `http://127.0.0.1:${await listen(server)}`;
    const deliver = (installation) => {
      const raw = JSON.stringify({ action: 'opened', installation: { id: installation }, issue: { number: 3, title: 'Bug', state: 'open', html_url: 'u' }, repository: { full_name: 'acme/api' } });
      return fetch(`${url}/api/hooks/github-app`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-hub-signature-256': sign(raw) }, body: raw }).then((r) => r.json());
    };
    const count = (ws) => spaces.get(ws).q('SELECT COUNT(*) AS n FROM items').get().n;
    try {
      const r = await deliver(42);
      assert.deepEqual(r.projects.map((x) => [x.project, x.item, x.created]), [['api', '#1', true]]);
      assert.deepEqual([count('alpha'), count('bravo')], [1, 0]);
      assert.deepEqual((await deliver(77)).projects, []);
      assert.deepEqual([count('alpha'), count('bravo')], [1, 0]);
    } finally { server.close(); server.closeAllConnections(); spaces.close(); }
  });

  test('the one-click manifest turns the app webhook on for a public address only', () => {
    const pub = manifest('https://hub.example.com', 'nuworq');
    assert.deepEqual(pub.hook_attributes, { url: 'https://hub.example.com/api/hooks/github-app', active: true });
    assert.deepEqual(pub.default_events, APP_EVENTS);
    const local = manifest('http://localhost:4000', 'nuworq');
    assert.equal(local.hook_attributes.active, false);
    assert.deepEqual(local.default_events, []);
  });

  test('a hub without the app webhook secret says so', async () => {
    const hub = new Hub();
    const server = createServer(hub, { githubApp: { id: 1, key: PEM, api: 'http://127.0.0.1:9' }, sweepMs: 3600_000 });
    const url = `http://127.0.0.1:${await listen(server)}`;
    try {
      const r = await fetch(`${url}/api/hooks/github-app`, { method: 'POST', headers: { 'x-github-event': 'ping' }, body: '{}' });
      assert.equal(r.status, 404);
      assert.match((await r.json()).hint, /NUWORQ_GITHUB_APP_WEBHOOK_SECRET/);
    } finally { server.close(); server.closeAllConnections(); }
  });
});
