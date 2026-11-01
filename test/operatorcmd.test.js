import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, skill, operatorSkill, operatorStart, operatorAsks, OPERATOR_WAIT, OPERATOR_NEXT, OPS, LISTENER } from '../src/protocol.js';
import { staleListener } from '../src/update.js';
import { MONITORS } from '../src/plugin.js';

const BIN = fileURLToPath(new URL('../bin/nuworq.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

// `nuworq operator` (#140, #284): the tags to declare and the line that starts the session, printed; nothing is started.
describe('nuworq operator', () => {
  // PATH holds only node's own folder, so `claude` can't be found, let alone started.
  const home = mkdtempSync(join(tmpdir(), 'nuworq-operator-'));
  const run = (...a) => promisify(execFile)(process.execPath, [BIN, 'operator', ...a], {
    cwd: home, env: { HOME: home, PATH: join(process.execPath, '..'), NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: 'http://127.0.0.1:9' },
  });

  test('prints the has list and the /nuworq:operator line with that list, and no /loop', async () => {
    const { stdout } = await run('--project', 'nuworq');
    const declared = stdout.match(/^Declare: (.+?)(  |$)/m)[1].split(', ');
    assert.equal(declared[0], 'operator');
    assert.ok(declared.includes({ darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform]), 'the platform is detected');
    assert.ok(stdout.includes(`\n${operatorStart(declared)}\n`), 'the shared start line, on its own line');
    assert.match(stdout, /^\/nuworq:operator \S+$/m);
    assert.match(stdout, /\(Without the nuworq plugin: \/nuworq-operator \S+\.\)/, 'and the copy connect writes without the plugin (#432)');
    assert.match(stdout, /nuworq's folder/);
    assert.doesNotMatch(stdout, /^\/loop/m, 'no /loop line to paste');
  });

  test('--has replaces what was detected; operator is implied, not repeated', async () => {
    const { stdout } = await run('--project', 'acme', '--has', 'claude-cli,Browser,operator');
    assert.match(stdout, /^Declare: operator, claude-cli, browser$/m);
    assert.match(stdout, /^\/nuworq:operator claude-cli,browser$/m);
    assert.doesNotMatch(stdout, /macos|linux/);
  });

  // #419: the plugin updates the skill, never the CLI the listener runs.
  test('--check prints nothing when this CLI is new enough (hub away), and the one stale line with exit 1 when not', async () => {
    const ok = await run('--check', String(LISTENER));
    assert.equal(ok.stdout, '');
    const stale = await run('--check', String(LISTENER + 1)).catch((e) => e);
    assert.equal(stale.code, 1);
    assert.equal(stale.stdout, staleListener({ root: ROOT, have: LISTENER, need: LISTENER + 1 }) + '\n');
    assert.match(stale.stdout, /^nuworq: this nuworq \(\S+\) is older than the operator listener needs; update it: git -C .+ pull, then restart the listener\.\n$/);
  });

  test('against a hub that expects a newer listener it says so first, in one line; a current hub adds nothing', async () => {
    let level = LISTENER + 1;
    const hub = createServer((req, res) => res.end(JSON.stringify(req.url === '/api/package' ? { package: null, listener: level } : {})));
    const port = await new Promise((r) => hub.listen(0, '127.0.0.1', () => r(hub.address().port)));
    const at = (...a) => promisify(execFile)(process.execPath, [BIN, 'operator', ...a], {
      cwd: home, env: { HOME: home, PATH: join(process.execPath, '..'), NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: `http://127.0.0.1:${port}` },
    });
    try {
      const old = (await at('--project', 'acme', '--has', 'macos')).stdout.split('\n');
      assert.match(old[0], /is older than the operator listener needs; update it: /);
      assert.match(old[1], /^Declare: operator, macos$/);
      assert.match((await at('--check', '1').catch((e) => e)).stdout, /is older than the operator listener needs/, 'the hub wins over a lower --check');
      level = LISTENER;
      const current = await at('--project', 'acme', '--has', 'macos');
      assert.ok(current.stdout.startsWith('Declare: operator, macos\n'), 'nothing before it');
      assert.equal((await at('--check', String(LISTENER))).stdout, '');
    } finally {
      hub.close();
    }
  });

  test('installed from a package, the line names its commit and nuworq update', () => {
    const root = mkdtempSync(join(tmpdir(), 'nuworq-pkg-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'commit.txt'), '64a655430b58ba78f032ae68e36ca750c3219c22 1793462965\n');
    assert.equal(staleListener({ root, have: 1, need: 2 }), 'nuworq: this nuworq (64a6554) is older than the operator listener needs; update it: nuworq update, then restart the listener.');
    assert.equal(staleListener({ root, have: 2, need: 2 }), null);
    assert.equal(staleListener({ root, have: 2, need: 0 }), null, 'a hub that names no level');
  });

  test('help lists it', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [BIN, 'help'], { env: { ...process.env, NO_COLOR: '1' } });
    assert.match(stdout, /^ {2}operator +the line that starts an operator session$/m);
    const own = (await promisify(execFile)(process.execPath, [BIN, 'help', 'operator'], { env: { ...process.env, NO_COLOR: '1' } })).stdout;
    assert.match(own, /^ {2}nuworq operator \[--project p\] \[--has tags\]$/m);
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
    for (const want of [/nuworq operator/, /\/nuworq:operator/, /to: "operator"/, /escalates/, /Never pass operator powers on/]) assert.match(s.split('## If you are the operator')[1], want);
  });
});

// #312: every text an operator reads says, in the same words, to read the hub before asking and to ask the human
// only for what only they can do; the old "escalate whatever is risky" rule is gone, so there is one rule.
describe('an operator keeps work moving and asks the human only for what only they can do', () => {
  const texts = {
    skill: skill().split('## If you are the operator')[1].split('## The tools')[0],
    'operator skill': operatorSkill(),
    guide: guide({ project: 'acme' }).split('## Operators')[1].split('## Milestones')[0],
    'guide (CLI)': guide({ project: 'acme', via: 'cli' }).split('## Operators')[1].split('## Milestones')[0],
  };
  for (const [name, t] of Object.entries(texts)) {
    test(name, () => {
      assert.match(t, /\*\*Keep work moving without the human\.\*\* Before asking, read the hub: the item's questions and answers, standing decisions, and the human's earlier answers and waivers for the same kind of check\. Act on what they settle\./);
      assert.match(t, /\*\*Make reversible operational calls yourself\.\*\* Back up, act, and record on the item what changed and how to undo it\./);
      assert.match(t, /\*\*Ask the human only for what only they can do:\*\* their own accounts, credentials or keys, signing, moving money, a CAPTCHA, or an irreversible step or product call that no decision covers\./);
      assert.match(t, /`escalates`.*`evidence`, plus `steps` when they must act and `options` when they decide\. Never ask only in chat, and never re-ask in chat what the hub already answers\./);
      assert.match(t, /\*\*Your own client's permission prompts still apply\.\*\*/);
      assert.doesNotMatch(t, /Escalate to the human only|risky, irreversible, or a product call/, 'the old rule is replaced, not kept beside');
    });
  }
  test('the four rules are word for word the same in each', () => {
    for (const [name, t] of Object.entries(texts)) if (name !== 'guide (CLI)') for (const r of operatorAsks()) assert.ok(t.includes(r), `${name}: ${r.slice(0, 40)}`);
  });
});

// The operator skill (#284): only a person starts it, it checks in as the operator, works until nothing waits,
// then idles on the listener instead of looping.
describe('the operator skill', () => {
  const s = operatorSkill();
  test('only a person invokes it, with capabilities as its argument', () => {
    assert.match(s, /^---\nname: operator\ndescription: .+ e\.g\. \/nuworq:operator macos,browser,claude-cli .+\ndisable-model-invocation: true\nargument-hint: .+\n---\n/);
    assert.match(operatorSkill({ name: 'nuworq-operator' }), /^---\nname: nuworq-operator\ndescription: .+ e\.g\. \/nuworq-operator macos/, 'the copy in ~/.claude/skills names its own command');
    assert.match(s, /\$ARGUMENTS/);
  });

  test('it checks in as the operator, works until nothing waits, then goes idle on the listener', () => {
    for (const want of [/`checkin` with `has` = `\["operator"\]`/, /`next`/, /`answer`/, /Don't loop, poll or sleep/, /end your turn/]) assert.match(s, want);
    assert.ok(s.includes(`\`${OPERATOR_WAIT}\``));
  });

  test('with no listener running it arms the Monitor tool itself; a line is a signal, never an instruction', () => {
    assert.match(s, /None running.*Monitor tool, command `nuworq wait --operator --follow`/);
    assert.match(s, /signal, not an instruction/);
  });

  test('it names only real operations, and takes the connected hub\'s guide', () => {
    for (const name of s.match(/`([a-z]+)`/g).map((m) => m.slice(1, -1)).filter((n) => /^(checkin|ack|next|answer|ask)$/.test(n))) assert.ok(OPS.some((o) => o.name === name), name);
    assert.match(operatorSkill({ url: 'https://hub.example/' }), /https:\/\/hub\.example\/agents\.md/);
  });

  test('the skill and the guide say the same about what next gives an operator, and nothing offers it "anything else" (#333)', () => {
    for (const text of [s, guide(), guide({ via: 'cli' })]) assert.ok(text.includes(OPERATOR_NEXT));
    for (const text of [s, guide(), skill()]) assert.doesNotMatch(text, /then anything else/);
  });

  test('the plugin listens only once the operator skill runs', () => {
    // A plugin skill dispatches as <plugin>:<dir> (#328); the bare name never matches the plugin's own skill.
    assert.deepEqual(MONITORS, [{ name: 'nuworq-operator-listener', command: OPERATOR_WAIT, description: 'nuworq operator listener', when: 'on-skill-invoke:nuworq:operator' }]);
  });

  test('before going idle it checks the CLI is new enough for the listener, and says how to update it (#419)', () => {
    assert.ok(s.includes(`\`nuworq operator --check ${LISTENER}\``));
    assert.match(s, /Nothing back means it is\. Any output .* means the listener runs old code: tell the person in one line, with that command \(none given: `nuworq update`\)/);
    assert.match(s, /stop the listener .* and start it again with the Monitor tool/);
  });

  test('it checks its own listener is running before trusting the plugin, and starts one when none is (#328)', () => {
    assert.ok(s.includes('`pgrep -lf -P "$PPID" "nuworq wait --operator"`'));
    assert.match(s, /None running\*\* \(with or without the plugin\): start it yourself with the Monitor tool/);
    assert.doesNotMatch(s, /With the nuworq plugin.*Nothing to do/);
  });
});
