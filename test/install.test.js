import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';

const run = promisify(execFile); // async: npm and the CLI talk to this process's own server
let npm = true;
try { execFileSync('npm', ['--version'], { stdio: 'ignore' }); } catch { npm = false; }

// #101 end to end, as a new machine sees it: nothing but Node, the package from the hub, connect, and the tools work.
test('npm install -g <hub>/nuworq.tgz, then nuworq connect <hub>: Claude Code, Codex and opencode get `nuworq mcp` with no paths, and its tools reach the hub', { timeout: 180_000, skip: !npm && 'npm is not installed here' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nuworq-install-')));
  const hub = new Hub();
  const server = createServer(hub, { auth: 'required', packageDir: join(root, 'cache') });
  const token = server.auth.createToken('e2e', 'agent');
  hub.tx(() => hub.project('demo', { create: true }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const prefix = join(root, 'prefix');
    await run('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', `${url}/nuworq.tgz`], { timeout: 120_000, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') } });

    // The machine: the installed nuworq, Node, and a Claude Code stub that logs its calls. No NUWORQ_* settings.
    const stubs = join(root, 'stubs');
    mkdirSync(stubs);
    const calls = join(root, 'claude-calls');
    writeFileSync(join(stubs, 'claude'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ "$2" = get ] && exit 1\nexit 0\n`);
    chmodSync(join(stubs, 'claude'), 0o755);
    const home = join(root, 'home');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
    writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), '{}\n');
    const env = { PATH: [join(prefix, 'bin'), stubs, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: home, NUWORQ_NO_UPDATE: '1' };
    const nuworq = join(prefix, 'bin', 'nuworq');

    const c = await run(nuworq, ['connect', url, '--token', token], { env });
    assert.match(c.stdout, /Connected to .* as e2e \(agent token\)/);

    const claude = readFileSync(calls, 'utf8');
    assert.match(claude, /^mcp add --scope user nuworq -- nuworq mcp$/m);
    const codex = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(codex, /\[mcp_servers\.nuworq\]\ncommand = "nuworq"\nargs = \["mcp"\]\ndefault_tools_approval_mode = "approve"\n/);
    const opencode = readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
    assert.deepEqual(JSON.parse(opencode).mcp.nuworq.command, ['nuworq', 'mcp']);
    for (const [name, text] of [['claude', claude], ['codex', codex], ['opencode', opencode]]) {
      assert.ok(!text.includes(root) && !text.includes('nuworq.js'), `${name} holds no path: ${text}`);
      assert.ok(!text.includes(token), `${name} holds no token`);
    }

    // What Claude Code then runs: `nuworq mcp`, which finds the hub and the token connect saved.
    const child = spawn(nuworq, ['mcp'], { env });
    const seen = [];
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { seen.push(JSON.parse(buf.slice(0, nl))); buf = buf.slice(nl + 1); } });
    let id = 0;
    const ask = async (method, params = {}) => {
      const n = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
        const m = seen.find((x) => x.id === n);
        if (m) return m.result;
      }
      throw new Error(`no answer to ${method}: ${JSON.stringify(seen)}`);
    };
    try {
      await ask('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'e2e' } });
      assert.ok((await ask('tools/list')).tools.some((t) => t.name === 'checkin'));
      const r = await ask('tools/call', { name: 'checkin', arguments: { project: 'demo' } });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.ok(hub.q("SELECT 1 FROM agents WHERE name LIKE 'e2e-%'").get(), 'the call reached the hub as a session of the connected agent');
    } finally { child.kill(); }
    assert.ok(existsSync(join(home, '.nuworq', 'connect.json')));
  } finally {
    server.close();
  }
});
