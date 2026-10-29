import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { appFromEnv } from '../src/ghapp.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'nuworq.js');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

// GitHub's REST API, as far as the app uses it. It checks the app's JWT, and knows which repos have the app.
function github() {
  const state = { installed: new Set(['acme/api']), suspended: false, mints: [], jwts: [] };
  const server = http.createServer(async (req, res) => {
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
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
      return json(201, { token: `ghs_secret${state.mints.length}`, expires_at: '2026-10-29T13:00:00Z', repository_selection: 'selected' });
    }
    json(404, { message: 'Not Found' });
  });
  return { server, state };
}

describe('a GitHub App mints one-repo, one-hour tokens per claim', () => {
  let gh, hub, server, port, url;
  before(async () => {
    gh = github();
    const api = `http://127.0.0.1:${await listen(gh.server)}`;
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
    assert.deepEqual({ ...r.json, password: undefined }, { ok: true, username: 'x-access-token', password: undefined, repo: 'github.com/acme/api', expires_at: '2026-10-29T13:00:00Z' });
    assert.equal(r.json.password, 'ghs_secret1');
    assert.deepEqual(gh.state.mints[0], { repositories: ['api'], permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' } });
    const jwt = gh.state.jwts.at(-1);
    assert.equal(jwt.iss, '1234');
    assert.ok(jwt.exp - jwt.iat <= 600, 'the app JWT lives at most 10 minutes');

    const e = hub.q(`SELECT * FROM events WHERE type = 'credential'`).get();
    assert.equal(e.actor, 'a1');
    assert.match(e.headline, /a1 got a GitHub token for github\.com\/acme\/api on #1, until 13:00 UTC/);
    assert.deepEqual(JSON.parse(e.data), { agent: 'a1', item: 1, repo: 'github.com/acme/api', expires_at: '2026-10-29T13:00:00Z', token: null });
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

  test('a hub without an app says so (404, which the helper takes as "step aside")', async () => {
    const plain = createServer(new Hub());
    const pp = await listen(plain);
    try {
      const r = await fetch(`http://127.0.0.1:${pp}/api/agent/credential`, { method: 'POST', headers: { 'x-nuworq-agent': 'a1' }, body: '{}' });
      assert.equal(r.status, 404);
      assert.match((await r.json()).hint, /NUWORQ_GITHUB_APP_ID/);
    } finally { plain.close(); }
    assert.equal(appFromEnv({}), null);
    assert.deepEqual(appFromEnv({ NUWORQ_GITHUB_APP_ID: '7', NUWORQ_GITHUB_APP_KEY: 'pem', NUWORQ_GITHUB_APP_SLUG: 's' }), { id: '7', key: 'pem', slug: 's' });
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
