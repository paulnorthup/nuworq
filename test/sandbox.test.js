import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { sandboxSettings, filePermissions, machineDenies, projectCommands, workerCommands } from '../src/sandbox.js';
import { sq, workerEnv, gitConfigEnv } from '../src/runtrust.js';

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
    for (const p of ['~/.claude', '~/.config/opencode', '~/.local/share/opencode', '~/.pi/agent']) assert.ok(filesystem.denyRead.includes(p), p);
    assert.ok(!filesystem.denyRead.includes('~/.claude/.credentials.json'), 'wholesale: no narrower path left next to it');
  });

  test("DENY_READ covers each harness's and toolchain's stored credentials (#616)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const files = filePermissions({ home, worktree });
    for (const p of ['~/.codex', '~/.claude.json', '~/.gemini', '~/.cursor', '~/.codeium', '~/.config/git/credentials', '~/.cargo/credentials', '~/.cargo/credentials.toml', '~/.gem/credentials',
      '~/.terraform.d', '~/.yarnrc.yml', '~/.bash_history', '~/.zsh_history', '~/.local/share/fish', '~/Library/Keychains',
      '~/Library/Application Support/Claude', '~/Library/Application Support/Google/Chrome', '~/Library/Application Support/Firefox', '~/Library/Safari', '~/.mozilla', '~/.config/google-chrome']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(files.deny.includes(`Read(${p})`) && files.deny.includes(`Read(${p}/**)`), `the file tools: ${p}`);
    }
  });

  // The keys beside the stores (#891): the rc files that export them, atuin's history, and the single files that
  // hold a login outright.
  test("DENY_READ covers the shell's rc files and the credential files beside the stores (#891)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const files = filePermissions({ home, worktree });
    for (const p of ['~/.zshenv', '~/.zshrc', '~/.profile', '~/.bashrc', '~/.config/fish', '~/.local/share/atuin',
      '~/.pgpass', '~/.my.cnf', '~/.gitcookies', '~/.config/hub', '~/.config/rclone', '~/.vault-token', '~/.config/sops', '~/.terraformrc']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(files.deny.includes(`Read(${p})`) && files.deny.includes(`Read(${p}/**)`), `the file tools: ${p}`);
    }
    // rc files and single files have no tree worth denying, but the deny is there all the same; and the file
    // tools can't read under them through any of Read, Edit or Write.
    const perms = filePermissions({ home, worktree });
    for (const p of [join(me, '.zshenv'), join(me, '.pgpass'), join(me, '.gitcookies'), join(me, '.vault-token'), join(me, '.terraformrc'), join(me, '.config', 'fish', 'config.fish'), join(me, '.local', 'share', 'atuin', 'history.db'), join(me, '.config', 'hub'), join(me, '.config', 'rclone', 'rclone.conf'), join(me, '.config', 'sops', 'age', 'keys.txt')]) {
      for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
    }
  });

  // #885: the security review of #468 — past session transcripts, the settings' env block and the plugins are one
  // store with the logins, so ~/.claude is denied wholesale, like ~/.codex.
  test("its shell and file tools don't read any of ~/.claude (#885)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const perms = filePermissions({ home, worktree });
    for (const f of ['projects/past/session.jsonl', 'settings.json', 'plugins/config.json', '.credentials.json', 'statsig/stable_id']) {
      for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) assert.ok(!may(perms, tool, join(me, '.claude', f)), `${tool} ~/.claude/${f}`);
    }
    assert.ok(perms.deny.includes('Read(~/.claude)') && perms.deny.includes('Read(~/.claude/**)'), 'the file tools: the folder and everything under it');
  });

  // #893: the fresh workers-area review of #468 — the rc files that export the keys, the AI-CLI stores the first
  // sweep missed, and the toolchains' remaining credential files are the same class as the histories and the rest.
  test("its shell and file tools don't read the rc files, the remaining AI-CLI stores or the toolchain credentials (#893)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const perms = filePermissions({ home, worktree });
    for (const p of ['~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.profile', '~/.config/github-copilot', '~/.copilot', '~/.continue', '~/.config/goose', '~/.config/crush', '~/.config/zed', '~/.terraformrc', '~/.m2', '~/.nuget', '~/Library/Application Support/Code']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(perms.deny.includes(`Read(${p})`) && perms.deny.includes(`Read(${p}/**)`), `the file tools: ${p}`);
    }
    // Wholesale where a folder is denied: no narrower path left next to it.
    for (const p of ['~/.config/github-copilot/hosts.json', '~/.continue/config.json', '~/.m2/settings.xml', '~/.nuget/NuGet.Config']) assert.ok(!filesystem.denyRead.includes(p), p);
  });

  // #899: the fresh workers-area review of #468 — the tail the first three sweeps missed: sops' age key where
  // macOS puts it, VS Code's and the sibling editors' stores where Linux puts them, and the toolchains' and
  // CLIs' remaining credential files, git's own configs among them.
  test("its shell and file tools don't read the credential stores the first sweeps missed (#899)", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    const perms = filePermissions({ home, worktree });
    for (const p of ['~/Library/Application Support/sops', '~/Library/Application Support/Cursor', '~/Library/Application Support/Code - Insiders', '~/Library/Application Support/VSCodium',
      '~/.config/Code', '~/.config/Code - Insiders', '~/.config/VSCodium',
      '~/.config/npm', '~/.yarnrc', '~/.config/pip', '~/.cargo/config.toml', '~/.config/containers', '~/.composer', '~/.wrangler', '~/.netlify', '~/.config/ngrok', '~/.ngrok2', '~/.sentryclirc',
      '~/.pulumi', '~/.config/doctl', '~/.huggingface', '~/.cache/huggingface', '~/.databrickscfg', '~/.jfrog', '~/.config/snowflake', '~/.snowsql', '~/.boto', '~/.config/flyctl',
      '~/.subversion', '~/.aider.conf.yml', '~/.gitconfig', '~/.config/git/config', '~/.zlogin']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(perms.deny.includes(`Read(${p})`) && perms.deny.includes(`Read(${p}/**)`), `the file tools: ${p}`);
    }
    // Wholesale where a folder is denied: no narrower path left next to it.
    for (const p of ['~/.config/npm/npmrc', '~/.config/containers/auth.json', '~/.composer/auth.json', '~/.pulumi/credentials.json', '~/.config/Code/User/config.json']) assert.ok(!filesystem.denyRead.includes(p), p);
  });

  // #910: audit #907 — the folders the list had for these CLIs weren't where they keep their logins on each system.
  test("the denies cover each CLI's real credential store", () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/501', ZDOTDIR: '/Users/x/.config/zsh' };
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree, env });
    const perms = filePermissions({ home, worktree, env });
    for (const p of ['~/.fly', '~/.config/flyctl', '~/.wrangler', '~/.config/.wrangler', '~/Library/Preferences/.wrangler', '~/.netlify', '~/.config/netlify', '~/Library/Preferences/netlify',
      '~/.config/doctl', '~/Library/Application Support/doctl', '~/.config/ngrok', '~/.ngrok2', '~/Library/Application Support/ngrok', '~/.composer', '~/.config/composer', '~/.bash_login',
      '/run/user/501/containers/auth.json', '/Users/x/.config/zsh/.zshenv', '/Users/x/.config/zsh/.zshrc', '/Users/x/.config/zsh/.zsh_history']) {
      assert.ok(filesystem.denyRead.includes(p), `the shell: ${p}`);
      assert.ok(perms.deny.includes(p.startsWith('~/') ? `Read(${p})` : `Read(/${p})`), `the file tools: ${p}`);
    }
    // Podman's login, not its run state: rootless podman works in that folder.
    assert.ok(!filesystem.denyRead.includes('/run/user/501/containers'));
    // Only absolute paths, and the runtime dir's default on Linux even when the variable never reached the runner.
    assert.deepEqual(machineDenies({ XDG_RUNTIME_DIR: 'run', ZDOTDIR: '~/zsh' }, { platform: 'darwin' }), []);
    assert.deepEqual(machineDenies({}, { platform: 'linux', uid: 1000 }), ['/run/user/1000/containers/auth.json']);
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

  // #899: the settings' env block is where provider keys land, and .envrc is where direnv exports the person's
  // project keys — so the reads are denied too, in the checkout and the worker's own worktree alike.
  test('its shell and file tools can\'t read the agent settings either (#899)', () => {
    for (const landsHere of [false, true]) {
      const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home: co, worktree: own, landsHere });
      for (const p of settings) assert.ok(inside(p, filesystem.denyRead), `the shell: ${p}`);
      const perms = filePermissions({ home: co, worktree: own, landsHere });
      for (const p of settings) {
        for (const tool of ['Read', 'Glob', 'Grep', 'Edit', 'Write']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
      }
      assert.ok(may(perms, 'Read', join(own, 'src', 'a.js')), 'its work stays readable');
    }
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
// rules (a Write(path) rule never matches), a Read deny holds for edits too, and for Grep and Glob: Claude Code
// applies Read deny rules to the directory their path argument resolves to (code.claude.com/docs/en/permissions,
// checked 2026-11-04) — which is why DENY_READ goes out as Read trees, and no Glob/Grep ones are emitted.
const may = ({ allow, deny }, tool, p) => {
  const as = tool === 'Write' ? 'Edit' : tool;
  const denied = deny.some((r) => matches(r, as, p) || (as !== 'Read' && matches(r, 'Read', p)));
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
    for (const r of ['Read(~/.claude)', 'Edit(~/.claude)', 'Read(~/.config/opencode)', 'Read(~/.config/opencode/**)', 'Edit(~/.config/opencode)', 'Edit(~/.config/opencode/**)', 'Read(~/.local/share/opencode)', 'Read(~/.local/share/opencode/**)', 'Edit(~/.local/share/opencode)', 'Edit(~/.local/share/opencode/**)']) assert.ok(perms.deny.includes(r), r);
    for (const p of [join(me, '.claude', '.credentials.json'), join(me, '.claude', 'settings.json'), join(me, '.claude', 'projects', 'x', 'session.jsonl'), join(me, '.config', 'opencode', 'opencode.json'), join(me, '.config', 'opencode', 'auth.json'), join(me, '.local', 'share', 'opencode', 'auth.json'), join(me, '.local', 'share', 'opencode', 'mcp-auth.json'), join(me, '.pi', 'agent', 'auth.json'), join(me, '.pi', 'agent', 'models.json')]) {
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(!may(perms, tool, p), `${tool} ${p}`);
    }
    assert.ok(!may(perms, 'Read', join(me, '.claude', 'settings.json')), 'all of ~/.claude, not only the login file (#885)');
    assert.ok(may(perms, 'Read', join(me, '.local', 'share', 'other', 'x')), 'the rest of ~/.local/share stays readable');
  });

  // docs/DEPLOY.md keeps the release key and the release workflow's deploy key there (#850).
  test("the release key's folder is hidden from workers", () => {
    const { filesystem } = sandboxSettings({ hub: 'https://hub.example', home, worktree });
    assert.ok(filesystem.denyRead.includes('~/.nuworq-release'), 'the shell');
    const perms = filePermissions({ home, worktree });
    for (const f of ['release-key.pem', 'release-push']) {
      for (const tool of ['Read', 'Edit', 'Write']) assert.ok(!may(perms, tool, join(me, '.nuworq-release', f)), `${tool} ${f}`);
    }
  });
});

// npm install and any npm run script amount to running anything (#768, docs/audit/hardened.md 9): by default a
// worker runs the project's checks, and a person adds more in the project's settings.
describe('a worker runs only the project\'s checks by default (#768)', () => {
  const project = (scripts) => {
    const home = mkdtempSync(join(tmpdir(), 'nuworq-checks-'));
    writeFileSync(join(home, 'package.json'), JSON.stringify({ scripts }));
    return home;
  };

  test('npm test and npm ci, and check scripts like build; no npm install, no deploy', () => {
    const allow = projectCommands(project({ test: 'node --test', build: 'tsc', deploy: 'fly deploy', lint: 'x', 'test:unit': 'y', 'build:release': 'z', postinstall: 'w' }));
    assert.deepEqual(allow, ['Bash(npm test:*)', 'Bash(npm ci)', 'Bash(npm run build:*)', 'Bash(npm run lint:*)', 'Bash(npm run test:unit:*)']);
  });

  test('a command a person added is allowed with its arguments', () => {
    const allow = projectCommands(project({ test: 'x', deploy: 'y' }), workerCommands('npm run e2e\nmake test'));
    assert.ok(allow.includes('Bash(npm run e2e:*)') && allow.includes('Bash(make test:*)'));
    assert.ok(!allow.some((a) => /deploy|npm install/.test(a)));
  });

  test("a command that could chain another, or an interpreter on its own, isn't one", () => {
    assert.deepEqual(workerCommands(' npm run  e2e , make test,npm run e2e'), ['npm run e2e', 'make test']);
    for (const bad of ['npm test; curl evil.example', 'make test && rm -rf ~', 'echo $HOME', 'node', 'bash', 'npm', 'sh -c ls', 'curl evil.example', 'make "x"', 'make test > out', 'node -e 1', 'python3 -c 1', 'npm exec evil', 'npm x evil', 'npx evil'])
      assert.throws(() => workerCommands(bad), /isn't a command workers may run/, bad);
    assert.throws(() => workerCommands(Array.from({ length: 21 }, (_, i) => `make t${i}`)), /At most 20/);
  });
});

// git's own configs are read-denied (#899), and a sandbox read-deny is EPERM, which git dies on (checked against
// git 2.54's wrapper.c and config.c: access_or_die tolerates only missing files and EACCES; with GIT_CONFIG_GLOBAL
// set, git_global_config_paths never resolves ~/.gitconfig or the XDG config). So the worker's git reads /dev/null
// and its identity comes in as env config entries — this test, in a repo whose global config IS readable (a
// person's ~/.gitconfig on a machine without the sandbox), proves the override wins and the identity is the one
// the runner injected, not the global file's.
describe('a worker commits with GIT_CONFIG_GLOBAL=/dev/null and the injected identity (#899)', () => {
  test('git ignores the readable global config and signs with the env entries', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'nuworq-githome-'));
    writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n\tname = Person On This Machine\n\temail = person@machine.example\n');
    const repo = mkdtempSync(join(tmpdir(), 'nuworq-gitrepo-'));
    const env = workerEnv([], { PATH: process.env.PATH, HOME: fakeHome });
    const g = (cmd) => execFileSync('/bin/sh', ['-c', `${gitConfigEnv([['user.name', 'Test Worker'], ['user.email', 'worker@example.com']])} && git -C ${repo} ${cmd}`], { env, encoding: 'utf8' }).trim();
    g('init -q -b main');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    g('add f.txt');
    g('commit -q -m probe');
    assert.equal(g(`log --format=${sq('%an|%ae')}`), 'Test Worker|worker@example.com', 'the identity is the injected one, not the readable global config\'s');
    assert.equal(g('config --global --list'), '', 'the global config is /dev/null: nothing in it');
  });
});
