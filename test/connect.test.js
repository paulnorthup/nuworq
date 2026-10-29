import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, statSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
import { Auth } from '../src/auth.js';
import { Workspaces } from '../src/workspaces.js';
import { createServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const CLIENT = new URL('../src/client.js', import.meta.url).href;

// A home of its own, and none of this machine's NUWORQ_* settings.
const envFor = (home, extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))),
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
    mkdirSync(join(home, '.codex'));
    const toml = '[mcp_servers.other]\ncommand = "other"\n';
    writeFileSync(join(home, '.codex', 'config.toml'), toml);
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    const oc = { theme: 'dark', mcp: { other: { type: 'local', command: ['other'] } } };
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify(oc));
    const env = envFor(home, { PATH: `${bin}${delimiter}${process.env.PATH}` });
    const read = {
      claude: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []),
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

      assert.equal(statSync(m.file).mode & 0o777, 0o600);
      const saved = JSON.parse(readFileSync(m.file, 'utf8'));
      assert.equal(saved.url, url);
      assert.ok(saved.token.startsWith('nwq_'));
      assert.deepEqual(saved.added.map((a) => a.tool), ['claude', 'codex', 'opencode']);
      assert.ok(!out.stdout.includes(saved.token), 'the token is never printed');

      // Each tool got nuworq and kept everything else; no config holds the token.
      assert.deepEqual(m.read.claude(), ['mcp get nuworq', `mcp add --scope user nuworq -- node ${BIN} mcp`]);
      assert.ok(m.read.codex().startsWith(m.toml), "Codex's own entries are untouched");
      assert.match(m.read.codex(), /\[mcp_servers\.nuworq\]\ncommand = "node"\nargs = \[.*"mcp"\]/);
      assert.deepEqual(m.read.opencode().mcp.other, m.oc.mcp.other);
      assert.equal(m.read.opencode().theme, 'dark');
      assert.deepEqual(m.read.opencode().mcp.nuworq.command, ['node', BIN, 'mcp']);
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
      assert.deepEqual(JSON.parse(readFileSync(m.file, 'utf8')).added.map((a) => a.tool), ['claude', 'codex', 'opencode'], 'still recorded for disconnect');
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
