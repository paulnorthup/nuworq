import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Hub } from '../src/core.js';
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

      // The token as one line on stdin, as when it is pasted.
      const ok = await cli(['connect', `${url}/`], { env, input: `${token}\n` });
      assert.equal(ok.code, 0, ok.stderr);
      assert.match(ok.stdout, /Connected to .* as me \(human token\)/);
      assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'the token is never printed');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { url, token });

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
});
