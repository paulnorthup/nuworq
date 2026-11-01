import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scan, scanMirror, secretIn, nameIn, highEntropy } from '../scripts/scan-history.js';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/scan-history.js', import.meta.url));
// Assembled at runtime, so this file holds no live-looking secret.
const r = (n) => Array.from({ length: n }, (_, i) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[(i * 7 + 3) % 56]).join('');

async function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'nuworq-scan-'));
  const git = (...a) => run('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a]);
  await git('init', '-q', '-b', 'main');
  const commit = async (file, text) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), text); await git('add', '-A'); await git('commit', '-qm', `edit ${file}`); };
  return { dir, git, commit };
}

describe('scripts/scan-history.js: secrets anywhere in the history, before going public', () => {
  test('a secret added and later removed is still found, on any branch; the output never shows it', async () => {
    const { dir, git, commit } = await repo();
    await commit('README.md', 'hello\n');
    assert.deepEqual((await scan(dir)).hits, []);
    const key = `sk-ant-api03-${r(40)}`;
    const hook = `whsec_${r(32)}`;
    await commit('deploy/hub.env', `ANTHROPIC_API_KEY=${key}\n`);
    await commit('deploy/hub.env', 'ANTHROPIC_API_KEY=\n');
    await git('switch', '-qc', 'side');
    await commit('notes.txt', `stripe: ${hook}\n`);
    await git('switch', '-q', 'main');
    assert.deepEqual((await scan(dir)).hits.map((h) => [h.file, h.kind]).sort(), [['deploy/hub.env', 'an Anthropic API key'], ['notes.txt', 'a Stripe webhook secret']]);
    const out = await run(process.execPath, [SCRIPT, dir]).then(() => assert.fail('expected exit 1'), (e) => e);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /deploy\/hub\.env: an Anthropic API key/);
    assert.ok(!out.stdout.includes(key) && !out.stdout.includes(hook), 'never prints a secret');
  });

  test("nuworq's own deliberate test fakes pass, but only in their own files", () => {
    const fake = 'ghp' + '_abcdefghijklmnopqrstuvwxyz0123456789'; // test/feedback.test.js's, in two parts
    assert.equal(secretIn('test/feedback.test.js', `{ text: 'my key is ${fake}' }`), null);
    assert.equal(secretIn('src/server.js', `const t = '${fake}'`), 'a GitHub token');
    assert.equal(secretIn('test/feedback.test.js', `{ text: 'ghp_${r(36)}' }`), 'a GitHub token', 'another token in the same file still counts');
  });

  test("the scanner's own files hold no whole fake, so landing it keeps the scan clean", () => {
    for (const rel of ['scripts/scan-history.js', 'test/scanhistory.test.js']) {
      const lines = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8').split('\n');
      lines.forEach((line, i) => assert.equal(secretIn(rel, line), null, `${rel}:${i + 1}`));
    }
  });

  test('a clean history exits 0 and says how much it read', async () => {
    const { dir, commit } = await repo();
    await commit('a.txt', 'one\ntwo\n');
    const { stdout } = await run(process.execPath, [SCRIPT, dir]);
    assert.match(stdout, /No secrets in 2 added lines, the messages and file names of 1 refs \(0 pull request refs\)/);
  });

  test('a fresh mirror clone reads refs a plain fetch never brings, refs/pull/* included', async () => {
    const { dir, git, commit } = await repo();
    await commit('a.txt', 'one\n');
    // A pull request's head: on no branch, so only a mirror has it.
    await git('switch', '-q', '--detach');
    await commit('pr.txt', `token ${'ghp_'}${r(36)}\n`);
    await git('update-ref', 'refs/pull/7/head', 'HEAD');
    await git('switch', '-q', 'main');
    const out = await scanMirror(dir);
    assert.equal(out.pulls, 1);
    assert.deepEqual(out.hits.map((h) => [h.file, h.kind]), [['pr.txt', 'a GitHub token']]);
  });

  test('a secret only a merge added, and secrets in commit and tag messages, are found', async () => {
    const { dir, git, commit } = await repo();
    await commit('a.txt', 'one\n');
    await git('switch', '-qc', 'side');
    await commit('b.txt', 'two\n');
    await git('switch', '-q', 'main');
    await commit('c.txt', 'three\n');
    await git('merge', '-q', '--no-commit', 'side');
    writeFileSync(join(dir, 'merged.env.txt'), `STRIPE=${'sk_'}test_${r(24)}\n`);
    await git('add', '-A');
    await git('commit', '-qm', 'merge side');
    await git('commit', '-q', '--allow-empty', '-m', `deploy with ${'npm_'}${r(36)}`);
    await git('tag', '-a', 'v1', '-m', `signed by ${'sk-ant-'}api03-${r(30)}`);
    const got = (await scan(dir)).hits.map((h) => [h.file, h.kind]).sort();
    assert.deepEqual(got, [['(message)', 'an npm token'], ['(tag v1)', 'an Anthropic API key'], ['merged.env.txt', 'a Stripe key']]);
  });

  test('files that hold keys or environments are found by name, binary ones too', async () => {
    const { dir, git, commit } = await repo();
    await commit('deploy/.env', 'nothing yet\n');
    await commit('.env.example', 'NUWORQ_TOKEN=\n');
    writeFileSync(join(dir, 'release.p12'), Buffer.from([0, 1, 2, 0, 255]));
    await git('add', '-A');
    await git('commit', '-qm', 'a binary key');
    await commit('keys/hub.pem', 'not really\n');
    const got = (await scan(dir)).hits.map((h) => [h.file, h.kind]).sort();
    assert.deepEqual(got, [['deploy/.env', 'an environment file'], ['keys/hub.pem', 'a key file'], ['release.p12', 'a key file']]);
  });

  test('the new shapes: test keys, environment secrets, JWTs and tunnel tokens, npm and Cloudflare tokens', () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const cases = [
      [`${'rk_'}test_${r(24)}`, 'a Stripe key'],
      [`NUWORQ_TURNSTILE${'_SECRET'}=${r(24)}`, 'a secret in an environment line'],
      [`${b64({ alg: 'HS256' })}.${b64({ sub: 'x', iat: 1 })}.${r(20)}`, 'a JWT or tunnel token'],
      [`cloudflared service install ${b64({ a: r(32), t: r(36), s: r(44) }).replace(/-/g, '+')}`, 'a JWT or tunnel token'],
      [`${'npm_'}${r(36)}`, 'an npm token'],
      [`CLOUDFLARE${'_API_TOKEN'}=${r(40)}`, 'a Cloudflare API token'],
    ];
    for (const [line, kind] of cases) assert.equal(secretIn('x.txt', line), kind, line.slice(0, 20));
    for (const ok of ['NUWORQ_GITHUB_CLIENT_SECRET=…', 'NUWORQ_TURNSTILE_SECRET=$SECRET', 'TOKEN=<your token>']) assert.equal(secretIn('x.txt', ok), null, ok);
  });

  test('long random-looking strings count; hashes, alphabets, fingerprints, paths and public keys do not', () => {
    // r() draws from only 8 characters; these look random, and are the same every run.
    const rand = (seed, n = 42) => createHash('sha512').update(seed).digest('base64url').slice(0, n);
    assert.equal(secretIn('config.js', `const key = '${rand('one')}';`), 'a high-entropy string');
    assert.ok(highEntropy(`api_key: "${rand('two')}"`));
    for (const line of [
      `commit ${'0123456789abcdef'.repeat(2)}0123abcd`,
      "const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';",
      `#   SHA256:${rand('fingerprint', 43)}`,
      'see src/very-long-module-name/and-another-path/file-name-here.js',
      '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk">',
    ]) assert.equal(highEntropy(line), null, line.slice(0, 30));
    assert.equal(secretIn('release-key.pub', `MCowBQYDK2VwAyEA${rand('pub', 28)}`), null);
    assert.equal(nameIn('docs/.env.sample'), null);
  });
});
