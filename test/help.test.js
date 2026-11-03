import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { COMMANDS, bare, commandHelp, reference, nearest, command, wrap } from '../src/help.js';
import { OPS } from '../src/protocol.js';
import { POSITIONAL } from '../src/agentargs.js';

// The CLI's help (#481): one table, three views.
const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const cli = (...a) => promisify(execFile)(process.execPath, [BIN, ...a], { env: { ...process.env, NUWORQ_NO_UPDATE: '1' } });
const source = readFileSync(BIN, 'utf8');

// What main() dispatches: its `cmd === '…'` branches and the agent commands (POSITIONAL, one per op, #521).
function dispatched() {
  const main = source.slice(source.indexOf('async function main()'));
  const named = [...main.matchAll(/cmd === '([a-z][\w-]*)'/g)].map((m) => m[1]);
  return new Set([...named, ...Object.keys(POSITIONAL)]);
}
const wide = (text, max = 80) => text.split('\n').filter((l) => l.length > max);

describe('the CLI help comes from one table (#481)', () => {
  test('every command main() dispatches has an entry, and every entry is a command', () => {
    const cmds = dispatched();
    const entries = new Set(COMMANDS.map((c) => c.name));
    assert.ok(cmds.has('run') && cmds.has('checkin') && cmds.has('git-credential'), 'it reads the dispatch');
    assert.deepEqual([...cmds].filter((c) => !entries.has(c)), [], 'commands without help');
    assert.deepEqual([...entries].filter((c) => !cmds.has(c)), [], 'help for no command');
  });

  test('a bare nuworq is one screen: at most 30 lines and 80 columns, grouped, one line per command', async () => {
    const { stdout } = await cli();
    assert.equal(stdout, `${bare()}\n`);
    assert.equal((await cli('help')).stdout, stdout);
    const lines = stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 30, `${lines.length} lines`);
    assert.deepEqual(wide(stdout), []);
    assert.match(stdout, /^nuworq \d+\.\d+\.\d+: a hub where agents do the work and people steer\n\nGet going\n {2}connect <hub> +use a hub/);
    for (const g of ['Get going', 'Work with agents', 'Run a hub']) assert.match(stdout, new RegExp(`^${g}$`, 'm'));
    assert.match(stdout, /^For agents \(through MCP\): checkin, next, claim/m);
    assert.match(stdout, /^nuworq help <command> +flags, examples and environment for one$/m);
    assert.doesNotMatch(stdout, /\x1b\[/, 'not a terminal: no styling');
  });

  test("help <command> and <command> --help print that command's help, no wider than 80", async () => {
    const run = (await cli('help', 'run')).stdout;
    assert.equal((await cli('run', '--help')).stdout, run);
    assert.match(run, /^nuworq run: keep up to N headless workers/);
    assert.match(run, /^Usage\n {2}nuworq run \[flags\]\n {2}nuworq run --sweep \[--dry-run\]/m);
    assert.match(run, /^ {2}--poll <s> +the most seconds between looks; new work is heard at once\n +\(default: 30\)$/m);
    assert.match(run, /^Environment\n {2}NUWORQ_AGENT_TOKEN /m);
    assert.match(run, /^Example\n {2}nuworq run --workers 3 --agent claude$/m);
    for (const c of COMMANDS) {
      const h = commandHelp(c.name);
      assert.deepEqual(wide(h), [], c.name);
      assert.match(h, /^Usage$/m, c.name);
      assert.match(h, /^Example$/m, c.name);
    }
  });

  test('text wraps to the width with its hanging indent intact', () => {
    const h = commandHelp('run', { width: 50 });
    assert.deepEqual(wide(h, 50), []);
    const flags = h.split('\nFlags\n')[1].split('\n\n')[0].split('\n');
    const col = flags[0].indexOf('workers at once');
    assert.ok(flags.filter((l) => !/^ {2}--/.test(l)).every((l) => l.startsWith(' '.repeat(col)) && l[col] !== ' '), 'continuations line up under the text');
    assert.deepEqual(wrap('one two three four', 9, { first: '  ', hang: '    ' }), ['  one two', '    three', '    four']);
  });

  test("the agent commands say what the protocol's OPS say, so they can't drift", () => {
    for (const op of OPS.filter((o) => command(o.name)?.group === 'protocol')) {
      const first = op.description.match(/^.*?\.(?=\s|$)/)[0].replace(/\.$/, '');
      assert.equal(command(op.name).does, first.charAt(0).toLowerCase() + first.slice(1), op.name);
    }
    // A flag reads its param: e.g. ask --assumption is the first sentence of assumption's description, and its limit.
    const { description, maxLength } = OPS.find((o) => o.name === 'ask').params.assumption;
    assert.equal(command('ask').flags.find(([f]) => f.startsWith('--assumption '))[1], `${description.charAt(0).toLowerCase() + description.slice(1).replace(/\.$/, '')}, at most ${maxLength.toLocaleString('en-US')} characters`);
  });

  test('help all is the full reference, and docs/CLI.md is generated from it', async () => {
    const all = (await cli('help', 'all')).stdout;
    for (const c of COMMANDS) assert.ok(all.includes(`nuworq ${c.name}: `), c.name);
    assert.match(all, /^Environment \(every command\)$/m);
    assert.deepEqual(wide(all), []);
    const doc = readFileSync(new URL('../docs/CLI.md', import.meta.url), 'utf8');
    assert.equal(doc, `${reference({ markdown: true })}\n`, 'docs/CLI.md is out of date: nuworq help all --markdown > docs/CLI.md');
    assert.equal((await cli('help', 'all', '--markdown')).stdout, doc);
  });

  test('in a terminal, command names are bold and placeholders dim', () => {
    const style = { bold: (s) => `*${s}*`, dim: (s) => `_${s}_` };
    const b = bare({ style });
    assert.match(b, /^ {2}\*connect\* _<hub>_ +use a hub/m);
    assert.match(b, /^\*Get going\*$/m);
    const claim = commandHelp('claim', { style });
    assert.match(claim, /^\*nuworq claim\*: claim a specific item/);
    assert.match(claim, /^ {2}nuworq \*claim\* _<item>_ \[flags\]$/m);
  });

  test('NO_COLOR or no terminal: nothing is styled', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'help', 'run'], { env: { ...process.env, NO_COLOR: '1', NUWORQ_NO_UPDATE: '1' } });
    assert.doesNotMatch(stdout, /\x1b\[/);
  });

  test('an unknown command suggests the nearest and points to nuworq help', async () => {
    assert.equal(nearest('rnu'), 'run');
    assert.equal(nearest('chekin'), 'checkin');
    assert.equal(nearest('zzzzzzzzzz'), null);
    await assert.rejects(cli('rnu'), (e) => /unknown command "rnu"/.test(e.stderr) && /Did you mean run\? See: nuworq help/.test(e.stderr));
    await assert.rejects(cli('help', 'statsu'), (e) => /Did you mean status\?/.test(e.stderr));
  });
});
