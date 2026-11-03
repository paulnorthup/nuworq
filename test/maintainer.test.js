// Nothing in the repository names its maintainer (#817): docs, help, screens and code say the maintainer, the
// owner, a person or you, and tests' people are generic. LICENSE's copyright line keeps the name, and the
// repository's address (github.com/<handle>/nuworq) keeps the handle.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The maintainer's first name and GitHub handle, built so this file doesn't hold them.
const NAME = ['pa', 'ul'].join('');
const HANDLE = NAME + 'northup';

// The `git grep -n` lines that still name the maintainer once the handle is taken out, LICENSE aside.
function mentions(lines) {
  const name = new RegExp(NAME, 'i');
  return lines.filter(Boolean).filter((l) => !/^LICENSE:/.test(l)).filter((l) => name.test(l.replaceAll(new RegExp(HANDLE, 'gi'), '')));
}

describe('the repository names roles, not its maintainer', () => {
  test('a planted mention is found; the handle and LICENSE are not', () => {
    assert.deepEqual(mentions([`docs/x.md:1:Ask ${NAME[0].toUpperCase()}${NAME.slice(1)} first`, `src/y.js:2:as${NAME.toUpperCase()}()`]).length, 2);
    assert.deepEqual(mentions([`README.md:3:github.com/${HANDLE}/nuworq`, `LICENSE:3:Copyright (c) 2026 ${NAME}`, '']), []);
  });

  test('no tracked file other than LICENSE mentions the maintainer by name', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-i', '-I', NAME], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      if (e.status !== 1) throw e; // 1: nothing found
    }
    assert.deepEqual(mentions(out.split('\n')), [], 'write the maintainer, the owner, a person or you; a test fixture person is a generic name');
  });
});
