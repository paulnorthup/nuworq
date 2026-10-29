import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/core.js';
import { createServer } from '../src/server.js';
import { connectCommands, shellCommands } from '../web/connect.js';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const REMOTE = { bin: '/var/lib/nuworq/hub-src/bin/nuworq.js', url: 'http://nuworq.com', auth: 'required', source: 'github.com/paulnorthup/nuworq' };

// "Connect an agent" (#82): what it says to paste must work when pasted.
describe('connect an agent: commands that paste and run', () => {
  test('no shell command holds a placeholder a shell would read as a redirect', () => {
    for (const info of [REMOTE, { ...REMOTE, auth: 'local' }, { ...REMOTE, url: 'http://127.0.0.1:4747' }, { ...REMOTE, url: 'http://localhost:9000', auth: 'local' }]) {
      for (const cmd of shellCommands(connectCommands(info, null, 'demo'))) assert.doesNotMatch(cmd, /[<>|]/, `${info.url} ${info.auth}: ${cmd}`);
    }
  });

  test('every shell command parses in a real shell: zsh no longer says "no such file or directory"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nuworq-modal-'));
    for (const cmd of shellCommands(connectCommands(REMOTE, null, 'demo'))) {
      // -n: read and parse, run nothing. A redirect from a missing file is a runtime error, so run it with every word a no-op.
      execFileSync('sh', ['-n', '-c', cmd]);
      execFileSync('sh', ['-c', cmd.split('\n').map((l) => `: ${l}`).join('\n')], { cwd: dir });
    }
  });

  test('a hub on another machine: clone nuworq, then connect; never the server\'s own path', () => {
    const c = connectCommands(REMOTE, { protocol: 'https:', host: 'nuworq.com' }, 'demo');
    assert.equal(c.local, false);
    assert.equal(c.url, 'https://nuworq.com', 'the page is on https, so the hub is too');
    assert.equal(c.clone, 'git clone https://github.com/paulnorthup/nuworq.git ~/nuworq');
    assert.equal(c.connect, 'node ~/nuworq/bin/nuworq.js connect https://nuworq.com');
    assert.equal(c.claude, null, 'connect registers Claude Code itself, with the token');
    assert.match(c.worker, /^node ~\/nuworq\/bin\/nuworq\.js worker --agent claude --run$/m);
    for (const text of Object.values(c)) assert.ok(!String(text).includes('/var/lib/nuworq'), String(text));
    assert.match(c.codex, /NUWORQ_TOKEN = "paste-an-agent-token-here"/, 'config files say where the token goes, in plain words');
    assert.equal(connectCommands({ ...REMOTE, source: null }).clone, null, "no source known: the UI says to clone it, without a guessed address");
  });

  test('a hub that serves its package: install it, then connect, for a plain hub and a workspace (#105)', () => {
    const pkg = { url: 'http://nuworq.com/nuworq.tgz', sha256: 'ab'.repeat(32), commit: '1234567' };
    const c = connectCommands({ ...REMOTE, package: pkg }, { protocol: 'https:', host: 'nuworq.com' }, 'demo');
    assert.equal(c.install, 'npm install -g https://nuworq.com/nuworq.tgz');
    assert.equal(c.connect, 'nuworq connect https://nuworq.com');
    assert.equal(c.clone, null, 'no clone once there is a package');
    assert.match(c.worker, /^nuworq worker --agent claude --run$/m);
    assert.equal(c.guide, 'nuworq guide --project demo');
    assert.match(c.codex, /command = "nuworq"\nargs = \["mcp"\]/, 'config files need no path either');
    for (const [k, text] of Object.entries(c)) if (k !== 'token') assert.ok(!String(text).includes('nuworq.js'), String(text)); // token: run on the hub's host

    const w = connectCommands({ ...REMOTE, url: 'https://nuworq.com/w/acme', package: { ...pkg, url: 'https://nuworq.com/nuworq.tgz' } }, null, 'demo');
    assert.equal(w.install, 'npm install -g https://nuworq.com/nuworq.tgz', 'one package for the whole hub');
    assert.equal(w.connect, 'nuworq connect https://nuworq.com/w/acme', 'connect names the workspace');

    const old = connectCommands({ ...REMOTE, package: null }, null, 'demo');
    assert.equal(old.install, null, 'an older hub: no package, so the clone instructions stay');
    assert.ok(old.clone);
    const here = connectCommands({ bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'local', package: pkg }, null, 'demo');
    assert.equal(here.install, null, 'on the hub\'s own machine its copy is already here');
  });

  test('a hub on this machine without login: the hub\'s own copy, Claude Code by hand, nothing to connect', () => {
    const c = connectCommands({ bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'local' }, null, 'demo');
    assert.equal(c.local, true);
    assert.equal(c.clone, null);
    assert.equal(c.connect, null);
    assert.equal(c.claude, 'claude mcp add --scope user nuworq -- node "/Users/me/nuworq/bin/nuworq.js" mcp');
    assert.equal(c.guide, 'node "/Users/me/nuworq/bin/nuworq.js" guide --project demo');
  });

  test('/api/info gives the public address when the hub has one, and where nuworq comes from', async () => {
    const server = createServer(new Hub(), { publicUrl: 'https://hub.example' });
    try {
      const info = await (await fetch(`http://127.0.0.1:${await listen(server)}/api/info`)).json();
      assert.equal(info.url, 'https://hub.example');
      assert.ok('source' in info);
    } finally {
      server.close();
    }
  });
});
