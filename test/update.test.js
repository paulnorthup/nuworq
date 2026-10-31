import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { update, describeUpdate, offReason, fileInTarball, runningCommit, releaseOf, CHECK_EVERY, changelogEntry, versionOf } from '../src/update.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pub: publicKey.export({ type: 'spki', format: 'pem' }) };
};
const RELEASE = keyPair(), OTHER = keyPair();
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const OLD_T = 1_790_000_000, NEW_T = OLD_T + 3600; // committer times (unix seconds)
const line = (commit, time) => `${commit}${time == null ? '' : ` ${time}`}\n`;

// An installed package: its commit (and time) and the release key it pinned.
function installed({ pub = RELEASE.pub, commit = OLD, time = OLD_T } = {}) {
  const root = tmp('nuworq-upd-root-');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'commit.txt'), line(commit, time));
  if (pub) writeFileSync(join(root, 'release-key.pub'), pub);
  return root;
}
// A package tarball in npm's layout, carrying the given release key.
function tarball({ pub = RELEASE.pub, commit = NEW, time = NEW_T, version = null, changelog = null } = {}) {
  const dir = tmp('nuworq-upd-pkg-');
  mkdirSync(join(dir, 'package', 'src'), { recursive: true });
  writeFileSync(join(dir, 'package', 'src', 'commit.txt'), line(commit, time));
  writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name: 'nuworq', ...(version ? { version } : {}) }));
  if (changelog) writeFileSync(join(dir, 'package', 'CHANGELOG.md'), changelog);
  if (pub) writeFileSync(join(dir, 'package', 'release-key.pub'), pub);
  execFileSync('tar', ['-czf', join(dir, 'p.tgz'), '-C', dir, 'package']);
  return readFileSync(join(dir, 'p.tgz'));
}
const sigOf = (bytes, key = RELEASE.privateKey) => `${sign(null, bytes, key).toString('base64')}\n`;

// A hub serving /api/package, /nuworq.tgz and /nuworq.tgz.sig. Counts what was asked. release: { tgz, commit,
// time?, sig? }, the newest signed release it names and serves at /nuworq-<commit>.tgz (#254). old: one from
// before /api/package (#224), naming its packages only in /api/info. status: what it answers everything.
async function fakeHub({ tgz = tarball(), sha = null, sig = undefined, commit = NEW, release = null, old = false, status = null } = {}) {
  const hits = [];
  const sha256 = (b) => createHash('sha256').update(b).digest('hex');
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (status) { res.writeHead(status); return res.end('{}'); }
    if (req.url === (old ? '/api/info' : '/api/package')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ package: { url: 'x', sha256: sha ?? sha256(tgz), ...(old ? { commit: commit.slice(0, 7) } : { commit, signed: sig !== null }),
        release: release && { url: 'y', sha256: sha256(release.tgz), commit: release.commit, time: release.time } } }));
    }
    if (release && req.url === `/nuworq-${release.commit}.tgz`) { res.writeHead(200); return res.end(release.tgz); }
    if (release && req.url === `/nuworq-${release.commit}.tgz.sig`) { res.writeHead(200); return res.end(release.sig ?? sigOf(release.tgz)); }
    if (req.url === '/nuworq.tgz') { res.writeHead(200); return res.end(tgz); }
    if (req.url === '/nuworq.tgz.sig' && sig !== null) { res.writeHead(200); return res.end(sig ?? sigOf(tgz)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() };
}
const installer = () => {
  const calls = [];
  return { calls, install: async (file) => { calls.push(readFileSync(file)); return null; } };
};

describe('the package updates itself only to a release signed by its pinned key', () => {
  test('a newer, validly signed version is verified and installed; update reports old → new', async () => {
    const tgz = tarball();
    const hub = await fakeHub({ tgz });
    try {
      const { calls, install } = installer();
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(calls.length, 1);
      assert.ok(calls[0].equals(tgz), 'installs exactly the bytes that verified');
      assert.equal(describeUpdate(r), `Updated nuworq aaaaaaa → bbbbbbb. The next run uses it.`);
      assert.equal(fileInTarball(tgz, 'release-key.pub').toString(), RELEASE.pub);
    } finally { hub.close(); }
  });

  test('a release says the versions it moved between, then its changelog lines (#400)', async () => {
    const changelog = '# Changelog\n\n## 0.3.0 (2026-10-31)\n\nWhat landed since v0.2.0.\n\n**Faster search (#12)**\n\n- Index titles (#13)\n\n## 0.2.0\n\n- Old news\n';
    const hub = await fakeHub({ tgz: tarball({ version: '0.3.0', changelog }) });
    try {
      const root = installed();
      writeFileSync(join(root, 'package.json'), '{"name":"nuworq","version":"0.2.0"}');
      // As npm install -g does, the install replaces the package the update runs from.
      const install = async () => { writeFileSync(join(root, 'package.json'), '{"name":"nuworq","version":"0.3.0"}'); return null; };
      const r = await update({ root, hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(describeUpdate(r), 'Updated nuworq 0.2.0 → 0.3.0. The next run uses it.\n  What landed since v0.2.0.\n  Faster search (#12)\n  - Index titles (#13)');
    } finally { hub.close(); }
  });

  test('changelogEntry finds a version\'s lines; first: only when it leads (#400)', () => {
    const text = '# Changelog\n\n## v1.1.0 (2026-10-31)\n\n- New\n\n## 1.0.0\n\n- Old\n';
    assert.equal(changelogEntry(text, '1.1.0', { first: true }), '- New');
    assert.equal(changelogEntry(text, '1.0.0'), '- Old');
    assert.equal(changelogEntry(text, '1.0.0', { first: true }), null, 'not the first entry');
    assert.equal(changelogEntry(text, '1.2.0'), null);
    assert.equal(changelogEntry(null, '1.0.0'), null);
    assert.equal(versionOf('{"version":"1.2.3"}'), '1.2.3');
    assert.equal(versionOf('{"name":"x"}'), null);
  });

  const refusedFor = async (hubOpts, why, root = installed()) => {
    const hub = await fakeHub(hubOpts);
    try {
      const { calls, install } = installer();
      const r = await update({ root, hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'refused');
      assert.match(r.reason, why);
      assert.match(r.reason, /Kept the installed version/);
      assert.equal(calls.length, 0, 'nothing installed');
    } finally { hub.close(); }
  };

  test('tampered bytes: the sha256 the hub gave fails', async () => {
    const good = tarball();
    const bad = Buffer.concat([good, Buffer.from('x')]);
    await refusedFor({ tgz: bad, sha: createHash('sha256').update(good).digest('hex'), sig: sigOf(good) }, /doesn't match the sha256/);
  });

  test('tampered bytes with a matching sha256 (a compromised hub): the signature fails', async () => {
    const good = tarball(), bad = tarball({ commit: 'c'.repeat(40) });
    await refusedFor({ tgz: bad, sig: sigOf(good) }, /isn't from the release key this install trusts/);
  });

  test('signed by another key', async () => {
    const tgz = tarball();
    await refusedFor({ tgz, sig: sigOf(tgz, OTHER.privateKey) }, /isn't from the release key this install trusts/);
  });

  test('a hub from before /api/package that serves no signature', async () => {
    await refusedFor({ sig: null, old: true }, /serves no signature .* isn't a signed release/);
  });

  test("a newer package nobody has signed yet isn't a release: current, nothing downloads, nothing to print", async () => {
    const hub = await fakeHub({ sig: null });
    try {
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), force: true });
      assert.equal(r.status, 'current');
      assert.equal(describeUpdate(r), "nuworq aaaaaaa is current (the hub's bbbbbbb isn't a signed release yet).");
      assert.deepEqual(hub.hits, ['/api/package']);
    } finally { hub.close(); }
  });

  test('a hub from before /api/package is asked /api/info, and updates as before', async () => {
    const hub = await fakeHub({ old: true });
    try {
      const { calls, install } = installer();
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(calls.length, 1);
      assert.deepEqual(hub.hits.slice(0, 2), ['/api/package', '/api/info']);
    } finally { hub.close(); }
  });

  test('connected to a workspace (/w/acme), it asks the hub\'s root, where the package is', async () => {
    const hub = await fakeHub();
    try {
      const { calls, install } = installer();
      const r = await update({ root: installed(), hub: `${hub.url}/w/acme/`, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(calls.length, 1);
      assert.deepEqual(hub.hits, ['/api/package', '/nuworq.tgz', '/nuworq.tgz.sig']);
    } finally { hub.close(); }
  });

  test('a hub that won\'t say which version it serves (401) isn\'t taken for "current"', async () => {
    const hub = await fakeHub({ status: 401 });
    try {
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), force: true });
      assert.equal(r.status, 'unreachable');
      assert.match(describeUpdate(r), /^Didn't update: the hub at http:\/\/127\.0\.0\.1:\d+ answered 401 when asked which version it serves; carrying on with the installed version\.$/);
    } finally { hub.close(); }
  });

  test('a new package that pins a different release key', async () => {
    const tgz = tarball({ pub: OTHER.pub });
    await refusedFor({ tgz, sig: sigOf(tgz) }, /carries a different release key; changing keys takes a reinstall by hand/);
  });

  test('an older release, validly signed, is refused: updates never go back', async () => {
    const tgz = tarball({ time: OLD_T - 86400 });
    await refusedFor({ tgz }, /bbbbbbb \(2026-09-20 \d\d:\d\d UTC\) isn't newer than the installed aaaaaaa \(2026-09-21 \d\d:\d\d UTC\); updates never go back/);
    const same = tarball({ time: OLD_T });
    await refusedFor({ tgz: same }, /isn't newer than the installed/, installed());
  });

  test("a signed package that doesn't say when it was made is refused by an install that knows its own time", async () => {
    await refusedFor({ tgz: tarball({ time: null }) }, /doesn't say when it was made/);
  });

  test('an install from before release times takes a signed release once; after that it orders them', async () => {
    const hub = await fakeHub();
    try {
      const { calls, install } = installer();
      const r = await update({ root: installed({ time: null }), hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(calls.length, 1);
    } finally { hub.close(); }
  });

  test('the signed package must be the version the hub named', async () => {
    const tgz = tarball({ commit: 'c'.repeat(40) });
    await refusedFor({ tgz }, /the signed package says it is ccccccc, not bbbbbbb/);
  });

  // #254: the hub runs a newer, unsigned commit, and names the newest signed release it keeps.
  const SIGNED = 'd'.repeat(40);
  test('the newest signed release the hub names is installed by its commit, not the unsigned package it runs', async () => {
    const tgz = tarball({ commit: SIGNED, time: NEW_T });
    const hub = await fakeHub({ tgz: tarball({ commit: 'e'.repeat(40), time: NEW_T + 600 }), sig: null, commit: 'e'.repeat(40), release: { tgz, commit: SIGNED, time: NEW_T } });
    try {
      const { calls, install } = installer();
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), install, force: true });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(r.to, SIGNED);
      assert.ok(calls[0].equals(tgz));
      assert.deepEqual(hub.hits, ['/api/package', `/nuworq-${SIGNED}.tgz`, `/nuworq-${SIGNED}.tgz.sig`]);
    } finally { hub.close(); }
  });

  test('a named release the hub says is no newer than the installed one: current, nothing downloads', async () => {
    const hub = await fakeHub({ sig: null, release: { tgz: tarball({ commit: SIGNED, time: OLD_T }), commit: SIGNED, time: OLD_T } });
    try {
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), force: true });
      assert.equal(r.status, 'current', describeUpdate(r));
      assert.match(describeUpdate(r), /the newest signed release, ddddddd, isn't newer/);
      assert.deepEqual(hub.hits, ['/api/package']);
    } finally { hub.close(); }
  });

  test('a named release still has to verify: its signed time, its key, its commit', async () => {
    // The hub claims a later time than the package signs: the signed time decides.
    const old = tarball({ commit: SIGNED, time: OLD_T - 60 });
    await refusedFor({ sig: null, release: { tgz: old, commit: SIGNED, time: NEW_T } }, /ddddddd .* isn't newer than the installed aaaaaaa/);
    const tgz = tarball({ commit: SIGNED });
    await refusedFor({ sig: null, release: { tgz, commit: SIGNED, time: NEW_T, sig: sigOf(tgz, OTHER.privateKey) } }, /isn't from the release key this install trusts/);
    await refusedFor({ sig: null, release: { tgz: tarball({ commit: 'c'.repeat(40) }), commit: SIGNED, time: NEW_T } }, /says it is ccccccc, not ddddddd/);
    await refusedFor({ sig: null, release: { tgz, commit: SIGNED.slice(0, 7), time: NEW_T } }, /isn't a commit/);
  });

  test('the same version is current; nothing downloads', async () => {
    const hub = await fakeHub({ commit: OLD });
    try {
      const r = await update({ root: installed(), hub: hub.url, dir: tmp('nuworq-upd-data-'), force: true });
      assert.equal(r.status, 'current');
      assert.deepEqual(hub.hits, ['/api/package']);
    } finally { hub.close(); }
  });

  test('offline: no error, and no second try within 10 minutes', async () => {
    const closed = await fakeHub();
    closed.close();
    const dir = tmp('nuworq-upd-data-'), root = installed();
    let asked = 0;
    const get = (...a) => { asked++; return fetch(...a); };
    const t = Date.now();
    const r = await update({ root, hub: closed.url, dir, fetch: get, now: t });
    assert.equal(r.status, 'unreachable');
    assert.match(describeUpdate(r), /carrying on with the installed version/);
    assert.equal((await update({ root, hub: closed.url, dir, fetch: get, now: t + CHECK_EVERY - 1 })).status, 'skipped');
    assert.equal(asked, 1, 'not asked again inside 10 minutes');
    assert.equal((await update({ root, hub: closed.url, dir, fetch: get, now: t + CHECK_EVERY })).status, 'unreachable');
    assert.equal(asked, 2);
  });

  test('two update checks at once install once', async () => {
    const hub = await fakeHub();
    try {
      const { calls, install } = installer();
      const dir = tmp('nuworq-upd-data-'), root = installed();
      const rs = await Promise.all([1, 2, 3].map(() => update({ root, hub: hub.url, dir, install, force: true })));
      assert.equal(calls.length, 1, rs.map(describeUpdate).join(' | '));
      assert.equal(rs.filter((r) => r.status === 'updated').length, 1);
      assert.ok(!existsSync(join(dir, 'update.lock')), 'the lock is let go');
    } finally { hub.close(); }
  });

  test('npm failing keeps the version and names the command to install the verified file by hand', async () => {
    const tgz = tarball();
    const hub = await fakeHub({ tgz });
    try {
      const dir = tmp('nuworq-upd-data-');
      const r = await update({ root: installed(), hub: hub.url, dir, install: async () => 'EACCES: permission denied', force: true });
      assert.equal(r.status, 'failed');
      const file = join(dir, `nuworq-${NEW}.tgz`);
      assert.equal(r.command, `npm install -g ${file}`, 'the file that verified, not a fresh download from the hub');
      assert.ok(readFileSync(file).equals(tgz));
      assert.match(describeUpdate(r), /EACCES.*Run it yourself: npm install -g \//);
      assert.doesNotMatch(describeUpdate(r), /nuworq\.tgz$|127\.0\.0\.1/);
    } finally { hub.close(); }
  });

  test('off: no pinned key, a git checkout, NUWORQ_NO_UPDATE, a plain-http remote hub; none downloads', async () => {
    const checkout = installed();
    mkdirSync(join(checkout, '.git'));
    const cases = [
      [{ root: installed({ pub: null }), hub: 'https://hub.test' }, /no pinned release key/],
      [{ root: checkout, hub: 'https://hub.test' }, /runs from a git checkout/],
      [{ root: installed(), hub: 'https://hub.test', env: { NUWORQ_NO_UPDATE: '1' } }, /NUWORQ_NO_UPDATE=1/],
      [{ root: installed(), hub: 'http://hub.test:4747' }, /isn't https, and isn't on this machine/],
    ];
    for (const [opts, why] of cases) {
      let asked = 0;
      const r = await update({ ...opts, dir: tmp('nuworq-upd-data-'), force: true, fetch: async () => { asked++; throw new Error('no'); } });
      assert.equal(r.status, 'off');
      assert.match(describeUpdate(r), why);
      assert.equal(asked, 0);
    }
    assert.equal(offReason({ root: installed(), hub: 'http://127.0.0.1:4747', env: {} }), null, 'a hub on this machine may be plain http');
  });

  test('`nuworq update` from this checkout says why it is off', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'update', '--url', 'https://hub.test'], { env: { ...process.env, NUWORQ_NO_UPDATE: '' } });
    assert.match(stdout, /Updates are off: nuworq runs from a git checkout/);
  });

  test('a package knows its commit; a checkout does not', () => {
    assert.equal(runningCommit(installed()), OLD);
    assert.equal(runningCommit(installed({ time: null })), OLD, 'a package from before release times');
    assert.deepEqual(releaseOf(`${NEW} ${NEW_T}\n`), { commit: NEW, time: NEW_T });
    assert.equal(releaseOf('$Format:%H %ct$'), null);
    assert.equal(runningCommit(fileURLToPath(new URL('..', import.meta.url))), null, 'the $Format placeholder is not a commit');
  });
});
