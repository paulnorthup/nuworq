import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createVerify, createHmac } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { appFromEnv, appFromFile, GitHubApp, prClient } from '../src/ghapp.js';
import { receive } from '../src/github.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuworq.js');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// GitHub's REST API, as far as the app uses it. It checks the app's JWT, and knows which repos have the app.
// With a token it minted, the installation opens, auto-merges and merges acme/api's pull requests (prs).
function github() {
  // expiresIn: how long minted tokens live. Under 5 minutes by default, so the hub never reuses them
  // unless a test says so. mergeable: the mergeable_state of PRs opened from now on (clean: nothing to wait
  // for). autoMergeOff: the repository doesn't allow auto-merge. refuseMerge: why GitHub won't merge, if it won't.
  const state = {
    installed: new Set(['acme/api']), suspended: false, mints: [], jwts: [], expiresIn: 4 * 60_000,
    prs: new Map(), merges: [], mergeable: 'clean', autoMergeOff: false, refuseMerge: '',
  };
  const pulls = async (req, json) => {
    let raw = '', m;
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'POST' && req.url === '/repos/acme/api/pulls') {
      const number = 101 + state.prs.size;
      const pr = { number, state: 'open', merged: false, mergeable_state: state.mergeable, auto_merge: null, merge_commit_sha: null, title: body.title,
        html_url: `https://github.com/acme/api/pull/${number}`, node_id: `PR_${number}`, head: { ref: body.head, sha: 'abc1234' }, base: { ref: body.base } };
      state.prs.set(number, pr);
      return json(201, pr);
    }
    if (req.method === 'POST' && req.url === '/graphql') {
      const pr = [...state.prs.values()].find((x) => x.node_id === body.variables.id);
      const no = (message) => json(200, { data: { enablePullRequestAutoMerge: null }, errors: [{ type: 'UNPROCESSABLE', path: ['enablePullRequestAutoMerge'], message }] });
      if (state.autoMergeOff) return no('Pull request Auto merge is not allowed for this repository');
      if (pr.mergeable_state === 'clean') return no('Pull request Pull request is in clean status');
      pr.auto_merge = { merge_method: 'squash' };
      return json(200, { data: { enablePullRequestAutoMerge: { clientMutationId: null } } });
    }
    if (req.method === 'PUT' && (m = req.url.match(/^\/repos\/acme\/api\/pulls\/(\d+)\/merge$/))) {
      state.merges.push({ number: Number(m[1]), ...body });
      if (state.refuseMerge) return json(405, { message: state.refuseMerge });
      Object.assign(state.prs.get(Number(m[1])), { state: 'closed', merged: true, merge_commit_sha: 'squash123' });
      return json(200, { sha: 'squash123', merged: true, message: 'Pull Request successfully merged' });
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/repos\/acme\/api\/pulls\/(\d+)$/))) {
      return state.prs.has(Number(m[1])) ? json(200, state.prs.get(Number(m[1]))) : json(404, { message: 'Not Found' });
    }
    json(404, { message: 'Not Found' });
  };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (/^Bearer ghs_secret\d+$/.test(req.headers.authorization ?? '')) return pulls(req, json);
    // The manifest flow's code exchange needs no credential: the one-time code is it.
    let c;
    if (req.method === 'POST' && (c = req.url.match(/^\/app-manifests\/([^/]+)\/conversions$/))) {
      return c[1] === 'good'
        ? json(201, { id: 999, slug: 'nuworq-hub', pem: PEM, webhook_secret: 'whs', client_id: 'cid', client_secret: 'csec', owner: { login: 'paul' } })
        : json(404, { message: 'Not Found' });
    }
    const jwt = String(req.headers.authorization ?? '').replace('Bearer ', '');
    const [h, p, sig] = jwt.split('.');
    const ok = sig && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    if (!ok) return json(401, { message: 'A JSON web token could not be decoded' });
    state.jwts.push(JSON.parse(Buffer.from(p, 'base64url')));
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      return state.installed.has(m[1]) ? json(200, { id: 42, account: { login: m[1].split('/')[0] } }) : json(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
      if (state.suspended) return json(403, { message: 'This installation has been suspended' });
      let raw = '';
      for await (const c of req) raw += c;
      state.mints.push(JSON.parse(raw));
      return json(201, { token: `ghs_secret${state.mints.length}`, expires_at: new Date(Date.now() + state.expiresIn).toISOString(), repository_selection: 'selected' });
    }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('a GitHub App mints one-repo, one-hour tokens per claim', () => {
  let gh, hub, server, port, url, api;
  before(async () => {
    gh = github();
    api = `http://127.0.0.1:${await listen(gh.server)}`;
    hub = new Hub();
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'git@github.com:acme/api.git', 'you');
    hub.tx(() => hub.project('web', { create: true }));
    hub.addRemote(hub.project('web'), 'https://github.com/acme/web', 'you');
    for (const slug of ['api', 'web']) hub.humanOp(slug, 'create', { title: `${slug} work`, acceptance: 'done' });
    server = createServer(hub, { githubApp: { id: 1234, key: PEM, slug: 'nuworq-test', api } });
    port = await listen(server);
    url = `http://127.0.0.1:${port}`;
  });
  after(() => { for (const s of [server, gh.server]) { s.close(); s.closeAllConnections(); } });

  const credential = (agent) => fetch(`${url}/api/agent/credential`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nuworq-agent': agent }, body: '{}' })
    .then(async (r) => ({ status: r.status, json: await r.json() }));

  test('without a claim there is nothing to push for', async () => {
    const r = await credential('a1');
    assert.equal(r.status, 409);
    assert.match(r.json.hint, /claim one/);
  });

  test('a claim gets a token restricted to its one repository, and the mint is on the record without the token', async () => {
    hub.agentOp('api', 'claim', 'a1', { item: '#1' });
    const r = await credential('a1');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const expires = r.json.expires_at;
    assert.deepEqual({ ...r.json, password: undefined }, { ok: true, username: 'x-access-token', password: undefined, repo: 'github.com/acme/api', expires_at: expires });
    assert.equal(r.json.password, 'ghs_secret1');
    assert.deepEqual(gh.state.mints[0], { repositories: ['api'], permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' } });
    const jwt = gh.state.jwts.at(-1);
    assert.equal(jwt.iss, '1234');
    assert.ok(jwt.exp - jwt.iat <= 600, 'the app JWT lives at most 10 minutes');

    const e = hub.q(`SELECT * FROM events WHERE type = 'credential'`).get();
    assert.equal(e.actor, 'a1');
    assert.match(e.headline, new RegExp(`a1 got a GitHub token for github\\.com/acme/api on #1, until ${expires.slice(11, 16)} UTC`));
    assert.deepEqual(JSON.parse(e.data), { agent: 'a1', item: 1, repo: 'github.com/acme/api', expires_at: expires, token: null });
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE data LIKE '%ghs_%' OR headline LIKE '%ghs_%'`).get().n, 0, 'the token itself is never stored');
  });

  test('uninstalled (or suspended) app: no token, and the hub says why in plain words', async () => {
    hub.agentOp('web', 'claim', 'a2', { item: '#1' });
    const r = await credential('a2');
    assert.equal(r.status, 424);
    assert.match(r.json.error, /The nuworq GitHub App isn't installed on acme\/web \(or was uninstalled\), so the hub can't give out tokens for it/);
    assert.match(r.json.hint, /github\.com\/apps\/nuworq-test\/installations\/new/);
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'credential_refused' AND actor = 'a2'`).get(), 'the refusal is on the record');

    gh.state.suspended = true;
    const s = await credential('a1');
    assert.equal(s.status, 424);
    assert.match(s.json.error, /suspended or removed/);
    gh.state.suspended = false;
  });

  test('git-credential answers git for the held repository only, and stays quiet elsewhere', async () => {
    // As git runs it: the request on stdin, the answer on stdout.
    const git = (input) => new Promise((resolve, reject) => {
      const env = { ...process.env, NUWORQ_URL: url, NUWORQ_TOKEN: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-cred-')) };
      const child = execFile(process.execPath, [BIN, 'git-credential', 'get', '--as', 'a1'], { env }, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
      child.stdin.end(input);
    });
    const yes = await git('protocol=https\nhost=github.com\npath=acme/api.git\n\n');
    assert.match(yes.stdout, /^username=x-access-token\npassword=ghs_secret\d+\n$/);
    const other = await git('protocol=https\nhost=github.com\npath=acme/web.git\n\n');
    assert.equal(other.stdout, '');
    assert.match(other.stderr, /the token is for github\.com\/acme\/api/);
    assert.equal((await git('protocol=https\nhost=gitlab.com\npath=acme/api.git\n\n')).stdout, '');
  });

  test('git asking again reuses the token until 5 minutes before it expires: one mint, one event', async () => {
    const events = () => hub.q(`SELECT COUNT(*) AS n FROM events WHERE type = 'credential'`).get().n;
    const mints = gh.state.mints.length, logged = events();
    gh.state.expiresIn = 3600_000;
    const [a, b, c] = [await credential('a1'), await credential('a1'), await credential('a1')];
    gh.state.expiresIn = 4 * 60_000;
    assert.equal(gh.state.mints.length, mints + 1, 'one mint for three asks');
    assert.equal(events(), logged + 1, 'one event on the record');
    assert.equal(b.json.password, a.json.password);
    assert.equal(c.json.password, a.json.password);
    // A token with under 5 minutes left is not handed out again: the next ask mints a fresh one.
    hub.agentOp('web', 'handoff', 'a2', { item: '#1', headline: 'later' });
    gh.state.installed.add('acme/web');
    hub.agentOp('web', 'claim', 'a2', { item: '#1' });
    const [d, e] = [await credential('a2'), await credential('a2')];
    assert.notEqual(d.json.password, e.json.password, 'short-lived tokens are minted again');
  });

  test('cloning a project with no item held: a read-only token for one of its repos, on the record; never for others', async () => {
    const clone = (b, headers = {}, at = url) => fetch(`${at}/api/agent/credential`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ purpose: 'clone', ...b }) })
      .then(async (r) => ({ status: r.status, json: await r.json() }));
    const mints = gh.state.mints.length;
    const r = await clone({ project: 'api', repo: 'github.com/acme/api', agent: 'run-1' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.repo, 'github.com/acme/api');
    assert.match(r.json.password, /^ghs_/);
    assert.deepEqual(gh.state.mints[mints], { repositories: ['api'], permissions: { contents: 'read', metadata: 'read' } });
    const e = hub.q(`SELECT * FROM events WHERE type = 'credential' AND data LIKE '%"purpose":"clone"%'`).get();
    assert.match(e.headline, /run-1 got a read-only GitHub token to clone github\.com\/acme\/api/);
    assert.equal(e.item_id, null, 'on the project, no item');
    assert.equal(hub.q(`SELECT COUNT(*) AS n FROM events WHERE data LIKE '%ghs_%' OR headline LIKE '%ghs_%'`).get().n, 0, 'never stored');

    assert.equal((await clone({ project: 'api', repo: 'github.com/acme/web' })).status, 400, "web isn't api's repository");
    gh.state.installed.delete('acme/web');
    const refused = await clone({ project: 'web', repo: 'https://github.com/acme/web' });
    assert.equal(refused.status, 424);
    assert.match(refused.json.error, /isn't installed on acme\/web/);
    assert.ok(hub.q(`SELECT 1 FROM events WHERE type = 'credential_refused' AND data LIKE '%"purpose":"clone"%'`).get());
    gh.state.installed.add('acme/web');

    // A token scoped to other projects can't clone this one.
    const locked = createServer(hub, { auth: 'required', githubApp: { id: 1234, key: PEM, api } });
    const at = `http://127.0.0.1:${await listen(locked)}`;
    try {
      const webOnly = locked.auth.createToken('box', 'agent', { projects: ['web'] });
      const no = await clone({ project: 'api', repo: 'github.com/acme/api' }, { authorization: `Bearer ${webOnly}` }, at);
      assert.equal(no.status, 403);
      assert.match(no.json.error, /can't reach api/);
      const yes = await clone({ project: 'web', repo: 'github.com/acme/web' }, { authorization: `Bearer ${webOnly}` }, at);
      assert.equal(yes.status, 200, JSON.stringify(yes.json));
      assert.match(hub.q(`SELECT headline FROM events WHERE type = 'credential' ORDER BY id DESC`).get().headline, /^box got a read-only/, 'named by the agent token that asked');
    } finally { locked.close(); }
  });

  test('git-credential --project answers git with the clone token', async () => {
    const env = { ...process.env, NUWORQ_URL: url, NUWORQ_TOKEN: '', HOME: mkdtempSync(join(tmpdir(), 'nuworq-cred-')) };
    const out = await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [BIN, 'git-credential', 'get', '--project', 'api'], { env }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin.end('protocol=https\nhost=github.com\npath=acme/api.git\n\n');
    });
    assert.match(out, /^username=x-access-token\npassword=ghs_secret\d+\n$/);
  });

  test('a hub without an app says so (404, which the helper takes as "step aside")', async () => {
    const plain = createServer(new Hub());
    const pp = await listen(plain);
    try {
      const r = await fetch(`http://127.0.0.1:${pp}/api/agent/credential`, { method: 'POST', headers: { 'x-nuworq-agent': 'a1' }, body: '{}' });
      assert.equal(r.status, 404);
      assert.match((await r.json()).hint, /NUWORQ_GITHUB_APP_ID/);
    } finally { plain.close(); }
    assert.equal(appFromEnv({}), null);
    assert.deepEqual(appFromEnv({ NUWORQ_GITHUB_APP_ID: '7', NUWORQ_GITHUB_APP_KEY: 'pem', NUWORQ_GITHUB_APP_SLUG: 's' }), { id: '7', key: 'pem', slug: 's', client_id: '', client_secret: '' });
    assert.deepEqual(appFromEnv({ NUWORQ_GITHUB_APP_ID: '7', NUWORQ_GITHUB_APP_KEY: 'pem', NUWORQ_GITHUB_APP_CLIENT_ID: 'Iv1.c', NUWORQ_GITHUB_APP_CLIENT_SECRET: 'cs' }), { id: '7', key: 'pem', slug: '', client_id: 'Iv1.c', client_secret: 'cs' });
  });
});

describe('an owner creates the hub\'s GitHub App in one click', () => {
  test('the page posts the manifest to GitHub; the callback trades the code, saves the app 0600, and the hub uses it', async () => {
    const gh = github();
    const stub = `http://127.0.0.1:${await listen(gh.server)}`;
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-app-'));
    const appFile = join(dir, 'github-app.json');
    const hub = new Hub();
    hub.tx(() => hub.project('api', { create: true }));
    hub.addRemote(hub.project('api'), 'github.com/acme/api', 'you');
    hub.humanOp('api', 'create', { title: 'api work', acceptance: 'done' });
    const server = createServer(hub, { appFile, github: { web: stub, api: stub }, publicUrl: 'http://hub.test' });
    const port = await listen(server);
    const get = (path) => fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' });
    try {
      assert.deepEqual(await (await get('/api/github/app')).json(), { configured: false, slug: null, can_create: true });
      const page = await get('/api/github/app/new');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-security-policy'), new RegExp(`form-action 'self' ${stub}`));
      const html = await page.text();
      const action = html.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&');
      assert.ok(action.startsWith(`${stub}/settings/apps/new?state=`), action);
      const m = JSON.parse(html.match(/name="manifest" value="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      assert.deepEqual(m.default_permissions, { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read', issues: 'write' });
      assert.equal(m.redirect_url, 'http://hub.test/api/github/app/callback');
      assert.equal(m.hook_attributes.url, 'http://hub.test/api/hooks/github-app');
      const state = new URL(action).searchParams.get('state');

      assert.equal((await get(`/api/github/app/callback?code=good&state=forged`)).status, 400, 'a state the hub never made is refused');
      const back = await get(`/api/github/app/callback?code=good&state=${state}`);
      assert.equal(back.status, 302);
      assert.equal((statSync(appFile).mode & 0o777).toString(8), '600');
      assert.deepEqual(JSON.parse(readFileSync(appFile, 'utf8')), { id: '999', slug: 'nuworq-hub', key: PEM, webhook_secret: 'whs', client_id: 'cid', client_secret: 'csec', owner: 'paul' });
      assert.equal((await get(`/api/github/app/callback?code=good&state=${state}`)).status, 400, 'a state works once');
      assert.deepEqual(await (await get('/api/github/app')).json(), { configured: true, slug: 'nuworq-hub', can_create: true });
      assert.deepEqual(appFromFile(appFile).id, '999', 'serve picks it up from the file next time');

      hub.agentOp('api', 'claim', 'a1', { item: '#1' });
      const r = await fetch(`http://127.0.0.1:${port}/api/agent/credential`, { method: 'POST', headers: { 'x-nuworq-agent': 'a1' }, body: '{}' });
      assert.equal(r.status, 200, 'the new app mints at once, no restart');
      assert.equal(gh.state.jwts.at(-1).iss, '999');
    } finally { for (const s of [server, gh.server]) { s.close(); s.closeAllConnections(); } }
  });
});

describe('workers ask git for tokens through the helper', () => {
  test("a worker in a clone with an origin gets the helper in its own environment, not in any config file", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-helper-')));
    const home = join(dir, 'api');
    execFileSync('git', ['init', '-q', '-b', 'main', home]);
    execFileSync('git', ['-C', home, 'remote', 'add', 'origin', 'https://github.com/acme/api.git']);
    const hub = new Hub();
    hub.tx(() => hub.project('api', { create: true }));
    hub.humanOp('api', 'settings', { path: home });
    const server = createServer(hub);
    const port = await listen(server);
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'worker', '--url', `http://127.0.0.1:${port}`, '--project', 'api', '--as', 'w1'], { env: { ...process.env, HOME: dir }, cwd: dir });
      assert.match(stdout, /export GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential\.https:\/\/github\.com\.helper GIT_CONFIG_VALUE_0='!NUWORQ_URL=http:\/\/127\.0\.0\.1:\d+ node "[^"]+" git-credential --as w1'/);
      assert.match(stdout, /GIT_CONFIG_KEY_1=credential\.https:\/\/github\.com\.useHttpPath GIT_CONFIG_VALUE_1=true/);
      assert.doesNotMatch(execFileSync('git', ['-C', home, 'config', '--list', '--local'], { encoding: 'utf8' }), /credential/);
    } finally { server.close(); }
  });
});

describe('a renamed GitHub App', () => {
  test('the hub asks GitHub for the app\'s current slug instead of trusting the saved one', async () => {
    const { GitHubApp } = await import('../src/ghapp.js');
    const gh = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/app' ? { id: 1234, slug: 'nuworq', name: 'nuworq' } : {}));
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    try {
      const app = new GitHubApp({ id: 1234, key: PEM, slug: 'nuworq-nuworq-com', api: `http://127.0.0.1:${gh.address().port}` });
      assert.equal(await app.refreshSlug(), true);
      assert.equal(app.slug, 'nuworq');
      assert.equal(app.installUrl(), 'https://github.com/apps/nuworq/installations/new');
      assert.equal(await app.refreshSlug(), false, 'unchanged the second time');
    } finally {
      gh.close();
    }
  });
});

describe('the hub lands pull requests GitHub would leave waiting', () => {
  let gh, api;
  before(async () => { gh = github(); api = `http://127.0.0.1:${await listen(gh.server)}`; });
  after(() => { gh.server.close(); gh.server.closeAllConnections(); });

  // #1 was accepted on github.com/acme/api, which the hub has no checkout of: it lands through a pull request
  // the hub opens as the app. mergeable: the PR's state on GitHub when opened (clean: nothing to wait for).
  const landing = async ({ mergeable = 'clean', refuse = '', autoMergeOff = false } = {}) => {
    Object.assign(gh.state, { mergeable, refuseMerge: refuse, autoMergeOff });
    let t = Date.UTC(2026, 9, 29, 9);
    const hub = new Hub({ clock: () => t });
    hub.tx(() => hub.project('api', { create: true }));
    const p = hub.project('api');
    hub.addRemote(p, 'github.com/acme/api', 'you');
    hub.humanOp('api', 'settings', { github_secret: 'whs' });
    hub.github = prClient(new GitHubApp({ id: 1234, key: PEM, api }));
    hub.humanOp('api', 'create', { title: 'Ship it', acceptance: 'done' });
    const item = () => hub.item(p, '#1');
    hub.patch(item(), { stage: 'landing', branch: 'nuworq/1-ship-it' });
    hub.openPr(p, item());
    await hub.prsSettled();
    gh.state.autoMergeOff = false;
    const pr = gh.state.prs.get(100 + gh.state.prs.size);
    return {
      hub, p, item, pr, advance: (ms) => (t += ms),
      events: (type) => hub.q('SELECT * FROM events WHERE item_id = ? AND type = ? ORDER BY id').all(item().id, type),
      row: () => hub.q('SELECT * FROM prs WHERE number = ?').get(pr.number),
      merges: () => gh.state.merges.filter((m) => m.number === pr.number),
    };
  };

  test('GitHub won\'t turn auto-merge on ("clean status"): the hub squash-merges it, and that lands the item', async () => {
    const w = await landing();
    const n = w.pr.number;
    assert.deepEqual(w.merges(), [{ number: n, merge_method: 'squash' }]);
    assert.equal(w.item().stage, 'done');
    assert.equal(w.item().holder, null);
    assert.equal(w.events('pr')[0].headline, `Opened PR #${n} for #1; it had nothing to wait for, so the hub squash-merged it`);
    const landed = w.events('landed');
    assert.equal(landed.length, 1);
    assert.equal(landed[0].headline, `GitHub merged PR #${n}: #1 is on main`, "as GitHub's merged webhook says it");
    assert.equal(JSON.parse(landed[0].data).head, 'squash123');
    assert.equal(w.row().state, 'merged');

    // The merged webhook, arriving after, changes nothing.
    const raw = Buffer.from(JSON.stringify({ action: 'closed', repository: { full_name: 'acme/api' }, pull_request: { ...w.pr, title: 'Ship it' } }));
    receive(w.hub, 'api', { event: 'pull_request', raw, signature: 'sha256=' + createHmac('sha256', 'whs').update(raw).digest('hex') });
    assert.equal(w.events('landed').length, 1);
    assert.equal(w.events('pr').length, 2, 'opened, merged: nothing more');
  });

  test('auto-merge turned on: the hub merges nothing, and its periodic pass lands it once GitHub has merged it', async () => {
    const w = await landing({ mergeable: 'blocked' }); // a required check still running
    assert.ok(w.pr.auto_merge, 'auto-merge is on');
    assert.match(w.events('pr')[0].headline, /; GitHub squash-merges it when its checks pass$/);
    assert.equal(w.item().stage, 'landing');
    assert.equal(await w.hub.mergeReady(), 0);
    assert.deepEqual(w.merges(), [], 'left to auto-merge');

    // GitHub merges it when the check passes, and no webhook reaches the hub.
    Object.assign(w.pr, { state: 'closed', merged: true, merge_commit_sha: 'auto456' });
    assert.equal(await w.hub.mergeReady(), 0, 'at most one look a minute');
    w.advance(60_000);
    assert.equal(await w.hub.mergeReady(), 1);
    assert.equal(w.item().stage, 'done');
    assert.equal(w.events('landed')[0].headline, `GitHub merged PR #${w.pr.number}: #1 is on main`);
    assert.equal(JSON.parse(w.events('landed')[0].data).head, 'auto456');
    assert.deepEqual(w.merges(), []);
  });

  test('GitHub refusing the merge: the item stays in landing with the reason, said once, and a later pass merges it', async () => {
    const w = await landing({ refuse: 'Pull Request is not mergeable' });
    const n = w.pr.number;
    assert.equal(w.item().stage, 'landing');
    assert.equal(w.item().holder, null);
    assert.equal(w.row().state, 'open');
    const failed = w.events('pr_merge_failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].headline, `The hub couldn't merge PR #${n} for #1, which is ready: GitHub didn't merge PR #${n} (405: Pull Request is not mergeable)`);
    assert.match(failed[0].summary, /tries again within a minute; or merge it on GitHub, and the hub marks #1 done/);

    w.advance(60_000);
    assert.equal(await w.hub.mergeReady(), 0);
    assert.equal(w.merges().length, 2, 'tried again');
    assert.equal(w.events('pr_merge_failed').length, 1, 'the same reason goes on the record once');

    gh.state.refuseMerge = '';
    w.advance(60_000);
    assert.equal(await w.hub.mergeReady(), 1);
    assert.equal(w.item().stage, 'done');
  });

  test('a PR with no auto-merge (opened before the hub merged ready PRs, or auto-merge off) merges on the pass once ready', async () => {
    const w = await landing({ mergeable: 'unstable', autoMergeOff: true }); // its checks still running
    assert.match(w.events('pr')[0].summary, /Auto-merge couldn't be turned on \(Pull request Auto merge is not allowed for this repository\)/);
    assert.equal(await w.hub.mergeReady(), 0);
    assert.deepEqual(w.merges(), [], 'not while its checks run');
    w.pr.mergeable_state = 'clean';
    w.advance(60_000);
    assert.equal(await w.hub.mergeReady(), 1);
    assert.deepEqual(w.merges(), [{ number: w.pr.number, merge_method: 'squash' }]);
    assert.equal(w.item().stage, 'done');
  });

  test('closed on GitHub without merging: the pass leaves it in landing as a land job, saying so', async () => {
    const w = await landing({ mergeable: 'blocked' });
    w.pr.state = 'closed';
    await w.hub.mergeReady();
    assert.equal(w.item().stage, 'landing');
    assert.equal(w.row().state, 'closed');
    assert.equal(w.events('pr').at(-1).headline, `PR #${w.pr.number} was closed without merging; #1 is a land job again`);
    w.advance(3 * 60_000);
    const job = w.hub.agentOp('api', 'next', 'a1');
    assert.equal(job.mode, 'land');
    assert.equal(job.item, '#1');
  });

  test('in conflict with main ("dirty"): the pass makes it a land job to rebase and force-push the branch', async () => {
    const w = await landing({ mergeable: 'blocked' });
    w.hub.patch(w.item(), { holder: 'a0', lease_until: Date.UTC(2026, 9, 29, 12) }); // a hold from before the conflict
    w.pr.mergeable_state = 'dirty';
    await w.hub.mergeReady();
    assert.equal(w.row().blocked, 'conflict');
    assert.equal(w.item().holder, null);
    assert.match(w.events('pr_blocked')[0].headline, new RegExp(`PR #${w.pr.number} can't merge: its branch conflicts with main`));
    w.advance(3 * 60_000);
    const job = w.hub.agentOp('api', 'next', 'a1');
    assert.equal(job.mode, 'land');
    assert.equal(job.item, '#1');
    assert.match(job.hint, /git rebase origin\/main/);
    assert.match(job.hint, /Run the project's checks/);
    assert.match(job.hint, /git push origin nuworq\/1-ship-it --force-with-lease/);
    w.advance(60_000);
    await w.hub.mergeReady();
    assert.equal(w.events('pr_blocked').length, 1, 'said once');
    assert.deepEqual(w.merges(), []);
  });
});
