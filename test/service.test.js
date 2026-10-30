import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { launchdPlist, systemdUnit, install, uninstall, serviceEnv, serviceArgs, LABEL, UNIT } from '../src/service.js';
import { cleanWorktree } from '../src/runner.js';

const command = ['/usr/local/bin/node', '/opt/nuworq/bin/nuworq.js', 'run', '--workers', '3', '--agent', 'claude', '--model', 'opus & "friends" 100%$'];
const env = { HOME: '/Users/ann', NUWORQ_URL: 'https://hub.example.com', PATH: '/usr/bin:/bin' };

describe('nuworq run --install (#172)', () => {
  test('the LaunchAgent: the run command and its flags, starts at load, kept alive, output to the log', () => {
    const p = launchdPlist({ command, env, log: '/Users/ann/.nuworq/logs/run.log' });
    assert.match(p, new RegExp(`<key>Label</key>\\s*<string>${LABEL}</string>`));
    assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(p, /<key>KeepAlive<\/key>\s*<true\/>/);
    assert.match(p, /<key>StandardOutPath<\/key>\s*<string>\/Users\/ann\/\.nuworq\/logs\/run\.log<\/string>/);
    assert.match(p, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/ann\/\.nuworq\/logs\/run\.log<\/string>/);
    const args = [...p.matchAll(/^ {4}<string>(.*)<\/string>$/gm)].map((m) => m[1]);
    assert.deepEqual(args.slice(0, command.length), [...command.slice(0, -1), 'opus &amp; &quot;friends&quot; 100%$'], 'every argument, XML-escaped');
    assert.match(p, /<key>NUWORQ_URL<\/key>\s*<string>https:\/\/hub\.example\.com<\/string>/);
  });

  test('the systemd user unit: the run command, restarted always, started for the user, output to the log', () => {
    const u = systemdUnit({ command, env, log: '/home/ann/.nuworq/logs/run.log' });
    assert.match(u, /^ExecStart="\/usr\/local\/bin\/node" "\/opt\/nuworq\/bin\/nuworq\.js" "run" "--workers" "3" "--agent" "claude" "--model" "opus & \\"friends\\" 100%%\$\$"$/m);
    assert.match(u, /^Restart=always$/m);
    assert.match(u, /^Environment="NUWORQ_URL=https:\/\/hub\.example\.com"$/m);
    assert.match(u, /^StandardOutput=append:\/home\/ann\/\.nuworq\/logs\/run\.log$/m);
    assert.match(u, /^WantedBy=default\.target$/m);
  });

  test('install writes the definition (0600) and loads it, replacing one already there; uninstall stops and removes it', async () => {
    for (const [platform, file, load, unload] of [
      ['darwin', join('Library', 'LaunchAgents', `${LABEL}.plist`), [['launchctl', 'bootstrap', 'gui/501']], [['launchctl', 'bootout', `gui/501/${LABEL}`]]],
      ['linux', join('.config', 'systemd', 'user', UNIT), [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', UNIT]], [['systemctl', '--user', 'disable', '--now', UNIT]]],
    ]) {
      const home = mkdtempSync(join(tmpdir(), 'nuworq-svc-'));
      const ran = [];
      const exec = async (cmd, args) => { ran.push([cmd, ...args]); if (args.includes('bootout') || args.includes('disable')) throw new Error('not loaded'); };
      const log = join(home, '.nuworq', 'logs', 'run.log');
      const r = await install({ platform, home, uid: 501, command, env, log, exec });
      assert.equal(r.file, join(home, file));
      assert.equal(statSync(r.file).mode & 0o777, 0o600, platform);
      assert.match(readFileSync(r.file, 'utf8'), /--workers/);
      assert.equal(r.uninstall, '/usr/local/bin/node /opt/nuworq/bin/nuworq.js run --uninstall');
      // The old one is unloaded first (an error there is fine), then the new one loaded.
      assert.deepEqual(ran.slice(0, unload.length), unload, platform);
      assert.deepEqual(ran.slice(unload.length).map((c) => c.slice(0, load[0].length)), load.map((c) => c.slice(0, load[0].length)), platform);
      // Installing again replaces it.
      await install({ platform, home, uid: 501, command: [...command.slice(0, 3), '--workers', '1'], env, log, exec });
      assert.doesNotMatch(readFileSync(r.file, 'utf8'), /claude/);
      ran.length = 0;
      const gone = await uninstall({ platform, home, uid: 501, exec });
      assert.equal(gone.removed, true);
      assert.equal(existsSync(r.file), false);
      assert.deepEqual(ran[0], unload[0]);
      assert.equal((await uninstall({ platform, home, uid: 501, exec })).removed, false, 'nothing to remove');
    }
    await assert.rejects(install({ platform: 'win32', home: tmpdir(), uid: 0, command, env, log: 'x', exec: async () => {} }), /macOS \(launchd\) and Linux \(systemd\)/);
  });

  test('a load that fails is an error, not a silent success', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nuworq-svc-'));
    const exec = async (cmd, args) => { if (args[0] === 'bootstrap') throw new Error('Bootstrap failed: 5: Input/output error'); };
    await assert.rejects(install({ platform: 'darwin', home, uid: 501, command, env, log: join(home, 'run.log'), exec }), /Bootstrap failed/);
  });

  test('the flags it keeps, the ones it refuses, and the environment it carries', () => {
    assert.deepEqual(serviceArgs(['--workers', '2', '--install', '--agent', 'codex']), ['--workers', '2', '--agent', 'codex']);
    assert.throws(() => serviceArgs(['--install', '--until-idle']), /--until-idle makes run exit/);
    assert.throws(() => serviceArgs(['--install', '--max-runs=3']), /--max-runs makes run exit/);
    assert.deepEqual(serviceEnv({ PATH: '/bin', HOME: '/h', NUWORQ_TOKEN: 't', TRELLIS_URL: 'u', SECRET: 'no', SHELL: '/bin/zsh' }), { HOME: '/h', NUWORQ_TOKEN: 't', PATH: '/bin', TRELLIS_URL: 'u' });
  });
});

describe("a worker's worktree goes when it exits (#172)", () => {
  const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const git = async (args) => (await promisify(execFile)('git', args)).stdout;
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-wt-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
    return dir;
  }
  const add = (dir, name) => { const wt = `${dir}.worktrees/${name}`; sh(dir, 'worktree', 'add', '-q', '--detach', wt, 'main'); return wt; };

  test('a clean worktree is removed', async () => {
    const dir = repo();
    const wt = add(dir, 'w1');
    assert.deepEqual(await cleanWorktree(wt, git), { kept: false });
    assert.equal(existsSync(wt), false);
    assert.doesNotMatch(sh(dir, 'worktree', 'list'), /\.worktrees\/w1/);
  });

  test('one with committed work on a branch is removed; the branch stays', async () => {
    const dir = repo();
    const wt = add(dir, 'w2');
    sh(wt, 'switch', '-q', '-c', 'nuworq/1-thing');
    sh(wt, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'work');
    assert.deepEqual(await cleanWorktree(wt, git), { kept: false });
    assert.match(sh(dir, 'branch', '--list', 'nuworq/1-thing'), /nuworq\/1-thing/);
  });

  test('a dirty worktree is kept, and so is one with commits on no branch', async () => {
    const dir = repo();
    const dirty = add(dir, 'w3');
    writeFileSync(join(dirty, 'half-done.txt'), 'x');
    assert.deepEqual(await cleanWorktree(dirty, git), { kept: true, why: 'it has uncommitted changes' });
    assert.equal(existsSync(dirty), true);
    const loose = add(dir, 'w4');
    sh(loose, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'detached work');
    assert.deepEqual(await cleanWorktree(loose, git), { kept: true, why: 'it has commits that are on no branch' });
    assert.equal(existsSync(loose), true);
  });
});
