import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sandboxSettings, filePermissions } from '../src/sandbox.js';

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

  test("its git reads the worker's own token file, and nothing else of ~/.nuworq", () => {
    const tokenFile = join('/home/me', '.nuworq', 'tokens', 'claude-1a2b.token');
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree, tokenFile });
    assert.ok(filesystem.denyRead.includes('~/.nuworq'));
    assert.deepEqual(filesystem.allowRead, [tokenFile], 'one file: the narrower path re-opens it');
    assert.equal(sandboxSettings({ hub: 'https://hub.example', home, worktree }).filesystem.allowRead, undefined, 'no token, nothing re-opened');
  });

  test("its shell doesn't read Claude Code's or opencode's own logins (#580, #581)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    for (const p of ['~/.claude/.credentials.json', '~/.config/opencode', '~/.local/share/opencode', '~/.pi/agent']) assert.ok(filesystem.denyRead.includes(p), p);
  });

  test("DENY_READ covers each harness's and toolchain's stored credentials (#616)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const files = filePermissions({ home, worktree });
    for (const p of ['~/.codex', '~/.claude.json', '~/.config/git/credentials', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.gem/credentials',
      '~/.terraform.d', '~/.yarnrc.yml', '~/.bash_history', '~/.zsh_history', '~/.local/share/fish', '~/Library/Keychains',
      '~/Library/Application Support/Google/Chrome', '~/Library/Application Support/Firefox', '~/Library/Safari', '~/.mozilla', '~/.config/google-chrome']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(files.deny.includes(`Read(${p})`) && files.deny.includes(`Read(${p}/**)`), `the file tools: ${p}`);
    }
  });

  test('without a worktree of its own (--here), the checkout\'s hooks and config are still denied', () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree: null, landsHere: true });
    for (const p of ['hooks', 'config', 'modules', 'info']) assert.ok(filesystem.denyWrite.includes(join(home, '.git', p)), p);
  });
});

// #606: on a project without an origin a worker may write the whole checkout, so what an unsandboxed tool later reads
// there is denied by name: other workers' git metadata, and the agent settings an operator or the next worker starts with.
describe("a worker can't write another worker's git metadata or the checkout's agent settings (#606)", () => {
  const real = mkdtempSync(join(tmpdir(), 'nuworq-606-'));
  const co = join(real, 'api'), own = join(real, 'api.worktrees', 'claude-1a2b');
  for (const n of ['claude-1a2b', 'claude-9f9f', 'pi-77']) mkdirSync(join(co, '.git', 'worktrees', n), { recursive: true });
  const theirs = ['claude-9f9f', 'pi-77'].flatMap((n) => ['commondir', 'gitdir', 'config.worktree', 'HEAD'].map((f) => join(co, '.git', 'worktrees', n, f)));
  const settings = [co, own].flatMap((d) => [join(d, '.claude', 'settings.local.json'), join(d, '.claude', 'settings.json'), join(d, '.envrc'), join(d, '.vscode', 'tasks.json')]);

  test('the sandbox denies them, and still lets it commit in its own worktree and land in the checkout', () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home: co, worktree: own, landsHere: true });
    for (const p of [...theirs, ...settings]) assert.ok(inside(p, filesystem.denyWrite), p);
    for (const f of ['commondir', 'gitdir', 'config.worktree']) assert.ok(inside(join(co, '.git', 'worktrees', 'claude-1a2b', f), filesystem.denyWrite), `its own ${f}`);
    for (const f of ['HEAD', 'index', 'rebase-merge/done']) assert.ok(!inside(join(co, '.git', 'worktrees', 'claude-1a2b', f), filesystem.denyWrite), `its own ${f} stays writable`);
    assert.ok(inside(join(co, 'src', 'a.js'), filesystem.allowWrite) && !inside(join(co, 'src', 'a.js'), filesystem.denyWrite), 'the checkout, to land');
    for (const p of [...filesystem.allowWrite, ...filesystem.denyWrite]) assert.doesNotMatch(p, /[*?[]/, p);
    // Landing through origin, the others' folders were never writable; the agent settings are denied all the same.
    const through = sandboxSettings({ hub: 'https://hub.example', home: co, worktree: own }).filesystem;
    for (const p of theirs) assert.ok(!inside(p, through.allowWrite), p);
    for (const p of settings) assert.ok(inside(p, through.denyWrite), p);
  });

  test('its file tools are denied the same', () => {
    const perms = filePermissions({ home: co, worktree: own, landsHere: true });
    for (const p of [...theirs, ...settings]) for (const tool of ['Edit', 'Write']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
    assert.ok(may(perms, 'Edit', join(co, 'src', 'a.js')) && may(perms, 'Edit', join(own, 'src', 'a.js')), 'its work stays editable');
  });
});

// What Claude Code's file tools may do (#472): the sandbox holds only for the shell, so permission rules say the same.
// A rule's path, as Claude Code reads it: //abs is absolute, ~/ the home folder, a trailing /** everything under it.
const me = '/home/me';
const matches = (r, tool, p) => {
  const m = r.match(/^(\w+)(?:\((.*)\))?$/);
  if (m[1] !== tool) return false;
  if (m[2] === undefined) return true;
  const at = m[2].startsWith('~/') ? join(me, m[2].slice(2)) : m[2].startsWith('//') ? m[2].slice(1) : null;
  assert.ok(at, `${r}: an absolute or home path`);
  return at.endsWith('/**') ? p.startsWith(at.slice(0, -2)) : p === at;
};
// Headless, nobody answers a prompt: only an allowed call that no deny matches goes through. Write answers to Edit
// rules (a Write(path) rule never matches), and a Read deny holds for edits too.
const may = ({ allow, deny }, tool, p) => {
  const as = tool === 'Write' ? 'Edit' : tool;
  const denied = deny.some((r) => matches(r, as, p) || (as === 'Edit' && matches(r, 'Read', p)));
  return !denied && allow.some((r) => matches(r, as, p) || (tool === 'Write' && r === 'Write'));
};

describe("a worker's file tools stay where its shell does (#472)", () => {
  for (const landsHere of [false, true]) {
    test(landsHere ? 'landing in the checkout itself' : 'landing through origin', () => {
      const perms = filePermissions({ home, worktree, landsHere });
      assert.ok(!perms.allow.some((r) => /^(Edit|Write)$/.test(r)), 'no bare Edit or Write');
      assert.ok(![...perms.allow, ...perms.deny].some((r) => /^(Write|Glob|NotebookEdit)\(/.test(r)), 'no path rule that never matches');
      for (const tool of ['Edit', 'Write']) {
        assert.ok(may(perms, tool, join(worktree, 'src', 'a.js')), `${tool} in its worktree`);
        assert.equal(may(perms, tool, join(home, 'src', 'a.js')), landsHere, `${tool} in the checkout only when work lands there`);
        for (const p of [join(me, 'zz-probe-write-tool.txt'), '/etc/hosts', join(me, '.ssh', 'authorized_keys'), join(me, '.nuworq', 'connect.json'), join(me, '.zshrc'), '/work/api.worktrees/claude-9f9f/a.js']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
        for (const p of DANGER) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
      }
      for (const tool of ['Read', 'Glob', 'Grep']) assert.ok(may(perms, tool, join(worktree, 'src', 'a.js')), tool);
      for (const p of [join(me, '.ssh', 'known_hosts'), join(me, '.ssh', 'id_ed25519'), join(me, '.nuworq', 'connect.json'), join(me, '.nuworq', 'tokens', 'claude-1a2b.token'), join(me, '.aws', 'credentials'), join(me, '.git-credentials'), join(me, '.config', 'gh', 'hosts.yml')]) {
        assert.ok(!may(perms, 'Read', p), `Read ${p}`);
      }
    });
  }

  test('without a worktree of its own (--here), it edits the checkout, all but its .git\'s hooks and config', () => {
    const perms = filePermissions({ home, worktree: null, landsHere: true });
    assert.ok(may(perms, 'Edit', join(home, 'src', 'a.js')));
    for (const p of ['hooks/pre-commit', 'config', 'info/attributes']) assert.ok(!may(perms, 'Write', join(home, '.git', p)), p);
  });

  test("its file tools don't read or edit Claude Code's or opencode's own logins (#580, #581)", () => {
    const perms = filePermissions({ home, worktree });
    for (const r of ['Read(~/.claude/.credentials.json)', 'Edit(~/.claude/.credentials.json)', 'Read(~/.config/opencode)', 'Read(~/.config/opencode/**)', 'Edit(~/.config/opencode)', 'Edit(~/.config/opencode/**)', 'Read(~/.local/share/opencode)', 'Read(~/.local/share/opencode/**)', 'Edit(~/.local/share/opencode)', 'Edit(~/.local/share/opencode/**)']) assert.ok(perms.deny.includes(r), r);
    for (const p of [join(me, '.claude', '.credentials.json'), join(me, '.config', 'opencode', 'opencode.json'), join(me, '.config', 'opencode', 'auth.json'), join(me, '.local', 'share', 'opencode', 'auth.json'), join(me, '.local', 'share', 'opencode', 'mcp-auth.json'), join(me, '.pi', 'agent', 'auth.json'), join(me, '.pi', 'agent', 'models.json')]) {
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
    }
    assert.ok(may(perms, 'Read', join(me, '.claude', 'settings.json')), 'the rest of ~/.claude stays readable');
    assert.ok(may(perms, 'Read', join(me, '.local', 'share', 'other', 'x')), 'the rest of ~/.local/share stays readable');
  });
});
