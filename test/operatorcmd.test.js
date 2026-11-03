import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guide, skill, operatorSkill, operatorStart, operatorAsks, OPERATOR_WAIT, OPERATOR_NEXT, OPS, LISTENER, MODE_RULES } from '../src/protocol.js';
import { staleListener } from '../src/update.js';
import { saveLocal, changeInfra } from '../src/operator.js';
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

  test('prints the bare /nuworq:operator line (capabilities are detected when it starts), and no /loop', async () => {
    const { stdout } = await run('--project', 'nuworq');
    assert.ok(stdout.includes(`\n${operatorStart()}\n`), 'the shared start line, on its own line');
    assert.match(stdout, /^\/nuworq:operator$/m, 'nothing typed after it (#494)');
    assert.match(stdout, /Capabilities are optional: left out, it detects what this session can do \(see nuworq operator --detect\)/);
    assert.match(stdout, /\(Without the nuworq plugin: \/nuworq-operator\.\)/, 'and the copy connect writes without the plugin (#432)');
    assert.match(stdout, /nuworq's folder/);
    assert.doesNotMatch(stdout, /^\/loop/m, 'no /loop line to paste');
  });

  test('--has types them instead; operator is implied, not repeated', async () => {
    const { stdout } = await run('--project', 'acme', '--has', 'claude-cli,Browser,operator');
    assert.match(stdout, /^It declares operator, claude-cli, browser\.$/m);
    assert.match(stdout, /^\/nuworq:operator claude-cli,browser$/m);
    assert.doesNotMatch(stdout, /macos|linux/);
  });

  // #494: the one place detection lives, with a reason for each tag in or out.
  test('--detect says what to declare and why; the infra check is this machine\'s own', async () => {
    const d = await run('--detect');
    assert.match(d.stdout, /^Declare: operator,/);
    assert.match(d.stdout, /✗ claude-cli: claude doesn't run here/, 'PATH holds no claude');
    assert.match(d.stdout, /✓ infra: a person started this operator here, in a terminal they can see/);
    assert.match(d.stdout.trim().split('\n').at(-1), /^Operator: /);
    // Set as a person's confirmed change saves it (the command itself needs a terminal: below).
    const file = join(home, '.nuworq', 'operator.json');
    saveLocal(file, { infra_check: 'false' });
    assert.match((await run('--detect')).stdout, /✗ infra: its check failed \(false\)/);
    saveLocal(file, { infra_check: 'true' });
    assert.match((await run('--detect')).stdout, /✓ infra: its check passed \(true\)/);
    saveLocal(file, { without_infra: true });
    assert.match((await run('--detect')).stdout, /✗ infra: this machine was set --without infra/);
    saveLocal(file, { without_infra: null, infra_check: null });
    assert.match((await run('--detect')).stdout, /✓ infra: a person started/);
  });

  // #607: --detect runs the check with /bin/sh, so setting one is running code later. An agent's shell has no
  // terminal: from there nothing changes, whichever way it's asked.
  test('infra check changes only with a person\'s confirmation', async () => {
    const file = join(home, '.nuworq', 'operator.json');
    saveLocal(file, { infra_check: 'true' });
    const before = readFileSync(file, 'utf8');
    for (const args of [['--infra-check', 'touch pwned'], ['--detect', '--infra-check', 'touch pwned'], ['--infra-check', 'touch pwned', '--yes'], ['--without', 'infra'], ['--with', 'infra'], ['--infra-check', '']]) {
      const r = await run(...args).catch((e) => e);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.stdout, /Nothing changed: only a person at a terminal changes this machine's infra settings/);
      assert.equal(readFileSync(file, 'utf8'), before, `${args.join(' ')}: the file is as it was`);
    }
    const asked = [];
    const confirm = (answer) => async (q) => { asked.push(q); return answer; };
    assert.equal(await changeInfra(file, { infra_check: 'touch pwned' }, null), null, 'no terminal: no change');
    assert.equal(await changeInfra(file, { infra_check: 'touch pwned' }, confirm(false)), null, 'the person said no');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(await changeInfra(file, { infra_check: 'ssh vm true' }, confirm(true)), { infra_check: 'ssh vm true' });
    assert.match(asked[0], /^--detect will run "touch pwned" with \/bin\/sh to decide whether this machine declares infra\. Set it\?$/, 'the person sees the command');
    saveLocal(file, { infra_check: null });
  });

  test('--allow writes the rules into the project\'s settings.local.json only on a yes, and --off takes exactly those out', async () => {
    const proj = mkdtempSync(join(tmpdir(), 'nuworq-allow-'));
    const file = join(proj, '.claude', 'settings.local.json');
    mkdirSync(join(proj, '.claude'));
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, model: 'x' }));
    const at = (...a) => promisify(execFile)(process.execPath, [BIN, 'operator', ...a], { cwd: proj, env: { HOME: home, PATH: join(process.execPath, '..'), NO_COLOR: '1', NUWORQ_NO_UPDATE: '1', NUWORQ_URL: 'http://127.0.0.1:9' } });
    assert.match((await at('--allow')).stdout, /Nothing changed: run it at a terminal, or with --yes/, 'no terminal: no yes');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).permissions.allow, ['Bash(ls:*)']);
    assert.match((await at('--allow', '--yes')).stdout, /Added \d+ rules to .*settings\.local\.json\. Undo: nuworq operator --allow --off/);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(cfg.model, 'x', 'the rest stays');
    assert.ok(cfg.permissions.allow.includes('Bash(nuworq checkin:*)') && cfg.permissions.allow.includes('Bash(ls:*)'));
    assert.ok(!cfg.permissions.allow.includes('Bash(nuworq:*)'), 'never every nuworq command (#607)');
    assert.ok(cfg.permissions.deny.includes('Bash(git push --force*)'));
    await at('--allow', '--off');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { permissions: { allow: ['Bash(ls:*)'] }, model: 'x' });
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
      assert.match(old[1], /^Start it: /);
      assert.match((await at('--check', '1').catch((e) => e)).stdout, /is older than the operator listener needs/, 'the hub wins over a lower --check');
      level = LISTENER;
      const current = await at('--project', 'acme', '--has', 'macos');
      assert.ok(current.stdout.startsWith('Start it: '), 'nothing before it');
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
    assert.match(stdout, /^ {2}operator +start an operator: Claude Code in a terminal \(--start\)$/m);
    const own = (await promisify(execFile)(process.execPath, [BIN, 'help', 'operator'], { env: { ...process.env, NO_COLOR: '1' } })).stdout;
    assert.match(own, /^ {2}nuworq operator \[--project p\] \[--has tags\]$/m);
  });
});

describe('one start line for the skill, the README and the command; no /loop anywhere', () => {
  test('the worker skill and the README carry operatorStart() word for word, and the README and operator skill the listener', () => {
    const g = guide({ project: 'acme' });
    assert.ok(skill().includes(operatorStart()));
    assert.ok(operatorSkill().includes(OPERATOR_WAIT));
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(readme.includes(operatorStart()));
    assert.ok(readme.includes(OPERATOR_WAIT));
    assert.match(readme, /Capabilities are optional\. Left out, the session runs `nuworq operator --detect`/);
    for (const text of [g, readme, skill(), operatorSkill()]) assert.doesNotMatch(text, /\/loop (Work|Run)|paste the \/loop/);
  });

  test('the skill has an operator section that points at the operator skill', () => {
    const s = skill();
    assert.match(s, /## If you are the operator/);
    for (const want of [/nuworq operator/, /\/nuworq:operator/, /to: "operator"/, /escalates/, /Never pass operator powers on/]) assert.match(s.split('## If you are the operator')[1], want);
  });

  test('the skill\'s operator section says what --detect proves and lists the rules that run without prompts (#494)', () => {
    const s = skill().split('## If you are the operator')[1].split('## The tools')[0];
    assert.match(s, /with nothing typed after `\/nuworq:operator`, `nuworq operator --detect` proves each capability/);
    assert.match(s, /Routine commands run without prompts:.*git \(status, diff, .*rebase, push/);
    assert.match(s, /Force-pushes, deleting or rewriting remote refs .* still ask/);
    assert.match(s, /`nuworq operator --allow` adds them/);
  });
});

// #312: every text an operator reads says, in the same words, to read the hub before asking and to ask the human
// only for what only they can do; the old "escalate whatever is risky" rule is gone, so there is one rule.
describe('an operator keeps work moving and asks the human only for what only they can do', () => {
  const texts = {
    skill: skill().split('## If you are the operator')[1].split('## The tools')[0],
    'operator skill': operatorSkill(),
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
    for (const [name, t] of Object.entries(texts)) for (const r of operatorAsks()) assert.ok(t.includes(r), `${name}: ${r.slice(0, 40)}`);
  });
  test('the hint next gives an operator says it in short (#527)', () => {
    for (const want of [/read the hub first/, /make reversible calls yourself/, /only for what only they can do/, /escalates and evidence/, /permission prompts still apply/]) assert.match(MODE_RULES.operator, want);
  });
});

// The operator skill (#284): only a person starts it, it checks in as the operator, works until nothing waits,
// then idles on the listener instead of looping.
describe('the operator skill', () => {
  const s = operatorSkill();
  test('only a person invokes it, with capabilities as an optional argument; none given, it detects them', () => {
    assert.match(s, /^---\nname: operator\ndescription: .+capabilities are optional.+ e\.g\. \/nuworq:operator macos,browser,claude-cli\.\ndisable-model-invocation: true\nargument-hint: \[capabilities, optional: detected when left out\]\n---\n/);
    assert.match(s, /None given: run `nuworq operator --detect` and use the tags on its `Declare:` line/);
    assert.match(s, /Your first line to the person is the last line --detect printed/);
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

  test('the skill and the operator hint say the same about what next gives an operator, and nothing offers it "anything else" (#333)', () => {
    for (const text of [s, MODE_RULES.operator]) assert.ok(text.includes(OPERATOR_NEXT));
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
