import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo } from '../src/server.js';
import { buildPackage, commitOf, ownCheckout } from '../src/package.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
// A fresh repository with an origin and one commit: { dir, head }.
const repo = (origin) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-owncommit-')));
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', origin);
  writeFileSync(join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
};
const RELEASE = 'bf34a25'.padEnd(40, '0');

// An installed nuworq names its own commit, even inside another git repository such as Homebrew's (#511).
describe("an installed nuworq names its own commit, never an enclosing repository's", () => {
  test("inside Homebrew's clone: src/commit.txt's commit, linked on nuworq's repository, no source, nothing to package", async () => {
    const brew = repo('https://github.com/Homebrew/brew');
    const at = join(brew.dir, 'lib', 'node_modules', 'nuworq');
    mkdirSync(join(at, 'src'), { recursive: true });
    copyFileSync(join(ROOT, 'package.json'), join(at, 'package.json'));
    writeFileSync(join(at, 'src', 'commit.txt'), `${RELEASE} 1761980000\n`);

    assert.equal(ownCheckout(at), false, 'inside a repository is not a checkout of its own');
    const b = buildInfo(at);
    assert.equal(b.commit, 'bf34a25');
    assert.equal(b.commit_url, `https://github.com/paulnorthup/nuworq/commit/${RELEASE}`);
    assert.equal(b.source, null);
    assert.doesNotMatch(JSON.stringify(b), /homebrew|brew/i);
    assert.equal(commitOf(at), null);
    assert.equal(await buildPackage(at, join(brew.dir, 'cache')), null, "never packages Homebrew's files");
  });

  test('no commit.txt and no repository named: no commit and no link', () => {
    const outer = repo('https://github.com/someone/dotfiles');
    const at = join(outer.dir, 'tools', 'nuworq');
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'package.json'), '{"name":"nuworq","version":"9.9.9"}\n');
    assert.deepEqual(buildInfo(at), { version: '9.9.9', commit: null, commit_url: null, source: null });
  });

  test('a checkout of its own still reports its HEAD, linked on its origin', () => {
    const own = repo('git@github.com:acme/nuworq-fork.git');
    copyFileSync(join(ROOT, 'package.json'), join(own.dir, 'package.json'));
    assert.equal(ownCheckout(own.dir), true);
    assert.equal(commitOf(own.dir), own.head);
    const b = buildInfo(own.dir);
    assert.equal(b.commit, own.head.slice(0, 7));
    assert.equal(b.commit_url, `https://github.com/acme/nuworq-fork/commit/${own.head}`);
    assert.equal(b.source, 'github.com/acme/nuworq-fork');
    assert.equal(commitOf(ROOT), git(ROOT, 'rev-parse', 'HEAD'), "this repository's own checkout too");
  });
});
