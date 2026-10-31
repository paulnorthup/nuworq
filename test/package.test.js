import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { fileInTarball, releaseOf, update, describeUpdate } from '../src/update.js';
import { Workspaces } from '../src/workspaces.js';
import { LISTENER } from '../src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const npm = (() => { try { execFileSync('npm', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// The hub serves nuworq as an npm package of the commit it runs (#102).
describe('/nuworq.tgz', () => {
  let dir, clone, server, url;
  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pkg-')));
    clone = join(dir, 'src');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, clone]);
    server = createServer(new Hub(), { source: clone, packageDir: join(dir, 'cache') });
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  after(() => { server.close(); server.closeAllConnections(); });

  test('the running commit, runtime files only, under package/, with its sha256 in /api/info', async () => {
    const r = await fetch(`${url}/nuworq.tgz`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/gzip');
    const body = Buffer.from(await r.arrayBuffer());
    const sha = createHash('sha256').update(body).digest('hex');
    assert.equal(r.headers.get('etag'), `"${sha}"`);
    const info = await (await fetch(`${url}/api/info`)).json();
    assert.equal(info.package.sha256, sha);
    assert.equal(info.package.url, `${url}/nuworq.tgz`);
    assert.equal(info.package.commit, execFileSync('git', ['-C', clone, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).trim());

    writeFileSync(join(dir, 'p.tgz'), body);
    const files = execFileSync('tar', ['-tzf', join(dir, 'p.tgz')], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(files.every((f) => f.startsWith('package/')), 'npm takes it: everything under package/');
    for (const f of ['package/package.json', 'package/bin/nuworq.js', 'package/src/core.js', 'package/web/app.js']) assert.ok(files.includes(f), f);
    assert.ok(!files.some((f) => /^package\/(test|docs|deploy)\//.test(f)), 'only what runs');

    const again = await fetch(`${url}/nuworq.tgz`);
    assert.equal(again.headers.get('etag'), `"${sha}"`, 'built once, served from the cache');
    // It knows which commit it is, so an install can tell whether the hub has a newer one (#107).
    // With its commit time, which orders releases: an update is never older than what runs (#128).
    const [commit, time] = execFileSync('git', ['-C', clone, 'log', '-1', '--format=%H %ct'], { encoding: 'utf8' }).trim().split(' ');
    assert.deepEqual(releaseOf(fileInTarball(body, 'src/commit.txt')), { commit, time: Number(time) });
  });

  test('its release signature is served only when one was put beside it', async () => {
    const commit = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await fetch(`${url}/nuworq.tgz`);
    const unsigned = await fetch(`${url}/nuworq.tgz.sig`);
    assert.equal(unsigned.status, 404);
    assert.match((await unsigned.json()).error, /isn't signed/);
    writeFileSync(join(dir, 'cache', `nuworq-${commit}.tgz.sig`), 'c2lnbmF0dXJl\n');
    const signed = await fetch(`${url}/nuworq.tgz.sig`);
    assert.equal(signed.status, 200);
    assert.equal(await signed.text(), 'c2lnbmF0dXJl\n');
  });

  test('npm installs it on a machine with nothing else, and the CLI runs', { skip: !npm && 'npm is not installed here' }, async () => {
    const prefix = join(dir, 'prefix');
    // Asynchronously: npm downloads from this process's own server.
    await promisify(execFile)('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `${url}/nuworq.tgz`], { timeout: 120_000, env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') } });
    const bin = join(prefix, 'bin', 'nuworq');
    assert.ok(existsSync(bin));
    assert.match(execFileSync(bin, ['help'], { encoding: 'utf8', env: { ...process.env, NUWORQ_URL: 'http://127.0.0.1:9' } }), /connect/);
  });

  // #254: Paul signs the package of the commit the hub runs; main then moves on twice before an install checks.
  test('a release signed an hour ago reaches an install after main has moved on twice', async () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-pkg-rel-')));
    const repo = join(d, 'src'), cache = join(d, 'cache');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, repo]);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(join(repo, 'release-key.pub'), pub);
    const t0 = Math.floor(Date.now() / 1000) - 7200;
    const commit = (n, msg) => {
      const env = { ...process.env, GIT_COMMITTER_DATE: `${t0 + n * 1800} +0000`, GIT_AUTHOR_DATE: `${t0 + n * 1800} +0000` };
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qa', '--allow-empty', '-m', msg], { env });
      return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    };
    // The hub runs a commit, Paul signs its package, then main moves on and the hub follows: a restart each time.
    const serve = async () => {
      const s = createServer(new Hub(), { source: repo, packageDir: cache });
      const port = await listen(s);
      await s.package;
      return { s, u: `http://127.0.0.1:${port}`, close: () => { s.close(); s.closeAllConnections(); } };
    };
    execFileSync('git', ['-C', repo, 'add', 'release-key.pub']);
    const a = commit(1, 'a release');
    const first = await serve();
    const tgz = readFileSync(join(cache, `nuworq-${a}.tgz`));
    writeFileSync(join(cache, `nuworq-${a}.tgz.sig`), `${sign(null, tgz, privateKey).toString('base64')}\n`);
    first.close();
    commit(2, 'landed');
    (await serve()).close();
    const c = commit(3, 'landed again');
    const hub = await serve();
    try {
      const info = (await (await fetch(`${hub.u}/api/info`)).json()).package;
      assert.equal(info.commit, c.slice(0, 7), 'the hub runs the newest commit');
      assert.deepEqual(info.release, { url: `${hub.u}/nuworq-${a}.tgz`, sha256: createHash('sha256').update(tgz).digest('hex'), commit: a, time: t0 + 1800 });
      assert.equal((await fetch(`${hub.u}/nuworq.tgz.sig`)).status, 404, 'what it runs is unsigned');
      assert.equal((await fetch(`${hub.u}/nuworq-${c}.tgz.sig`)).status, 404);
      for (const p of [`/nuworq-${'f'.repeat(40)}.tgz`, `/nuworq-${a.slice(0, 7)}.tgz`, '/nuworq-..%2Fhub.json.tgz', `/nuworq-${a}.tgz.sig.sig`]) {
        assert.equal((await fetch(`${hub.u}${p}`)).status, 404, p);
      }

      // An install of something older, pinning the same key.
      const root = join(d, 'installed');
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'commit.txt'), `${'0'.repeat(40)} ${t0}\n`);
      writeFileSync(join(root, 'release-key.pub'), pub);
      const got = [];
      const r = await update({ root, hub: hub.u, dir: join(d, 'data'), env: {}, force: true, install: async (f) => { got.push(readFileSync(f)); return null; } });
      assert.equal(r.status, 'updated', describeUpdate(r));
      assert.equal(r.to, a);
      assert.ok(got[0].equals(tgz), 'exactly the signed bytes');
    } finally { hub.close(); }
  });

  test('a hub not running from a git checkout says so', async () => {
    const plain = createServer(new Hub(), { source: join(dir, 'nowhere'), packageDir: join(dir, 'cache2') });
    const u = `http://127.0.0.1:${await listen(plain)}`;
    try {
      const r = await fetch(`${u}/nuworq.tgz`);
      assert.equal(r.status, 404);
      assert.match((await r.json()).error, /doesn't run from a git checkout/);
      assert.equal((await (await fetch(`${u}/api/info`)).json()).package, null);
    } finally {
      plain.close();
    }
  });
});

// On a hub that needs a sign-in (the live one, with workspaces), installs never saw the package: /api/info
// answers 401 or 404 to them, and update took that for "current" (#224). /api/package is public at the root.
describe('a signed release reaches installs through the public /api/package', () => {
  const SIGN = join(ROOT, 'scripts', 'sign-release.js');
  const run = promisify(execFile);
  let dir, clone, server, url, commit, time;
  // An install that pinned the release key, one minute older than the hub's commit.
  const installed = () => {
    const root = mkdtempSync(join(tmpdir(), 'nuworq-rel-root-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'commit.txt'), `${'a'.repeat(40)} ${time - 60}\n`);
    copyFileSync(join(dir, 'key', 'release-key.pub'), join(root, 'release-key.pub'));
    return root;
  };
  before(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-rel-')));
    clone = join(dir, 'src');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', ROOT, clone]);
    // Its release key, the public half committed at the root, as on main once the key is made.
    for (const k of ['key', 'other']) { mkdirSync(join(dir, k)); execFileSync(process.execPath, [SIGN, 'keygen', join(dir, k)]); }
    copyFileSync(join(dir, 'key', 'release-key.pub'), join(clone, 'release-key.pub'));
    execFileSync('git', ['-C', clone, 'add', 'release-key.pub']);
    execFileSync('git', ['-C', clone, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-qm', 'release key']);
    [commit, time] = execFileSync('git', ['-C', clone, 'log', '-1', '--format=%H %ct'], { encoding: 'utf8' }).trim().split(' ');
    time = Number(time);
    const spaces = new Workspaces({ dir: join(dir, 'workspaces') });
    spaces.create('acme');
    server = createServer(spaces, { source: clone, packageDir: join(dir, 'cache') });
    url = `http://127.0.0.1:${await listen(server)}`;
    await server.package;
  });
  after(() => { server.close(); server.closeAllConnections(); });

  test('/api/info needs a workspace and a sign-in; /api/package needs neither', async () => {
    assert.equal((await fetch(`${url}/api/info`)).status, 404);
    assert.equal((await fetch(`${url}/w/acme/api/info`)).status, 401);
    const r = await fetch(`${url}/api/package`);
    assert.equal(r.status, 200);
    const { package: p, listener } = await r.json();
    assert.deepEqual(p, { url: `${url}/nuworq.tgz`, release: null, commit, sha256: createHash('sha256').update(Buffer.from(await (await fetch(`${url}/nuworq.tgz`)).arrayBuffer())).digest('hex'), signed: false });
    assert.equal(listener, LISTENER, 'the operator listener level it expects (#419)');
  });

  test('unsigned, it is no release: an install connected to a workspace stays quiet and downloads nothing', async () => {
    const asked = [];
    const r = await update({ root: installed(), hub: `${url}/w/acme`, dir: mkdtempSync(join(tmpdir(), 'nuworq-rel-upd-')), force: true, fetch: (u, o) => { asked.push(new URL(u).pathname); return fetch(u, o); } });
    assert.equal(r.status, 'current', describeUpdate(r));
    assert.match(describeUpdate(r), new RegExp(`the hub's ${commit.slice(0, 7)} isn't a signed release yet`));
    assert.deepEqual(asked, ['/api/package'], 'asked at the root, not under /w/acme, and fetched no package');
  });

  test("release refuses a key the package doesn't pin", async () => {
    const out = mkdtempSync(join(tmpdir(), 'nuworq-rel-out-'));
    await assert.rejects(run(process.execPath, [SIGN, 'release', url, join(dir, 'other', 'release-key.pem')], { cwd: out }),
      (e) => /doesn't carry this key's release-key\.pub, so installs would refuse it/.test(e.stderr));
    assert.ok(!existsSync(join(out, `nuworq-${commit}.tgz.sig`)), 'nothing signed');
  });

  test('release signs what the hub serves; put beside it, installs take it', async () => {
    const out = mkdtempSync(join(tmpdir(), 'nuworq-rel-out-'));
    const { stdout } = await run(process.execPath, [SIGN, 'release', `${url}/w/acme`, join(dir, 'key', 'release-key.pem')], { cwd: out });
    const sig = `nuworq-${commit}.tgz.sig`;
    assert.match(stdout, new RegExp(`Signed ${commit.slice(0, 7)} \\(made \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\): wrote ${sig}`));
    assert.match(stdout, new RegExp(`scp ${sig} <hub host>:/var/lib/nuworq/package/`));
    copyFileSync(join(out, sig), join(dir, 'cache', sig));
    const named = (await (await fetch(`${url}/api/package`)).json()).package;
    assert.equal(named.signed, true);
    assert.equal(named.release?.commit, commit, 'and it is the release installs follow (#254), whatever the hub runs later');

    const installs = [];
    const r = await update({ root: installed(), hub: `${url}/w/acme`, dir: mkdtempSync(join(tmpdir(), 'nuworq-rel-upd-')), force: true, install: async (f) => { installs.push(readFileSync(f)); return null; } });
    assert.equal(r.status, 'updated', describeUpdate(r));
    assert.equal(describeUpdate(r), `Updated nuworq aaaaaaa → ${commit.slice(0, 7)}. The next run uses it.`);
    assert.ok(installs[0].equals(Buffer.from(await (await fetch(`${url}/nuworq.tgz`)).arrayBuffer())), 'the bytes that were signed');
  });
});
