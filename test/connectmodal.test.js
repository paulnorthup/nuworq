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

  test('install from this hub, connect to it, keep workers going: for a plain hub and a workspace (#105)', () => {
    const pkg = { url: 'http://nuworq.com/nuworq.tgz', sha256: 'ab'.repeat(32), commit: '1234567' };
    const c = connectCommands({ ...REMOTE, package: pkg }, { protocol: 'https:', host: 'nuworq.com' }, 'demo');
    assert.equal(c.url, 'https://nuworq.com', 'the page is on https, so the hub is too');
    assert.equal(c.install, 'npm install -g https://nuworq.com/nuworq.tgz');
    assert.equal(c.connect, 'nuworq connect https://nuworq.com');
    assert.equal(c.run, 'nuworq run --workers 3 --agent claude');
    assert.equal(c.worker, 'nuworq worker --agent claude --run');
    assert.equal(c.guide, 'nuworq guide --project demo');

    const w = connectCommands({ ...REMOTE, url: 'https://nuworq.com/w/acme', package: { ...pkg, url: 'https://nuworq.com/nuworq.tgz' } }, null, 'demo');
    assert.equal(w.install, 'npm install -g https://nuworq.com/nuworq.tgz', 'one package for the whole hub');
    assert.equal(w.connect, 'nuworq connect https://nuworq.com/w/acme', 'connect names the workspace');

    const here = connectCommands({ bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'local', package: { ...pkg, url: 'http://127.0.0.1:4747/nuworq.tgz' } }, null, 'demo');
    assert.equal(here.install, 'npm install -g http://127.0.0.1:4747/nuworq.tgz', 'a hub on this machine installs the same way');
    assert.equal(here.connect, 'nuworq connect http://127.0.0.1:4747');
    assert.equal(connectCommands({ ...REMOTE, package: null }).install, null, 'a hub with no package: the dialog says to install nuworq the way the hub was');
  });

  test('setting up by hand: no token, no address, no path, no clone, in any command or config', () => {
    for (const info of [REMOTE, { ...REMOTE, package: { url: 'https://nuworq.com/nuworq.tgz' } }, { bin: '/Users/me/nuworq/bin/nuworq.js', url: 'http://127.0.0.1:4747', auth: 'local' }]) {
      const c = connectCommands(info, null, 'demo');
      assert.equal(c.claude, 'claude mcp add --scope user nuworq -- nuworq mcp');
      assert.equal(c.codex, '[mcp_servers.nuworq]\ncommand = "nuworq"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"');
      assert.equal(c.mcp, 'command: nuworq\nargs: ["mcp"]');
      for (const [k, text] of Object.entries(c)) {
        if (typeof text !== 'string' || k === 'url') continue;
        assert.doesNotMatch(text, /git clone|nuworq\.js|\/path\/to|NUWORQ_TOKEN|NUWORQ_URL|paste-an|\bnode /, `${k}: ${text}`);
      }
    }
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
