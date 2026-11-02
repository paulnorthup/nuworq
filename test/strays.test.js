// The repository holds no stray test logs (#635): #550 and #564 each landed a full run's .test-N.txt in the root,
// and one on main stops other worktrees' rebases ("untracked working tree files would be overwritten").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the repository holds no stray test logs (#635)', () => {
  test('no .test-*.txt is tracked, and .gitignore keeps them out', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
    assert.deepEqual(tracked.filter((f) => /(^|\/)\.test-[^/]*\.txt$/.test(f)), [], 'write test logs outside the repository, e.g. /tmp/<you>-test.txt');
    assert.ok(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').includes('.test-*.txt'));
  });
});
