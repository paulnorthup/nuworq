// Releases signed on GitHub Actions (#813): the rules the workflow and signing by hand share, the workflow's build and signature
// (scripts/release.js), and the hub taking a release's .sig from its GitHub Release (src/ghrelease.js).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { archive, newestSigned } from '../src/package.js';
import { releaseRefusal, latest, newer, handCheck } from '../scripts/release.js';
import { signByHand, installRefusal } from '../src/releasesign.js';
import { takeReleases, githubRepoOf, releaseAlarm } from '../src/ghrelease.js';
import { Hub } from '../src/core.js';
import { createServer as createHubServer } from '../src/server.js';

const RELEASE = fileURLToPath(new URL('../scripts/release.js', import.meta.url));
const WORKFLOW = '.github/workflows/release.yml';
const YAML = readFileSync(fileURLToPath(new URL(`../${WORKFLOW}`, import.meta.url)), 'utf8');
const jobOf = (name) => YAML.split(/\n  (?=\w+:\n)/).find((j) => j.startsWith(`${name}:\n`));
// The shell a step runs, as the runner gets it: its `run: |` block, unindented.
const stepRun = (name) => {
  const lines = YAML.split('\n');
  let i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(i >= 0, `no step named ${name}`);
  while (!/^\s+run: \|$/.test(lines[i])) i++;
  const body = [];
  const indent = lines[i].search(/\S/) + 2;
  for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i++) body.push(lines[i].slice(indent));
  return body.join('\n');
};
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
    assert.ok(newer('0.10.0', '0.9.0') && !newer('0.9.0', '0.10.0') && !newer('1.0.0', '1.0.0'), 'versions compare as numbers');
  });
});

// Signing by hand, the fallback to the workflow (#815): origin's tag by the workflow's rules, against the hub's
// signed release, never the hub's package.
describe('signing by hand (#815)', () => {
  const hubAt = (release) => async (url) => ({ ok: true, json: async () => ({ package: { release } }), url });

  test('a release tag on origin\'s main may be signed, with its commit and changelog to show', async () => {
    const c = release('1.0.0', { changelog: '## 1.0.0\n\n- signed by hand\n' });
    git(repo, 'tag', '-d', 'v1.0.0'); // the checkout's own tags don't count: origin's is fetched
    const r = await handCheck(repo, { tag: 'v1.0.0', pub: ours.pub, hub: 'https://hub.test', get: hubAt(null) });
    assert.deepEqual({ ...r, subject: undefined }, { commit: c, subject: undefined, changes: '- signed by hand', refusal: '' });
    assert.match(r.subject, /^Release v1\.0\.0 \(\d{4}-\d\d-\d\d\)$/);
    assert.equal(git(repo, 'tag', '-l', 'v1.0.0'), '', 'the checkout\'s tags stay as they are');
  });

  test('refuses what the workflow refuses: no such tag, off main, another key, older than the hub\'s release', async () => {
    const at = (tag, more = {}) => handCheck(repo, { tag, pub: ours.pub, hub: 'https://hub.test', get: hubAt(null), ...more }).then((r) => r.refusal);
    assert.match(await at('v9.9.9'), /couldn't fetch origin's main and v9\.9\.9/);
    assert.match(await at('9.9.9'), /isn't a release tag/);
    release('1.0.0', { branch: 'side' });
    assert.match(await at('v1.0.0'), /isn't on origin's main/);
    const c = release('1.1.0');
    assert.match(await at('v1.1.0', { pub: keypair().pub }), /release-key\.pub isn't this key's public half/);
    const later = release('1.2.0');
    assert.match(await at('v1.1.0', { get: hubAt({ commit: later }) }), /older than the hub's signed release v1\.2\.0/);
    assert.equal(await at('v1.2.0', { get: hubAt({ commit: c }) }), '');
  });

  // An installed package: no .git, and src/commit.txt names its commit, as git archive writes it.
  const install = (pub = ours.pub) => {
    const root = join(dir, 'install');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'commit.txt'), `${'a'.repeat(40)} ${stamp}\n`);
    writeFileSync(join(root, 'release-key.pub'), pub);
    return root;
  };
  const pemFile = () => { const f = join(dir, 'release-key.pem'); writeFileSync(f, ours.pem); return f; };
  const said = [];
  const hand = (more) => signByHand({ repo, tag: 'v1.0.0', hub: 'https://hub.test', tty: true, get: hubAt(null), out: join(dir, 'signatures'), say: (s) => said.push(s), ...more });

  test('signing by hand never runs a checkout\'s code with the key', async () => {
    // A pem that throws if read: a directory.
    const pem = join(dir, 'unreadable.pem');
    mkdirSync(pem);
    const root = install();
    mkdirSync(join(root, '.git'));
    await assert.rejects(hand({ root, pem, ask: async () => 'v1.0.0' }), /runs from a git checkout.*never touches the release key/);
    assert.match(installRefusal(repo), /runs from a git checkout/, 'a clone is a checkout');
    // This repository's own CLI, from its checkout, refuses before the terminal check and before the key.
    const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/nuworq.js', import.meta.url)), 'release', 'sign', 'v1.0.0', pem, 'https://hub.test'],
      { cwd: repo, env: { ...process.env, HOME: dir, NUWORQ_NO_UPDATE: '1' } }).then(() => null, (e) => e);
    assert.ok(cli, 'it refused');
    assert.match(cli.stderr, /runs from a git checkout/);
    assert.doesNotMatch(cli.stderr, /EISDIR/, 'it never opened the key');
    // The script it replaces only says where it went.
    const old = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/sign-release.js', import.meta.url)), 'release', 'v1.0.0', pem, 'https://hub.test'], { cwd: repo }).then(() => null, (e) => e);
    assert.match(old.stderr, /nuworq release sign/);
    assert.doesNotMatch(old.stderr, /EISDIR/);
  });

  test('a package that doesn\'t name its commit, or pins another key, isn\'t a signed release', async () => {
    const root = install(keypair().pub);
    await assert.rejects(hand({ root, pem: pemFile(), ask: async () => 'v1.0.0' }), /pins another release key/);
    writeFileSync(join(root, 'src', 'commit.txt'), '$Format:%H %ct$\n');
    assert.match(installRefusal(root), /doesn't say which commit/);
  });

  test('from a signed install, at a terminal, it signs GitHub\'s build of the tag once the tag is typed', async () => {
    const c = release('1.0.0');
    const root = install();
    await assert.rejects(hand({ root, pem: pemFile(), tty: false, ask: async () => 'v1.0.0' }), /needs a person at a terminal/);
    await hand({ root, pem: pemFile(), ask: async () => 'no' });
    assert.ok(!existsSync(join(dir, 'signatures', `nuworq-${c}.tgz`)), 'not typed: nothing written');
    await hand({ root, pem: pemFile(), ask: async () => 'v1.0.0' });
    const file = join(dir, 'signatures', `nuworq-${c}.tgz`);
    const sig = Buffer.from(readFileSync(`${file}.sig`, 'utf8').trim(), 'base64');
    assert.ok(verify(null, readFileSync(file), createPublicKey(ours.pub), sig), 'the .sig verifies over the package');
    assert.match(said.at(-1), /gh release create v1\.0\.0/);
  });

  // #843: until a signed release ships `nuworq release sign`, the recipe is run at the last signed release's tag,
  // so it must give the command that tag's script accepts: v0.9.0's `release <hub> <pem> [<scp>]`, v0.10.0's
  // `release <vX.Y.Z> <pem> <hub>`. From then on, this package's own command, in the form its usage says.
  test('the hand-signing recipe in DEPLOY.md matches the release command\'s usage', () => {
    const doc = readFileSync(fileURLToPath(new URL('../docs/DEPLOY.md', import.meta.url)), 'utf8');
    const recipe = doc.slice(doc.indexOf('**Signing by hand, the fallback.**')).split('```')[1];
    const args = (prefix) => recipe.split('\n').filter((l) => l.startsWith(prefix)).map((l) => l.split('#')[0].trim().split(/\s+/).slice(prefix.split(' ').length - 1));
    const shape = { '<vX.Y.Z>': /^v\d+\.\d+\.\d+$/, '<release-key.pem>': /\.pem$/, '<hub>': /^https:\/\/[^/]+$/ };
    const fits = (line, usage) => line.length === usage.length && usage.every((u, i) => shape[u].test(line[i]));
    const cli = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
    const env = { ...process.env, HOME: dir, NUWORQ_NO_UPDATE: '1' };
    const usage = spawnSync(process.execPath, [cli, 'release'], { encoding: 'utf8', env }).stderr.match(/nuworq release sign ((?:<[^>]+> ?)+)/)[1].trim().split(' ');
    assert.deepEqual(usage, ['<vX.Y.Z>', '<release-key.pem>', '<hub>'], 'the usage this test reads');
    const current = args('nuworq release sign ');
    assert.equal(current.length, 1, 'one line for this package\'s command');
    assert.ok(fits(current[0], usage), 'in the form its usage says');
    const r = spawnSync(process.execPath, [cli, 'release', 'sign', ...current[0]], { encoding: 'utf8', env, cwd: repo });
    assert.match(r.stderr, /runs from a git checkout/, 'past the argument check, not the usage');
    const older = args('node scripts/sign-release.js release ');
    const v010 = older.filter((line) => fits(line, usage));
    assert.equal(v010.length, 1, 'v0.10.0\'s, while it is the last signed release');
    const v09 = older.filter((line) => !v010.includes(line));
    assert.equal(v09.length, 1, 'and v0.9.0\'s');
    assert.match(v09[0][0], shape['<hub>']);
    assert.match(v09[0][1], shape['<release-key.pem>']);
    assert.match(recipe, /^node scripts\/sign-release\.js approve v\d+\.\d+\.\d+ \S+\.pem$/m, 'v0.9.0 signs only what was approved');
  });

  test('the command works when its checkout is reached through a symlink', () => {
    const link = join(dir, 'linked');
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link);
    const run = (...args) => spawnSync(process.execPath, [join(link, 'scripts', 'sign-release.js'), ...args], { encoding: 'utf8' });
    const bogus = run('bogus');
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /usage: sign-release\.js keygen/);
    const keys = join(dir, 'keys');
    mkdirSync(keys);
    assert.equal(run('keygen', keys).status, 0);
    assert.ok(existsSync(join(keys, 'release-key.pem')) && existsSync(join(keys, 'release-key.pub')));
  });
});

describe('the release workflow (#813)', () => {
  test('the workflow signs only after the release environment\'s approval', () => {
    const check = jobOf('check'), changes = jobOf('changes'), signJob = jobOf('sign');
    assert.match(YAML, /\npermissions: \{\}\n/, 'nothing by default');
    for (const job of [check, changes]) {
      assert.match(job, /contents: read/);
      assert.doesNotMatch(job, /secrets\.|environment:/, 'check and changes hold no secret');
    }
    assert.match(signJob, /needs: \[check, changes\]\n\s+runs-on: ubuntu-latest\n\s+timeout-minutes: \d+\n\s+environment: release\n/);
    assert.match(signJob, /RELEASE_KEY: \$\{\{ secrets\.RELEASE_KEY \}\}/);
    assert.doesNotMatch(YAML, /upload-artifact|echo "\$RELEASE_KEY"|set -x/, 'no artifact, and the key never echoed');
    assert.match(YAML, /^on:\n  push:\n    tags: \['v\*'\]\n/m);
  });

  test('sign and changes run none of the repository\'s code: no script, module, npm or set-up node of the tag\'s', () => {
    for (const job of [jobOf('changes'), jobOf('sign')]) {
      assert.doesNotMatch(job, /node (?:\.\/)?(?:scripts|src|bin)\/|npm |npx |setup-node|import\(|require\(['"]\./);
      // node only ever runs a script written in this file.
      const nodes = [...job.matchAll(/(?:^\s*|[|(]\s*)node (\S+ \S+)/gm)].map((m) => m[1]);
      assert.ok(nodes.length > 0);
      for (const args of nodes) assert.match(args, /^--input-type=commonjs (?:-p|-)$/);
    }
    // The secrets reach sign's own steps only, and the approval's "changed" line comes from changes, not from check.
    assert.equal(YAML.match(/secrets\./g).length, 2);
    assert.match(stepRun('What the approval rests on'), /git diff --name-only "\$last" "\$commit" -- \.github\/workflows "\$\{ran\[@\]\}"/);
    assert.doesNotMatch(readFileSync(RELEASE, 'utf8'), /changed since/);
  });

  test('sign builds with git alone what src/package.js builds: the same files', () => {
    const runs = /const RUNS = \[([^\]]+)\]/.exec(readFileSync(fileURLToPath(new URL('../src/package.js', import.meta.url)), 'utf8'))[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
    for (const step of ['Build the package again with git alone', 'What the approval rests on']) {
      const yaml = /for f in ([^;]+); do/.exec(stepRun(step))[1].split(' ');
      assert.deepEqual(yaml, runs, step);
    }
  });

  const run = (args, env = {}) => promisify(execFile)(process.execPath, [RELEASE, ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: dir, ...env } });
  // A workflow step, run as the runner would: bash, in the checkout, with node on PATH and the given environment.
  const step = (name, env = {}, cwd = repo) => promisify(execFile)('bash', ['-c', stepRun(name)], { cwd, env: { PATH: `${join(dir, 'bin')}:${join(process.execPath, '..')}:${process.env.PATH}`, HOME: dir, TMPDIR: tmpdir(), RUNNER_TEMP: join(dir, 'runner'), GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', ...env } });

  test('check builds the package byte for byte as the hub does, and shows its version, sha256 and changelog', async () => {
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
    assert.match(readFileSync(outputs, 'utf8'), new RegExp(`commit=${c}\\nsha256=[0-9a-f]{64}`));
  });

  test('sign rebuilds the bytes check showed with git alone, and its signature verifies with release-key.pub; the key is never printed', async () => {
    const c = release('1.0.0', { changelog: '# Changelog\n\n## 1.0.0 (2026-11-03)\n\n- things\n\n## 0.9.0\n\n- older\n' });
    const outputs = join(dir, 'outputs');
    await run(['check', 'v1.0.0', join(dir, 'out')], { GITHUB_OUTPUT: outputs });
    const sha = /sha256=(\w+)/.exec(readFileSync(outputs, 'utf8'))[1];
    await step('Build the package again with git alone', { GITHUB_SHA: c, CHECKED: c });
    const out = join(dir, 'runner', 'release');
    const pkg = readFileSync(join(out, `nuworq-${c}.tgz`));
    assert.deepEqual(pkg, readFileSync(join(dir, 'out', `nuworq-${c}.tgz`)), 'git alone builds what check built');
    assert.equal(readFileSync(join(out, 'notes.md'), 'utf8').trim(), '- things');
    const { stdout, stderr } = await step('Sign it', { COMMIT: c, SHA256: sha, RELEASE_KEY: ours.pem });
    const sig = Buffer.from(readFileSync(join(out, `nuworq-${c}.tgz.sig`), 'utf8').trim(), 'base64');
    assert.ok(verify(null, pkg, createPublicKey(readFileSync(join(work, 'release-key.pub'))), sig));
    const body = ours.pem.split('\n')[1];
    assert.ok(!`${stdout}${stderr}`.includes(body), 'no part of the key in the log');
    // Not the bytes check showed, another key than the one the release pins, or no key: nothing new is signed.
    await assert.rejects(step('Sign it', { COMMIT: c, SHA256: 'f'.repeat(64), RELEASE_KEY: ours.pem }), /as the check job showed/);
    await assert.rejects(step('Sign it', { COMMIT: c, SHA256: sha, RELEASE_KEY: keypair().pem }), /doesn't verify against the tag's release-key\.pub/);
    await assert.rejects(step('Sign it', { COMMIT: c, SHA256: sha }), /RELEASE_KEY is empty/);
    await assert.rejects(step('Build the package again with git alone', { GITHUB_SHA: c, CHECKED: 'a'.repeat(40) }), /not the tag's commit/);
  });

  describe('changes: what the approval rests on, from the workflow alone', () => {
    // gh, as GitHub's releases API filtered by the step's --jq: the tags of signed releases, one a line.
    const fakeGh = (tags) => {
      mkdirSync(join(dir, 'bin'), { recursive: true });
      writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\ncat <<'EOF'\n${tags.map((t) => `${t}\n`).join('')}EOF\n`, { mode: 0o755 });
    };
    const changes = async (tag, c, env = {}) => {
      const summaryFile = join(dir, `changes-${tag}.md`);
      writeFileSync(summaryFile, '');
      const r = await step('What the approval rests on', { GITHUB_SHA: c, GITHUB_REF_NAME: tag, GITHUB_STEP_SUMMARY: summaryFile, ...env }).then(() => null, (e) => e);
      return { failed: r, said: readFileSync(summaryFile, 'utf8') };
    };

    test('says whether the code check ran changed since the last signed release, with the diff', async () => {
      fakeGh([]);
      const a = release('1.0.0');
      let { failed, said } = await changes('v1.0.0', a);
      assert.equal(failed, null, failed?.stderr);
      assert.match(said, /No signed release to compare with/);
      fakeGh(['v1.0.0']);
      const b = release('1.1.0', { files: { 'bin/nuworq.js': '// not run by check\n' } });
      ({ failed, said } = await changes('v1.1.0', b));
      assert.equal(failed, null, failed?.stderr);
      assert.match(said, new RegExp(`The code \`check\` ran is unchanged\\*\\* since v1\\.0\\.0 \\(\`${a.slice(0, 7)}\`\\)`));
      const c = release('1.2.0', { files: { 'src/update.js': '// changed\n' } });
      ({ failed, said } = await changes('v1.2.0', c));
      assert.equal(failed, null, failed?.stderr);
      assert.match(said, new RegExp(`The code \`check\` ran changed\\*\\* since v1\\.0\\.0 \\(\`${a.slice(0, 7)}\`\\): \`src/update\\.js\`\\. \\[Read the diff\\]\\(https://github\\.com/o/r/compare/${a}\\.\\.\\.${c}\\)`));
      assert.match(said, /The `sign` job runs none of the repository's code/);
    });

    // A hub naming commit as its signed release, and serving sig (base64, as src/server.js does) as its .sig, if any.
    const fakeHub = async (commit, sig) => {
      const hub = createServer((req, res) => {
        if (req.url === '/api/package') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ package: { release: { commit } } })); }
        if (req.url === `/nuworq-${commit}.tgz.sig` && sig) { res.writeHead(200); return res.end(`${sig.toString('base64')}\n`); }
        res.writeHead(404); res.end();
      });
      return { at: `http://127.0.0.1:${await listen(hub)}`, close: () => hub.close() };
    };
    // What sign would have signed for commit: src/package.js's archive, which sign builds with git alone.
    const signed = async (commit, key = ours.key) => { const f = join(dir, `signed-${commit}.tgz`); await archive(origin, commit, f); return sign(null, readFileSync(f), key); };

    test('the hub\'s signed release counts when it is newer than GitHub\'s', async () => {
      const a = release('1.0.0'), b = release('1.1.0');
      fakeGh(['v1.0.0']);
      const hub = await fakeHub(b, await signed(b));
      try {
        const c = release('1.2.0', { files: { 'scripts/release.js': '// changed\n' } });
        const { failed, said } = await changes('v1.2.0', c, { NUWORQ_HUB: `${hub.at}/` });
        assert.equal(failed, null, failed?.stderr);
        assert.match(said, new RegExp(`changed\\*\\* since the hub's signed release \\(\`${b.slice(0, 7)}\`\\): \`scripts/release\\.js\``));
        assert.ok(!said.includes(a.slice(0, 7)));
        assert.doesNotMatch(said, /didn't verify|release key changed/);
      } finally { hub.close(); }
    });

    test('the approval summary\'s base is a release whose signature verified', async () => {
      const a = release('1.0.0');
      fakeGh(['v1.0.0']);
      // A compromised hub names the tag's parent, which changed the code check runs, as its signed release.
      const parent = commit({ 'src/update.js': '// changed by landed code\n' }, 'x');
      git(work, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
      const c = release('1.1.0');
      for (const sig of [null, Buffer.alloc(64), await signed(parent, keypair().key)]) {
        const hub = await fakeHub(parent, sig);
        try {
          const { failed, said } = await changes('v1.1.0', c, { NUWORQ_HUB: hub.at });
          assert.equal(failed, null, failed?.stderr);
          assert.match(said, new RegExp(`The hub's claim didn't verify:\\*\\* it names \`${parent.slice(0, 7)}\``));
          assert.match(said, new RegExp(`The code \`check\` ran changed\\*\\* since v1\\.0\\.0 \\(\`${a.slice(0, 7)}\`\\): \`src/update\\.js\``));
          assert.doesNotMatch(said, /unchanged/);
        } finally { hub.close(); }
      }
      // Its claim still counts against a rollback: a tag no newer than it isn't signed.
      const hub = await fakeHub(c, null);
      try {
        const r = await changes('v1.1.0', c, { NUWORQ_HUB: hub.at });
        assert.ok(r.failed);
        assert.match(r.said, /isn't newer than the hub's signed release .*roll installs back/);
      } finally { hub.close(); }
      // The step verifies with node:crypto inline, over sign's own build, before the hub's commit becomes the base.
      const step = stepRun('What the approval rests on');
      assert.ok(step.indexOf('verify(null, pkg') < step.indexOf('last=$hub'));
      assert.match(step, /curl [^\n]*"\$\{NUWORQ_HUB%\/\}\/nuworq-\$hub\.tgz\.sig"/);
      assert.match(step, /git show "\$keyfrom:release-key\.pub"/);
    });

    test('a release key the tag swapped in can\'t make the hub\'s .sig verify, and the summary says the key changed (#842)', async () => {
      const a = release('1.0.0');
      fakeGh(['v1.0.0']);
      // Landed code swaps release-key.pub and changes the code check runs; a compromised hub signs it with the new key.
      const theirs = keypair();
      const parent = commit({ 'release-key.pub': theirs.pub, 'src/update.js': '// changed by landed code\n' }, 'x');
      git(work, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
      const c = release('1.1.0', { pub: theirs.pub });
      const hub = await fakeHub(parent, await signed(parent, theirs.key));
      try {
        const { failed, said } = await changes('v1.1.0', c, { NUWORQ_HUB: hub.at });
        assert.equal(failed, null, failed?.stderr);
        assert.match(said, new RegExp(`The hub's claim didn't verify:\\*\\* it names \`${parent.slice(0, 7)}\`.*release-key\\.pub of v1\\.0\\.0`));
        assert.match(said, new RegExp(`The code \`check\` ran changed\\*\\* since v1\\.0\\.0 \\(\`${a.slice(0, 7)}\`\\): \`src/update\\.js\``));
        assert.match(said, new RegExp(`The release key changed\\*\\* since v1\\.0\\.0 \\(\`${a.slice(0, 7)}\`\\)`));
      } finally { hub.close(); }
    });

    test('a hub naming its signed release by anything but a full sha fails, naming the hub (#842)', async () => {
      const a = release('1.0.0');
      fakeGh(['v1.0.0']);
      const c = release('1.1.0');
      for (const name of ['v1.0.0', 'HEAD~1', a.slice(0, 7), a.toUpperCase(), `${a} `]) {
        const hub = await fakeHub(name, null);
        try {
          const { failed, said } = await changes('v1.1.0', c, { NUWORQ_HUB: hub.at });
          assert.ok(failed, `${JSON.stringify(name)} passed`);
          assert.match(said, new RegExp(`the hub at ${hub.at.replace(/\./g, '\\.')} names its signed release by something other than a 40-character commit sha`));
          assert.doesNotMatch(said, /HEAD~1|rests on/);
        } finally { hub.close(); }
      }
    });

    test('refuses, before anyone is asked, a tag off main, at another version, or a rollback', async () => {
      fakeGh([]);
      let r = await changes('v1.0.0', release('1.0.0', { branch: 'side' }));
      assert.ok(r.failed);
      assert.match(r.said, /won't be signed: \w{7} isn't on main/);
      const wrong = commit({ 'package.json': JSON.stringify({ version: '1.0.1' }) }, 'x');
      git(work, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
      r = await changes('v1.0.2', wrong);
      assert.match(r.said, /package\.json says 1\.0\.1, not 1\.0\.2/);
      const old = release('1.1.0'); release('1.2.0');
      fakeGh(['v1.2.0']);
      r = await changes('v1.1.0', old);
      assert.ok(r.failed);
      assert.match(r.said, /isn't newer than v1\.2\.0 .*roll installs back/);
    });
  });

  test('a failed check stops before anyone is asked: the summary says why and nothing is built', async () => {
    release('1.0.0', { changelog: '## 0.9.0\n' });
    const out = join(dir, 'out'), summaryFile = join(dir, 'summary.md');
    await assert.rejects(run(['check', 'v1.0.0', out], { GITHUB_STEP_SUMMARY: summaryFile }));
    assert.match(readFileSync(summaryFile, 'utf8'), /won't be signed: its CHANGELOG\.md doesn't begin with 1\.0\.0/);
    assert.equal(existsSync(out), false);
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
