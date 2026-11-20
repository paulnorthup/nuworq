import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorSource, mirrorPath, sshHosts, relayTarget, pushMirror, fetchMirror } from '../src/git.js';
import { relayPush, serveFetch, receivePack } from '../src/gitproxy.js';

const run = promisify(execFile);
const HOST = 'git.example.test';

describe('relayed git hosts: plain SSH git servers with no owner level', () => {
  test('a host/repo remote is fetched as git@host:repo.git; github.com still needs an owner', () => {
    assert.equal(mirrorSource(`${HOST}/ai-stack`), `git@${HOST}:ai-stack.git`);
    assert.equal(mirrorSource('github.com/acme/api'), 'git@github.com:acme/api.git');
    assert.equal(mirrorSource('github.com/api'), null);
    assert.equal(mirrorSource(`${HOST}/..`), null);
    assert.equal(mirrorPath('/r', `${HOST}/ai-stack`), `/r/${HOST}/ai-stack.git`);
  });

  test('NUWORQ_GIT_SSH_HOSTS: host names only, never github.com', () => {
    assert.deepEqual([...sshHosts(` git@${HOST}, other.example.test `)], [HOST, 'other.example.test']);
    assert.deepEqual([...sshHosts('')], []);
    assert.deepEqual([...sshHosts(undefined)], []);
    for (const bad of ['github.com', 'localhost', 'a b.example', 'host/x', '-x.example', 'x.example;rm']) {
      assert.throws(() => sshHosts(bad), /isn't a host name/, bad);
    }
  });

  test('relayTarget: only plain repository names on a relayed host reach its login shell', () => {
    const hosts = sshHosts(HOST);
    assert.deepEqual(relayTarget(`${HOST}/ai-stack`, hosts), { target: `git@${HOST}`, path: 'ai-stack.git' });
    assert.deepEqual(relayTarget(`${HOST}/homelab_ui.v2`, hosts), { target: `git@${HOST}`, path: 'homelab_ui.v2.git' });
    for (const bad of [`${HOST}/-x`, `${HOST}/.x`, `${HOST}/a;b`, `${HOST}/a'b`, `${HOST}/a b`, `${HOST}/$(id)`, `${HOST}/a/b`, `${HOST}/x.git`, `${HOST}/`, 'other.example.test/x', 'github.com/acme/api']) {
      assert.equal(relayTarget(bad, hosts), null, bad);
    }
    assert.equal(relayTarget(`${HOST}/x`, null), null);
    assert.throws(() => receivePack(`git@${HOST}`, "x';id;'.git"), /not a repository the hub relays/);
    assert.throws(() => receivePack('root@x', 'x.git'), /not a repository the hub relays/);
  });
});

// A stand-in for the git host: an `ssh` on PATH that runs the remote command in a folder of bare repositories, as
// git-shell would. Real git on both ends: a client pushes and fetches over smart HTTP to a server that relays.
describe('a worker fetches and pushes a relayed repository through the hub', () => {
  let dir, host, mirrors, server, port, oldPath;
  const branch = 'nuworq/7-relay';
  const git = (cwd, ...args) => run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-relay-')));
    host = join(dir, 'host');
    mirrors = join(dir, 'mirrors');
    mkdirSync(host);
    mkdirSync(join(dir, 'bin'));
    const ssh = join(dir, 'bin', 'ssh');
    writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncd '${host}' && exec sh -c "$last"\n`);
    chmodSync(ssh, 0o755);
    oldPath = process.env.PATH;
    process.env.PATH = `${join(dir, 'bin')}:${oldPath}`;
    await git(host, 'init', '-q', '--bare', '-b', 'main', 'r.git');
    const seed = join(dir, 'seed');
    await git(dir, 'init', '-q', '-b', 'main', seed);
    await git(seed, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'one');
    await git(seed, 'push', '-q', join(host, 'r.git'), 'main');
    const f = await fetchMirror(mirrors, `${HOST}/r`);
    assert.ok(!f.error, f.error);
    const target = relayTarget(`${HOST}/r`, sshHosts(HOST));
    server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://hub');
      const service = u.pathname.replace(/^\/r\.git\//, '');
      try {
        if (service === 'git-receive-pack' || u.searchParams.get('service') === 'git-receive-pack') {
          return await relayPush(req, res, { ...target, service, branch });
        }
        return await serveFetch(req, res, { mirror: mirrorPath(mirrors, `${HOST}/r`), service, query: u.search.slice(1) });
      } catch (e) {
        res.writeHead(500); res.end(String(e.message));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(() => {
    server?.close();
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test('clone from the mirror, push the held branch to the host; main and other branches are refused', async () => {
    const work = join(dir, 'work');
    await git(dir, 'clone', '-q', `http://127.0.0.1:${port}/r.git`, work);
    assert.match((await git(work, 'log', '--format=%s')).stdout, /one/);
    await git(work, 'switch', '-q', '-c', branch);
    await git(work, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'two');
    await git(work, 'push', '-q', 'origin', branch);
    const pushed = (await git(join(host, 'r.git'), 'rev-parse', branch)).stdout.trim();
    assert.equal(pushed, (await git(work, 'rev-parse', 'HEAD')).stdout.trim(), 'the branch is on the git host');
    await assert.rejects(git(work, 'push', 'origin', `${branch}:main`), /workers never push main/);
    await assert.rejects(git(work, 'push', 'origin', `${branch}:refs/heads/other`), /workers push only/);
    assert.match((await git(join(host, 'r.git'), 'log', '--format=%s', 'main')).stdout, /^one\n$/, 'main is untouched');
  });

  test('the hub fast-forwards main from its mirror, and never forces', async () => {
    {
      const f = await fetchMirror(mirrors, `${HOST}/r`);
      assert.ok(!f.error, f.error);
    }
    const head = (await git(join(host, 'r.git'), 'rev-parse', branch)).stdout.trim();
    assert.equal(await pushMirror(mirrors, `${HOST}/r`, `+${head}:refs/heads/main`), 'the hub never force-pushes');
    assert.equal(await pushMirror(mirrors, `${HOST}/r`, `${head}:refs/heads/main`), null);
    assert.equal((await git(join(host, 'r.git'), 'rev-parse', 'main')).stdout.trim(), head);
  });
});
