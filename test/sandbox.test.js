import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { sandboxSettings } from '../src/sandbox.js';

// What a worker's sandbox lets it write (#472): never what an unsandboxed git later runs or reads its settings from.
const home = '/work/api';
const worktree = '/work/api.worktrees/claude-1a2b';
const inside = (p, dirs) => dirs.some((d) => p === d || p.startsWith(d + sep));
// What git runs or configures itself from, in the checkout's .git and the worker's own worktree.
const DANGER = [
  join(home, '.git', 'hooks', 'pre-commit'), join(home, '.git', 'hooks', 'reference-transaction'), join(home, '.git', 'config'),
  join(home, '.git', 'config.worktree'), join(home, '.git', 'modules', 'lib', 'hooks', 'post-checkout'), join(home, '.git', 'modules', 'lib', 'config'),
  join(home, '.git', 'info', 'attributes'), join(home, '.git', 'worktrees', 'claude-1a2b', 'config.worktree'), join(worktree, '.git'),
];

describe("a worker's sandbox never lets it write git's hooks or config (#472)", () => {
  for (const landsHere of [false, true]) {
    test(landsHere ? 'landing in the checkout itself: all of it but those' : 'landing through origin: only what commits need', () => {
      const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree, landsHere });
      // Each one is either never allowed, or denied outright (a deny holds inside an allowed folder).
      for (const p of DANGER) assert.ok(!inside(p, filesystem.allowWrite) || inside(p, filesystem.denyWrite), p);
      for (const p of DANGER.filter((x) => inside(x, filesystem.allowWrite))) assert.ok(inside(p, filesystem.denyWrite), `${p} is denied`);
      // What a commit, a fetch and a rebase in its worktree write.
      for (const p of ['objects/ab/cdef', 'refs/heads/nuworq/12-x', 'refs/remotes/origin/main', 'logs/refs/heads/nuworq/12-x', 'packed-refs', 'worktrees/claude-1a2b/index', 'worktrees/claude-1a2b/HEAD', 'worktrees/claude-1a2b/rebase-merge/done']) {
        const at = join(home, '.git', p);
        assert.ok(inside(at, filesystem.allowWrite) && !inside(at, filesystem.denyWrite), p);
      }
      if (!landsHere) {
        assert.ok(!inside(join(home, 'src', 'a.js'), filesystem.allowWrite), 'not the checkout');
        assert.ok(!inside(join(home, '.git', 'worktrees', 'claude-9f9f', 'HEAD'), filesystem.allowWrite), "not another worker's worktree");
      } else assert.ok(inside(join(home, 'src', 'a.js'), filesystem.allowWrite), 'the checkout, to fast-forward it');
      // Exact paths only: Linux's sandbox takes no glob but a trailing /**.
      for (const p of [...filesystem.allowWrite, ...filesystem.denyWrite]) assert.doesNotMatch(p, /[*?[]/, p);
    });
  }

  test('without a worktree of its own (--here), the checkout\'s hooks and config are still denied', () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree: null, landsHere: true });
    for (const p of ['hooks', 'config', 'modules', 'info']) assert.ok(filesystem.denyWrite.includes(join(home, '.git', p)), p);
  });
});
