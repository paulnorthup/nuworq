import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scan, secretIn } from '../scripts/scan-history.js';

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
    assert.match(stdout, /No secrets in 2 added lines across every ref/);
  });
});
