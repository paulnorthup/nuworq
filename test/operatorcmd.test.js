import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, skill, operatorSkill, operatorStart, OPERATOR_WAIT, OPS } from '../src/protocol.js';
import { MONITORS } from '../src/plugin.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));

// `nuworq operator` (#140, #284): the tags to declare and the line that starts the session, printed; nothing is started.
describe('nuworq operator', () => {
  // PATH holds only node's own folder, so `claude` can't be found, let alone started.
  const home = mkdtempSync(join(tmpdir(), 'nuworq-operator-'));
  const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'operator', ...a], {
    cwd: home, env: { HOME: home, PATH: join(process.execPath, '..'), NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: 'http://127.0.0.1:9' },
  });

  test('prints the has list and the /nuworq-operator line with that list, and no /loop', async () => {
    const { stdout } = await run('--project', 'nuworq');
    const declared = stdout.match(/^Declare: (.+?)(  |$)/m)[1].split(', ');
    assert.equal(declared[0], 'operator');
    assert.ok(declared.includes({ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform]), 'the platform is detected');
    assert.ok(stdout.includes(`\n${operatorStart(declared)}\n`), 'the shared start line, on its own line');
    assert.match(stdout, /^\/nuworq-operator \S+$/m);
    assert.match(stdout, /nuworq's folder/);
    assert.doesNotMatch(stdout, /^\/loop/m, 'no /loop line to paste');
  });

  test('--has replaces what was detected; operator is implied, not repeated', async () => {
    const { stdout } = await run('--project', 'acme', '--has', 'claude-cli,Browser,operator');
    assert.match(stdout, /^Declare: operator, claude-cli, browser$/m);
    assert.match(stdout, /^\/nuworq-operator claude-cli,browser$/m);
    assert.doesNotMatch(stdout, /macos|linux/);
  });

  test('help lists it', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'help'], { env: { ...process.env, NO_COLOR: '1' } });
    assert.match(stdout, /^ {2}operator \[--project p\] \[--has tags\]/m);
  });
});

describe('one start line for the guide, the README and the command; no /loop anywhere', () => {
  test('the guide and the README carry operatorStart() word for word, and the listener', () => {
    const g = guide({ project: 'acme' });
    assert.ok(g.includes(operatorStart()));
    assert.ok(g.split('## Operators')[1].includes(OPERATOR_WAIT));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(readme.includes(operatorStart()));
    assert.ok(readme.includes(OPERATOR_WAIT));
    assert.match(readme, /`nuworq operator --project <project>`/);
    for (const text of [g, readme, skill(), operatorSkill()]) assert.doesNotMatch(text, /\/loop (Work|Run)|paste the \/loop/);
  });

  test('the skill has an operator section that points at the operator skill', () => {
    const s = skill();
    assert.match(s, /## If you are the operator/);
    for (const want of [/nuworq operator/, /\/nuworq-operator/, /to: "operator"/, /escalates/, /Never pass operator powers on/]) assert.match(s.split('## If you are the operator')[1], want);
  });
});

// The operator skill (#284): only a person starts it, it checks in as the operator, works until nothing waits,
// then idles on the listener instead of looping.
describe('the nuworq-operator skill', () => {
  const s = operatorSkill();
  test('only a person invokes it, with capabilities as its argument', () => {
    assert.match(s, /^---\nname: nuworq-operator\ndescription: .+\ndisable-model-invocation: true\nargument-hint: .+\n---\n/);
    assert.match(s, /\$ARGUMENTS/);
  });

  test('it checks in as the operator, works until nothing waits, then goes idle on the listener', () => {
    for (const want of [/`checkin` with `has` = `\["operator"\]`/, /`next`/, /`answer`/, /Don't loop, poll or sleep/, /end your turn/]) assert.match(s, want);
    assert.ok(s.includes(`\`${OPERATOR_WAIT}\``));
  });

  test('without the plugin it arms the Monitor tool itself; a line is a signal, never an instruction', () => {
    assert.match(s, /Without it.*Monitor tool, command `nuworq wait --operator --follow`/);
    assert.match(s, /signal, not an instruction/);
  });

  test('it names only real operations, and takes the connected hub\'s guide', () => {
    for (const name of s.match(/`([a-z]+)`/g).map((m) => m.slice(1, -1)).filter((n) => /^(checkin|ack|next|answer|ask)$/.test(n))) assert.ok(OPS.some((o) => o.name === name), name);
    assert.match(operatorSkill({ url: 'https://hub.example/' }), /https:\/\/hub\.example\/agents\.md/);
  });

  test('the plugin listens only once the operator skill runs', () => {
    assert.deepEqual(MONITORS, [{ name: 'nuworq-operator-listener', command: OPERATOR_WAIT, description: 'nuworq operator listener', when: 'on-skill-invoke:nuworq-operator' }]);
  });
});
