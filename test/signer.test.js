import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, createHash, sign, verify } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archive, newestSigned, packageAt, releasePackage, signatureOf, PACKAGE_NAME } from '../src/package.js';
import { round, watch, newer, releaseItem, writeApproval, approvalOf, proposedRelease, RELEASE_BRANCH } from '../scripts/signer.js';

const SIGN = fileURLToPath(new URL('../scripts/sign-release.js', import.meta.url));
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
  // buildsReleases: the hub builds a skipped release's package when asked for it, as hubs with #434 do.
  let dir, origin, work, repo, hubDir, approvals, server, hub, ours, pinned, scpFails, ran, comments, asked, withdrawn, buildsReleases, claims;
  const commit = (files, msg) => {
    for (const [f, text] of Object.entries(files)) { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), text); }
    git(work, 'add', '-A');
    stamp += 60;
    git(work, 'commit', '-qm', msg);
    return git(work, 'rev-parse', 'HEAD');
  };
  // A release as main gets it: the version, its changelog entry first, the pinned key; tagged and pushed.
  // approved: a person approved it where the key lives (sign-release.js approve), as every release needs (#473).
  const release = async (version, { changelog = `## ${version}\n\n- things\n`, pub = pinned, branch = 'main', run = true, approved = true } = {}) => {
    if (branch !== 'main') git(work, 'switch', '-qc', branch);
    const c = commit({ 'package.json': JSON.stringify({ name: 'nuworq', version }), 'CHANGELOG.md': changelog, 'release-key.pub': pub }, `Release v${version}`);
    git(work, 'tag', `v${version}`);
    git(work, 'push', '-q', 'origin', branch, `v${version}`);
    if (branch !== 'main') git(work, 'switch', '-q', 'main');
    if (run) await runs(c);
    if (approved) writeApproval(approvals, ours.key, { tag: `v${version}`, commit: c });
    return c;
  };
  // The hub ran commit c: it built its package from its own checkout (here, the origin).
  const runs = async (c) => { await archive(origin, c, join(hubDir, `nuworq-${c}.tgz`)); ran = c; };
  const scp = async (file, to) => {
    if (scpFails) throw new Error('ssh: connect to host signing-host: Operation timed out');
    copyFileSync(file, join(to, basename(file)));
  };
  const check = (state = {}) => round({ repo, hub, key: ours.key, dest: hubDir, scp, approvals, state, comment: async (r) => comments.push(r),
    ask: async (r) => { asked.push(r); return 100 + asked.length; }, withdraw: async (id, why) => { withdrawn.push([id, why]); } });
  const outcome = (rs, tag) => rs.find((r) => r.tag === tag);

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-signer-test-')));
    origin = join(dir, 'origin.git'); work = join(dir, 'work'); repo = join(dir, 'signer'); hubDir = join(dir, 'hub-packages'); approvals = join(dir, 'approvals');
    mkdirSync(hubDir);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, work]);
    git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
    ours = keypair(); pinned = ours.pub; scpFails = false; comments = []; asked = []; withdrawn = []; buildsReleases = false; claims = null;
    commit({ '.gitattributes': 'src/commit.txt export-subst\n', 'src/commit.txt': '$Format:%H %ct$\n', 'bin/nuworq.js': '// nuworq\n', 'release-key.pub': pinned }, 'start');
    git(work, 'push', '-q', 'origin', 'main');
    await runs(git(work, 'rev-parse', 'HEAD'));
    execFileSync('git', ['clone', '-q', origin, repo]);
    server = createServer(async (req, res) => {
      await new Promise((r) => setTimeout(r, 0));
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/api/package') {
        // claims: a compromised hub, naming a release of its choosing.
        const r = claims ?? newestSigned(hubDir, readFileSync(join(work, 'release-key.pub'), 'utf8'), new Map());
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ package: { commit: ran.slice(0, 7), signed: !!signatureOf({ file: join(hubDir, `nuworq-${ran}.tgz`) }), release: r && { commit: r.commit, time: r.time, sha256: r.sha256 } } }));
      }
      const m = path.slice(1).replace(/\.sig$/, '').match(PACKAGE_NAME);
      const b = m && (buildsReleases && !path.endsWith('.sig') ? await releasePackage(origin, hubDir, m[1]) : packageAt(hubDir, m[1]));
      if (!b) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'this hub has no package of it' })); }
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
    const r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'waiting');
    assert.match(r.reason, /no package of [0-9a-f]{7} yet; it builds one when it runs that commit, or a later one with the v0\.3\.0 tag/);
    await runs(c);
    assert.equal(outcome(await check(), 'v0.3.0').outcome, 'signed');
  });

  // #434: v0.4.0's commit failed follow's tests, the hub moved straight on to the next one, and the signer
  // said "it builds one when it runs that commit" every round, forever.
  test('a release the hub skipped: said plainly, and signed once the hub builds it on request', async () => {
    const c = await release('0.3.0', { run: false });
    commit({ 'bin/nuworq.js': '// landed after\n' }, 'landed after'); git(work, 'push', '-q', 'origin', 'main');
    await runs(git(work, 'rev-parse', 'HEAD'));
    const r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'waiting');
    assert.match(r.reason, new RegExp(`^the hub skipped ${c.slice(0, 7)} \\(it runs ${ran.slice(0, 7)}, after it\\) and has no package of it \\("this hub has no package of it"\\); a hub with #434 builds one once its checkout has the v0\\.3\\.0 tag, else sign it by hand\\. Trying again next round$`));
    buildsReleases = true;
    assert.equal(outcome(await check(), 'v0.3.0').outcome, 'signed');
    assert.ok(verify(null, readFileSync(join(hubDir, `nuworq-${c}.tgz`)), createPublicKey(ours.key), Buffer.from(readFileSync(join(hubDir, `nuworq-${c}.tgz.sig`), 'utf8'), 'base64')));
  });

  test('an scp failure is tried again on the next round', async () => {
    await release('0.3.0');
    scpFails = true;
    const state = {};
    const r = outcome(await check(state), 'v0.3.0');
    assert.equal(r.outcome, 'failed');
    assert.match(r.reason, /scp to .* failed \(ssh: connect to host signing-host.*\); trying again next round/);
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
    await watch({ repo, hub, key: ours.key, dest: hubDir, scp, approvals, stateFile, log: (l) => lines.push(l), rounds: 3, sleep: async () => {} });
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.match(lines[0], /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d v0\.3\.0 \([0-9a-f]{7}\): signed v0\.3\.0/);
    assert.match(lines[1], /v0\.3\.0 \([0-9a-f]{7}\): the hub serves it as its signed release$/, 'changed: said again');
    assert.match(lines[2], /checked 1 release tag: nothing new$/);
    server.close(); server.closeAllConnections();
    const down = [];
    await watch({ repo, hub, key: ours.key, dest: hubDir, scp, approvals, stateFile, log: (l) => down.push(l), rounds: 1 });
    assert.match(down[0], /check failed: .*trying again in 5 min/);
    assert.ok(existsSync(stateFile));
  });

  // #473: a tag on main was signed with no person in the loop, so whoever could push main and a tag shipped code.
  test('signs nothing a person hasn\'t approved: it asks once, then signs once approved, and takes the question back', async () => {
    const c = await release('0.3.0', { approved: false });
    const state = {};
    const r = outcome(await check(state), 'v0.3.0');
    assert.equal(r.outcome, 'approval');
    assert.match(r.reason, /^waits for a person's approval \(no one has approved it\): .*node scripts\/sign-release\.js approve v0\.3\.0 <release-key\.pem>$/);
    assert.ok(!existsSync(join(hubDir, `nuworq-${c}.tgz.sig`)), 'not signed');
    assert.equal(git(origin, 'branch', '--list', RELEASE_BRANCH), '', 'the plugin\'s branch not moved');
    assert.deepEqual(asked.map((x) => x.tag), ['v0.3.0'], 'the human is asked');
    assert.deepEqual(state.asked, { 'v0.3.0': 101 });
    await check(state);
    assert.equal(asked.length, 1, 'once, not every round');
    writeApproval(approvals, ours.key, { tag: 'v0.3.0', commit: c });
    assert.equal(outcome(await check(state), 'v0.3.0').outcome, 'signed');
    assert.deepEqual(withdrawn, [[101, 'v0.3.0 was approved and signed']]);
    assert.deepEqual(state.asked, {});
  });

  test('an approval counts only signed with the release key, and only for the commit it names', async () => {
    const c = await release('0.3.0', { approved: false });
    // Written by someone without the key (a worker, a hub): signed with another key.
    writeApproval(approvals, keypair().key, { tag: 'v0.3.0', commit: c });
    let r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'approval');
    assert.match(r.reason, /isn't signed by this key, so it doesn't count/);
    // Approved, then the tag moved to another commit.
    writeApproval(approvals, ours.key, { tag: 'v0.3.0', commit: c });
    commit({ 'bin/nuworq.js': '// slipped in\n' }, 'slipped in');
    git(work, 'tag', '-f', 'v0.3.0'); git(work, 'push', '-q', '-f', 'origin', 'main', 'v0.3.0'); await runs(git(work, 'rev-parse', 'HEAD'));
    r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'approval');
    assert.match(r.reason, new RegExp(`approved at ${c.slice(0, 7)}, but v0\\.3\\.0 is [0-9a-f]{7} now`));
    assert.equal(approvalOf(approvals, ours.key, 'v0.3.0', c), '');
  });

  test('moves origin\'s release branch, which the plugin installs from, to each signed release, and to the one the hub serves', async () => {
    const c = await release('0.3.0');
    const r = outcome(await check(), 'v0.3.0');
    assert.match(r.reason, /the plugin's release branch is at it now$/);
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), c);
    // main moving on changes nothing there.
    commit({ 'bin/nuworq.js': '// landed after\n' }, 'landed after'); git(work, 'push', '-q', 'origin', 'main');
    await check();
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), c);
    // A release signed before the branch existed: the branch catches up to it.
    git(origin, 'branch', '-D', RELEASE_BRANCH);
    assert.match(outcome(await check(), 'v0.3.0').reason, /^the hub serves it as its signed release; the plugin's release branch is at it now$/);
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), c);
  });

  test('moves the release branch only to a release it can check itself, not one a hub merely names', async () => {
    const c = await release('0.3.0', { approved: false });
    claims = { commit: c, time: 0, sha256: 'x' };
    let r = outcome(await check(), 'v0.3.0');
    assert.equal(r.outcome, 'done');
    assert.match(r.reason, /the plugin's release branch stays where it is: no one approved it here, and the hub's package of it isn't signed by this key$/);
    assert.equal(git(origin, 'branch', '--list', RELEASE_BRANCH), '', 'a compromised hub can\'t move the plugin');
    // Off main, even signed: not moved.
    const side = await release('0.4.0', { branch: 'side' });
    claims = { commit: side, time: 0, sha256: 'x' };
    assert.match(outcome(await check(), 'v0.4.0').reason, /stays where it is: [0-9a-f]{7} isn't on origin's main$/);
    // Signed by hand before approvals existed: the hub's package carries this key's signature, so it moves.
    writeFileSync(join(hubDir, `nuworq-${c}.tgz.sig`), `${sign(null, readFileSync(join(hubDir, `nuworq-${c}.tgz`)), ours.key).toString('base64')}\n`);
    claims = { commit: c, time: 0, sha256: 'x' };
    r = outcome(await check(), 'v0.3.0');
    assert.match(r.reason, /^the hub serves it as its signed release; the plugin's release branch is at it now$/);
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), c);
  });

  test('a hub replaying an older signed package under an unapproved tag doesn\'t move the release branch', async () => {
    const old = await release('0.3.0');
    await check();
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), old);
    const c = await release('0.4.0', { approved: false, run: false });
    // v0.3.0's package and its genuine signature, served as v0.4.0's.
    copyFileSync(join(hubDir, `nuworq-${old}.tgz`), join(hubDir, `nuworq-${c}.tgz`));
    copyFileSync(join(hubDir, `nuworq-${old}.tgz.sig`), join(hubDir, `nuworq-${c}.tgz.sig`));
    claims = { commit: c, time: 0, sha256: 'x' };
    const r = outcome(await check(), 'v0.4.0');
    assert.match(r.reason, new RegExp(`stays where it is: no one approved it here, and the signed package the hub serves for it isn't GitHub's build of ${c.slice(0, 7)}$`));
    assert.equal(git(origin, 'rev-parse', RELEASE_BRANCH), old, 'the plugin stays on the approved release');
  });

  test('what a person approves: the tag\'s commit, its changelog, and whether the signer would refuse it', async () => {
    const c = await release('0.3.0', { changelog: '## 0.3.0\n\n- the plugin installs from releases\n', approved: false });
    const p = await proposedRelease(repo, 'v0.3.0');
    assert.equal(p.commit, c);
    assert.equal(p.changes, '- the plugin installs from releases');
    assert.equal(p.refusal, '');
    await release('0.4.0', { branch: 'side', approved: false });
    assert.match((await proposedRelease(repo, 'v0.4.0')).refusal, /isn't on origin's main/);
    assert.equal(await proposedRelease(repo, 'v9.9.9'), null);
  });

  // #603: signing by hand (sign-release.js release) checked only files inside the package the hub served, so a
  // compromised hub could have its own build signed. It makes the signer's checks now.
  test('a release signed by hand is GitHub\'s build of an approved tag', async () => {
    const home = join(dir, 'home');
    const pem = join(dir, 'release-key.pem');
    writeFileSync(pem, ours.key.export({ type: 'pkcs8', format: 'pem' }));
    const pkg = (c) => readFileSync(join(hubDir, `nuworq-${c}.tgz`));
    const signature = (c) => join(home, '.nuworq', 'signatures', `nuworq-${c}.tgz.sig`);
    const approve = (tag, c) => writeApproval(join(home, '.nuworq', 'release-approvals'), ours.key, { tag, commit: c });
    // A hub serving bytes as its package of c; release runs in the signer's checkout, as a person would.
    const byHand = async (c, bytes) => {
      const s = createServer((req, res) => {
        if (req.url !== '/api/package') return res.end(bytes);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ package: { commit: c, sha256: createHash('sha256').update(bytes).digest('hex') } }));
      });
      const url = `http://127.0.0.1:${await listen(s)}`;
      try {
        return await promisify(execFile)(process.execPath, [SIGN, 'release', url, pem], { cwd: repo, env: { ...process.env, HOME: home } })
          .then((r) => ({ ok: true, out: r.stdout }), (e) => ({ ok: false, out: e.stderr }));
      } finally { s.close(); s.closeAllConnections(); }
    };

    const c = await release('0.3.0', { approved: false });
    let r = await byHand(c, pkg(c));
    assert.ok(!r.ok, 'an unapproved tag is refused');
    assert.match(r.out, /not signed: v0\.3\.0 isn't approved \(no one has approved it\): approve it first/);
    approve('v0.3.0', c);
    // The hub's own build: the same commit.txt, version, changelog and key inside, one file's bytes changed.
    const tar = gunzipSync(pkg(c)).toString('latin1');
    assert.ok(tar.includes('// nuworq\n'));
    r = await byHand(c, gzipSync(Buffer.from(tar.replace('// nuworq\n', '// evil!!\n'), 'latin1')));
    assert.ok(!r.ok, 'a package that differs from GitHub\'s build is refused');
    assert.match(r.out, new RegExp(`not signed: the hub's package of ${c.slice(0, 7)} isn't GitHub's build of it`));
    const side = await release('0.4.0', { branch: 'side' });
    approve('v0.4.0', side);
    r = await byHand(side, pkg(side));
    assert.ok(!r.ok, 'a commit not on main is refused');
    assert.match(r.out, new RegExp(`not signed: ${side.slice(0, 7)} isn't on origin's main`));
    assert.ok(!existsSync(signature(c)) && !existsSync(signature(side)), 'nothing signed');

    r = await byHand(c, pkg(c));
    assert.ok(r.ok, r.out);
    assert.match(r.out, /^Signed 0\.3\.0/);
    assert.ok(verify(null, pkg(c), createPublicKey(ours.key), Buffer.from(readFileSync(signature(c), 'utf8'), 'base64')), 'GitHub\'s build, approved, on main: signed');
  });

  test('versions compare as numbers, and a release item is found by its title', () => {
    assert.ok(newer('0.10.0', '0.9.9'));
    assert.ok(!newer('0.3.0', '0.3.0'));
    const board = { ready: ['#12 [now] Fix it'], recently_done: ['#423 Release v0.3.0: package.json says 0.3.0', '#428 Release v0.4.0: x'] };
    assert.equal(releaseItem(board, '0.3.0'), '#423');
    assert.equal(releaseItem(board, '0.5.0'), null);
  });
});
