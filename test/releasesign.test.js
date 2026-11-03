// Releases signed on GitHub Actions (#813): the rules both signers share, the workflow's build and signature
// (scripts/release.js), and the hub taking a release's .sig from its GitHub Release (src/ghrelease.js).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archive, newestSigned } from '../src/package.js';
import { releaseRefusal, filesRun, runsChanged, summary, latest, WORKFLOW } from '../scripts/release.js';
import { takeReleases, githubRepoOf, releaseAlarm } from '../src/ghrelease.js';
import { Hub } from '../src/core.js';
import { createServer as createHubServer } from '../src/server.js';

const RELEASE = fileURLToPath(new URL('../scripts/release.js', import.meta.url));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
let stamp = 1_700_000_000;
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: `${stamp} +0000`, GIT_AUTHOR_DATE: `${stamp} +0000` } }).trim();
const keypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: publicKey.export({ type: 'spki', format: 'pem' }) };
};

// origin: a bare repository, as GitHub. work: where commits are made. repo: a clone, as the workflow's checkout.
let dir, origin, work, repo, ours;
const commit = (files, msg) => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(work, f, '..'), { recursive: true }); writeFileSync(join(work, f), text); }
  git(work, 'add', '-A');
  stamp += 60;
  git(work, 'commit', '-qm', msg);
  return git(work, 'rev-parse', 'HEAD');
};
const release = (version, { changelog = `## ${version}\n\n- things\n`, pub = ours.pub, branch = 'main', files = {} } = {}) => {
  if (branch !== 'main') git(work, 'switch', '-qc', branch);
  const c = commit({ 'package.json': JSON.stringify({ name: 'nuworq', version }), 'CHANGELOG.md': changelog, 'release-key.pub': pub, ...files }, `Release v${version}`);
  git(work, 'tag', `v${version}`);
  git(work, 'push', '-q', 'origin', branch, `v${version}`);
  if (branch !== 'main') git(work, 'switch', '-q', 'main');
  git(repo, 'fetch', '-q', '--tags', 'origin');
  git(repo, 'merge', '-q', '--ff-only', 'origin/main'); // the hub runs main
  return c;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-releasesign-test-')));
  origin = join(dir, 'origin.git'); work = join(dir, 'work'); repo = join(dir, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  git(work, 'config', 'user.email', 't@example.com'); git(work, 'config', 'user.name', 'T');
  ours = keypair();
  commit({ '.gitattributes': 'src/commit.txt export-subst\n', 'src/commit.txt': '$Format:%H %ct$\n', 'bin/nuworq.js': '// nuworq\n', 'release-key.pub': ours.pub,
    'scripts/release.js': "import { archive } from '../src/package.js';\n", 'src/package.js': "import { x } from './update.js';\n", 'src/update.js': '// update\n', [WORKFLOW]: 'name: Release\n' }, 'start');
  git(work, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, repo]);
});

describe('the rules every signer shares (#813)', () => {
  const MAIN = 'refs/remotes/origin/main';
  const refusal = (tag, c, more = {}) => releaseRefusal(repo, { tag, commit: c, main: MAIN, pub: ours.pub, ...more });

  test('a release on main at its version, with its changelog and this key, may be signed', async () => {
    assert.equal(await refusal('v1.0.0', release('1.0.0')), '');
  });

  test('refuses a tag off main, a version or changelog mismatch, a key mismatch and a rollback', async () => {
    assert.match(await refusal('v1.0.0', release('1.0.0', { branch: 'side' })), /isn't on origin's main/);
    git(work, 'switch', '-q', 'main');
    const wrongVersion = commit({ 'package.json': JSON.stringify({ version: '1.0.1' }), 'CHANGELOG.md': '## 1.0.2\n' }, 'x');
    git(work, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
    assert.match(await refusal('v1.0.2', wrongVersion), /package\.json says 1\.0\.1, not 1\.0\.2/);
    assert.match(await refusal('v1.1.0', release('1.1.0', { changelog: '## 1.0.9\n\n## 1.1.0\n' })), /CHANGELOG\.md doesn't begin with 1\.1\.0/);
    assert.match(await refusal('v1.2.0', release('1.2.0', { pub: keypair().pub })), /release-key\.pub isn't this key's public half/);
    const c = release('1.3.0');
    const last = { version: '1.4.0', commit: c, time: 0, where: 'the hub\'s signed release' };
    assert.match(await refusal('v1.3.0', c, { last }), /older than the hub's signed release v1\.4\.0/);
    assert.match(await refusal('v1.3.0', c, { last: { version: '1.2.0', commit: c, time: stamp + 1 } }), /older than the last signed release/, 'an older commit time is a rollback too');
    assert.equal(await refusal('v1.3.0', c, { last: { version: '1.2.0', commit: c, time: stamp - 1 } }), '');
    assert.match(await refusal('1.3.0', c), /isn't a release tag/);
  });

  test('the newest of the hub\'s and GitHub\'s signed releases is what a release must beat', () => {
    const a = { version: '1.0.0', time: 5 }, b = { version: '1.1.0', time: 4 };
    assert.equal(latest(a, b), b);
    assert.equal(latest(null, a), a);
    assert.equal(latest(a, null), a);
  });
});

describe('the release workflow (#813)', () => {
  test('the workflow a person installs is the one reviewed, and signs only after the release environment\'s approval', () => {
    const staged = readFileSync(fileURLToPath(new URL('../scripts/release-workflow.yml', import.meta.url)), 'utf8');
    const installed = fileURLToPath(new URL(`../${WORKFLOW}`, import.meta.url));
    if (existsSync(installed)) assert.equal(readFileSync(installed, 'utf8'), staged, `${WORKFLOW} differs from scripts/release-workflow.yml`);
    const jobs = staged.split(/\n  (?=check:|sign:)/);
    const check = jobs.find((j) => j.startsWith('check:')), signJob = jobs.find((j) => j.startsWith('sign:'));
    assert.match(staged, /\npermissions: \{\}\n/, 'nothing by default');
    assert.match(check, /contents: read/);
    assert.doesNotMatch(check, /secrets\.|environment:/, 'check holds no secret');
    assert.match(signJob, /needs: check\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: \d+\n\s+environment: release\n/);
    assert.match(signJob, /RELEASE_KEY: \$\{\{ secrets\.RELEASE_KEY \}\}/);
    assert.doesNotMatch(staged, /upload-artifact|echo "\$RELEASE_KEY"|set -x/, 'no artifact, and the key never echoed');
    assert.match(staged, /^on:\n  push:\n    tags: \['v\*'\]\n/m);
  });

  const run = (args, env = {}) => promisify(execFile)(process.execPath, [RELEASE, ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: dir, ...env } });

  test('check builds the package byte for byte as the hub does, and says what Paul approves', async () => {
    const c = release('1.0.0');
    const out = join(dir, 'out');
    const summaryFile = join(dir, 'summary.md'), outputs = join(dir, 'outputs');
    await run(['check', 'v1.0.0', out], { GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputs });
    const hubs = join(dir, 'hub.tgz');
    await archive(origin, c, hubs); // the hub builds from its own checkout of the same commit
    assert.deepEqual(readFileSync(join(out, `nuworq-${c}.tgz`)), readFileSync(hubs));
    const said = readFileSync(summaryFile, 'utf8');
    assert.match(said, /## Release v1\.0\.0/);
    assert.match(said, new RegExp(c));
    assert.match(said, /- things/);
    assert.match(said, /no signed release to compare with/);
    assert.match(readFileSync(outputs, 'utf8'), new RegExp(`commit=${c}\\nsha256=[0-9a-f]{64}`));
    assert.equal(readFileSync(join(out, 'notes.md'), 'utf8'), '- things\n');
  });

  test('a failed check stops before anyone is asked: the summary says why and nothing is built', async () => {
    release('1.0.0', { changelog: '## 0.9.0\n' });
    const out = join(dir, 'out'), summaryFile = join(dir, 'summary.md');
    await assert.rejects(run(['check', 'v1.0.0', out], { GITHUB_STEP_SUMMARY: summaryFile }));
    assert.match(readFileSync(summaryFile, 'utf8'), /won't be signed: its CHANGELOG\.md doesn't begin with 1\.0\.0/);
    assert.equal(existsSync(out), false);
  });

  test('sign signs the bytes check showed, and the signature verifies with release-key.pub; the key is never printed', async () => {
    const c = release('1.0.0');
    const out = join(dir, 'out'), outputs = join(dir, 'outputs');
    await run(['check', 'v1.0.0', out], { GITHUB_OUTPUT: outputs });
    const sha = /sha256=(\w+)/.exec(readFileSync(outputs, 'utf8'))[1];
    const { stdout, stderr } = await run(['sign', 'v1.0.0', out, sha], { RELEASE_KEY: ours.pem });
    const pkg = readFileSync(join(out, `nuworq-${c}.tgz`));
    const sig = Buffer.from(readFileSync(join(out, `nuworq-${c}.tgz.sig`), 'utf8').trim(), 'base64');
    assert.ok(verify(null, pkg, createPublicKey(readFileSync(join(work, 'release-key.pub'))), sig));
    const body = ours.pem.split('\n')[1];
    assert.ok(!`${stdout}${stderr}`.includes(body), 'no part of the key in the log');
    // Not the bytes check showed, or another key than the one the release pins: nothing is signed.
    await assert.rejects(run(['sign', 'v1.0.0', join(dir, 'o2'), 'f'.repeat(64)], { RELEASE_KEY: ours.pem }), /not the .* check job showed|as the check job showed/);
    await assert.rejects(run(['sign', 'v1.0.0', join(dir, 'o3'), sha], { RELEASE_KEY: keypair().pem }), /release-key\.pub isn't this key's public half/);
    await assert.rejects(run(['sign', 'v1.0.0', join(dir, 'o4'), sha]), /RELEASE_KEY is empty/);
    assert.equal(existsSync(join(dir, 'o3', `nuworq-${c}.tgz.sig`)), false);
  });

  test('the summary says whether the workflow or the code it runs changed since the last signed release', async () => {
    const a = release('1.0.0');
    assert.deepEqual(await filesRun(repo, a), [WORKFLOW, 'scripts/release.js', 'src/package.js', 'src/update.js']);
    const b = release('1.1.0');
    const last = { version: '1.0.0', commit: a, time: 0 };
    assert.deepEqual(await runsChanged(repo, last, b), []);
    const c = release('1.2.0', { files: { 'src/update.js': '// changed\n', 'bin/nuworq.js': '// not run by the workflow\n' } });
    assert.deepEqual(await runsChanged(repo, last, c), ['src/update.js']);
    const said = summary({ tag: 'v1.2.0', commit: c, sha256: 'ab', changes: '- x', last, changed: ['src/update.js'], compare: 'https://github.com/o/r/compare/a...c' });
    assert.match(said, /The release workflow or the code it runs changed\*\* since v1\.0\.0: `src\/update\.js`\. \[Read the diff\]\(https:\/\/github\.com\/o\/r\/compare\/a\.\.\.c\)/);
    assert.match(summary({ tag: 'v1.1.0', commit: b, sha256: 'ab', changes: '', last, changed: [] }), /are unchanged\*\* since v1\.0\.0/);
  });

  test('check refuses a rollback past the last release signed on GitHub', async () => {
    release('1.1.0');
    const c = release('1.0.5');
    const gh = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ tag_name: 'v1.1.0', assets: [{ name: `nuworq-${'a'.repeat(40)}.tgz.sig` }] }]));
    });
    const api = `http://127.0.0.1:${await listen(gh)}`;
    try {
      const summaryFile = join(dir, 'summary.md');
      await assert.rejects(run(['check', 'v1.0.5', join(dir, 'out')], { GITHUB_API_URL: api, GITHUB_REPOSITORY: 'o/r', GITHUB_STEP_SUMMARY: summaryFile }));
      assert.match(readFileSync(summaryFile, 'utf8'), new RegExp(`v1\\.0\\.5 \\(${c.slice(0, 7)}\\) won't be signed: older than the last release signed on GitHub v1\\.1\\.0`));
    } finally { gh.close(); }
  });
});

describe('the hub takes a release\'s .sig from GitHub (#813)', () => {
  let gh, api, web, releases, files, hubDir, hubRoot;
  beforeEach(async () => {
    releases = []; files = new Map();
    hubDir = join(dir, 'hub-packages'); mkdirSync(hubDir);
    hubRoot = repo; // the hub's checkout: a clone of origin with its tags
    gh = createServer((req, res) => {
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/repos/o/r/releases') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(releases)); }
      const f = files.get(path);
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200); res.end(f);
    });
    api = web = `http://127.0.0.1:${await listen(gh)}`;
  });
  afterEach(() => { gh.close(); gh.closeAllConnections(); });
  // A GitHub Release of tag with pkg and sig as its assets.
  const publish = (tag, c, pkg, sig) => {
    const name = `nuworq-${c}.tgz`;
    files.set(`/o/r/releases/download/${tag}/${name}`, pkg);
    files.set(`/o/r/releases/download/${tag}/${name}.sig`, `${sig}\n`);
    releases.unshift({ tag_name: tag, assets: [name, `${name}.sig`].map((n, i) => ({ id: releases.length * 2 + i, name: n, browser_download_url: `${web}/o/r/releases/download/${tag}/${n}` })) });
  };
  const built = async (c) => { const f = join(dir, `gh-${c}.tgz`); await archive(repo, c, f); return readFileSync(f); };
  const take = (seen) => takeReleases({ root: hubRoot, dir: hubDir, key: ours.pub, repo: 'o/r', api, web, seen });

  test('a .sig that verifies over the hub\'s own package makes it the hub\'s signed release', async () => {
    const c = release('1.0.0');
    const pkg = await built(c);
    publish('v1.0.0', c, pkg, sign(null, pkg, ours.key).toString('base64'));
    const seen = new Map();
    const [r] = await take(seen);
    assert.equal(r.outcome, 'taken', JSON.stringify(r));
    assert.equal(newestSigned(hubDir, ours.pub)?.commit, c);
    assert.equal((await take(seen))[0].outcome, 'had', 'settled once, not fetched again');
  });

  test('GitHub\'s gzip of the same files is taken, with its signature, in place of the hub\'s', async () => {
    const c = release('1.0.0');
    const theirs = gzipSync(gunzipSync(await built(c)), { level: 1 });
    const own = await built(c);
    assert.notDeepEqual(theirs, own);
    publish('v1.0.0', c, theirs, sign(null, theirs, ours.key).toString('base64'));
    assert.equal((await take())[0].outcome, 'taken');
    assert.deepEqual(readFileSync(join(hubDir, `nuworq-${c}.tgz`)), theirs);
    assert.equal(newestSigned(hubDir, ours.pub)?.commit, c);
  });

  test('a .sig that doesn\'t verify is ignored and said, and the hub serves no release', async () => {
    const c = release('1.0.0');
    const pkg = await built(c);
    publish('v1.0.0', c, pkg, sign(null, pkg, keypair().key).toString('base64'));
    const [r] = await take();
    assert.equal(r.outcome, 'refused');
    assert.match(r.reason, /doesn't verify against this hub's release-key\.pub/);
    assert.equal(existsSync(join(hubDir, `nuworq-${c}.tgz.sig`)), false);
    assert.equal(newestSigned(hubDir, ours.pub), null);
    // Other files under a valid signature: not the hub's build, so ignored too.
    const d = release('1.1.0');
    const other = gzipSync(Buffer.alloc(1024));
    publish('v1.1.0', d, other, sign(null, other, ours.key).toString('base64'));
    const rs = await take();
    assert.match(rs.find((x) => x.tag === 'v1.1.0').reason, /isn't the hub's build of/);
    assert.equal(existsSync(join(hubDir, `nuworq-${d}.tgz.sig`)), false);
    const q = releaseAlarm('o/r', r);
    assert.equal(q.to, 'operator');
    assert.ok(q.steps.length >= 2 && q.steps.every((s) => s.do && s.where && s.check));
  });

  test('a release whose tag the hub\'s checkout lacks waits, and assets come only from the repository\'s downloads', async () => {
    const c = release('1.0.0');
    git(work, 'tag', 'v2.0.0', c); // not fetched into the hub's checkout
    const pkg = await built(c);
    publish('v2.0.0', 'b'.repeat(40), pkg, 'x');
    assert.equal((await take())[0].outcome, 'waiting');
    releases = [{ tag_name: 'v1.0.0', assets: [`nuworq-${c}.tgz`, `nuworq-${c}.tgz.sig`].map((n) => ({ name: n, browser_download_url: `http://127.0.0.1:1/${n}` })) }];
    await assert.rejects(take(), /isn't a release download of o\/r/);
  });

  test('a hub serving with githubReleases serves a verified release, and asks the operator about one that isn\'t', async () => {
    const c = release('1.0.0');
    const pkg = await built(c);
    publish('v1.0.0', c, pkg, sign(null, pkg, ours.key).toString('base64'));
    const d = release('1.1.0');
    const other = await built(d);
    publish('v1.1.0', d, other, sign(null, other, keypair().key).toString('base64'));
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    const hub = new Hub();
    const p = hub.tx(() => hub.project('nuworq', { create: true }));
    hub.tx(() => hub.addRemote(p, 'github.com/o/r', 'test'));
    const s = createHubServer(hub, { source: repo, packageDir: hubDir, githubReleases: true, github: { api, web }, sweepMs: 2 ** 31 - 1 });
    const u = `http://127.0.0.1:${await listen(s)}`;
    try {
      let rel = null;
      for (let i = 0; i < 100 && !rel; i++) { await new Promise((r) => setTimeout(r, 50)); rel = (await (await fetch(`${u}/api/package`)).json()).package?.release; }
      assert.equal(rel?.commit, c, 'v1.0.0 is served as the signed release; v1.1.0\'s foreign signature is not');
      let q = null;
      for (let i = 0; i < 100 && !q; i++) { await new Promise((r) => setTimeout(r, 50)); q = hub.q("SELECT * FROM questions WHERE project_id = ? AND status = 'open'").get(p.id); }
      assert.match(JSON.stringify(q), /v1\.1\.0/);
      assert.equal(q.audience, 'operator');
    } finally { s.close(); s.closeAllConnections(); }
  });

  test('the repository is read from the checkout\'s origin on GitHub', () => {
    git(repo, 'remote', 'set-url', 'origin', 'git@github.com:paulnorthup/nuworq.git');
    assert.equal(githubRepoOf(repo), 'paulnorthup/nuworq');
    git(repo, 'remote', 'set-url', 'origin', 'https://github.com/paulnorthup/nuworq.git');
    assert.equal(githubRepoOf(repo), 'paulnorthup/nuworq');
    git(repo, 'remote', 'set-url', 'origin', '/srv/nuworq.git');
    assert.equal(githubRepoOf(repo), null);
  });
});
