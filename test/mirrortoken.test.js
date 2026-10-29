import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { GitHubApp, prClient } from '../src/ghapp.js';
import { view } from '../src/insight.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// git http-backend behind a token check. argv: git, root (served/ holds the repos, tokens the live
// tokens; each request let in is a line in served.log). Prints its address when listening.
const GIT_SERVER = `
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
const [git, root] = process.argv.slice(1);
const server = http.createServer((req, res) => {
  const [user, token] = Buffer.from(String(req.headers.authorization ?? '').replace(/^basic /i, ''), 'base64').toString().split(':');
  if (user !== 'x-access-token' || !token || !readFileSync(root + '/tokens', 'utf8').split('\\n').includes(token)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
    return res.end();
  }
  appendFileSync(root + '/served.log', req.url + '\\n');
  const url = new URL(req.url, 'http://x');
  const cgi = spawn(git, ['http-backend'], { env: {
    GIT_PROJECT_ROOT: root + '/served', GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1',
    ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
  } });
  req.pipe(cgi.stdin);
  const chunks = [];
  cgi.stdout.on('data', (c) => chunks.push(c));
  cgi.on('close', () => {
    const out = Buffer.concat(chunks), at = out.indexOf('\\r\\n\\r\\n');
    const headers = {};
    let status = 200;
    for (const line of out.subarray(0, at).toString().split('\\r\\n')) {
      const [k, ...v] = line.split(': ');
      if (k.toLowerCase() === 'status') status = parseInt(v.join(': '), 10);
      else headers[k] = v.join(': ');
    }
    res.writeHead(status, headers);
    res.end(out.subarray(at + 4));
  });
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));
`;

// The hub's mirrors come over HTTPS with the GitHub App's read token (#85). A fake GitHub API mints
// tokens; a smart-HTTP git server (git http-backend) serves bare repos and lets in only a live token.
describe("the hub's mirrors use the GitHub App's token", () => {
  const state = { installed: new Set(['acme/api']), suspended: false, mints: [], tokens: new Set() };
  const served = () => (existsSync(join(root, 'served.log')) ? readFileSync(join(root, 'served.log'), 'utf8').split('\n').length - 1 : 0);
  let root, api, web, hub, bin, log, errors, saved;
  const git = (cwd, ...a) => execFileSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const settle = (remote) => hub._mirrorTokens.get(remote)?.pending;

  before(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-mirrortoken-')));
    for (const name of ['api', 'web']) {
      const bare = join(root, 'served', 'acme', `${name}.git`);
      mkdirSync(bare, { recursive: true });
      git(bare, 'init', '-q', '--bare', '-b', 'main');
      const seed = join(root, `seed-${name}`);
      git(root, 'clone', '-q', bare, seed);
      writeFileSync(join(seed, 'README'), `${name}\n`);
      git(seed, 'add', '.');
      git(seed, 'commit', '-q', '-m', 'init');
      git(seed, 'push', '-q', 'origin', 'main');
    }

    api = http.createServer(async (req, res) => {
      const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
      let m, raw = '';
      for await (const c of req) raw += c;
      if (req.method === 'GET' && (m = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
        return state.installed.has(m[1]) ? json(200, { id: 42 }) : json(404, { message: 'Not Found' });
      }
      if (req.method === 'POST' && req.url === '/app/installations/42/access_tokens') {
        if (state.suspended) return json(403, { message: 'This installation has been suspended' });
        state.mints.push(JSON.parse(raw));
        const token = `ghs_mirror${state.mints.length}`;
        state.tokens.add(token);
        appendFileSync(join(root, 'tokens'), `${token}\n`);
        return json(201, { token, expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      json(404, { message: 'Not Found' });
    });
    // GitHub's git over HTTPS, in a process of its own: the hub runs git synchronously, which would
    // block a server in this one. Lets in a live token as basic auth (x-access-token), else 401.
    writeFileSync(join(root, 'tokens'), '');
    web = spawn(process.execPath, ['--input-type=module', '-e', GIT_SERVER, GIT, root], { stdio: ['ignore', 'pipe', 'inherit'] });
    const webUrl = await new Promise((r) => web.stdout.once('data', (d) => r(String(d).trim())));
    const apiUrl = `http://127.0.0.1:${await listen(api)}`;

    // Every git the hub runs goes through a shim that records its arguments; ssh refuses, so the
    // deploy-key path never leaves the machine.
    bin = join(root, 'bin');
    log = join(root, 'git.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${GIT}' "$@"\n`, { mode: 0o755 });
    saved = { PATH: process.env.PATH, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND, GIT_SSH: process.env.GIT_SSH };
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.GIT_SSH_COMMAND = 'false';
    delete process.env.GIT_SSH;
    errors = [];
    saved.error = console.error;
    console.error = (...a) => errors.push(a.join(' '));

    hub = new Hub({ repos: join(root, 'hub', 'repos') });
    hub.github = prClient(new GitHubApp({ id: 1, key: PEM, slug: 'nuworq-test', api: apiUrl }), { web: webUrl });
    for (const name of ['api', 'web']) {
      hub.tx(() => hub.project(name, { create: true }));
      hub.addRemote(hub.project(name), `github.com/acme/${name}`, 'you');
    }
  });
  after(() => {
    console.error = saved.error;
    for (const k of ['PATH', 'GIT_SSH_COMMAND', 'GIT_SSH']) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    api.close();
    api.closeAllConnections();
    web.kill();
  });

  test('cloned and fetched over HTTPS with a read-only token, minted once while it is good', async () => {
    const p = hub.project('api');
    // The first ask has no token yet: it tries the deploy key (refused here) and starts minting.
    assert.equal(hub.repoFor(p, null, { fresh: true }), null);
    await settle('github.com/acme/api');
    assert.deepEqual(state.mints, [{ repositories: ['api'], permissions: { contents: 'read', metadata: 'read' } }]);

    const repo = hub.repoFor(p);
    assert.equal(repo?.mode, 'remote', 'cloned at the next ask, without waiting out the fetch interval');
    assert.equal(git(repo.path, 'rev-parse', 'main'), git(join(root, 'seed-api'), 'rev-parse', 'HEAD'));

    // Work pushed since reaches the mirror at the next fresh fetch, with the same token.
    const seed = join(root, 'seed-api');
    git(seed, 'switch', '-q', '-c', 'nuworq/1-x');
    writeFileSync(join(seed, 'x'), 'x\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'x');
    git(seed, 'push', '-q', 'origin', 'nuworq/1-x');
    const before = served();
    assert.ok(hub.repoFor(p, null, { fresh: true }));
    assert.ok(served() > before, 'fetched over HTTPS, let in by the token');
    assert.equal(git(repo.path, 'rev-parse', 'nuworq/1-x'), git(seed, 'rev-parse', 'HEAD'));
    assert.equal(state.mints.length, 1, 'the token is reused until 5 minutes before it expires');
  });

  test('the token is never in argv, the mirror, or the logs', () => {
    const repo = hub.repoFor(hub.project('api'));
    const secrets = [...state.tokens].flatMap((t) => [t, Buffer.from(`x-access-token:${t}`).toString('base64')]);
    const config = git(repo.path, 'config', '--list');
    const argv = readFileSync(log, 'utf8');
    assert.match(argv, /clone -q --mirror -- http:\/\/127\.0\.0\.1:\d+\/acme\/api\.git/);
    for (const s of secrets) {
      assert.ok(!config.includes(s), 'not in the mirror config');
      assert.ok(!readFileSync(join(repo.path, 'config'), 'utf8').includes(s));
      assert.ok(!argv.includes(s), 'not in any git argv');
      assert.ok(!errors.join('\n').includes(s), 'not in the hub log');
    }
  });

  test("an app that isn't installed is worth knowing, and the hub falls back to the deploy key until it is", async () => {
    const p = hub.project('web'), remote = 'github.com/acme/web';
    // A mirror the hub cloned over SSH with a deploy key, before the app.
    const path = join(root, 'hub', 'repos', 'github.com', 'acme', 'web.git');
    mkdirSync(join(path, '..'), { recursive: true });
    git(root, 'clone', '-q', '--mirror', join(root, 'served', 'acme', 'web.git'), path);
    git(path, 'remote', 'set-url', 'origin', 'git@github.com:acme/web.git');
    const before = readFileSync(log, 'utf8').length;
    assert.equal(hub.repoFor(p, null, { fresh: true }), null);
    await settle(remote);
    assert.equal(hub.repoFor(p, null, { fresh: true }), null, 'no token: the deploy key, refused here');
    assert.ok(readFileSync(log, 'utf8').slice(before).split('\n').includes(`-C ${path} fetch -q --prune`), 'fetched from its SSH remote, as before the app');
    const know = () => view(hub, 'web').attention.filter((a) => a.kind === 'app-read');
    assert.equal(know().length, 1);
    assert.equal(know()[0].level, 'know');
    assert.match(know()[0].headline, /can't read github\.com\/acme\/web through its GitHub App/);
    assert.match(know()[0].sub, /isn't installed on acme\/web/);
    assert.match(know()[0].why, /github\.com\/apps\/nuworq-test\/installations\/new/);
    assert.equal(view(hub, 'api').attention.filter((a) => a.kind === 'app-read').length, 0, "only the repository's own project");

    // Within the retry window the hub doesn't ask GitHub again.
    const mints = state.mints.length;
    hub.refreshMirrorTokens();
    assert.equal(settle(remote), undefined);

    state.installed.add('acme/web');
    await hub.mintMirrorToken(remote);
    assert.equal(know().length, 0, 'clears once the app can mint');
    assert.equal(state.mints.length, mints + 1);
    // The SSH-cloned mirror is fetched over HTTPS now, and keeps its own remote.
    const seed = join(root, 'seed-web');
    writeFileSync(join(seed, 'y'), 'y\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'y');
    git(seed, 'push', '-q', 'origin', 'main');
    assert.equal(hub.repoFor(p)?.path, path);
    assert.equal(git(path, 'rev-parse', 'main'), git(seed, 'rev-parse', 'HEAD'));
    assert.equal(git(path, 'remote', 'get-url', 'origin'), 'git@github.com:acme/web.git');
  });

  test('a suspended installation is worth knowing too', async () => {
    state.suspended = true;
    try {
      await hub.mintMirrorToken('github.com/acme/web');
      const [a] = view(hub, 'web').attention.filter((x) => x.kind === 'app-read');
      assert.match(a.sub, /suspended or removed/);
    } finally {
      state.suspended = false;
    }
  });

  test('without the app, or for a repository not on GitHub, mirrors are fetched as before', () => {
    const plain = new Hub({ repos: join(root, 'plain') });
    assert.equal(plain.mirrorHttps('github.com/acme/api'), null, 'no app');
    assert.equal(hub.mirrorHttps('/srv/git/api'), null, 'a path is no GitHub repository');
    assert.equal(hub._mirrorTokens.has('/srv/git/api'), false, 'and nothing is minted for it');
  });
});
