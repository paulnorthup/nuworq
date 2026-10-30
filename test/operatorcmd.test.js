import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, skill, operatorLoop } from '../src/protocol.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// `nuworq operator` (#140): the tags to declare and the /loop line, printed; nothing is started.
describe('nuworq operator', () => {
  // PATH holds only node's own folder, so `claude` can't be found, let alone started.
  const home = mkdtempSync(join(tmpdir(), 'nuworq-operator-'));
  const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'operator', ...a], {
    cwd: home, env: { HOME: home, PATH: join(process.execPath, '..'), NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: 'http://127.0.0.1:9' },
  });

  test('prints the has list and a /loop line with the project, "operator" and that list', async () => {
    const { stdout } = await run('--project', 'nuworq');
    const declared = stdout.match(/^Declare: (.+?)(  |$)/m)[1].split(', ');
    assert.equal(declared[0], 'operator');
    assert.ok(declared.includes({ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform]), 'the platform is detected');
    assert.ok(stdout.includes(operatorLoop('nuworq', declared)), 'the shared /loop text');
    assert.match(stdout, /\/loop Work on nuworq as its operator using nuworq: checkin with has \["operator"/);
  });

  test('--has replaces what was detected; operator stays first and once', async () => {
    const { stdout } = await run('--project', 'acme', '--has', 'claude-cli,Browser,operator');
    assert.match(stdout, /^Declare: operator, claude-cli, browser$/m);
    assert.ok(stdout.includes('checkin with has ["operator", "claude-cli", "browser"]'));
    assert.doesNotMatch(stdout, /macos|linux/);
  });

  test('help lists it', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'help'], { env: { ...process.env, NO_COLOR: '1' } });
    assert.match(stdout, /^ {2}operator \[--project p\] \[--has tags\]/m);
  });
});

describe('one /loop text for the guide, the README and the command', () => {
  test('the guide and the README carry operatorLoop() word for word', () => {
    assert.ok(guide({ project: 'acme' }).includes(operatorLoop('acme')));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(readme.includes(operatorLoop('<project>')));
    assert.match(readme, /`nuworq operator --project <project>`/);
  });

  test('the skill has an operator section', () => {
    const s = skill();
    assert.match(s, /## If you are the operator/);
    for (const want of [/nuworq operator/, /to: "operator"/, /escalates/, /Never pass operator powers on/]) assert.match(s.split('## If you are the operator')[1], want);
  });
});
