// nuworq up (#559): what it does is planned from data, and the commands that open terminals are built without running.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/core.js';
import { projectList, liveOperators } from '../src/insight.js';
import { launchdPlist, systemdUnit } from '../src/service.js';
import { upPlan, readService, autoArgs, launcherFor, launchCommands, operatorShell, appleString, upTable } from '../src/up.js';

const NODE = '/opt/homebrew/bin/node', BIN = '/usr/local/lib/node_modules/nuworq/bin/nuworq.js';
const auto = { supported: true, args: ['--workers', 'auto'], cwd: '/src/nuworq', up: true };

// 2026-11-01 after a restart: one runner without auto, an operator only on nuworq, cancer-hub parked.
const day = () => [
  { slug: 'cancer-hub', name: 'cancer-hub', parked: true, runner: false, operators: [] },
  { slug: 'llm-proxy', name: 'llm-proxy', parked: false, runner: true, operators: [] },
  { slug: 'nuworq', name: 'nuworq', parked: false, runner: true, operators: [{ name: 'claude-code-9ccc', machine: 'Pauls-MacBook-Pro' }] },
  { slug: 'nuworq-site', name: 'nuworq-site', parked: false, runner: false, operators: [] },
];
const clones = { 'cancer-hub': { folder: '/src/cancer-hub' }, 'llm-proxy': { folder: '/src/llm-proxy' }, nuworq: { folder: '/src/nuworq' }, 'nuworq-site': { folder: '/src/nuworq-site' } };

describe('the runner', () => {
  test("its service file is read back, launchd's and systemd's, with its folder", () => {
    const command = [NODE, BIN, 'run', '--workers', '2', '--agent', 'claude'];
    for (const [platform, text] of [['darwin', launchdPlist({ command, log: '/l', cwd: '/src/a & b' })], ['linux', systemdUnit({ command, log: '/l', cwd: '/src/50%' })]]) {
      const r = readService(text, platform);
      assert.deepEqual(r.args, ['--workers', '2', '--agent', 'claude'], platform);
      assert.equal(r.cwd, platform === 'darwin' ? '/src/a & b' : '/src/50%');
    }
    assert.equal(readService('', 'darwin'), null);
    assert.equal(readService('<plist/>', 'darwin'), null);
  });

  test('--workers auto replaces any --workers, and keeps the rest', () => {
    assert.deepEqual(autoArgs(['--workers', '3', '--agent', 'codex']), ['--agent', 'codex', '--workers', 'auto']);
    assert.deepEqual(autoArgs(['--workers=1']), ['--workers', 'auto']);
    assert.deepEqual(autoArgs([]), ['--workers', 'auto']);
  });

  test('installed when there is none, restarted when its flags differ or it is down, else left alone', () => {
    const at = (runner) => upPlan({ projects: [], runner }).runner;
    assert.equal(at({ supported: true, args: null }).action, 'install');
    assert.deepEqual(at({ supported: true, args: null }).args, ['--workers', 'auto']);
    const differ = at({ supported: true, args: ['--workers', '2'], cwd: '/src/x', up: true });
    assert.deepEqual([differ.action, differ.args, differ.cwd], ['restart', ['--workers', 'auto'], '/src/x']);
    assert.match(differ.why, /--workers 2/);
    assert.deepEqual([at({ ...auto, up: false }).action, at({ ...auto, up: false }).why], ['restart', "it isn't running"]);
    assert.equal(at(auto).action, 'keep');
    assert.equal(at({ supported: false }).action, 'none');
  });
});

describe('staffing and operators', () => {
  test("2026-11-01: operators for llm-proxy and nuworq-site, none for parked cancer-hub, nuworq's kept", () => {
    const plan = upPlan({ projects: day(), clones, runner: { supported: true, args: ['--workers', '1'], up: true } });
    const op = Object.fromEntries(plan.rows.map((r) => [r.slug, r.operator]));
    assert.deepEqual(op['cancer-hub'], { state: 'skip', why: 'parked' });
    assert.deepEqual(op['llm-proxy'], { state: 'start', folder: '/src/llm-proxy' });
    assert.deepEqual(op['nuworq-site'], { state: 'start', folder: '/src/nuworq-site' });
    assert.deepEqual(op.nuworq, { state: 'running', why: 'claude-code-9ccc on Pauls-MacBook-Pro' });
    assert.deepEqual(plan.staff.map((p) => p.slug), ['nuworq-site'], 'only unparked, unstaffed projects are asked about');
    assert.equal(plan.runner.action, 'restart');
  });

  test('a second run starts nothing: the operators it started run here, even before they check in', () => {
    const plan = upPlan({ projects: day(), clones, local: { 'llm-proxy': true, 'nuworq-site': true }, declined: ['nuworq-site'], runner: auto });
    assert.deepEqual(plan.rows.filter((r) => r.operator.state === 'start'), []);
    assert.deepEqual(plan.staff, [], 'a no is remembered');
    assert.equal(plan.runner.action, 'keep');
    assert.equal(plan.rows.find((r) => r.slug === 'llm-proxy').operator.why, 'started here');
  });

  test('no clone here: skipped, saying where to clone; a parked project that still has an operator is named', () => {
    const projects = day();
    projects[0].operators = [{ name: 'op-old', machine: null }];
    const plan = upPlan({ projects, clones: { ...clones, 'llm-proxy': { hint: 'git clone github.com/p/llm-proxy /src/llm-proxy' } }, runner: auto });
    const op = Object.fromEntries(plan.rows.map((r) => [r.slug, r.operator]));
    assert.deepEqual(op['llm-proxy'], { state: 'skip', why: 'no clone here: git clone github.com/p/llm-proxy /src/llm-proxy' });
    assert.equal(op['cancer-hub'].state, 'running');
    assert.match(op['cancer-hub'].why, /op-old; cancer-hub is parked, so stop it/);
  });

  test('the table: each project, parked, staffed, its operator, then the runner', () => {
    const plan = upPlan({ projects: day(), clones, runner: auto });
    const t = upTable(plan, { dryRun: true });
    assert.match(t, /^Project\s+Parked\s+Staffed\s+Operator$/m);
    assert.match(t, /^cancer-hub\s+yes\s+no\s+skipped \(parked\)$/m);
    assert.match(t, /^llm-proxy\s+no\s+yes\s+would start \(\/src\/llm-proxy\)$/m);
    assert.match(t, /^nuworq\s+no\s+yes\s+running \(claude-code-9ccc on Pauls-MacBook-Pro\)$/m);
    assert.match(t, /Runner: workers auto, running$/);
    plan.rows[1].operator = { state: 'started', why: 'tmux window nuworq:llm-proxy' };
    assert.match(upTable(plan), /^llm-proxy\s+no\s+yes\s+started \(tmux window nuworq:llm-proxy\)$/m);
  });
});

describe('opening terminals', () => {
  const shell = operatorShell({ folder: "/src/it's", pidFile: '/h/.nuworq/operators/x.pid', settings: '{"a":1}', line: '/nuworq:operator' });

  test('one operator: in its folder, its pid written, claude exec’d with its settings and the line', () => {
    assert.equal(shell, `cd '/src/it'\\''s' && echo $$ > '/h/.nuworq/operators/x.pid' && exec claude --settings '{"a":1}' '/nuworq:operator'`);
  });

  test('tmux when installed, else iTerm or Terminal on a Mac, else print', () => {
    assert.equal(launcherFor({ tmux: true, platform: 'linux' }), 'tmux');
    assert.equal(launcherFor({ platform: 'darwin', iterm: true }), 'iterm');
    assert.equal(launcherFor({ platform: 'darwin' }), 'terminal');
    assert.equal(launcherFor({ platform: 'linux' }), 'print');
  });

  test('tmux: the nuworq session made by the first window, one window per project; or windows in the session there', () => {
    const ws = [{ name: 'a', folder: '/src/a', shell: 'sh-a' }, { name: 'b', folder: '/src/b', shell: 'sh-b' }];
    assert.deepEqual(launchCommands('tmux', ws), [
      ['tmux', 'new-session', '-d', '-s', 'nuworq', '-n', 'a', '-c', '/src/a', 'sh-a'],
      ['tmux', 'new-window', '-d', '-t', 'nuworq:', '-n', 'b', '-c', '/src/b', 'sh-b'],
    ]);
    assert.equal(launchCommands('tmux', ws, { exists: true })[0][1], 'new-window');
    assert.deepEqual(launchCommands('print', ws), []);
  });

  test('Terminal and iTerm through osascript, the line quoted as an AppleScript string', () => {
    assert.equal(appleString('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"');
    const [t] = launchCommands('terminal', [{ name: 'a', folder: '/a', shell }]);
    assert.deepEqual(t.slice(0, 2), ['osascript', '-e']);
    assert.equal(t[2], `tell application "Terminal" to do script ${appleString(shell)}`);
    const [i] = launchCommands('iterm', [{ name: 'a', folder: '/a', shell }]);
    assert.match(i[2], /^tell application "iTerm"\n {2}set w to \(create window with default profile\)\n {2}tell current session of w to write text "cd /);
  });
});

describe('the hub says which operators each project has', () => {
  test('operators checked in and not signed off, in the project list; workers and signed-off sessions are not', () => {
    const hub = new Hub();
    hub.project('acme', { create: true });
    hub.agentOp('acme', 'checkin', 'op-1', { has: ['operator'], machine: 'mac' });
    hub.agentOp('acme', 'checkin', 'op-2', { has: ['operator'] });
    hub.agentOp('acme', 'checkin', 'w-1', {});
    hub.agentOp('acme', 'signoff', 'op-2', { headline: 'done' });
    const [line] = projectList(hub);
    assert.deepEqual(line.operators.map((o) => [o.name, o.machine]), [['op-1', 'mac']]);
    // A day without being seen: no longer counted.
    const p = hub.project('acme');
    hub.q('UPDATE agents SET last_seen = ? WHERE name = ?').run(hub.now() - 25 * 3600_000, 'op-1');
    assert.deepEqual(liveOperators(hub, p), []);
  });
});
