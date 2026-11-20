import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mirrorSource, mirrorPath, sshHosts, relayTarget, pushMirror, fetchMirror } from '../src/git.js';
import { relayPush, serveFetch, receivePack } from '../src/gitproxy.js';
import { Hub, LAND_GRACE } from '../src/core.js';
import { tagRelease, tagsSettled } from '../src/releases.js';

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

// The hub lands relayed work itself (landRelayed): a reviewed branch is fast-forwarded onto main on the git host; a
// branch that moved past its review goes back to review instead of waiting in landing for land jobs that can't land it.
describe('the hub lands work on a relayed git host', () => {
  let root, oldPath;
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-relay-land-')));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'host'));
    writeFileSync(join(root, 'bin', 'ssh'), `#!/bin/sh\nfor last; do :; done\ncd '${join(root, 'host')}' && exec sh -c "$last"\n`);
    chmodSync(join(root, 'bin', 'ssh'), 0o755);
    oldPath = process.env.PATH;
    process.env.PATH = `${join(root, 'bin')}:${oldPath}`;
  });
  after(() => {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  });

  function setup(name) {
    const origin = join(root, 'host', `${name}.git`);
    git(join(root, 'host'), 'init', '-q', '--bare', '-b', 'main', `${name}.git`);
    const seed = join(root, `${name}-seed`);
    git(root, 'clone', '-q', origin, seed);
    writeFileSync(join(seed, 'README'), 'hi\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'init');
    git(seed, 'push', '-q', 'origin', 'main');
    let now = Date.UTC(2026, 10, 20, 9);
    const hub = new Hub({ clock: () => now, repos: join(root, `${name}-repos`), sshHosts: sshHosts(HOST) });
    hub.tx(() => hub.project('demo', { create: true }));
    hub.agentOp('demo', 'checkin', 'a1', {}, { root: '/elsewhere', remote: `git@${HOST}:${name}.git` });
    const op = (agent, n, args = {}) => hub.agentOp('demo', n, agent, args);
    const item = (n) => hub.item(hub.project('demo'), `#${n}`);
    // A worker's clone: straight from the bare repository (the relay itself is tested above).
    const mac = join(root, `${name}-mac`);
    git(root, 'clone', '-q', origin, mac);
    const commit = (file) => { writeFileSync(join(mac, file), `${file}\n`); git(mac, 'add', '.'); git(mac, 'commit', '-q', '-m', `add ${file}`); };
    return { hub, origin, mac, op, item, commit, tick: (ms) => { now += ms; } };
  }

  test('accepted work is fast-forwarded onto main by the hub when the land job submits; workers may land it', async () => {
    const { hub, origin, mac, op, item, commit, tick } = setup('a');
    assert.deepEqual(hub.relayHosts(hub.project('demo')), [HOST]);
    hub.humanOp('demo', 'create', { title: 'Add a greeting file', acceptance: 'greeting exists' });
    const job = op('a1', 'next');
    git(mac, 'switch', '-q', '--no-track', '-c', job.branch, 'origin/main');
    commit('greeting');
    git(mac, 'push', '-q', 'origin', job.branch);
    tick(60_000);
    await hub.prefetch('demo', { item: '#1' });
    op('a1', 'submit', { item: '#1', headline: 'Greeting added', evidence: [{ label: 'ls: greeting' }] });
    hub.humanOp('demo', 'accept', { item: '#1' });
    assert.equal(item(1).stage, 'landing');
    tick(LAND_GRACE + 1000);
    op('w1', 'checkin', { role: 'worker', runner: 'mac' });
    const land = op('w1', 'next');
    assert.equal(land.mode, 'land', 'a worker may land relayed work: it never pushes main');
    assert.match(land.hint, /the hub puts nuworq\/1-add-a-greeting-file on main itself/);
    await hub.landRelayed('demo', { item: '#1' });
    assert.equal(git(origin, 'rev-parse', 'main'), git(mac, 'rev-parse', job.branch), 'main on the git host is the branch');
    op('w1', 'submit', { item: '#1', headline: 'Landed' });
    assert.equal(item(1).stage, 'done');
  });

  test('a branch that moved past its review goes back to review; main is untouched', async () => {
    const { hub, origin, mac, op, item, commit, tick } = setup('b');
    hub.humanOp('demo', 'create', { title: 'Add a file', acceptance: 'x' });
    const job = op('a1', 'next');
    git(mac, 'switch', '-q', '--no-track', '-c', job.branch, 'origin/main');
    commit('one');
    git(mac, 'push', '-q', 'origin', job.branch);
    tick(60_000);
    await hub.prefetch('demo', { item: '#1' });
    op('a1', 'submit', { item: '#1', headline: 'One', evidence: [{ label: 'ok' }] });
    hub.humanOp('demo', 'accept', { item: '#1' });
    const main = git(origin, 'rev-parse', 'main');
    commit('two'); // after the review: not what was accepted
    git(mac, 'push', '-q', 'origin', job.branch);
    await hub.landRelayed('demo', { item: '#1' });
    assert.equal(item(1).stage, 'verifying', 'back to review, not left in landing');
    assert.equal(git(origin, 'rev-parse', 'main'), main, 'nothing unreviewed reached main');
  });

  // A release that lands there is tagged there by the hub, as the GitHub App tags one on GitHub: no hand step.
  const tagEvents = (hub, id) => hub.q(`SELECT type, headline FROM events WHERE item_id = ? AND type IN ('tagged', 'tag_failed') ORDER BY id`).all(id).map((e) => ({ ...e }));
  const tagQuestions = (hub, id) => hub.q(`SELECT * FROM questions WHERE item_id = ? AND audience = 'operator' AND status = 'open'`).all(id);

  test('a release that lands is tagged on the git host by the hub, on the commit main got; a tag is never moved', async () => {
    const { hub, origin, mac, op, item, commit, tick } = setup('c');
    const p = hub.project('demo');
    hub.humanOp('demo', 'create', { title: 'Release v0.3.0', acceptance: 'x' });
    hub.patch(item(1), { release: 1 });
    const job = op('a1', 'next');
    assert.equal(job.item, '#1');
    git(mac, 'switch', '-q', '--no-track', '-c', job.branch, 'origin/main');
    commit('VERSION');
    git(mac, 'push', '-q', 'origin', job.branch);
    tick(60_000);
    await hub.prefetch('demo', { item: '#1' });
    op('a1', 'submit', { item: '#1', headline: 'v0.3.0', evidence: [{ label: 'ok' }] });
    hub.humanOp('demo', 'accept', { item: '#1' });
    tick(LAND_GRACE + 1000);
    op('w1', 'checkin', { role: 'worker', runner: 'mac' });
    assert.equal(op('w1', 'next').mode, 'land');
    await hub.landRelayed('demo', { item: '#1' });
    const res = op('w1', 'submit', { item: '#1', headline: 'Landed' });
    assert.doesNotMatch(res.hint, /Tag it/, 'the hub tags it; nothing for the lander to do');
    await tagsSettled(hub);
    const main = git(origin, 'rev-parse', 'main');
    assert.equal(main, git(mac, 'rev-parse', job.branch));
    assert.equal(git(origin, 'rev-parse', 'v0.3.0^{commit}'), main, 'v0.3.0 is on the git host, on the commit main got');
    assert.equal(git(origin, 'cat-file', '-t', 'v0.3.0'), 'commit', 'a lightweight tag, as on GitHub');
    assert.deepEqual(tagEvents(hub, item(1).id), [{ type: 'tagged', headline: `nuworq tagged ${main.slice(0, 7)} v0.3.0 on ${HOST}/c` }]);
    assert.equal(tagQuestions(hub, item(1).id).length, 0);

    // Tagged again (a retry, a second lander): it is there on that commit already, so that is done, with no push.
    hub.tx(() => tagRelease(hub, p, item(1), main));
    await tagsSettled(hub);
    assert.equal(tagEvents(hub, item(1).id).at(-1).headline, `v0.3.0 was already on ${main.slice(0, 7)} in ${HOST}/c`);

    // Asked to tag another commit: the tag stays where it is, and an operator is asked, not forced.
    const before = git(origin, 'rev-parse', 'main~1');
    hub.tx(() => tagRelease(hub, p, item(1), before));
    await tagsSettled(hub);
    assert.equal(git(origin, 'rev-parse', 'v0.3.0^{commit}'), main, 'never moved');
    assert.deepEqual(tagEvents(hub, item(1).id).at(-1), { type: 'tag_failed', headline: `The hub couldn't tag ${before.slice(0, 7)} v0.3.0 on ${HOST}/c: v0.3.0 is already on ${HOST}/c at ${main.slice(0, 7)}` });
    const [q] = tagQuestions(hub, item(1).id);
    assert.match(q.question, /^Tag the release v0\.3\.0/);
  });

  test('a git server that refuses the hub\'s tag: tag_failed, and an operator gets the command to tag it by hand', async () => {
    const { hub, origin, item } = setup('d');
    // The git server lets the hub push branches but no tags.
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/tags/*) echo "refused: no tags from the hub" >&2; exit 1;; esac; done\n');
    chmodSync(join(origin, 'hooks', 'pre-receive'), 0o755);
    const p = hub.project('demo');
    hub.humanOp('demo', 'create', { title: 'Release v1.0.0', acceptance: 'x' });
    hub.patch(item(1), { release: 1, stage: 'done' });
    const main = git(origin, 'rev-parse', 'main');
    assert.equal(hub.tx(() => tagRelease(hub, p, item(1), main)), '');
    await tagsSettled(hub);
    assert.equal(git(origin, 'tag', '--list'), '', 'no tag on the git server');
    const [ev] = tagEvents(hub, item(1).id);
    assert.equal(ev.type, 'tag_failed');
    assert.match(ev.headline, new RegExp(`^The hub couldn't tag ${main.slice(0, 7)} v1\\.0\\.0 on ${HOST}/d: `));
    const [q] = tagQuestions(hub, item(1).id);
    assert.ok(q.context.includes(`git tag v1.0.0 ${main} && git push origin refs/tags/v1.0.0`), 'the operator gets the exact command');
  });

  test('tagRelayed pushes only a vX.Y.Z tag at a full commit id', async () => {
    const { hub, origin } = setup('e');
    const main = git(origin, 'rev-parse', 'main');
    assert.match((await hub.tagRelayed(`${HOST}/e`, 'v1.0', main)).error, /isn't a release tag the hub pushes/);
    assert.match((await hub.tagRelayed(`${HOST}/e`, 'v1.0.0', 'main')).error, /isn't a release tag the hub pushes/);
    assert.match((await hub.tagRelayed(`${HOST}/e`, 'v1.0.0', '+'.padEnd(40, 'a'))).error, /isn't a release tag the hub pushes/);
    assert.match((await hub.tagRelayed(`${HOST}/e`, 'v1.0.0', 'f'.repeat(40))).error, /doesn't have fffffff/);
    assert.deepEqual(await hub.tagRelayed(`${HOST}/e`, 'v1.0.0', main), { tagged: true });
    assert.equal(git(origin, 'rev-parse', 'v1.0.0'), main);
  });
});
