import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// serve's startup banner says what the Connect dialog says (#105): the installed `nuworq`, never a path into the checkout.
test('the serve banner connects with the installed nuworq, not node <path>/bin/nuworq.js (#157)', { timeout: 20_000 }, async () => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NUWORQ|TRELLIS)_/.test(k))),
    HOME: mkdtempSync(join(tmpdir(), 'nuworq-banner-')), NO_COLOR: '1',
  };
  const child = spawn(process.execPath, [BIN, 'serve', '--demo', '--port', '0', '--public-url', 'https://hub.example'], { env });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  try {
    for (let i = 0; i < 150 && !/Tool schemas/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /Tool schemas/, out);
    assert.match(out, /npm install -g https:\/\/hub\.example\/nuworq\.tgz/, 'installs from the hub, at its public address');
    assert.match(out, /nuworq connect https:\/\/hub\.example/);
    assert.match(out, /nuworq run --workers 3 --agent claude/);
    assert.match(out, /nuworq guide/);
    assert.doesNotMatch(out, /bin\/nuworq\.js|\bnode "/, 'no path into this checkout');
  } finally {
    child.kill('SIGTERM');
  }
});
