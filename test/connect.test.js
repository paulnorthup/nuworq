import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { skill, shaperSkill, operatorSkill, userSkills, OPS } from '../src/protocol.js';
import { installPlugin as installWithClaude, PLUGIN_INSTALL, leftovers, pluginScopes } from '../src/connect.js';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const CLIENT = new URL('../src/client.js', import.meta.url).href;

// A home of its own, and none of this machine's NUWORQ_* settings.
const envFor = (home, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^NUWORQ_/.test(k))),
  HOME: home, ...extra,
});

function cli(args, { env, input = '' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// The hub and token the CLI and MCP server would use there.
async function settings(env, cwd) {
  const code = `import { resolveSettings } from ${JSON.stringify(CLIENT)};
    const s = resolveSettings({ cwd: ${JSON.stringify(cwd)} });
    console.log(JSON.stringify({ url: s.url, token: s.token }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env });
  return JSON.parse(stdout);
}

describe('nuworq connect', () => {
  test('checks the hub and the token, saves them for you alone; the client uses them until the environment says otherwise', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-connect-')));
    const file = join(home, '.nuworq', 'connect.json');
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    const token = server.auth.createToken('me', 'human');
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = envFor(home);
    try {
      const refused = await cli(['connect', url, '--token', 'nwq_not-a-real-token-at-all'], { env });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /refused that token/);
      assert.ok(!existsSync(file), 'nothing saved');

      // --token -: one line on stdin, as when it is pasted.
      const ok = await cli(['connect', `${url}/`, '--token', '-', '--no-mcp'], { env, input: `${token}\n` });
      assert.equal(ok.code, 0, ok.stderr);
      assert.match(ok.stdout, /Connected to .* as me \(human token\)/);
      assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token is never printed');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url, token, added: [] });

      assert.deepEqual(await settings(env, home), { url, token });
      const call = await cli(['checkin', '--as', 'a1', '--project', 'demo'], { env });
      assert.equal(call.code, 0, call.stderr);
      assert.ok(hub.projects().some((p) => p.slug === 'demo'), 'an authenticated call reached the connected hub');

      // The environment wins; the saved token never goes to another hub.
      assert.deepEqual(await settings(envFor(home, { NUWORQ_URL: 'http://127.0.0.1:9' }), home), { url: 'http://127.0.0.1:9', token: '' });
      assert.deepEqual(await settings(envFor(home, { NUWORQ_TOKEN: 'nwq_other' }), home), { url, token: 'nwq_other' });

      const off = await cli(['connect', '--off'], { env });
      assert.equal(off.code, 0, off.stderr);
      assert.ok(!existsSync(file));
      assert.deepEqual(await settings(env, home), { url: 'http://127.0.0.1:4747', token: '' });
    } finally {
      server.close();
    }
  });

  // A machine with Claude Code (a stub on PATH that logs what it is asked), Codex and opencode configs
  // that already hold someone else's entries.
  function machine() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-machine-')));
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const calls = join(home, 'claude-calls');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ "$2" = get ] && exit 1\nexit 0\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    // pi: a stub too, so this machine's own pi (if any) is never what answers.
    const piCalls = join(home, 'pi-calls');
    writeFileSync(join(bin, 'pi'), `#!/bin/sh\necho "PI_CODING_AGENT_DIR=$PI_CODING_AGENT_DIR $*" >> ${JSON.stringify(piCalls)}\nexit 0\n`);
    chmodSync(join(bin, 'pi'), 0o755);
    mkdirSync(join(home, '.codex'));
    const toml = '[mcp_servers.other]\ncommand = "other"\n';
    writeFileSync(join(home, '.codex', 'config.toml'), toml);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const oc = { theme: 'dark', mcp: { other: { type: 'local', command: ['other'] } } };
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify(oc));
    const env = envFor(home, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    const read = {
      claude: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
      pi: () => (existsSync(piCalls) ? readFileSync(piCalls, 'utf8').trim().split('\n') : []),
      codex: () => readFileSync(join(home, '.codex', 'config.toml'), 'utf8'),
      opencode: () => JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8')),
    };
    return { home, env, toml, oc, read, file: join(home, '.nuworq', 'connect.json') };
  }

  // The CLI running in the background, and a way to wait for a line of its output.
  function background(args, env) {
    const child = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
    const waitFor = async (re) => {
      for (let i = 0; i < 100; i++) {
        const m = stdout.match(re);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`never printed ${re}: ${stdout}${stderr}`);
    };
    return { child, done, waitFor };
  }

  test('a device login approved in the browser, MCP for every tool installed, and disconnect undoes exactly that', { timeout: 30_000 }, async () => {
    const m = machine();
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    server.auth.addPerson('bea', 'member');
    const bea = server.auth.createToken('bea-l', 'human', { person: 'bea' });
    hub.tx(() => hub.project('demo', { create: true }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const run = background(['connect', url, '--no-browser'], m.env);
      const [, code] = await run.waitFor(/approve the code (\S+)/);
      const approve = await fetch(`${url}/api/device/approve`, {
        method: 'POST', headers: { authorization: `Bearer ${bea}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user_code: code.replace(/\x1b\[[\d;]*m/g, ''), approve: true }),
      });
      assert.equal(approve.status, 200);
      const out = await run.done;
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /Connected to .* as bea@\S+ \(agent token\)/);
      assert.match(out.stdout, /Claude Code: added the nuworq MCP server/);
      assert.match(out.stdout, /Codex: added the nuworq MCP server/);
      assert.match(out.stdout, /opencode: added the nuworq MCP server/);
      assert.match(out.stdout, /pi: added the nuworq MCP server \(\S+\/\.pi\/agent\/mcp\.json\)/);

      assert.equal(statSync(m.file).mode & 0o777, 0o600);
      const saved = JSON.parse(readFileSync(m.file, 'utf8'));
      assert.equal(saved.url, url);
      assert.ok(saved.token.startsWith('nwq_'));
      assert.deepEqual(saved.added.map((a) => a.tool), ['claude', 'codex', 'opencode', 'pi', 'skill']);
      assert.ok(!out.stdout.includes(saved.token), 'the token is never printed');
      // No plugin and no one at a terminal to ask (#432): it says how to get the plugin, and writes the skills,
      // generated, pointing at this hub's guide, under names that keep clear of a person's own.
      assert.match(out.stdout, /Claude Code takes nuworq best as its plugin, installed for your account, with \/nuworq:shaper and \/nuworq:operator: claude plugin marketplace add paulnorthup\/nuworq#release && claude plugin install nuworq@nuworq --scope user/);
      const skillFile = join(m.home, '.claude', 'skills', 'nuworq', 'SKILL.md');
      const planFile = join(m.home, '.claude', 'skills', 'nuworq-shaper', 'SKILL.md');
      assert.equal(readFileSync(skillFile, 'utf8'), skill({ url }));
      assert.equal(readFileSync(planFile, 'utf8'), shaperSkill({ url, name: 'nuworq-shaper' }));
      assert.equal(readFileSync(join(m.home, '.claude', 'skills', 'nuworq-operator', 'SKILL.md'), 'utf8'), operatorSkill({ url, name: 'nuworq-operator' }));
      assert.match(out.stdout, /Claude Code skill: wrote the nuworq, nuworq-shaper and nuworq-operator skills/);

      // Each tool got nuworq and kept everything else; no config holds the token.
      assert.deepEqual(m.read.claude(), ['mcp get nuworq', `mcp add --scope user nuworq -- node ${BIN} mcp`]);
      assert.ok(m.read.codex().startsWith(m.toml), "Codex's own entries are untouched");
      assert.match(m.read.codex(), /\[mcp_servers\.nuworq\]\ncommand = "node"\nargs = \[.*"mcp"\]/);
      assert.match(m.read.codex(), /default_tools_approval_mode = "approve"/, 'headless Codex would otherwise cancel every nuworq call');
      assert.deepEqual(m.read.opencode().mcp.other, m.oc.mcp.other);
      assert.equal(m.read.opencode().theme, 'dark');
      assert.deepEqual(m.read.opencode().mcp.nuworq.command, ['node', BIN, 'mcp']);
      assert.deepEqual(m.read.pi(), [`PI_CODING_AGENT_DIR= mcp add nuworq --exposure direct -- node ${BIN} mcp`]);
      for (const text of [m.read.codex(), JSON.stringify(m.read.opencode())]) assert.ok(!text.includes(saved.token));

      // No env, no flags: the CLI reaches the hub with the saved agent token.
      const call = await cli(['checkin', '--as', 'x', '--project', 'demo'], { env: m.env });
      assert.equal(call.code, 0, call.stderr);
      assert.ok(hub.q("SELECT 1 FROM agents WHERE name = 'x'").get(), 'the checkin reached the hub');

      const off = await cli(['disconnect'], { env: m.env });
      assert.equal(off.code, 0, off.stderr);
      assert.match(off.stdout, /Revoked the token bea@\S+/);
      assert.ok(!existsSync(m.file));
      const me = await (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${saved.token}` } })).json();
      assert.equal(me.role, null, 'the token no longer works');
      assert.equal(m.read.codex(), m.toml, 'Codex config is exactly as before');
      assert.deepEqual(m.read.opencode(), m.oc, 'opencode config has its own entries and nothing else');
      assert.equal(m.read.claude().at(-1), 'mcp remove --scope user nuworq');
      assert.equal(m.read.pi().at(-1), 'PI_CODING_AGENT_DIR= mcp remove nuworq');
      assert.ok(!existsSync(skillFile) && !existsSync(dirname(skillFile)), 'the skill is gone too');
      assert.ok(!existsSync(planFile) && !existsSync(dirname(planFile)), 'and the shaper skill');

      const again = await cli(['disconnect'], { env: m.env });
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /Not connected/);
    } finally {
      server.close();
    }
  });

  test('connecting again revokes the old token; MCP set up last time is not added twice; --no-mcp touches no tools', async () => {
    const m = machine();
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    const one = server.auth.createToken('one', 'agent'), two = server.auth.createToken('two', 'agent');
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const role = async (t) => (await (await fetch(`${url}/api/me`, { headers: { authorization: `Bearer ${t}` } })).json()).role;
    try {
      const first = await cli(['connect', url, '--token', one], { env: m.env });
      assert.equal(first.code, 0, first.stderr);
      const second = await cli(['connect', url, '--token', two], { env: m.env });
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /Revoked the token one/);
      assert.match(second.stdout, /Codex: already set up by an earlier connect/);
      assert.equal(await role(one), null);
      assert.equal(await role(two), 'agent');
      assert.equal(m.read.codex().match(/\[mcp_servers\.nuworq\]/g).length, 1);
      assert.deepEqual(JSON.parse(readFileSync(m.file, 'utf8')).added.map((a) => a.tool), ['claude', 'codex', 'opencode', 'pi', 'skill'], 'still recorded for disconnect, the skill once');
      await cli(['disconnect'], { env: m.env });
      assert.equal(m.read.codex(), m.toml);

      assert.equal(await role(two), null, 'disconnect revoked it');
      const bare = machine();
      const three = server.auth.createToken('three', 'agent');
      const r = await cli(['connect', url, '--token', three, '--no-mcp'], { env: bare.env });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(bare.read.codex(), bare.toml);
      assert.deepEqual(bare.read.claude(), []);
    } finally {
      server.close();
    }
  });

  test('with the nuworq plugin installed, connect leaves Claude Code to it, and takes back what it added there before', async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const token = () => server.auth.createToken(`t${Math.random()}`, 'agent');
    const installPlugin = (home) => {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2, plugins: { 'nuworq@nuworq': [{ scope: 'user', installPath: join(home, 'cache'), version: '0.2.0' }] },
      }));
    };
    const skillDir = (home) => join(home, '.claude', 'skills', 'nuworq');
    try {
      // A clean machine: plugin install, then a plain connect.
      const fresh = machine();
      installPlugin(fresh.home);
      const r = await cli(['connect', url, '--token', token()], { env: fresh.env });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Claude Code: left to the nuworq plugin, which brings the MCP server and the \/nuworq:shaper and \/nuworq:operator commands\n/);
      assert.doesNotMatch(r.stdout, /takes nuworq best as its plugin/, 'nothing to suggest');
      assert.deepEqual(fresh.read.claude(), [], 'no second MCP server');
      assert.ok(!existsSync(skillDir(fresh.home)), 'no second copy of the skills');
      assert.deepEqual(JSON.parse(readFileSync(fresh.file, 'utf8')).added.map((a) => a.tool), ['codex', 'opencode', 'pi']);

      // Connected before the plugin: connecting again removes the server and skills it added, and says so.
      const before = machine();
      await cli(['connect', url, '--token', token()], { env: before.env });
      assert.ok(existsSync(skillDir(before.home)));
      installPlugin(before.home);
      const again = await cli(['connect', url, '--token', token()], { env: before.env });
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /left to the nuworq plugin.*; removed what an earlier connect added: its MCP server and the nuworq, nuworq-shaper and nuworq-operator skills in \S+\.claude\/skills/);
      assert.equal(before.read.claude().at(-1), 'mcp remove --scope user nuworq');
      for (const name of Object.keys(userSkills())) assert.ok(!existsSync(join(before.home, '.claude', 'skills', name)), `${name} is gone`);
      assert.deepEqual(JSON.parse(readFileSync(before.file, 'utf8')).added.map((a) => a.tool), ['codex', 'opencode', 'pi']);
    } finally {
      server.close();
    }
  });

  // #496: the maintainer's Mac on 2026-11-01. The plugin installed for one checkout and its worktrees only, the skills of
  // earlier connects (two recorded, nuworq-operator not), and a user-scope MCP server connect never recorded.
  test('an install for some folders only gets the account-wide offer; beside one for the account, nuworq\'s leftovers go, recorded or not', async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const token = () => server.auth.createToken(`t${Math.random()}`, 'agent');
    const generated = 'Generated by `nuworq skill` from the hub\'s protocol; regenerate it rather than editing it.\n';
    const plugins = (home, installs) => {
      mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
      writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'nuworq@nuworq': installs } }));
    };
    const local = (path) => ({ scope: 'local', projectPath: path, installPath: '/cache/nuworq', version: '0.5.0' });
    const skill = (home, name) => join(home, '.claude', 'skills', name, 'SKILL.md');
    const seed = () => {
      const m = machine();
      plugins(m.home, [local('/Users/p/Projects/nuworq-app'), local('/Users/p/Projects/nuworq-app.worktrees/claude-1'), local('/Users/p/Projects/nuworq-app.worktrees/claude-2'), local('/Users/p/Projects/nuworq-app.worktrees/claude-3')]);
      for (const name of ['nuworq', 'nuworq-plan', 'nuworq-operator']) { mkdirSync(dirname(skill(m.home, name)), { recursive: true }); writeFileSync(skill(m.home, name), `---\nname: ${name}\n---\n${generated}`); }
      // Written by hand under a name nuworq uses: the person's, never touched.
      mkdirSync(dirname(skill(m.home, 'nuworq-shaper')), { recursive: true });
      writeFileSync(skill(m.home, 'nuworq-shaper'), '---\nname: nuworq-shaper\n---\nMy own notes.\n');
      writeFileSync(join(m.home, '.claude.json'), JSON.stringify({ mcpServers: { nuworq: { type: 'stdio', command: 'nuworq', args: ['mcp'], env: {} }, other: { command: 'other' } } }));
      mkdirSync(dirname(m.file), { recursive: true });
      writeFileSync(m.file, JSON.stringify({ url, token: '', added: [{ tool: 'skill', files: [skill(m.home, 'nuworq'), skill(m.home, 'nuworq-plan')] }] }));
      return m;
    };
    // What `claude plugin install nuworq@nuworq --scope user` adds beside the folder installs.
    const forAccount = (m) => plugins(m.home, [...JSON.parse(readFileSync(join(m.home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins['nuworq@nuworq'], { scope: 'user', installPath: '/cache/nuworq', version: '0.5.0' }]);
    try {
      // Folder installs only: not installed, as far as other projects go. It names the folders and offers the account's.
      const only = seed();
      const r = await cli(['connect', url, '--token', token()], { env: only.env });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Claude Code has the nuworq plugin only for 4 folders \(\/Users\/p\/Projects\/nuworq-app, \S+claude-1, \S+claude-2 and 1 more\), so other projects don't get \/nuworq:shaper and \/nuworq:operator\./);
      assert.match(r.stdout, /installed for your account, .*claude plugin install nuworq@nuworq --scope user, then connect again/);
      assert.doesNotMatch(r.stdout, /left to the nuworq plugin/);

      // With no one to ask and no --yes: the leftovers are listed with the commands that remove them, and stay.
      const told = seed();
      forAccount(told);
      const t = await cli(['connect', url, '--token', token()], { env: told.env });
      assert.equal(t.code, 0, t.stderr);
      assert.match(t.stdout, /Claude Code: an earlier nuworq left the nuworq-operator skill folder in \S+ and a user-scope nuworq MCP server beside the plugin\. To remove them: rm -r "\S+nuworq-operator" && claude mcp remove --scope user nuworq/);
      assert.ok(existsSync(skill(told.home, 'nuworq-operator')));
      assert.ok(!told.read.claude().includes('mcp remove --scope user nuworq'));

      // --yes (a yes at the prompt): exactly those go. The recorded skills went as before; the hand-written one stays.
      const yes = seed();
      forAccount(yes);
      const y = await cli(['connect', url, '--token', token(), '--yes'], { env: yes.env });
      assert.equal(y.code, 0, y.stderr);
      assert.match(y.stdout, /left to the nuworq plugin.*; removed what an earlier connect added: the nuworq and nuworq-plan skills/);
      assert.match(y.stdout, /Claude Code: left the plugin's 4 installs for single folders alone \(workers turn plugins off there\)/);
      assert.match(y.stdout, /Claude Code: removed what an earlier nuworq left beside the plugin: the nuworq-operator skill folder in \S+ and a user-scope nuworq MCP server/);
      for (const name of ['nuworq', 'nuworq-plan', 'nuworq-operator']) assert.ok(!existsSync(dirname(skill(yes.home, name))), `${name} is gone`);
      assert.equal(readFileSync(skill(yes.home, 'nuworq-shaper'), 'utf8'), '---\nname: nuworq-shaper\n---\nMy own notes.\n');
      assert.deepEqual(yes.read.claude(), ['mcp remove --scope user nuworq'], 'only the server, and no plugin commands');
      assert.equal(JSON.parse(readFileSync(join(yes.home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins['nuworq@nuworq'].length, 5, 'folder installs stay');
    } finally {
      server.close();
    }
  });

  test('a user-scope nuworq MCP server that starts something else, or a skill folder without the generated line, is never a leftover', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-left-')));
    mkdirSync(join(home, '.claude', 'skills', 'nuworq-operator'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'nuworq-operator', 'SKILL.md'), 'mine');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { nuworq: { command: 'npx', args: ['some-other-nuworq'] } } }));
    assert.deepEqual(leftovers(home), { skills: [], mcp: false });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { nuworq: { command: 'node', args: ['/opt/nuworq/bin/nuworq.js', 'mcp'] } } }));
    assert.deepEqual(leftovers(home), { skills: [], mcp: true }, 'node <bin> mcp is nuworq too');
    assert.deepEqual(leftovers(home, { skip: ['claude'] }).mcp, false, 'one connect recorded is taken back by connect itself');
  });

  test('the plugin covers Claude Code only when installed for the account', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-scope-')));
    const write = (installs) => { mkdirSync(join(home, '.claude', 'plugins'), { recursive: true }); writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'nuworq@nuworq': installs, 'other@x': [{ scope: 'user' }] } })); };
    assert.deepEqual(pluginScopes(home), { account: false, folders: [], installs: [] }, 'no plugins file');
    write([{ scope: 'local', projectPath: '/a' }, { scope: 'project', projectPath: '/b' }]);
    assert.deepEqual(pluginScopes(home), { account: false, folders: ['/a', '/b'], installs: [{ scope: 'local', projectPath: '/a' }, { scope: 'project', projectPath: '/b' }] });
    write([{ scope: 'local', projectPath: '/a' }, { scope: 'user' }]);
    assert.deepEqual(pluginScopes(home), { account: true, folders: ['/a'], installs: [{ scope: 'local', projectPath: '/a' }] });
    write({ installPath: '/old', version: '0.1.0' });
    assert.equal(pluginScopes(home).account, true, 'an entry from before scopes was the account\'s');
  });

  // #432: the plugin is the one place for nuworq in Claude Code; the skills in ~/.claude/skills are the fallback.
  test('without the plugin, connect removes skills it wrote under old names; a yes installs the plugin with claude', async () => {
    const hub = new Hub();
    const server = createServer(hub, { auth: 'required' });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      // What a connect before #432 left: the planning skill, recorded for disconnect.
      const m = machine();
      const old = join(m.home, '.claude', 'skills', 'nuworq-plan', 'SKILL.md');
      mkdirSync(dirname(old), { recursive: true });
      writeFileSync(old, 'old');
      mkdirSync(dirname(m.file), { recursive: true });
      writeFileSync(m.file, JSON.stringify({ url, token: '', added: [{ tool: 'skill', files: [join(m.home, '.claude', 'skills', 'nuworq', 'SKILL.md'), old] }] }));
      const r = await cli(['connect', url, '--token', server.auth.createToken('t', 'agent'), '--skills'], { env: m.env });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Claude Code skill: removed the old nuworq-plan skill \(/);
      assert.ok(!existsSync(dirname(old)), 'its folder is gone');
      assert.ok(existsSync(join(m.home, '.claude', 'skills', 'nuworq-shaper', 'SKILL.md')), 'the shaper took its place');
      assert.deepEqual(JSON.parse(readFileSync(m.file, 'utf8')).added.find((a) => a.tool === 'skill').files.map((f) => f.split('/').at(-2)), Object.keys(userSkills()));

      // Said yes at the prompt: Claude Code's own CLI adds the marketplace and installs the plugin.
      const yes = machine();
      assert.equal(installWithClaude(yes.env), null);
      assert.deepEqual(yes.read.claude(), PLUGIN_INSTALL.map((a) => a.join(' ')));
      assert.deepEqual(PLUGIN_INSTALL, [['plugin', 'marketplace', 'add', 'paulnorthup/nuworq#release'],['plugin', 'install', 'nuworq@nuworq', '--scope', 'user']]);
    } finally {
      server.close();
    }
  });

  test('connect <workspace> --hub <url> reaches that workspace', async () => {
    const m = machine();
    const spaces = new Workspaces({ dir: mkdtempSync(join(tmpdir(), 'nuworq-ws-')) });
    spaces.create('acme');
    const token = new Auth(spaces.get('acme').db).createToken('bot', 'agent');
    spaces.get('acme').tx(() => spaces.get('acme').project('demo', { create: true }));
    const server = createServer(spaces, {});
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const hubUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await cli(['connect', 'acme', '--hub', hubUrl, '--token', token, '--no-mcp'], { env: m.env });
      assert.equal(r.code, 0, r.stderr);
      const saved = JSON.parse(readFileSync(m.file, 'utf8'));
      assert.equal(saved.url, `${hubUrl}/w/acme`);
      assert.equal(saved.workspace, 'acme');
      const call = await cli(['checkin', '--as', 'x', '--project', 'demo'], { env: m.env });
      assert.equal(call.code, 0, call.stderr);
      assert.ok(spaces.get('acme').q("SELECT 1 FROM agents WHERE name = 'x'").get());
    } finally {
      server.close();
    }
  });

  test('serve never touches connect.json', { timeout: 20_000 }, async () => {
    const m = machine();
    mkdirSync(dirname(m.file), { recursive: true });
    const saved = JSON.stringify({ url: 'https://elsewhere.example', token: 'nwq_keep', added: [] }) + '\n';
    writeFileSync(m.file, saved, { mode: 0o600 });
    const s = background(['serve', '--port', '0'], m.env);
    await s.waitFor(/is running at/);
    s.child.kill('SIGTERM');
    await s.done;
    assert.equal(readFileSync(m.file, 'utf8'), saved);
    assert.ok(existsSync(join(dirname(m.file), 'hub.json')), 'serve wrote its own hub.json instead');
  });
});

describe('the nuworq skill is generated from the protocol', () => {
  test('it names exactly the operations the hub has, points at the guide, and stays short', () => {
    const text = skill({ url: 'https://hub.test/' });
    const fm = text.match(/^---\nname: nuworq\ndescription: (.+)\n(?:[a-z-]+: .+\n)*---\n/);
    assert.ok(fm && fm[1].length > 40, 'frontmatter with a name and a real description');
    const named = [...text.matchAll(/^- `([a-z]+)`: /gm)].map((m) => m[1]);
    assert.deepEqual(named, OPS.map((o) => o.name), 'every operation, and nothing that is not one');
    assert.match(text, /https:\/\/hub\.test\/agents\.md/);
    assert.match(text, /follow the hub/);
    assert.ok(text.split('\n').length <= 61, `${text.split('\n').length} lines`); // 61 since distill's line (#552)
  });

  test('it stays out of the slash menu but loads on its own (#432)', () => {
    assert.match(skill(), /^---\nname: nuworq\ndescription: .+\nuser-invocable: false\n---\n/);
    assert.doesNotMatch(skill(), /disable-model-invocation/, 'the model must still be able to load it');
  });

  test('the shaper skill names only real operations, the ones shaping needs, and points at the guide', () => {
    const text = shaperSkill({ url: 'https://hub.test/' });
    const fm = text.match(/^---\nname: shaper\ndescription: (.+)\n---\n/);
    assert.ok(fm && fm[1].length > 40, 'frontmatter with a name and a real description');
    const ops = new Set(OPS.map((o) => o.name));
    // Every one-word code span is a tool name.
    const named = new Set([...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
    for (const n of named) assert.ok(ops.has(n), `\`${n}\` is not an operation`);
    for (const n of ['checkin', 'look', 'propose', 'refine', 'ask']) assert.ok(named.has(n), `names \`${n}\``);
    for (const field of ['title', 'acceptance', 'parent', 'depends_on', 'needs', 'size', 'repo']) {
      assert.ok(field in OPS.find((o) => o.name === 'propose').params, `propose still takes ${field}`);
      assert.match(text, new RegExp(`\\*\\*${field}\\*\\*`), `explains ${field}`);
    }
    assert.match(text, /https:\/\/hub\.test\/agents\.md/);
    assert.match(text, /follow the hub/);
    assert.ok(text.split('\n').length <= 60, `${text.split('\n').length} lines`);
  });

  // The maintainer's words for the role, and the lessons from the 2026-10-31 shaping session (#432).
  test('the shaper skill says what a shaper does, asks before proposing, and carries the lessons', () => {
    const text = shaperSkill();
    assert.match(text, /interview the person, ask questions, hone the idea, and build milestones with their parts to submit to the hub/);
    assert.match(text, /`checkin` with role "shaper"/);
    assert.match(text, /never build, review or land/);
    assert.match(text, /Explain and recommend/);
    assert.match(text, /Nothing goes to the hub until the person says to propose it\. Once they have, propose all of it without asking again/);
    assert.match(text, /interrupted.*may have gone through anyway\. `look` at the board before proposing it again/);
    assert.match(text, /`look` at the parent first \(another agent may already have split it\), then propose its missing parts at once/);
    assert.equal(shaperSkill({ name: 'nuworq-shaper' }).split('\n')[1], 'name: nuworq-shaper', 'the copy in ~/.claude/skills keeps nuworq- in front');
  });

  test('the shaper skill drafts decisions and asks; it never tells the agent to make one', () => {
    const text = shaperSkill();
    const about = text.split(/(?<=[.:!?])\s+|\n/).filter((s) => /\bdecisions?\b/i.test(s));
    assert.ok(about.length, 'it talks about decisions');
    for (const s of about) {
      assert.doesNotMatch(s.replace(/\bnever\b.*/i, ''), /\b(write|record|add|create|make|set)s?\b[^.]*\bdecisions?\b/i, `"${s}"`);
    }
    assert.match(text, /draft the wording and `ask` the person/);
    assert.match(text, /only the person makes them/);
    assert.ok(!OPS.some((o) => /decide|decision/.test(o.name)), 'agents have no operation that writes a decision');
  });

  test('`nuworq skill --dir d` writes the three skills under their new names', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-skill-')));
    const r = await cli(['skill', '--dir', dir], { env: envFor(dir, { NUWORQ_URL: 'http://127.0.0.1:9' }) });
    assert.equal(r.code, 0, r.stderr);
    const url = 'http://127.0.0.1:9';
    assert.equal(readFileSync(join(dir, 'nuworq', 'SKILL.md'), 'utf8'), skill({ url }));
    assert.equal(readFileSync(join(dir, 'nuworq-shaper', 'SKILL.md'), 'utf8'), shaperSkill({ url, name: 'nuworq-shaper' }));
    assert.equal(readFileSync(join(dir, 'nuworq-operator', 'SKILL.md'), 'utf8'), operatorSkill({ url, name: 'nuworq-operator' }));
    assert.ok(!existsSync(join(dir, 'nuworq-plan')));
  });
});
