import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

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
  });

  test('npm installs it on a machine with nothing else, and the CLI runs', { skip: !npm && 'npm is not installed here' }, async () => {
    const prefix = join(dir, 'prefix');
    // Asynchronously: npm downloads from this process's own server.
    await promisify(execFile)('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `${url}/nuworq.tgz`], { timeout: 120_000, env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') } });
    const bin = join(prefix, 'bin', 'nuworq');
    assert.ok(existsSync(bin));
    assert.match(execFileSync(bin, ['help'], { encoding: 'utf8', env: { ...process.env, NUWORQ_URL: 'http://127.0.0.1:9' } }), /connect/);
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
