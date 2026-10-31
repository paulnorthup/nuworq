import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archive, newestSigned, packageAt, signatureOf, PACKAGE_NAME } from '../src/package.js';
import { round, watch, newer, releaseItem } from '../scripts/signer.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: `${stamp} +0000`, GIT_AUTHOR_DATE: `${stamp} +0000` } }).trim();
let stamp = 1_700_000_000;
const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: publicKey.export({ type: 'spki', format: 'pem' }) };
};

// A fake origin (a bare repository, as GitHub), a checkout of it the signer runs in, and a fake hub that keeps
// the packages of the commits it ran and names its newest validly signed one as its release, as the real one
// does (src/package.js). scp copies into the hub's package folder, unless told to fail.
describe('the release signer (#430)', () => {
  let dir, origin, work, repo, hubDir, server, hub, ours, pinned, scpFails, ran, comments;
  const commit = (files, msg) => {
    for (const [f, text] of Object.entries(files)) { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), text); }
    git(work, 'add', '-A');
    stamp += 60;
    git(work, 'commit', '-qm', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  // A release as main gets it: the version, its changelog entry first, the pinned key; tagged and pushed.
  const release = async (version, { changelog = `## ${version}\n\n- things\n`, pub = pinned, branch = 'main', run = true } = {}) => {
    if (branch !== 'main') git(work, 'switch', '-qc', branch);
    const c = commit({ 'package.json': JSON.stringify({ name: 'nuworq', version }), 'CHANGELOG.md': changelog, 'release-key.pub': pub }, `Release v${version}`);
    git(work, 'tag', `v${version}`);
    git(work, 'push', '-q', 'origin', branch, `v${version}`);
    if (branch !== 'main') git(work, 'switch', '-q', 'main');
    if (run) await runs(c);
    return c;
  };
  // The hub ran commit c: it built its package from its own checkout (here, the origin).
  const runs = async (c) => { await archive(origin, c, join(hubDir, `nuworq-${c}.tgz`)); ran = c; };
  const scp = async (file, to) => {
    if (scpFails) throw new Error('ssh: connect to host nuworq-vm: Operation timed out');
    copyFileSync(file, join(to, basename(file)));
  };
  const check = (state = {}) => round({ repo, hub, key: ours.key, dest: hubDir, scp, state, comment: async (r) => comments.push(r) });
  const outcome = (rs, tag) => rs.find((r) => r.tag === tag);

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-signer-test-')));
    origin = join(dir, 'origin.git'); work = join(dir, 'work'); repo = join(dir, 'signer'); hubDir = join(dir, 'hub-packages');
    mkdirSync(hubDir);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, work]);
    git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
    ours = keypair(); pinned = ours.pub; scpFails = false; comments = [];
    commit({ '.gitattributes': 'src/commit.txt export-subst\n', 'src/commit.txt': '$Format:%H %ct$\n', 'bin/nuworq.js': '// nuworq\n', 'release-key.pub': pinned }, 'start');
    git(work, 'push', '-q', 'origin', 'main');
    await runs(git(work, 'rev-parse', 'HEAD'));
    execFileSync('git', ['clone', '-q', origin, repo]);
    server = createServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, 0));
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/api/package') {
        const r = newestSigned(hubDir, readFileSync(join(work, 'release-key.pub'), 'utf8'), new Map());
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ package: { commit: ran.slice(0, 7), signed: !!signatureOf({ file: join(hubDir, `nuworq-${ran}.tgz`) }), release: r && { commit: r.commit, time: r.time, sha256: r.sha256 } } }));
      }
      const m = path.slice(1).replace(/\.sig$/, '').match(PACKAGE_NAME);
      const b = m && packageAt(hubDir, m[1]);
      if (!b) { res.writeHead(404); return res.end(); }
      if (path.endsWith('.sig')) {
        const sig = signatureOf(b);
        res.writeHead(sig ? 200 : 404);
        return res.end(sig ?? '');
      }
      res.writeHead(200, { etag: `"${b.sha256}"` });
      res.end(readFileSync(b.file));
    });
    hub = `http://127.0.0.1:${await listen(server)}`;
  });
  afterEach(() => { server.close(); server.closeAllConnections(); });

  test('signs a new tag on main, built from GitHub, and the hub serves it as its release', async () => {
    const c = await release('0.3.0');
    const rs = await check();
    assert.equal(outcome(rs, 'v0.3.0').outcome, 'signed', JSON.stringify(rs));
    const sig = readFileSync(join(hubDir, `nuworq-${c}.tgz.sig`), 'utf8');
    assert.ok(verify(null, readFileSync(join(hubDir, `nuworq-${c}.tgz`)), createPublicKey(ours.key), Buffer.from(sig, 'base64')), 'a signature over the hub\'s very bytes');
    assert.deepEqual(comments.map((r) => [r.version, r.short]), [['0.3.0', c.slice(0, 7)]], 'said once, for the release item');
    const again = await check();
    assert.equal(outcome(again, 'v0.3.0').outcome, 'done', 'signed once: the next round leaves it');
    assert.equal(comments.length, 1);
    // The next release is newer, so it is signed too; the one before is now older.
    await release('0.4.0');
    const next = await check();
    assert.equal(outcome(next, 'v0.4.0').outcome, 'signed');
    assert.equal(outcome(next, 'v0.3.0').outcome, 'refused');
    assert.match(outcome(next, 'v0.3.0').reason, /older than the hub's signed release v0\.4\.0/);
  });

  test('never signs a tag off main', async () => {
    const c = await release('0.3.0', { branch: 'side' });
    const r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'refused');
    assert.match(r.reason, /isn't on origin's main/);
    assert.ok(!existsSync(join(hubDir, `nuworq-${c}.tgz.sig`)));
  });

  test('refuses a version mismatch and a missing changelog entry', async () => {
    commit({ 'package.json': JSON.stringify({ version: '0.2.9' }), 'CHANGELOG.md': '## 0.3.0\n', 'release-key.pub': pinned }, 'not bumped');
    git(work, 'tag', 'v0.3.0'); git(work, 'push', '-q', 'origin', 'main', 'v0.3.0'); await runs(git(work, 'rev-parse', 'HEAD'));
    await release('0.3.1', { changelog: '## 0.3.0\n\n- the last one\n\n## 0.3.1\n' });
    const rs = await check();
    assert.match(outcome(rs, 'v0.3.0').reason, /package\.json says 0\.2\.9, not 0\.3\.0/);
    assert.match(outcome(rs, 'v0.3.1').reason, /CHANGELOG\.md doesn't begin with 0\.3\.1/);
    assert.ok(rs.every((r) => r.outcome === 'refused'), JSON.stringify(rs));
  });

  test('refuses a release that pins another key', async () => {
    await release('0.3.0', { pub: keypair().pub });
    const r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'refused');
    assert.match(r.reason, /release-key\.pub isn't this key's/);
  });

  test('never rolls back: a tag older than the hub\'s signed release is refused', async () => {
    await release('0.3.0');
    await check();
    // A tag of a lower version made after it, and one of a higher version on an older commit.
    await release('0.2.5');
    const rs = await check();
    assert.equal(outcome(rs, 'v0.2.5').outcome, 'refused');
    assert.match(outcome(rs, 'v0.2.5').reason, /older than the hub's signed release v0\.3\.0/);
    git(work, 'tag', 'v0.9.0', 'HEAD~2'); git(work, 'push', '-q', 'origin', 'v0.9.0');
    assert.equal(outcome(await check(), 'v0.9.0').outcome, 'refused');
  });

  test('leaves alone a release the hub already has a signature for', async () => {
    const c = await release('0.3.0');
    writeFileSync(join(hubDir, `nuworq-${c}.tgz.sig`), 'c2lnbmVkIGJ5IGhhbmQ=\n');
    const r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'done');
    assert.equal(readFileSync(join(hubDir, `nuworq-${c}.tgz.sig`), 'utf8'), 'c2lnbmVkIGJ5IGhhbmQ=\n', 'not overwritten');
  });

  test('waits while the hub hasn\'t built the tagged commit yet', async () => {
    const c = await release('0.3.0', { run: false });
    assert.equal(outcome(await check(), 'v0.3.0').outcome, 'waiting');
    await runs(c);
    assert.equal(outcome(await check(), 'v0.3.0').outcome, 'signed');
  });

  test('an scp failure is tried again on the next round', async () => {
    await release('0.3.0');
    scpFails = true;
    const state = {};
    const r = outcome(await check(state), 'v0.3.0');
    assert.equal(r.outcome, 'failed');
    assert.match(r.reason, /scp to .* failed \(ssh: connect to host nuworq-vm.*\); trying again next round/);
    scpFails = false;
    assert.equal(outcome(await check(state), 'v0.3.0').outcome, 'signed');
  });

  test('a hub whose package isn\'t GitHub\'s build raises an alarm once, and never copies a signature for it', async () => {
    const c = await release('0.3.0');
    writeFileSync(join(hubDir, `nuworq-${c}.tgz`), 'not what GitHub has');
    const state = {};
    const r = outcome(await check(state), 'v0.3.0');
    assert.equal(r.outcome, 'alarm');
    assert.match(r.reason, /isn't GitHub's build of it/);
    assert.ok(!existsSync(join(hubDir, `nuworq-${c}.tgz.sig`)));
    assert.ok(state.alarms[c], 'remembered');
    const again = outcome(await check(state), 'v0.3.0');
    assert.equal(again.outcome, 'alarm');
    assert.match(again.reason, /^not tried again/);
  });

  test('a hub whose git gzips differently, the same files byte for byte, is signed as the hub has it', async () => {
    const c = await release('0.3.0');
    const file = join(hubDir, `nuworq-${c}.tgz`);
    writeFileSync(file, gzipSync(gunzipSync(readFileSync(file)), { level: 1 }));
    assert.equal(outcome(await check(), 'v0.3.0').outcome, 'signed');
    assert.ok(verify(null, readFileSync(file), createPublicKey(ours.key), Buffer.from(readFileSync(`${file}.sig`, 'utf8'), 'base64')));
  });

  test('a signature the hub ignores after the copy is an alarm too, not retried', async () => {
    const c = await release('0.3.0');
    // The hub runs a commit pinning another key, so the signature never verifies there.
    commit({ 'release-key.pub': keypair().pub }, 'rotate'); git(work, 'push', '-q', 'origin', 'main'); await runs(git(work, 'rev-parse', 'HEAD'));
    const state = {};
    const r = outcome(await check(state), 'v0.3.0');
    assert.equal(r.outcome, 'alarm');
    assert.match(r.reason, /but the hub ignores it/);
    assert.ok(existsSync(join(hubDir, `nuworq-${c}.tgz.sig`)));
    assert.equal(outcome(await check(state), 'v0.3.0').outcome, 'alarm', 'never copied again');
    assert.equal(comments.length, 0);
  });

  test('watch logs a line when a result changes, else one that nothing did, and keeps the alarms across restarts', async () => {
    await release('0.3.0');
    const lines = [];
    const stateFile = join(dir, 'state', 'signer.json');
    await watch({ repo, hub, key: ours.key, dest: hubDir, scp, stateFile, log: (l) => lines.push(l), rounds: 3, sleep: async () => {} });
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d v0\.3\.0 \([0-9a-f]{7}\): signed v0\.3\.0/);
    assert.match(lines[1], /v0\.3\.0 \([0-9a-f]{7}\): the hub serves it as its signed release$/, 'changed: said again');
    assert.match(lines[2], /checked 1 release tag: nothing new$/);
    server.close(); server.closeAllConnections();
    const down = [];
    await watch({ repo, hub, key: ours.key, dest: hubDir, scp, stateFile, log: (l) => down.push(l), rounds: 1 });
    assert.match(down[0], /check failed: .*trying again in 5 min/);
    assert.ok(existsSync(stateFile));
  });

  test('versions compare as numbers, and a release item is found by its title', () => {
    assert.ok(newer('0.10.0', '0.9.9'));
    assert.ok(!newer('0.3.0', '0.3.0'));
    const board = { ready: ['#12 [now] Fix it'], recently_done: ['#423 Release v0.3.0: package.json says 0.3.0', '#428 Release v0.4.0: x'] };
    assert.equal(releaseItem(board, '0.3.0'), '#423');
    assert.equal(releaseItem(board, '0.5.0'), null);
  });
});
